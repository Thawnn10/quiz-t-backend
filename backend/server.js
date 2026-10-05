const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { GoogleGenAI } = require('@google/genai');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ================== HEALTH ==================
app.get('/', (req, res) => res.status(200).send('Quiz backend is running!'));
app.get('/health', (req, res) => res.status(200).send('OK'));

// ================== GEMINI INIT ==================
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('❌ Thiếu GEMINI_API_KEY');
  process.exit(1);
}
const ai = new GoogleGenAI({ apiKey });
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// ============================================================
//                 LANGUAGE FILTER (chống tiếng Anh)
// ============================================================

/**
 * Từ/cụm tiếng Anh hay bị lẫn → map sang tiếng Việt.
 * Dùng cho cả question, options, explanation.
 */
const EN_TO_VI = {
  'hello': 'xin chào',
  'hi': 'xin chào',
  'thank you': 'cảm ơn',
  'thanks': 'cảm ơn',
  'goodbye': 'tạm biệt',
  'bye': 'tạm biệt',
  'sorry': 'xin lỗi',
  'excuse me': 'xin lỗi',
  'yes': 'vâng',
  'no': 'không',
  'please': 'làm ơn',
  'water': 'nước',
  'tea': 'trà',
  'coffee': 'cà phê',
  'rice': 'cơm',
  'food': 'đồ ăn',
  'friend': 'bạn bè',
  'teacher': 'giáo viên',
  'student': 'học sinh',
  'school': 'trường học',
  'family': 'gia đình',
  'mother': 'mẹ',
  'father': 'bố',
  'book': 'sách',
  'to read': 'đọc',
  'to write': 'viết',
  'to eat': 'ăn',
  'to drink': 'uống',
  'to go': 'đi',
  'to come': 'đến',
  'today': 'hôm nay',
  'tomorrow': 'ngày mai',
  'yesterday': 'hôm qua',
  'morning': 'buổi sáng',
  'evening': 'buổi tối',
  'the meaning of': 'nghĩa của',
  'what is': 'gì là',
  'which': 'nào',
  'choose': 'chọn',
  'the correct': 'đúng',
  'translation': 'bản dịch',
  'word': 'từ',
  'sentence': 'câu',
  'example': 'ví dụ',
};

/**
 * Phát hiện xem string có chứa từ tiếng Anh đáng ngờ không.
 * Cách: kiểm tra tỉ lệ các từ Latin thuần (không dấu tiếng Việt) — nếu > 60% → nghi tiếng Anh.
 * Ngoại lệ: pinyin, chữ Hán, tên riêng.
 */
function looksLikeEnglish(text) {
  if (!text || typeof text !== 'string') return false;
  const s = text.trim();
  if (!s) return false;

  // Nếu có chữ Hán → OK, không phải tiếng Anh thuần
  if (/[\u4e00-\u9fff]/.test(s)) return false;

  // Đếm từ
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;

  // Từ "có dấu tiếng Việt"?
  const hasVietnameseDiacritic = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i.test(s);

  // Nếu có dấu tiếng Việt → chắc chắn không phải tiếng Anh
  if (hasVietnameseDiacritic) return false;

  // Kiểm tra từ đen (blacklist từ tiếng Anh phổ biến)
  const lower = s.toLowerCase();
  const enWords = ['the', 'is', 'are', 'of', 'to', 'and', 'what', 'which', 'choose', 'select', 'meaning', 'word', 'sentence'];
  const matchCount = enWords.filter(w => new RegExp(`\\b${w}\\b`, 'i').test(lower)).length;
  if (matchCount >= 1) return true;

  // Nếu toàn bộ từ không dấu + ngắn → nghi
  if (words.every(w => /^[a-zA-Z'-]+$/.test(w))) return true;

  return false;
}

/**
 * Dọn tiếng Anh trong 1 string: map các từ thông dụng + giữ phần còn lại.
 */
function sanitizeText(text) {
  if (!text || typeof text !== 'string') return text || '';
  let out = text;

  for (const [en, vi] of Object.entries(EN_TO_VI)) {
    const re = new RegExp(`\\b${en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    out = out.replace(re, vi);
  }
  return out;
}

/**
 * Kiểm tra 1 câu hỏi có "sạch" (toàn tiếng Việt/Hán/pinyin) không.
 */
function isCleanQuestion(q) {
  if (!q || typeof q !== 'object') return false;
  const texts = [q.question, q.answer, q.explanation, ...(q.options || [])];
  // Nếu BẤT KỲ text nào trông giống tiếng Anh → loại
  return texts.every(t => !looksLikeEnglish(t));
}

// ============================================================
//                    HELPERS GỌI GEMINI
// ============================================================

function readResponseText(response) {
  if (!response) return '';
  try {
    if (typeof response.text === 'string' && response.text.trim()) return response.text;
  } catch (_) {}
  try {
    if (typeof response.text === 'function') {
      const t = response.text();
      if (typeof t === 'string' && t.trim()) return t;
    }
  } catch (_) {}
  const parts = response.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    const j = parts.map(p => p?.text || '').join('');
    if (j.trim()) return j;
  }
  return '';
}

function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const first = s.search(/[\[{]/);
  const last = Math.max(s.lastIndexOf(']'), s.lastIndexOf('}'));
  if (first !== -1 && last > first) s = s.slice(first, last + 1);
  try { return JSON.parse(s); } catch (e) {
    console.warn('[extractJson] Parse fail:', e.message);
    return null;
  }
}

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
//         LOCAL QUIZ GENERATOR — 100% TIẾNG VIỆT
// ============================================================
function generateLocalQuiz(word, count = 5) {
  const hanzi = word?.hanzi || '?';
  const pinyin = word?.pinyin || '?';
  const meaning = (word?.translations?.[0]) || pinyin;

  // Templates — tất cả tiếng Việt
  const templates = [
    `Nghĩa của từ "${hanzi}" là gì?`,
    `"${hanzi}" có nghĩa là gì?`,
    `Chọn nghĩa đúng của "${hanzi}" (${pinyin}).`,
    `Từ "${hanzi}" tương ứng với nghĩa nào?`,
    `Phiên âm "${pinyin}" có nghĩa là gì?`,
    `Từ nào sau đây có nghĩa là "${meaning}"?`,
    `Bạn hãy chọn đáp án đúng cho "${hanzi}".`,
  ];

  // Đáp án nhiễu — HOÀN TOÀN tiếng Việt
  const distractors = [
    'xin chào', 'cảm ơn', 'tạm biệt', 'xin lỗi', 'không có gì',
    'nước', 'cơm', 'trà', 'cà phê', 'bánh mì',
    'bạn bè', 'giáo viên', 'học sinh', 'trường học', 'gia đình',
    'mẹ', 'bố', 'anh trai', 'chị gái', 'em trai',
    'hôm nay', 'ngày mai', 'hôm qua', 'buổi sáng', 'buổi tối',
    'đọc sách', 'viết chữ', 'nghe nhạc', 'xem phim', 'nói chuyện',
    'đi học', 'đi làm', 'ăn cơm', 'uống nước', 'ngủ',
    'to', 'nhỏ', 'đẹp', 'xấu', 'nhanh', 'chậm',
    'một', 'hai', 'ba', 'bốn', 'năm',
  ].filter(d => d !== meaning);

  const questions = [];
  for (let i = 0; i < count; i++) {
    const picked = [...distractors]
      .sort(() => Math.random() - 0.5)
      .slice(0, 3);

    const options = [meaning, ...picked]
      .filter((v, idx, arr) => arr.indexOf(v) === idx)
      .sort(() => Math.random() - 0.5);

    questions.push({
      question: templates[i % templates.length],
      options,
      answer: meaning,
      explanation: `"${hanzi}" (${pinyin}) có nghĩa là: ${meaning}.`
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

    // Validate input
    if (
      !word ||
      typeof word.hanzi !== 'string' ||
      typeof word.pinyin !== 'string' ||
      !Array.isArray(word.translations) ||
      word.translations.length === 0
    ) {
      console.warn('[vocab-quiz] Payload thiếu → fallback local');
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

    // 🔥 PROMPT CỨNG — CẤM TIẾNG ANH
    const prompt = `Bạn là giáo viên tiếng Trung đang soạn bài tập trắc nghiệm cho học sinh người Việt.

Từ vựng cần ôn:
- Hán tự: ${word.hanzi}
- Pinyin: ${word.pinyin}
- Nghĩa tiếng Việt: ${word.translations.join(', ')}

⚠️ QUY TẮC NGÔN NGỮ (BẮT BUỘC TUYỆT ĐỐI):
- TOÀN BỘ câu hỏi, lựa chọn (options), đáp án (answer), và giải thích (explanation) PHẢI viết bằng TIẾNG VIỆT.
- TUYỆT ĐỐI KHÔNG dùng tiếng Anh (không "hello", không "thank you", không "What is", không "choose", không "meaning"...).
- Chỉ được giữ nguyên chữ Hán và pinyin trong câu hỏi khi cần thiết.
- Ví dụ SAI: options = ["hello", "thank you", "goodbye", "sorry"]
- Ví dụ ĐÚNG: options = ["xin chào", "cảm ơn", "tạm biệt", "xin lỗi"]

Hãy tạo ĐÚNG ${n} câu hỏi trắc nghiệm. Mỗi câu gồm:
- "question": câu hỏi bằng TIẾNG VIỆT (có thể chèn chữ Hán + pinyin)
- "options": MẢNG 4 lựa chọn — TẤT CẢ đều bằng TIẾNG VIỆT
- "answer": lựa chọn ĐÚNG — bằng TIẾNG VIỆT, BẮT BUỘC nằm trong "options"
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

    // Gọi Gemini (không throw ra ngoài)
    let quizArray = null;
    try {
      const text = await callGeminiWithRetry(prompt, 'application/json', responseSchema);
      quizArray = extractJson(text);
    } catch (aiErr) {
      console.warn('[vocab-quiz] Gemini lỗi:', aiErr?.message);
    }

    // 🔥 VALIDATE + FILTER tiếng Anh + SANITIZE
    let finalQuiz = [];
    if (Array.isArray(quizArray)) {
      finalQuiz = quizArray
        .map(q => {
          // Bước 1: sanitize từng field
          if (!q || typeof q !== 'object') return null;

          const cleanQ = {
            question: sanitizeText(q.question),
            options: Array.isArray(q.options)
              ? q.options.map(sanitizeText)
              : [],
            answer: sanitizeText(q.answer),
            explanation: sanitizeText(q.explanation),
          };

          // Bước 2: validate cấu trúc
          if (
            typeof cleanQ.question !== 'string' || !cleanQ.question.trim() ||
            cleanQ.options.length < 2 ||
            !cleanQ.options.every(o => typeof o === 'string' && o.trim()) ||
            typeof cleanQ.answer !== 'string' || !cleanQ.answer.trim() ||
            !cleanQ.options.includes(cleanQ.answer)
          ) {
            return null;
          }

          // Bước 3: 🔥 LOẠI nếu còn tiếng Anh
          if (!isCleanQuestion(cleanQ)) {
            console.warn('[vocab-quiz] Loại câu hỏi chứa tiếng Anh:', cleanQ.question);
            return null;
          }

          return cleanQ;
        })
        .filter(Boolean)
        .slice(0, n);
    }

    // Fallback local nếu thiếu câu
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
//                 API: DICTIONARY (tiếng Việt)
// ============================================================
app.post('/api/ai/dictionary', async (req, res) => {
  try {
    const { query } = req.body || {};
    if (!query) return res.status(400).json({ error: 'Thiếu từ cần tra' });

    const prompt = `Bạn là từ điển tiếng Trung dành cho người Việt.

Giải thích chi tiết từ/cụm từ: "${query}"

⚠️ QUY TẮC: Toàn bộ nội dung PHẢI bằng TIẾNG VIỆT. TUYỆT ĐỐI KHÔNG dùng tiếng Anh. Chỉ giữ chữ Hán và pinyin khi cần.

Bao gồm:
- Chữ Hán & phiên âm pinyin (có dấu thanh điệu)
- Nghĩa tiếng Việt
- Phân tích bộ thủ & cách ghi nhớ
- Câu ví dụ (chữ Hán + pinyin + nghĩa tiếng Việt)
- Lưu ý khi sử dụng

Trả lời bằng TIẾNG VIỆT, định dạng Markdown rõ ràng.`;

    const text = await callGeminiWithRetry(prompt, 'text/plain');
    res.json({ result: sanitizeText(text) });
  } catch (error) {
    console.error('Lỗi /api/ai/dictionary:', error);
    res.status(500).json({ error: 'Không thể tra từ. Vui lòng thử lại.' });
  }
});

// ============================================================
//                 API: GRAMMAR CHECK (tiếng Việt)
// ============================================================
app.post('/api/ai/grammar-check', async (req, res) => {
  try {
    const { sentence } = req.body || {};
    if (!sentence) return res.status(400).json({ error: 'Thiếu câu cần kiểm tra' });

    const prompt = `Bạn là chuyên gia ngữ pháp tiếng Trung dạy cho người Việt.

Kiểm tra câu: "${sentence}"

⚠️ QUY TẮC: Toàn bộ giải thích PHẢI bằng TIẾNG VIỆT. TUYỆT ĐỐI KHÔNG dùng tiếng Anh.

Trả lời theo cấu trúc:
- Câu gốc
- Câu đã sửa (chữ Hán + pinyin)
- Giải thích bằng tiếng Việt
- Mẹo ghi nhớ

Trả lời bằng TIẾNG VIỆT.`;

    const text = await callGeminiWithRetry(prompt, 'text/plain');
    res.json({ result: sanitizeText(text) });
  } catch (error) {
    console.error('Lỗi /api/ai/grammar-check:', error);
    res.status(500).json({ error: 'Không thể kiểm tra. Vui lòng thử lại.' });
  }
});

// ============================================================
//                 API: ROLEPLAY (tiếng Việt)
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

Tin nhắn của người học: "${message}"

⚠️ QUY TẮC:
- Câu trả lời tiếng Trung thì giữ nguyên chữ Hán + pinyin.
- Phần gợi ý/dịch nghĩa PHẢI bằng TIẾNG VIỆT.
- TUYỆT ĐỐI KHÔNG dùng tiếng Anh.

Trả lời theo cấu trúc:
- Trả lời (tiếng Trung)
- Phiên âm (pinyin)
- Gợi ý tiếng Việt

Giữ hội thoại tự nhiên, hữu ích.`;

    const text = await callGeminiWithRetry(prompt, 'text/plain');
    res.json({ result: sanitizeText(text) });
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
