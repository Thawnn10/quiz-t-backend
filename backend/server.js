const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { GoogleGenAI } = require('@google/genai');

// Nạp biến môi trường từ file .env (chỉ dùng khi chạy local)
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Khởi tạo Google GenAI
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('Thiếu GEMINI_API_KEY trong biến môi trường');
  process.exit(1);
}
const ai = new GoogleGenAI({ apiKey });

// ================== HELPER: Gọi Gemini ==================
async function generateContent(prompt, responseMimeType, responseSchema) {
  const config = {
    responseMimeType,
  };
  if (responseSchema) {
    config.responseSchema = responseSchema;
  }

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
    config,
  });

  // Lấy text từ response (hỗ trợ nhiều định dạng)
  let text = '';
  if (response.text) {
    text = response.text;
  } else if (response.candidates && response.candidates[0]?.content?.parts?.[0]?.text) {
    text = response.candidates[0].content.parts[0].text;
  } else {
    throw new Error('Không nhận được phản hồi từ Gemini');
  }

  return text;
}

// ================== API: VOCAB QUIZ ==================
app.post('/api/ai/vocab-quiz', async (req, res) => {
  try {
    const { word, count = 5 } = req.body;

    if (!word || !word.hanzi || !word.pinyin || !word.translations) {
      return res.status(400).json({ error: 'Thiếu thông tin từ vựng (hanzi, pinyin, translations)' });
    }

    const prompt = `
      Bạn là giáo viên tiếng Trung. Hãy tạo ${count} câu hỏi trắc nghiệm để ôn tập từ vựng sau:
      - Hán tự: ${word.hanzi}
      - Pinyin: ${word.pinyin}
      - Nghĩa: ${word.translations.join(', ')}

      Mỗi câu hỏi phải có:
      - "question": nội dung câu hỏi (có thể là điền từ, chọn nghĩa đúng, chọn pinyin đúng...)
      - "options": mảng 4 lựa chọn (string)
      - "answer": lựa chọn đúng (phải nằm trong options)
      - "explanation": giải thích ngắn gọn bằng tiếng Việt

      Trả về một mảng JSON chứa ${count} đối tượng câu hỏi.
    `;

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

    const text = await generateContent(prompt, 'application/json', responseSchema);
    const quizArray = JSON.parse(text);

    if (!Array.isArray(quizArray) || quizArray.length === 0) {
      throw new Error('AI trả về không đúng định dạng mảng');
    }

    const validQuiz = quizArray.filter(
      (q) => q.question && Array.isArray(q.options) && q.options.length >= 2 && q.answer && q.explanation
    );
    const finalQuiz = validQuiz.slice(0, count);

    if (finalQuiz.length === 0) {
      throw new Error('AI trả về không có câu hỏi hợp lệ');
    }

    res.json({ result: finalQuiz });
  } catch (error) {
    console.error('Lỗi /api/ai/vocab-quiz:', error);
    res.status(500).json({ error: error.message || 'Lỗi server' });
  }
});

// ================== API: DICTIONARY ==================
app.post('/api/ai/dictionary', async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) {
      return res.status(400).json({ error: 'Thiếu từ cần tra' });
    }

    const prompt = `
      Bạn là từ điển tiếng Trung. Hãy giải thích chi tiết về từ/cụm từ sau: "${query}".
      Bao gồm:
      - Phiên âm pinyin (nếu có)
      - Nghĩa tiếng Việt
      - Ví dụ câu (có pinyin và dịch nghĩa)
      - Cấu trúc ngữ pháp nếu cần
      Trả lời bằng tiếng Việt, định dạng rõ ràng.
    `;

    const text = await generateContent(prompt, 'text/plain');
    res.json({ result: text });
  } catch (error) {
    console.error('Lỗi /api/ai/dictionary:', error);
    res.status(500).json({ error: error.message || 'Lỗi server' });
  }
});

// ================== API: GRAMMAR CHECK ==================
app.post('/api/ai/grammar-check', async (req, res) => {
  try {
    const { sentence } = req.body;
    if (!sentence) {
      return res.status(400).json({ error: 'Thiếu câu cần kiểm tra' });
    }

    const prompt = `
      Bạn là chuyên gia ngữ pháp tiếng Trung. Hãy kiểm tra câu sau: "${sentence}".
      - Nếu câu sai, hãy chỉ ra lỗi sai, giải thích ngữ pháp và đề xuất câu đúng.
      - Nếu câu đúng, hãy xác nhận và giải thích cấu trúc.
      Trả lời bằng tiếng Việt.
    `;

    const text = await generateContent(prompt, 'text/plain');
    res.json({ result: text });
  } catch (error) {
    console.error('Lỗi /api/ai/grammar-check:', error);
    res.status(500).json({ error: error.message || 'Lỗi server' });
  }
});

// ================== API: ROLEPLAY ==================
app.post('/api/ai/roleplay', async (req, res) => {
  try {
    const { message, scenario } = req.body;
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

    const prompt = `
      Bạn là một người bản xứ Trung Quốc đang đóng vai trong tình huống ${scenarioName}.
      Hãy trả lời tin nhắn của người học bằng tiếng Trung (có kèm pinyin và dịch nghĩa tiếng Việt).
      Tin nhắn của người học: "${message}".
      Hãy giữ cuộc hội thoại tự nhiên, hữu ích cho việc luyện tập.
    `;

    const text = await generateContent(prompt, 'text/plain');
    res.json({ result: text });
  } catch (error) {
    console.error('Lỗi /api/ai/roleplay:', error);
    res.status(500).json({ error: error.message || 'Lỗi server' });
  }
});

// ================== KHỞI ĐỘNG SERVER ==================
app.listen(PORT, () => {
  console.log(`Backend đang chạy tại http://localhost:${PORT}`);
});
