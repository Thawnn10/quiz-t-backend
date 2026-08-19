const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { GoogleGenAI } = require('@google/genai');

// Nạp biến môi trường từ file .env
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Khởi tạo Google GenAI
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('Thiếu GEMINI_API_KEY trong file .env');
  process.exit(1);
}
const ai = new GoogleGenAI({ apiKey });

/**
 * Endpoint: POST /api/ai/vocab-quiz
 * Tạo 5 câu hỏi trắc nghiệm cho từ vựng được gửi lên
 */
app.post('/api/ai/vocab-quiz', async (req, res) => {
  try {
    const { word, count = 5 } = req.body;

    // Kiểm tra dữ liệu đầu vào
    if (!word || !word.hanzi || !word.pinyin || !word.translations) {
      return res.status(400).json({ error: 'Thiếu thông tin từ vựng (hanzi, pinyin, translations)' });
    }

    // Xây dựng prompt
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

    // Cấu hình responseSchema để AI trả về đúng định dạng
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string' },
              options: { type: 'array', items: { type: 'string' } },
              answer: { type: 'string' },
              explanation: { type: 'string' }
            },
            required: ['question', 'options', 'answer', 'explanation']
          }
        }
      }
    });

    // Lấy text từ response (kiểm tra nhiều định dạng)
    let text = '';
    if (response.text) {
      text = response.text;
    } else if (response.candidates && response.candidates[0]?.content?.parts?.[0]?.text) {
      text = response.candidates[0].content.parts[0].text;
    } else {
      throw new Error('Không nhận được phản hồi từ Gemini');
    }

    // Parse JSON
    const quizArray = JSON.parse(text);

    // Kiểm tra và lọc chỉ lấy đủ số câu hỏi (nếu AI trả thừa hoặc thiếu)
    if (!Array.isArray(quizArray) || quizArray.length === 0) {
      throw new Error('AI trả về không đúng định dạng mảng');
    }

    // Đảm bảo mỗi câu hỏi có đủ trường
    const validQuiz = quizArray.filter(q => q.question && Array.isArray(q.options) && q.options.length >= 2 && q.answer && q.explanation);
    const finalQuiz = validQuiz.slice(0, count);

    if (finalQuiz.length === 0) {
      throw new Error('AI trả về không có câu hỏi hợp lệ');
    }

    res.json({ result: finalQuiz });
  } catch (error) {
    console.error('Lỗi trong /api/ai/vocab-quiz:', error);
    res.status(500).json({ error: error.message || 'Lỗi server' });
  }
});

// Các endpoint AI khác (dictionary, grammar-check, roleplay) có thể thêm tương tự
// ...

// Khởi động server
app.listen(PORT, () => {
  console.log(`Backend đang chạy tại http://localhost:${PORT}`);
});