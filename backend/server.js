const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { GoogleGenAI } = require('@google/genai');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// 🔥 trust proxy để đọc đúng IP khi deploy sau reverse proxy
app.set('trust proxy', 1);

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ================== HEALTH ==================
app.get('/', (req, res) => {
  res.status(200).send('Quiz backend is running!');
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// ================== GEMINI INIT ==================
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('❌ Thiếu GEMINI_API_KEY trong biến môi trường');
  process.exit(1);
}
const ai = new GoogleGenAI({ apiKey });
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// ============================================================
//                      HELPERS
// ============================================================

/**
 * Đọc text từ response Gemini — hỗ trợ MỌI version SDK.
 * - SDK mới: response.text là getter → string
 * - SDK cũ:  response.text là function
 * - Fallback: đào sâu vào candidates[0].content.parts
 */
function readResponseText(response) {
  if (!response) return '';

  // SDK mới (getter)
  try {
    if (typeof response.text === 'string' && response.text.trim()) {
      return response.text;
    }
  } catch (_) { /* getter throw nếu bị chặn safety */ }

  // SDK cũ (function)
  try {
    if (typeof response.text === 'function') {
      const t = response.text();
      if (typeof t === 'string' && t.trim()) return t;
    }
  } catch (_) { /* ignore */ }

  // Deep fallback
  const parts = response.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    const joined = parts.map(p => p?.text || '').join('');
    if (joined.trim()) return joined;
  }
  return '';
}

/**
 * Loại bỏ ```json ... ``` và cắt về đúng đoạn JSON.
 * Trả về object/array hoặc null nếu parse fail.
 */
function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();

  // Bỏ code fence ```json ... ```
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  // Cắt từ dấu { hoặc [ đầu tiên tới } hoặc ] cuối cùng
  const first = s.search(/[\[{]/);
  const last = Math.max(s.lastIndexOf(']'), s.lastIndexOf('}'));
  if (first !== -1 && last > first) {
    s = s.slice(first, last + 1);
  }

  try {
    return JSON.parse(s);
  } catch (e) {
    console.warn('[extractJson] Parse fail:', e.message);
    return null;
  }
}

/**
 * Gọi Gemini — KHÔNG throw ra ngoài cho endpoint chết.
 */
async function callGemini(prompt, responseMimeType = 'text/plain', responseSchema) {
  const config = { responseMimeType };
  if (responseSchema) config.responseSchema = responseSchema;

  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: prompt,
      config,
    });
    const text = readResponseText(response);
    if (!text) throw new Error('Gemini trả về rỗng');
    return text;
  } catch (err) {
    // Nếu schema bị reject (version SDK cũ) → thử lại không schema
    if (responseSchema && /schema|Invalid|UNKNOWN|responseSchema/i.test(err.message || '')) {
      console.warn('[Gemini] Schema bị reject → retry không schema');
      const response = await ai.models.generateContent({
        model: MODEL,
        contents: prompt,
        config: { responseMimeType },
      });
      const text = readResponseText(response);
      if (!text) throw new Error('Gemini trả về rỗng (no-schema retry)');
      return text;
    }
    throw err;
  }
}

/**
 * Retry khi gặp lỗi tạm thời (429, 503, timeout).
 */
async function callGeminiWithRetry(prompt, mime, schema, retries = 2, delayMs = 1500) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await callGemini(prompt, mime, schema);
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || '');
      const retryable = /429|503|timeout|overload|ECONNRESET|fetch failed|rate limit/i.test(msg);
      if (!retryable || i === retries) throw err;
      console.warn(`[Gemini] Retry ${i + 1}/${retries} sau ${delayMs}ms — lý do: ${msg}`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

// ============================================================
//         LOCAL QUIZ GENERATOR (fallback khi AI fail)
// ============================================================
function generateLocalQuiz(word, count = 5) {
  const hanzi = word?.hanzi || '?';
  const pinyin = word?.pinyin || '?';
  const meaning = (word?.translations?.[0]) || pinyin;

  const templates = [
    `Nghĩa của từ "${hanzi}" là gì?`,
    `"${hanzi}" có nghĩa là gì?`,
    `Chọn nghĩa đúng của "${hanzi}" (${pinyin}).`,
    `Từ "${hanzi}" tương ứng với nghĩa nào?`,
    `"${pinyin}" nghĩa là gì?`
  ];

  const sampleDistractors = [
    'xin chào', 'cảm ơn', 'tạm biệt', 'xin lỗi', 'không có gì',
    'nước', 'cơm', 'trà', 'cà phê', 'bạn bè',
    'giáo viên', 'học sinh', 'trường học', 'gia đình',
    'ngày mai', 'hôm nay', 'buổi sáng', 'buổi tối',
    'đọc sách', 'viết chữ', 'nghe nhạc', 'xem phim'
  ].filter(d => d !== meaning);

  const questions = [];
  for (let i = 0; i < count; i++) {
    const distractors = [...sampleDistractors]
      .sort(() => Math.random() - 0.5)
      .slice(0, 3);
    const options = [meaning, ...distractors]
      .filter((v, idx, arr) => arr.indexOf(v) === idx)
      .sort(() => Math.random() - 0.5);

    questions.push({
      question: templates[i % templates.length],
      options,
      answer: meaning,
      explanation: `"${hanzi}" (${pinyin}) nghĩa là: ${meaning}.`
    });
  }
  return questions;
}

// ============================================================
//                 API: VOCAB QUIZ
// ============================================================
app.post('/api/ai/vocab-quiz', async (req, res) => {
  const t0 = Date.now();
  try {
    const { word, count = 5 } = req.body || {};

    // --- Validate input ---
    if (
      !word ||
      typeof word.hanzi !== 'string' ||
      typeof word.pinyin !== 'string' ||
      !Array.isArray(word.translations) ||
      word.translations.length === 0
    ) {
      console.warn('[vocab-quiz] Payload thiếu → trả về quiz local');
      return res.json({
        result: generateLocalQuiz(
          {
            hanzi: word?.hanzi || '?',
            pinyin: word?.pinyin || '?',
            translations: word?.translations || ['?']
          },
          Number(count) || 5
        ),
        fallback: true,
      });
    }

    const n = Math.max(1, Math.min(10, Number(count) || 5));

    const prompt = `Bạn là giáo viên tiếng Trung đang tạo bài tập trắc nghiệm cho học sinh người Việt.

Từ vựng cần ôn:
- Hán tự: ${word.hanzi}
- Pinyin: ${word.pinyin}
- Nghĩa: ${word.translations.join(', ')}

Hãy tạo ĐÚNG ${n} câu hỏi trắc nghiệm. Mỗi câu gồm:
- "question": câu hỏi bằng TIẾNG VIỆT
- "options": MẢNG 4 lựa chọn (string)
- "answer": lựa chọn ĐÚNG (BẮT BUỘC phải nằm trong "options")
- "explanation": giải thích ngắn bằng TIẾNG VIỆT

Chỉ trả về DUY NHẤT một mảng JSON. KHÔNG thêm markdown, không thêm văn bản ngoài.`;

    const responseSchema = {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          answer: { type: 'string' },
          explanation: { type: 'string' },
        },
        required: ['question', 'options', 'answer', 'explanation'],
      },
    };

    // --- Gọi Gemini (không để throw ra ngoài) ---
    let quizArray = null;
    try {
      const text = await callGeminiWithRetry(prompt, 'application/json', responseSchema);
      quizArray = extractJson(text);
    } catch (aiErr) {
      console.warn('[vocab-quiz] Gemini lỗi:', aiErr?.message);
    }

    // --- Validate từng câu ---
    let finalQuiz = [];
    if (Array.isArray(quizArray)) {
      finalQuiz = quizArray
        .filter(q =>
          q &&
          typeof q.question === 'string' && q.question.trim() &&
          Array.isArray(q.options) &&
          q.options.length >= 2 &&
          q.options.every(o => typeof o === 'string') &&
          typeof q.answer === 'string' &&
          q.options.includes(q.answer) &&         // 🔥 answer PHẢI nằm trong options
          typeof q.explanation === 'string'
        )
        .slice(0, n);
    }

    // --- Fallback local nếu AI fail hoặc thiếu câu ---
    let usedFallback = false;
    if (finalQuiz.length < n) {
      const need = n - finalQuiz.length;
      finalQuiz = [...finalQuiz, ...generateLocalQuiz(word, need)];
      usedFallback = true;
    }

    console.log(
      `[vocab-quiz] OK ${finalQuiz.length}/${n} câu (${Date.now() - t0}ms)` +
      (usedFallback ? ' [có fallback]' : '')
    );

    res.json({ result: finalQuiz, fallback: usedFallback });
  } catch (error) {
    // Cực hiếm khi vào đây — nhưng vẫn KHÔNG trả 500
    console.error('❌ Lỗi không mong đợi /api/ai/vocab-quiz:', error);
    try {
      const emergency = generateLocalQuiz(
        {
          hanzi: req.body?.word?.hanzi || '?',
          pinyin: req.body?.word?.pinyin || '?',
          translations: req.body?.word?.translations || ['?']
        },
        Number(req.body?.count) || 5
      );
      return res.json({ result: emergency, fallback: true, emergency: true });
    } catch {
      return res.status(500).json({ error: 'Không thể tạo quiz. Vui lòng thử lại.' });
    }
  }
});

// ============================================================
//                 API: DICTIONARY
// ============================================================
app.post('/api/ai/dictionary', async (req, res) => {
  try {
    const { query } = req.body || {};
    if (!query) return res.status(400).json({ error: 'Thiếu từ cần tra' });

    const prompt = `Bạn là từ điển tiếng Trung. Giải thích chi tiết từ/cụm từ: "${query}".
Bao gồm: phiên âm pinyin (nếu có), nghĩa tiếng Việt, ví dụ câu (có pinyin và dịch nghĩa), cấu trúc ngữ pháp nếu cần.
Trả lời bằng TIẾNG VIỆT, định dạng rõ ràng.`;

    const text = await callGeminiWithRetry(prompt, 'text/plain');
    res.json({ result: text });
  } catch (error) {
    console.error('Lỗi /api/ai/dictionary:', error);
    res.status(500).json({ error: 'Không thể tra từ. Vui lòng thử lại.' });
  }
});

// ============================================================
//                 API: GRAMMAR CHECK
// ============================================================
app.post('/api/ai/grammar-check', async (req, res) => {
  try {
    const { sentence } = req.body || {};
    if (!sentence) return res.status(400).json({ error: 'Thiếu câu cần kiểm tra' });

    const prompt = `Bạn là chuyên gia ngữ pháp tiếng Trung. Kiểm tra câu: "${sentence}".
- Nếu câu sai: chỉ ra lỗi, giải thích ngữ pháp, đề xuất câu đúng.
- Nếu câu đúng: xác nhận và giải thích cấu trúc.
Trả lời bằng TIẾNG VIỆT.`;

    const text = await callGeminiWithRetry(prompt, 'text/plain');
    res.json({ result: text });
  } catch (error) {
    console.error('Lỗi /api/ai/grammar-check:', error);
    res.status(500).json({ error: 'Không thể kiểm tra. Vui lòng thử lại.' });
  }
});

// ============================================================
//                 API: ROLEPLAY
// ============================================================
app.post('/api/ai/roleplay', async (req, res) => {
  try {
    const { message, scenario } = req.body || {};
    if (!message || !scenario) {
      return res.status(400).json({ error: 'Thiếu message hoặc scenario' });
    }

    const scenarioMap = {
      restaurant: 'nhà hàng',
      hotel: 'khách sạn',
      shopping: 'mua sắm',
      taxi: 'gọi taxi',
    };
    const scenarioName = scenarioMap[scenario] || scenario;

    const prompt = `Bạn là người bản xứ Trung Quốc đang đóng vai trong tình huống: ${scenarioName}.
Trả lời tin nhắn của người học bằng tiếng Trung (có pinyin và dịch nghĩa tiếng Việt).
Tin nhắn: "${message}".
Giữ hội thoại tự nhiên, hữu ích cho việc luyện tập.`;

    const text = await callGeminiWithRetry(prompt, 'text/plain');
    res.json({ result: text });
  } catch (error) {
    console.error('Lỗi /api/ai/roleplay:', error);
    res.status(500).json({ error: 'Không thể trả lời. Vui lòng thử lại.' });
  }
});

// ================== START ==================
app.listen(PORT, () => {
  console.log(`✅ Quiz backend đang chạy tại http://localhost:${PORT}`);
  console.log(`   Model: ${MODEL}`);
});
