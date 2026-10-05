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
  'roots or stems of plants': 'rễ hoặc thân cây',
  'root': 'rễ',
  'stem': 'thân',
  'plant': 'cây',
  'tree': 'cây',
  'flower': 'hoa',
  'grass': 'cỏ',
  'leaf': 'lá',
  'seed': 'hạt',
  'fruit': 'trái cây',
  'vegetable': 'rau',
};

// ============================================================
//         LANGUAGE HELPERS
// ============================================================
const VI_DIACRITIC_RE =
  /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i;
const VI_SPECIFIC_DIACRITIC_RE = /[ăâđêôơư]/i;
const PINYIN_TONE_RE = /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/i;

// Từ ngoại lai phổ biến đã Việt hoá — không coi là tiếng Anh
const COMMON_LOANWORDS = new Set([
  'taxi', 'video', 'hotel', 'radio', 'internet', 'email',
  'zoo', 'cafe', 'bikini', 'sushi', 'pizza', 'burger',
]);

function hasVietnameseDiacritic(s) {
  return typeof s === 'string' && VI_DIACRITIC_RE.test(s);
}
function hasVietnameseOnlyDiacritic(s) {
  return typeof s === 'string' && VI_SPECIFIC_DIACRITIC_RE.test(s);
}
function hasPinyinTone(s) {
  return typeof s === 'string' && PINYIN_TONE_RE.test(s);
}
function hasChinese(s) {
  return typeof s === 'string' && /[\u4e00-\u9fff]/.test(s);
}

function looksLikeEnglish(text) {
  if (!text || typeof text !== 'string') return false;
  const s = text.trim();
  if (!s) return false;

  if (hasChinese(s)) return false;
  if (hasVietnameseDiacritic(s)) return false;

  const lower = s.toLowerCase();
  if (COMMON_LOANWORDS.has(lower)) return false;

  const words = s.split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;

  const enBlacklist = [
    'the', 'is', 'are', 'of', 'to', 'and', 'what', 'which',
    'choose', 'select', 'meaning', 'word', 'sentence', 'translate',
    'hello', 'hi', 'thank', 'sorry', 'goodbye', 'yes', 'no',
    'roots', 'stems', 'plants', 'root', 'stem', 'plant',
  ];
  const matchCount = enBlacklist.filter(w =>
    new RegExp(`\\b${w}\\b`, 'i').test(lower)
  ).length;
  if (matchCount >= 1) return true;

  if (words.every(w => /^[a-zA-Z'-]+$/.test(w)) && /[a-zA-Z]/.test(s)) return true;
  return false;
}

function sanitizeText(text) {
  if (!text || typeof text !== 'string') return text || '';
  let out = text;
  for (const [en, vi] of Object.entries(EN_MEANING_MAP)) {
    const re = new RegExp(`\\b${en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    out = out.replace(re, vi);
  }
  return out;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ============================================================
//    KIỂM TRA NGÔN NGỮ OPTIONS (đáp án phải cùng 1 ngôn ngữ)
// ============================================================
function isPinyinLike(s) {
  if (!s || typeof s !== 'string') return false;
  const t = s.trim();
  if (!t) return false;
  if (hasChinese(t)) return false;
  if (hasVietnameseOnlyDiacritic(t)) return false;
  return /^[a-zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜü\s'\-]+$/i.test(t);
}

function validateOptionLanguage(q, translations = []) {
  const type = q.type || 'meaning';
  const opts = (q.options || []).map(o => String(o).trim()).filter(Boolean);
  if (opts.length < 2) return false;

  // ---- Hán tự ----
  if (type === 'hanzi' || type === 'fill_hanzi') {
    return opts.every(hasChinese);
  }

  // ---- Pinyin ----
  if (type === 'pinyin') {
    return opts.every(o => isPinyinLike(o));
  }

  // ---- Nghĩa tiếng Việt ----
  if (type === 'meaning' || type === 'fill_meaning') {
    return opts.every(o => {
      if (hasChinese(o)) return false;
      // Kiểm tra tiếng Anh TRƯỚC khi so với translations
      if (looksLikeEnglish(o)) return false;
      // Có dấu tiếng Việt → OK
      if (hasVietnameseDiacritic(o)) return true;
      // Không dấu nhưng không giống tiếng Anh (VD: taxi) → OK
      return true;
    });
  }

  // ---- fill_blank: hoặc toàn Hán, hoặc toàn Việt ----
  if (type === 'fill_blank') {
    const allZh = opts.every(hasChinese);
    const allVi = opts.every(o =>
      !hasChinese(o) && !looksLikeEnglish(o)
    );
    return allZh || allVi;
  }

  return false;
}

function isCleanQuestion(q, translations = []) {
  if (!q || typeof q !== 'object') return false;
  const texts = [q.question, q.answer, q.explanation, ...(q.options || [])];
  if (!texts.every(t => !looksLikeEnglish(t))) return false;
  return validateOptionLanguage(q, translations);
}

// ============================================================
//   DỊCH NGHĨA TIẾNG ANH → TIẾNG VIỆT (cho input từ vựng)
// ============================================================
async function translateMeaningToVietnamese(text) {
  if (!text || typeof text !== 'string') return text;
  const trimmed = text.trim();
  if (!trimmed) return trimmed;

  if (hasVietnameseDiacritic(trimmed)) return trimmed;
  if (hasChinese(trimmed)) return trimmed;

  const key = trimmed.toLowerCase().replace(/\s+/g, ' ').trim();
  if (EN_MEANING_MAP[key]) return EN_MEANING_MAP[key];
  if (!/[a-zA-Z]/.test(trimmed)) return trimmed;

  // Nếu là từ ngoại lai phổ biến → giữ nguyên
  if (COMMON_LOANWORDS.has(key)) return trimmed;

  try {
    let translated = await callGeminiWithRetry(
      `Dịch nghĩa sau sang TIẾNG VIỆT. CHỈ trả về duy nhất bản dịch tiếng Việt ngắn gọn, không thêm giải thích, không xuống dòng.\n\nTừ: "${trimmed}"`,
      'text/plain'
    );
    let cleaned = String(translated)
      .replace(/^["'`\s]+|["'`\s]+$/g, '')
      .split('\n')[0]
      .trim();

    // Nếu Gemini vẫn trả về tiếng Anh → thử lại lần 2
    if (looksLikeEnglish(cleaned)) {
      console.warn(`[translateMeaning] Lần 1 còn tiếng Anh: "${cleaned}". Thử lại...`);
      const retry = await callGeminiWithRetry(
        `Bạn là từ điển Anh-Việt. Dịch cụm từ tiếng Anh sau sang tiếng Việt (chỉ 1 dòng, không giải thích):\n"${trimmed}"`,
        'text/plain'
      );
      cleaned = String(retry)
        .replace(/^["'`\s]+|["'`\s]+$/g, '')
        .split('\n')[0]
        .trim();
    }

    // Vẫn là tiếng Anh → trả về rỗng để dùng fallback
    if (looksLikeEnglish(cleaned)) {
      console.warn(`[translateMeaning] Thất bại hoàn toàn với "${trimmed}" → trả rỗng.`);
      return '';
    }

    return cleaned || trimmed;
  } catch (e) {
    console.warn('[translateMeaning] lỗi:', e?.message);
    return '';
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
//      LOCAL QUIZ GENERATOR — 100% TIẾNG VIỆT, DỄ → KHÓ
// ============================================================
const DISTRACTOR_MEANINGS = [
  'xin chào', 'cảm ơn', 'tạm biệt', 'xin lỗi', 'không có gì', 'làm ơn',
  'nước', 'cơm', 'trà', 'cà phê', 'bánh mì', 'mì', 'trái cây', 'thịt',
  'bạn bè', 'giáo viên', 'học sinh', 'trường học', 'gia đình',
  'mẹ', 'bố', 'anh trai', 'chị gái', 'em trai', 'em gái', 'ông', 'bà',
  'hôm nay', 'ngày mai', 'hôm qua', 'buổi sáng', 'buổi chiều', 'buổi tối', 'ban đêm',
  'đọc sách', 'viết chữ', 'nghe nhạc', 'xem phim', 'nói chuyện',
  'đi học', 'đi làm', 'ăn cơm', 'uống nước', 'ngủ', 'chạy', 'đi bộ',
  'to lớn', 'nhỏ', 'đẹp', 'xấu', 'nhanh', 'chậm', 'cao', 'thấp', 'vui', 'buồn',
  'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín', 'mười',
  'cây', 'hoa', 'lá', 'rễ', 'thân cây', 'hạt', 'quả', 'rau', 'cỏ',
];

const PINYIN_DISTRACTOR_POOL = [
  'mā', 'má', 'mǎ', 'mà',
  'bā', 'bá', 'bǎ', 'bà',
  'hǎo', 'hào', 'háo', 'hāo',
  'shì', 'shí', 'shǐ', 'shī',
  'zhōng', 'zhòng', 'chōng', 'chóng',
  'guó', 'guò', 'guǒ', 'guō',
  'rén', 'rèn', 'rěn', 'rēn',
  'dà', 'dá', 'dǎ', 'dā',
  'xiǎo', 'xiào', 'xiáo', 'xiāo',
  'shuǐ', 'shuì', 'shuí', 'shuī',
  'huǒ', 'huò', 'huō', 'huó',
  'shān', 'shàn', 'shǎn', 'shán',
  'tiān', 'tián', 'tiǎn', 'tiàn',
  'dì', 'dí', 'dǐ', 'dī',
  'nǐ', 'ní', 'nì', 'nī',
  'wǒ', 'wó', 'wò', 'wō',
  'tā', 'tá', 'tǎ', 'tà',
  'men', 'mén', 'měn', 'mèn',
  'xué', 'xuě', 'xuè', 'xuē',
  'shēng', 'shéng', 'shěng', 'shèng',
  'běn', 'bēn', 'bèn', 'bén',
];

const HANZI_DISTRACTOR_POOL = [
  '你', '我', '他', '她', '们', '好', '是', '的', '了', '在',
  '中', '国', '人', '大', '小', '水', '火', '山', '天', '地',
  '日', '月', '年', '时', '学', '生', '老', '师', '朋', '友',
  '家', '父', '母', '兄', '弟', '姐', '妹', '吃', '喝', '看',
  '听', '说', '读', '写', '走', '来', '去', '回', '买', '卖',
  '红', '黄', '蓝', '绿', '白', '黑', '长', '短', '高', '低',
];

function pickMeaningOptions(correct, allTranslations, n = 4) {
  const used = new Set([correct, ...(allTranslations || [])]);
  const pool = shuffle(DISTRACTOR_MEANINGS.filter(d => !used.has(d) && !looksLikeEnglish(d)));
  const picked = pool.slice(0, n - 1);
  return shuffle([correct, ...picked]);
}

function pickPinyinOptions(correct, n = 4) {
  const pool = shuffle(PINYIN_DISTRACTOR_POOL.filter(p => p !== correct));
  const picked = [];
  for (const p of pool) {
    if (picked.length >= n - 1) break;
    if (!picked.includes(p)) picked.push(p);
  }
  return shuffle([correct, ...picked]);
}

function pickHanziOptions(correct, n = 4) {
  const pool = shuffle(HANZI_DISTRACTOR_POOL.filter(h => h !== correct));
  const picked = [];
  for (const p of pool) {
    if (picked.length >= n - 1) break;
    if (!picked.includes(p)) picked.push(p);
  }
  return shuffle([correct, ...picked]);
}

/**
 * Templates đa dạng loại câu, sắp xếp DỄ → KHÓ.
 * difficulty 1 = dễ nhất, 5 = khó nhất.
 */
function buildLocalTemplates(word) {
  const hanzi = word?.hanzi || '?';
  const pinyin = word?.pinyin || '?';
  const translations = Array.isArray(word?.translations) && word.translations.length
    ? word.translations
    : [pinyin];
  const meaning = translations[0];

  const templates = [];

  // ---------- DỄ (1-2) ----------
  templates.push({
    type: 'meaning',
    difficulty: 1,
    question: `Hãy chọn nghĩa phù hợp với Hán tự "${hanzi}" (đọc là "${pinyin}").`,
    options: pickMeaningOptions(meaning, translations, 4),
    answer: meaning,
    explanation: `"${hanzi}" đọc là "${pinyin}", nghĩa là: ${meaning}.`,
  });
  templates.push({
    type: 'hanzi',
    difficulty: 2,
    question: `Từ tiếng Việt "${meaning}" (đọc là "${pinyin}") tương ứng với Hán tự nào?`,
    options: pickHanziOptions(hanzi, 4),
    answer: hanzi,
    explanation: `"${meaning}" đọc là "${pinyin}", viết là "${hanzi}".`,
  });
  templates.push({
    type: 'pinyin',
    difficulty: 2,
    question: `Hán tự "${hanzi}" (nghĩa: ${meaning}) có phiên âm (pinyin) nào?`,
    options: pickPinyinOptions(pinyin, 4),
    answer: pinyin,
    explanation: `"${hanzi}" đọc là "${pinyin}", nghĩa là: ${meaning}.`,
  });

  // ---------- TRUNG BÌNH (3) ----------
  templates.push({
    type: 'fill_meaning',
    difficulty: 3,
    question: `Điền vào chỗ trống: Hán tự "${hanzi}" (${pinyin}) có nghĩa là ___.`,
    options: pickMeaningOptions(meaning, translations, 4),
    answer: meaning,
    explanation: `"${hanzi}" (${pinyin}) nghĩa là: ${meaning}.`,
  });
  templates.push({
    type: 'meaning',
    difficulty: 3,
    question: `Từ "${hanzi}" (${pinyin}) có nghĩa là gì?`,
    options: pickMeaningOptions(meaning, translations, 4),
    answer: meaning,
    explanation: `"${hanzi}" (${pinyin}) nghĩa là: ${meaning}.`,
  });
  templates.push({
    type: 'fill_hanzi',
    difficulty: 3,
    question: `Điền Hán tự thích hợp vào chỗ trống: "___" (đọc là "${pinyin}") có nghĩa là "${meaning}".`,
    options: pickHanziOptions(hanzi, 4),
    answer: hanzi,
    explanation: `Hán tự "${hanzi}" đọc là "${pinyin}", nghĩa là: ${meaning}.`,
  });

  // ---------- KHÓ (4-5) ----------
  templates.push({
    type: 'pinyin',
    difficulty: 4,
    question: `Hán tự "${hanzi}" có pinyin là gì?`,
    options: pickPinyinOptions(pinyin, 4),
    answer: pinyin,
    explanation: `"${hanzi}" đọc là "${pinyin}", nghĩa là: ${meaning}.`,
  });
  templates.push({
    type: 'hanzi',
    difficulty: 4,
    question: `Hán tự nào có nghĩa là "${meaning}"?`,
    options: pickHanziOptions(hanzi, 4),
    answer: hanzi,
    explanation: `"${meaning}" viết là "${hanzi}" (${pinyin}).`,
  });
  templates.push({
    type: 'meaning',
    difficulty: 5,
    question: `Nghĩa của Hán tự "${hanzi}" là gì?`,
    options: pickMeaningOptions(meaning, translations, 4),
    answer: meaning,
    explanation: `"${hanzi}" (${pinyin}) nghĩa là: ${meaning}.`,
  });

  return templates;
}

function generateLocalQuiz(word, count = 5) {
  const templates = buildLocalTemplates(word);

  // Nhóm theo type để round-robin đảm bảo đa dạng
  const byType = {};
  for (const t of templates) {
    (byType[t.type] = byType[t.type] || []).push(t);
  }
  for (const k of Object.keys(byType)) {
    byType[k] = shuffle(byType[k]);
  }

  const types = Object.keys(byType);
  const picked = [];
  const selected = new Set();
  let i = 0;
  while (picked.length < count && types.some(t => byType[t].length > 0)) {
    const type = types[i % types.length];
    if (byType[type].length > 0) {
      const item = byType[type].shift();
      picked.push(item);
      selected.add(item);
    }
    i++;
  }
  // Bù thêm nếu còn thiếu
  for (const t of shuffle(templates)) {
    if (picked.length >= count) break;
    if (!selected.has(t)) {
      picked.push(t);
      selected.add(t);
    }
  }

  // Sắp xếp DỄ → KHÓ
  picked.sort((a, b) => a.difficulty - b.difficulty);
  return picked.slice(0, count);
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
    let translated = await Promise.all(
      rawTranslations.map(t => translateMeaningToVietnamese(String(t || '')))
    );
    translated = translated
      .map(t => String(t).trim())
      .filter(Boolean);

    // Lọc bỏ hoàn toàn tiếng Anh còn sót
    translated = translated.filter(t => !looksLikeEnglish(t));

    // Dedup
    translated = [...new Set(translated)];

    // Nếu rỗng hết → dùng pinyin làm nghĩa tạm (không lý tưởng nhưng an toàn)
    if (translated.length === 0) {
      console.warn('[vocab-quiz] Không dịch được nghĩa nào → dùng pinyin tạm.');
      translated = [pinyin];
    }

    const n = Math.max(1, Math.min(10, Number(count) || 5));
    const cleanedWord = { hanzi, pinyin, translations: translated };

    // ---------- Prompt cho Gemini ----------
    const prompt = `Bạn là giáo viên tiếng Trung soạn bài tập trắc nghiệm cho học sinh người Việt.

Từ vựng cần ôn:
- Hán tự: ${hanzi}
- Pinyin: ${pinyin}
- Nghĩa tiếng Việt (đã chuẩn hoá): ${translated.join(' / ')}

⚠️ QUY TẮC NGÔN NGỮ (BẮT BUỘC):
- "question" và "explanation" PHẢI viết bằng TIẾNG VIỆT.
- TUYỆT ĐỐI KHÔNG dùng tiếng Anh (không "hello", "thank you", "what is", "choose", "meaning", "the", "which", "roots", "stems"...).
- Chỉ được giữ nguyên Hán tự và pinyin trong câu hỏi khi cần.

⚠️ ĐÁP ÁN TRONG CÙNG 1 CÂU HỎI PHẢI CÙNG 1 LOẠI NGÔN NGỮ (BẮT BUỘC):
- Câu loại "meaning" / "fill_meaning" (hỏi nghĩa)  → TẤT CẢ "options" là TIẾNG VIỆT.
- Câu loại "pinyin"                                 → TẤT CẢ "options" là PINYIN.
- Câu loại "hanzi" / "fill_hanzi" (chọn Hán tự)     → TẤT CẢ "options" là HÁN TỰ.
- Câu loại "fill_blank" (điền khuyết)               → TẤT CẢ "options" cùng là Hán tự HOẶC cùng là tiếng Việt.
- "answer" BẮT BUỘC nằm trong "options".
- Với loại "meaning", "answer" BẮT BUỘC là 1 trong các nghĩa: ${translated.join(' / ')}.
- Ví dụ SAI: options = ["roots or stems of plants", "cảm ơn", "nước", "làm ơn"]
- Ví dụ ĐÚNG (meaning): options = ["rễ hoặc thân cây", "cảm ơn", "nước", "làm ơn"]
- Ví dụ ĐÚNG (pinyin):  options = ["nǐ hǎo", "xiè xie", "zài jiàn", "duì bu qǐ"]
- Ví dụ ĐÚNG (hanzi):   options = ["你好", "谢谢", "再见", "对不起"]

⚠️ ĐA DẠNG LOẠI CÂU HỎI (BẮT BUỘC):
Trong ${n} câu phải có ĐỦ các loại sau (nếu đủ số lượng):
- "meaning"     — hỏi nghĩa tiếng Việt của Hán tự.
- "pinyin"      — hỏi phiên âm pinyin của Hán tự.
- "hanzi"       — cho nghĩa tiếng Việt, chọn Hán tự đúng.
- "fill_blank"  — câu điền khuyết (chỗ trống là Hán tự hoặc nghĩa, tuỳ ngữ cảnh).

⚠️ ĐỘ KHÓ (SẮP XẾP TĂNG DẦN: DỄ → KHÓ):
- Câu 1 (DỄ NHẤT): cho đầy đủ Hán tự + pinyin + gợi ý nghĩa.
- Các câu giữa (TRUNG BÌNH): cho Hán tự + pinyin.
- Câu cuối (KHÓ NHẤT): chỉ cho Hán tự, KHÔNG pinyin, KHÔNG gợi ý.

Hãy tạo ĐÚNG ${n} câu hỏi, sắp xếp từ DỄ đến KHÓ. Mỗi câu gồm:
- "type": một trong "meaning" | "pinyin" | "hanzi" | "fill_blank"
- "question": câu hỏi TIẾNG VIỆT (có thể chèn Hán tự + pinyin)
- "options": MẢNG 4 lựa chọn — TẤT CẢ cùng 1 loại ngôn ngữ như quy tắc trên
- "answer": lựa chọn ĐÚNG — phải nằm trong "options"
- "explanation": giải thích ngắn bằng TIẾNG VIỆT

Chỉ trả về DUY NHẤT một mảng JSON. KHÔNG thêm markdown, không thêm văn bản ngoài.`;

    const responseSchema = {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['meaning', 'pinyin', 'hanzi', 'fill_blank'] },
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          answer: { type: 'string' },
          explanation: { type: 'string' },
        },
        required: ['type', 'question', 'options', 'answer', 'explanation'],
      },
    };

    // ---------- Gọi Gemini ----------
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

          const rawOptions = Array.isArray(q.options) ? q.options : [];
          const sanitizedOptions = rawOptions
            .map(sanitizeText)
            .map(s => String(s).trim())
            .filter(Boolean);
          const uniqueOptions = [...new Set(sanitizedOptions)];

          const difficulty = 1 + Math.round(
            (idx / Math.max(1, quizArray.length - 1)) * 4
          );

          const cleanQ = {
            type: String(q.type || 'meaning').trim().toLowerCase(),
            question: sanitizeText(String(q.question || '')).trim(),
            options: uniqueOptions,
            answer: sanitizeText(String(q.answer || '')).trim(),
            explanation: sanitizeText(String(q.explanation || '')).trim(),
            difficulty,
          };

          const allowed = ['meaning', 'pinyin', 'hanzi', 'fill_blank', 'fill_meaning', 'fill_hanzi'];
          if (!allowed.includes(cleanQ.type)) cleanQ.type = 'meaning';

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

          // Validate ngôn ngữ (đáp án cùng 1 loại + không dính tiếng Anh)
          if (!isCleanQuestion(cleanQ, translated)) {
            console.warn(
              '[vocab-quiz] Bỏ câu sai ngôn ngữ:',
              cleanQ.type, '|', cleanQ.question, '|', cleanQ.options
            );
            return null;
          }
          return cleanQ;
        })
        .filter(Boolean);

      // Ưu tiên câu có answer là nghĩa tiếng Việt chính
      const preferred = new Set(translated);
      finalQuiz.sort((a, b) => {
        const aPref = preferred.has(a.answer) ? 0 : 1;
        const bPref = preferred.has(b.answer) ? 0 : 1;
        if (aPref !== bPref) return aPref - bPref;
        return (a.difficulty || 0) - (b.difficulty || 0);
      });

      finalQuiz = finalQuiz.slice(0, n);
    }

    // ---------- Fallback local nếu thiếu ----------
    let usedFallback = false;
    if (finalQuiz.length < n) {
      const need = n - finalQuiz.length;
      const local = generateLocalQuiz(cleanedWord, need);
      local.forEach(q => { q.difficulty = Math.max(1, (q.difficulty || 3) - 1); });
      finalQuiz = [...finalQuiz, ...local];
      usedFallback = true;
    }

    // Sắp xếp cuối cùng: DỄ → KHÓ
    finalQuiz.sort((a, b) => (a.difficulty || 0) - (b.difficulty || 0));

    console.log(
      `[vocab-quiz] OK ${finalQuiz.length}/${n} câu (${Date.now() - t0}ms)` +
      (usedFallback ? ' [có fallback]' : '')
    );

    res.json({
      result: finalQuiz,
      fallback: usedFallback,
      translations: translated,
    });
  } catch (error) {
    console.error('❌ Lỗi không mong đợi /api/ai/vocab-quiz:', error);
    try {
      const w = req.body?.word || {};
      const emergencyTranslations = Array.isArray(w.translations) && w.translations.length
        ? w.translations.filter(t => !looksLikeEnglish(String(t)))
        : [];
      const emergency = generateLocalQuiz(
        {
          hanzi: w.hanzi || '?',
          pinyin: w.pinyin || '?',
          translations: emergencyTranslations.length ? emergencyTranslations : ['?'],
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
