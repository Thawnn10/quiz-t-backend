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
//         MAP TIẾNG ANH → TIẾNG VIỆT (nghĩa từ vựng)
// ============================================================
const EN_MEANING_MAP = {
  'hello': 'xin chào',
  'hi': 'xin chào',
  'goodbye': 'tạm biệt',
  'bye': 'tạm biệt',
  'thank you': 'cảm ơn',
  'thanks': 'cảm ơn',
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
  'read': 'đọc',
  'write': 'viết',
  'eat': 'ăn',
  'drink': 'uống',
  'go': 'đi',
  'come': 'đến',
  'today': 'hôm nay',
  'tomorrow': 'ngày mai',
  'yesterday': 'hôm qua',
  'morning': 'buổi sáng',
  'afternoon': 'buổi chiều',
  'evening': 'buổi tối',
  'night': 'ban đêm',
  'big': 'to lớn',
  'small': 'nhỏ',
  'good': 'tốt',
  'bad': 'xấu',
  'beautiful': 'đẹp',
  'ugly': 'xấu xí',
  'fast': 'nhanh',
  'slow': 'chậm',
  'one': 'một',
  'two': 'hai',
  'three': 'ba',
  'four': 'bốn',
  'five': 'năm',
  'six': 'sáu',
  'seven': 'bảy',
  'eight': 'tám',
  'nine': 'chín',
  'ten': 'mười',
  'how are you': 'bạn khỏe không',
  'i love you': 'anh yêu em',
  'the meaning of': 'nghĩa của',
  'what is': 'là gì',
  'which': 'nào',
  'choose': 'chọn',
  'the correct': 'đúng',
  'translation': 'bản dịch',
  'word': 'từ',
  'sentence': 'câu',
  'example': 'ví dụ',
};

// ============================================================
//         LANGUAGE HELPERS
// ============================================================
const VI_DIACRITIC_RE =
  /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i;

function hasVietnameseDiacritic(s) {
  return typeof s === 'string' && VI_DIACRITIC_RE.test(s);
}

function hasChinese(s) {
  return typeof s === 'string' && /[\u4e00-\u9fff]/.test(s);
}

function looksLikeEnglish(text) {
  if (!text || typeof text !== 'string') return false;
  const s = text.trim();
  if (!s) return false;

  if (hasChinese(s)) return false;         // có Hán tự → coi như OK
  if (hasVietnameseDiacritic(s)) return false; // có dấu tiếng Việt → OK

  const words = s.split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;

  const lower = s.toLowerCase();
  const enBlacklist = [
    'the', 'is', 'are', 'of', 'to', 'and', 'what', 'which',
    'choose', 'select', 'meaning', 'word', 'sentence', 'translate',
    'hello', 'hi', 'thank', 'sorry', 'goodbye', 'yes', 'no',
  ];
  const matchCount = enBlacklist.filter(w =>
    new RegExp(`\\b${w}\\b`, 'i').test(lower)
  ).length;
  if (matchCount >= 1) return true;

  // Toàn bộ từ đều Latin không dấu và không phải số → nghi tiếng Anh
  if (words.every(w => /^[a-zA-Z'-]+$/.test(w)) && /[a-zA-Z]/.test(s)) return true;
  return false;
}

/** Map các từ tiếng Anh quen thuộc trong câu sang tiếng Việt (lưới an toàn). */
function sanitizeText(text) {
  if (!text || typeof text !== 'string') return text || '';
  let out = text;
  for (const [en, vi] of Object.entries(EN_MEANING_MAP)) {
    const re = new RegExp(`\\b${en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    out = out.replace(re, vi);
  }
  return out;
}

function isCleanQuestion(q) {
  if (!q || typeof q !== 'object') return false;
  const texts = [q.question, q.answer, q.explanation, ...(q.options || [])];
  return texts.every(t => !looksLikeEnglish(t));
}

// ============================================================
//   DỊCH NGHĨA TIẾNG ANH → TIẾNG VIỆT (cho input từ vựng)
// ============================================================
async function translateMeaningToVietnamese(text) {
  if (!text || typeof text !== 'string') return text;
  const trimmed = text.trim();
  if (!trimmed) return trimmed;

  // Đã có dấu tiếng Việt → giữ nguyên
  if (hasVietnameseDiacritic(trimmed)) return trimmed;

  // Có Hán tự → giữ nguyên (không dịch)
  if (hasChinese(trimmed)) return trimmed;

  // Map local trước
  const key = trimmed.toLowerCase().replace(/\s+/g, ' ').trim();
  if (EN_MEANING_MAP[key]) return EN_MEANING_MAP[key];

  // Không phải chuỗi chữ Latin (số, ký tự) → giữ nguyên
  if (!/[a-zA-Z]/.test(trimmed)) return trimmed;

  // Còn lại → nhờ Gemini dịch
  try {
    const translated = await callGeminiWithRetry(
      `Dịch nghĩa sau sang TIẾNG VIỆT. CHỈ trả về duy nhất bản dịch tiếng Việt ngắn gọn, không thêm giải thích, không xuống dòng.\n\nTừ: "${trimmed}"`,
      'text/plain'
    );
    const cleaned = String(translated)
      .replace(/^["'`\s]+|["'`\s]+$/g, '')
      .split('\n')[0]
      .trim();
    return cleaned || trimmed;
  } catch (e) {
    console.warn('[translateMeaning] lỗi:', e?.message);
    return trimmed;
  }
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
      console.warn(`[Gemini] Retry ${i + 1}/${retries} sau ${delayMs}ms — ${msg}`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

// ============================================================
//      LOCAL QUIZ GENERATOR — 100% TIẾNG VIỆT, KHÓ → DỄ
// ============================================================
const DISTRACTOR_POOL = [
  // Chào hỏi / lịch sự
  'xin chào', 'cảm ơn', 'tạm biệt', 'xin lỗi', 'không có gì', 'làm ơn',
  // Đồ ăn / đồ uống
  'nước', 'cơm', 'trà', 'cà phê', 'bánh mì', 'mì', 'trái cây', 'thịt',
  // Con người / quan hệ
  'bạn bè', 'giáo viên', 'học sinh', 'trường học', 'gia đình',
  'mẹ', 'bố', 'anh trai', 'chị gái', 'em trai', 'em gái', 'ông', 'bà',
  // Thời gian
  'hôm nay', 'ngày mai', 'hôm qua', 'buổi sáng', 'buổi chiều', 'buổi tối', 'ban đêm',
  // Hành động
  'đọc sách', 'viết chữ', 'nghe nhạc', 'xem phim', 'nói chuyện',
  'đi học', 'đi làm', 'ăn cơm', 'uống nước', 'ngủ', 'chạy', 'đi bộ',
  // Tính từ
  'to lớn', 'nhỏ', 'đẹp', 'xấu', 'nhanh', 'chậm', 'cao', 'thấp', 'vui', 'buồn',
  // Số đếm
  'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín', 'mười',
];

/**
 * Templates từ KHÓ → DỄ.
 * difficulty 5 = khó nhất (ít gợi ý), 1 = dễ nhất (nhiều gợi ý).
 */
function buildTemplates(hanzi, pinyin) {
  return [
    { text: `Nghĩa của Hán tự "${hanzi}" là gì?`,                        difficulty: 5 },
    { text: `"${hanzi}" có nghĩa là gì?`,                                 difficulty: 5 },
    { text: `Chọn nghĩa đúng của "${hanzi}".`,                             difficulty: 4 },
    { text: `Hán tự "${hanzi}" tương ứng với nghĩa nào?`,                  difficulty: 4 },
    { text: `Từ "${hanzi}" (${pinyin}) có nghĩa là gì?`,                   difficulty: 3 },
    { text: `Phiên âm "${pinyin}" tương ứng với nghĩa nào?`,               difficulty: 3 },
    { text: `Chọn đáp án đúng cho "${hanzi}" (${pinyin}).`,                 difficulty: 2 },
    { text: `Từ "${hanzi}" đọc là "${pinyin}", nghĩa là gì?`,              difficulty: 2 },
    { text: `Hãy chọn nghĩa phù hợp với "${hanzi}" — "${pinyin}".`,         difficulty: 1 },
    { text: `Đâu là nghĩa đúng của "${hanzi}" (${pinyin})?`,               difficulty: 1 },
  ];
}

function generateLocalQuiz(word, count = 5) {
  const hanzi = word?.hanzi || '?';
  const pinyin = word?.pinyin || '?';
  const meaning = (word?.translations?.[0]) || pinyin;

  const templates = buildTemplates(hanzi, pinyin);

  const questions = [];
  for (let i = 0; i < count; i++) {
    const tmpl = templates[Math.min(i, templates.length - 1)];

    const picked = DISTRACTOR_POOL
      .filter(d => d !== meaning)
      .sort(() => Math.random() - 0.5)
      .slice(0, 3);

    const options = [meaning, ...picked]
      .filter((v, idx, arr) => arr.indexOf(v) === idx)
      .sort(() => Math.random() - 0.5);

    questions.push({
      question: tmpl.text,
      options,
      answer: meaning,
      explanation: `"${hanzi}" (${pinyin}) có nghĩa là: ${meaning}.`,
      difficulty: tmpl.difficulty,
    });
  }

  // Sắp xếp KHÓ → DỄ
  questions.sort((a, b) => b.difficulty - a.difficulty);
  return questions;
}

// ============================================================
//                 API: VOCAB QUIZ
// ============================================================
app.post('/api/ai/vocab-quiz', async (req, res) => {
  const t0 = Date.now();
  try {
    const { word, count = 5 } = req.body || {};

    // ---------- Validate input + dịch nghĩa EN → VI ----------
    const hanzi = (typeof word?.hanzi === 'string' && word.hanzi.trim()) || '?';
    const pinyin = (typeof word?.pinyin === 'string' && word.pinyin.trim()) || '?';

    let rawTranslations = Array.isArray(word?.translations) ? word.translations : [];
    if (rawTranslations.length === 0) rawTranslations = [pinyin];

    // Dịch từng nghĩa nếu còn tiếng Anh
    let translations = await Promise.all(
      rawTranslations.map(t => translateMeaningToVietnamese(String(t || '')))
    );
    translations = translations
      .map(t => t.trim())
      .filter(Boolean);
    // Dedup
    translations = [...new Set(translations)];
    if (translations.length === 0) translations = [pinyin];

    const n = Math.max(1, Math.min(10, Number(count) || 5));
    const cleanedWord = { hanzi, pinyin, translations };

    // ---------- Prompt cho Gemini (đã có nghĩa tiếng Việt) ----------
    const prompt = `Bạn là giáo viên tiếng Trung soạn bài tập trắc nghiệm cho học sinh người Việt.

Từ vựng cần ôn:
- Hán tự: ${hanzi}
- Pinyin: ${pinyin}
- Nghĩa tiếng Việt (đã chuẩn hoá): ${translations.join(' / ')}

⚠️ QUY TẮC NGÔN NGỮ (BẮT BUỘC):
- TOÀN BỘ "question", "options", "answer", "explanation" PHẢI viết bằng TIẾNG VIỆT.
- TUYỆT ĐỐI KHÔNG dùng tiếng Anh (không "hello", "thank you", "what is", "choose", "meaning"...).
- Chỉ được giữ nguyên Hán tự và pinyin trong câu hỏi khi cần.
- "answer" BẮT BUỘC là 1 phần tử trong "options" và BẮT BUỘC là 1 trong các nghĩa tiếng Việt ở trên.
- Ví dụ SAI: options = ["hello", "thank you", "goodbye", "sorry"]
- Ví dụ ĐÚNG: options = ["xin chào", "cảm ơn", "tạm biệt", "xin lỗi"]

⚠️ ĐỘ KHÓ (SẮP XẾP TỪ KHÓ → DỄ):
- Câu 1..${n}: sắp xếp GIẢM DẦN độ khó.
- Câu KHÓ NHẤT: chỉ cho Hán tự "${hanzi}", KHÔNG gợi ý pinyin.
- Câu khó: Hán tự + pinyin.
- Câu trung bình: Hán tự + pinyin + ngữ cảnh.
- Câu dễ: cho nhiều gợi ý (Hán tự + pinyin + mô tả chủ đề).

Hãy tạo ĐÚNG ${n} câu hỏi. Mỗi câu gồm:
- "question": câu hỏi TIẾNG VIỆT (có thể chèn Hán tự + pinyin)
- "options": MẢNG 4 lựa chọn — TẤT CẢ bằng TIẾNG VIỆT
- "answer": lựa chọn ĐÚNG — TIẾNG VIỆT, phải nằm trong "options"
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

    // ---------- Gọi Gemini (không throw ra ngoài) ----------
    let quizArray = null;
    try {
      const text = await callGeminiWithRetry(prompt, 'application/json', responseSchema);
      quizArray = extractJson(text);
    } catch (aiErr) {
      console.warn('[vocab-quiz] Gemini lỗi:', aiErr?.message);
    }

    // ---------- Validate + sanitize + dedupe ----------
    let finalQuiz = [];
    if (Array.isArray(quizArray)) {
      finalQuiz = quizArray
        .map((q, idx) => {
          if (!q || typeof q !== 'object') return null;

          // sanitize answer + options CÙNG NHAU để giữ tính nhất quán
          const rawOptions = Array.isArray(q.options) ? q.options : [];
          const sanitizedOptions = rawOptions
            .map(sanitizeText)
            .map(s => String(s).trim())
            .filter(Boolean);
          // dedupe options
          const uniqueOptions = [...new Set(sanitizedOptions)];

          const cleanQ = {
            question: sanitizeText(String(q.question || '')).trim(),
            options: uniqueOptions,
            answer: sanitizeText(String(q.answer || '')).trim(),
            explanation: sanitizeText(String(q.explanation || '')).trim(),
            difficulty: Math.max(1, 5 - Math.floor(idx / 2)), // ước lượng giảm dần
          };

          // Validate cấu trúc
          if (
            !cleanQ.question ||
            cleanQ.options.length < 2 ||
            !cleanQ.answer ||
            !cleanQ.options.includes(cleanQ.answer)
          ) {
            console.warn('[vocab-quiz] Bỏ câu sai cấu trúc:', cleanQ.question);
            return null;
          }

          // Loại nếu còn dính tiếng Anh
          if (!isCleanQuestion(cleanQ)) {
            console.warn('[vocab-quiz] Bỏ câu còn tiếng Anh:', cleanQ.question);
            return null;
          }
          return cleanQ;
        })
        .filter(Boolean);

      // Ưu tiên câu có answer là nghĩa tiếng Việt chính
      const preferred = new Set(translations);
      finalQuiz.sort((a, b) => {
        const aPref = preferred.has(a.answer) ? 0 : 1;
        const bPref = preferred.has(b.answer) ? 0 : 1;
        if (aPref !== bPref) return aPref - bPref;
        return (b.difficulty || 0) - (a.difficulty || 0);
      });

      finalQuiz = finalQuiz.slice(0, n);
    }

    // Fallback local nếu thiếu câu
    let usedFallback = false;
    if (finalQuiz.length < n) {
      const need = n - finalQuiz.length;
      const local = generateLocalQuiz(cleanedWord, need);
      // Gán difficulty thấp hơn để nằm cuối (dễ hơn)
      local.forEach((q, i) => { q.difficulty = Math.max(1, (q.difficulty || 1) - 1); });
      finalQuiz = [...finalQuiz, ...local];
      usedFallback = true;
    }

    // Đảm bảo sắp xếp cuối cùng KHÓ → DỄ
    finalQuiz.sort((a, b) => (b.difficulty || 0) - (a.difficulty || 0));

    console.log(
      `[vocab-quiz] OK ${finalQuiz.length}/${n} câu (${Date.now() - t0}ms)` +
      (usedFallback ? ' [có fallback]' : '')
    );

    res.json({
      result: finalQuiz,
      fallback: usedFallback,
      translations, // trả về nghĩa đã chuẩn hoá tiếng Việt cho client
    });
  } catch (error) {
    console.error('❌ Lỗi không mong đợi /api/ai/vocab-quiz:', error);
    try {
      const w = req.body?.word || {};
      const emergency = generateLocalQuiz(
        {
          hanzi: w.hanzi || '?',
          pinyin: w.pinyin || '?',
          translations: Array.isArray(w.translations) && w.translations.length
            ? w.translations
            : ['?'],
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
