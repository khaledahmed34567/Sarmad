import express from 'express';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { GoogleGenAI, Modality } from '@google/genai';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

app.use(express.json({ limit: '10mb' }));

import fs from 'fs';

// Runtime storage for user-configured custom Gemini API key
const USER_KEY_FILE = path.join(__dirname, '.user_gemini_key');
let runtimeCustomApiKey = '';
try {
  if (fs.existsSync(USER_KEY_FILE)) {
    runtimeCustomApiKey = fs.readFileSync(USER_KEY_FILE, 'utf8').trim();
  }
} catch (_) {}

// Helper to reliably retrieve valid Gemini API key (supports request override, custom saved key, and env)
function getGeminiApiKey(requestKey = null) {
  if (requestKey && typeof requestKey === 'string' && requestKey.trim().length > 10) {
    return requestKey.trim();
  }
  if (runtimeCustomApiKey && runtimeCustomApiKey.length > 10) {
    return runtimeCustomApiKey;
  }
  const envKey = (process.env.GEMINI_API_KEY || '').trim();
  if (envKey && !envKey.startsWith('MY_') && envKey.length > 10) {
    return envKey;
  }
  try {
    if (fs.existsSync('/app/.dev.env.json')) {
      const parsed = JSON.parse(fs.readFileSync('/app/.dev.env.json', 'utf8'));
      if (parsed.GEMINI_API_KEY && !parsed.GEMINI_API_KEY.startsWith('MY_')) {
        return parsed.GEMINI_API_KEY.trim();
      }
    }
  } catch (e) {}
  return envKey;
}

function getGeminiClient(requestKey = null) {
  const key = getGeminiApiKey(requestKey);
  if (!key) return null;
  return new GoogleGenAI({
    apiKey: key,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

// Serve static assets from project root
app.use(express.static(__dirname, {
  etag: true,
  maxAge: '1h',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('sw.js')) {
      res.setHeader('Service-Worker-Allowed', '/');
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// Route for admin panel
app.get(['/admin', '/admin.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// API: Health & Gemini models status
app.get('/api/health', (req, res) => {
  const reqKey = req.headers['x-gemini-api-key'] || req.query.apiKey;
  const key = getGeminiApiKey(reqKey);
  res.json({
    status: 'ok',
    hasApiKey: !!key,
    keyValid: key.length > 20,
    isCustomKey: !!(reqKey || runtimeCustomApiKey),
    keyPreview: key && key.length > 10 ? `${key.slice(0, 6)}...${key.slice(-4)}` : null,
    modelsAvailable: [
      'gemini-3.5-flash',
      'gemini-3.1-flash-lite',
      'gemini-3.8-flash',
      'gemini-3.1-pro-preview',
      'gemini-3.8-live'
    ]
  });
});

// API: User Gemini Key Management (GET, POST, DELETE)
app.get('/api/gemini/key', (req, res) => {
  const reqKey = req.headers['x-gemini-api-key'];
  const key = getGeminiApiKey(reqKey);
  res.json({
    hasKey: !!key,
    isCustom: !!(reqKey || runtimeCustomApiKey),
    source: (reqKey ? 'request' : (runtimeCustomApiKey ? 'custom' : (process.env.GEMINI_API_KEY ? 'system' : 'none'))),
    keyPreview: key && key.length > 10 ? `${key.slice(0, 6)}...${key.slice(-4)}` : ''
  });
});

app.post('/api/gemini/key', async (req, res) => {
  try {
    const { apiKey } = req.body;
    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length < 15) {
      return res.status(400).json({ error: 'يرجى إدخال مفتاح Gemini API صالح يتكون من 15 حرفاً على الأقل.' });
    }
    const cleanKey = apiKey.trim();

    // Verify key by sending a test lightweight ping to Gemini
    const testClient = new GoogleGenAI({
      apiKey: cleanKey,
      httpOptions: { headers: { 'User-Agent': 'aistudio-build' } }
    });

    try {
      await testClient.models.generateContent({
        model: 'gemini-3.5-flash',
        contents: [{ role: 'user', parts: [{ text: 'قل مرحباً بكلمة واحدة فقط' }] }]
      });
    } catch (testErr) {
      console.warn('API key test failed:', testErr.message);
      return res.status(400).json({
        error: 'فشل التحقق من مفتاح Gemini API: ' + (testErr.message || 'المفتاح غير صالح أو الحساب لا يملك صلاحيات وصول.')
      });
    }

    // Key is verified successfully: persist it
    runtimeCustomApiKey = cleanKey;
    try {
      fs.writeFileSync(USER_KEY_FILE, cleanKey, 'utf8');
    } catch (_) {}

    res.json({
      success: true,
      message: 'تم التحقق من مفتاح Gemini API وحفظه بنجاح.',
      keyPreview: `${cleanKey.slice(0, 6)}...${cleanKey.slice(-4)}`
    });
  } catch (err) {
    console.error('Save API key error:', err);
    res.status(500).json({ error: 'حدث خطأ أثناء حفظ المفتاح: ' + err.message });
  }
});

app.delete('/api/gemini/key', (req, res) => {
  try {
    runtimeCustomApiKey = '';
    try {
      if (fs.existsSync(USER_KEY_FILE)) {
        fs.unlinkSync(USER_KEY_FILE);
      }
    } catch (_) {}
    const fallbackKey = getGeminiApiKey();
    res.json({
      success: true,
      message: 'تمت إزالة المفتاح المخصص واستعادة الإعدادات الافتراضية بنجاح.',
      hasSystemKey: !!fallbackKey
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Helper for model fallback
async function callGeminiWithFallback(preferredModel, contents, config, requestKey = null) {
  const client = getGeminiClient(requestKey);
  if (!client) {
    throw new Error('مفتاح Gemini API غير مهيأ. يرجى إدخال مفتاح API الخاص بك من إعدادات الذكاء الاصطناعي.');
  }

  // Model prioritization and fallback
  const modelCandidates = [
    preferredModel,
    'gemini-3.5-flash',
    'gemini-3.1-flash-lite',
    'gemini-3.8-flash'
  ].filter((m, i, arr) => m && arr.indexOf(m) === i);

  let lastError = null;
  for (const m of modelCandidates) {
    try {
      const cfg = { ...config };
      const res = await client.models.generateContent({
        model: m,
        contents,
        config: cfg
      });
      return { response: res, modelUsed: m };
    } catch (err) {
      console.warn(`Model ${m} call failed:`, err.message || err);
      lastError = err;
      continue;
    }
  }
  throw lastError;
}

// API: Multi-turn Chat & Search Grounding
app.post('/api/gemini/chat', async (req, res) => {
  try {
    const requestKey = req.headers['x-gemini-api-key'] || req.body?.apiKey;
    const {
      messages = [],
      model = 'gemini-3.5-flash',
      useSearch = false,
      systemInstruction = 'أنت مساعد سرمد الذكي، خبير في تعليم البرمجة والعلوم والتقنية باللغة العربية. قدم إجابات واضحة، تعليمية، ومنسقة دون استخدام أي إيموجيز نهائياً.'
    } = req.body;

    if (!messages.length) {
      return res.status(400).json({ error: 'الرسائل مطلوبة.' });
    }

    // Format contents for @google/genai
    const contents = messages.map(msg => ({
      role: msg.role === 'user' ? 'user' : 'model',
      parts: Array.isArray(msg.parts) ? msg.parts : [{ text: msg.content || msg.text || '' }]
    }));

    const config = {
      systemInstruction: systemInstruction + ' تنبيه: يمنع استخدام أي رموز تعبيرية (Emojis) في ردودك، اعتمد على التنسيق الاحترافي والرموز النصية أو العناوين فقط.'
    };

    if (useSearch) {
      config.tools = [{ googleSearch: {} }];
    }

    const { response, modelUsed } = await callGeminiWithFallback(model, contents, config, requestKey);

    const text = response.text || '';
    const groundingChunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];

    res.json({
      text,
      groundingChunks,
      modelUsed
    });
  } catch (error) {
    console.error('Chat API Error:', error);
    res.status(500).json({
      error: error.message || 'حدث خطأ أثناء معالجة الطلب في الذكاء الاصطناعي.',
      status: error.status || 500
    });
  }
});

// NEW FEATURE: Smart Code Explainer, Debugger & Optimizer
app.post('/api/gemini/explain-code', async (req, res) => {
  try {
    const requestKey = req.headers['x-gemini-api-key'] || req.body?.apiKey;
    const { code, language = 'javascript', question = '' } = req.body;
    if (!code || !code.trim()) {
      return res.status(400).json({ error: 'الكود البرمجي مطلوب.' });
    }

    const prompt = `أنت مهندس برمجيات أول ومصحح أكواد خبير في منصة سرمد التعليمية.
قم بتحليل الكود التالي المكتوب بلغة (${language}):

\`\`\`${language}
${code}
\`\`\`

${question ? `سؤال المستخدم المحدد: ${question}` : ''}

قدم تقريراً شاملاً باللغة العربية الفصحى منظم كالتالي:
1. **شرح الكود ووظيفته:** كيف يعمل خطوة بخطوة.
2. **الأخطاء والمشاكل المكتشفة:** أخطاء منطقية، مشاكل أداء، أو ثغرات أمنية (إن وجدت).
3. **الكود المصحح والمحسّن:** كود نظيف، متبع لأفضل الممارسات (Clean Code).
4. **تحليل التعقيد الحسابي:** Time Complexity (O(n)) و Space Complexity مع التعليل.

ملاحظة صارمة: لا تستخدم أي رموز تعبيرية (Emojis) إطلاقاً في الشرح أو الرد.`;

    const contents = [{ role: 'user', parts: [{ text: prompt }] }];
    const { response, modelUsed } = await callGeminiWithFallback('gemini-3.5-flash', contents, {
      systemInstruction: 'أنت مهندس برمجيات خبير يشرح الأكواد بأسلوب احترافي خالٍ تماماً من الإيموجيز.'
    }, requestKey);

    res.json({
      result: response.text || '',
      modelUsed
    });
  } catch (err) {
    console.error('Explain code error:', err);
    res.status(500).json({ error: err.message || 'فشل تحليل الكود البرمجي.' });
  }
});

// NEW FEATURE: Custom AI Study Plan Generator
app.post('/api/gemini/study-plan', async (req, res) => {
  try {
    const requestKey = req.headers['x-gemini-api-key'] || req.body?.apiKey;
    const { goal, currentLevel = 'beginner', hoursPerWeek = 10, weeks = 8 } = req.body;
    if (!goal || !goal.trim()) {
      return res.status(400).json({ error: 'الهدف التعليمي مطلوب.' });
    }

    const prompt = `أنت مستشار أكاديمي ومهني في منصة سرمد لتعليم البرمجة والتقنية.
قم بإنشاء خطة دراسية مخصصة واحترافية للمتعلم:
- الهدف: ${goal}
- المستوى الحالي: ${currentLevel}
- ساعات المذاكرة أسبوعياً: ${hoursPerWeek} ساعات
- مدة الخطة: ${weeks} أسابيع

نسق الخطة بدقة باللغة العربية كالتالي:
1. **نظرة عامة على المسار والمهارات المستهدفة**
2. **جدول زمني مقسم أسبوع بأسبوع:**
   - موضوع الأسبوع
   - مفاهيم أساسية يجب إتقانها
   - مشاريع وتطبيقات عملية (Hands-on Projects)
   - مقاييس الإنجاز (Checkpoints)
3. **أفضل الممارسات والنصائح الذهبية لتسريع التعلم**

ملاحظة صارمة: ممنوع استخدام أي إيموجيز (رموز تعبيرية) نهائياً.`;

    const contents = [{ role: 'user', parts: [{ text: prompt }] }];
    const { response, modelUsed } = await callGeminiWithFallback('gemini-3.5-flash', contents, {
      systemInstruction: 'أنت مستشار تعليمي متخصص في صناعة الخطط الدراسية البرمجية دون استخدام أي رموز تعبيرية.'
    }, requestKey);

    res.json({
      plan: response.text || '',
      modelUsed
    });
  } catch (err) {
    console.error('Study plan error:', err);
    res.status(500).json({ error: err.message || 'فشل توليد الخطة الدراسية.' });
  }
});

// NEW FEATURE: AI Coding Challenge & Quiz Generator
app.post('/api/gemini/quiz-challenge', async (req, res) => {
  try {
    const requestKey = req.headers['x-gemini-api-key'] || req.body?.apiKey;
    const { topic = 'JavaScript', difficulty = 'intermediate' } = req.body;

    const prompt = `أنشئ تحدياً برمجياً واختباراً ذكياً للموضوع (${topic}) بمستوى صعوبة (${difficulty}).
قدم:
1. **نص التحدي البرمجي:** المشكلة المطلوب حلها بوضوح مع الشروط والمدخلات والمخرجات المتوقعة (Test Cases).
2. **سؤالين اختيار من متعدد (MCQ):** مع 4 خيارات لكل سؤال وتحديد الإجابة الصحيحة مع التعليل.
3. **تلميح برمجي (Hint):** لمساعدة المتعلم دون حرق الحل.
4. **الحل النموذجي الموصى به:** مع شرح كفاءة الحل.

ملاحظة هامة: لا تستخدم أي إيموجيز إطلاقاً في أي جزء من الإجابة.`;

    const contents = [{ role: 'user', parts: [{ text: prompt }] }];
    const { response, modelUsed } = await callGeminiWithFallback('gemini-3.5-flash', contents, {
      systemInstruction: 'أنت مسؤول إعداد الاختبارات والتحديات البرمجية في منصة سرمد، تقدم أسئلة رصينة بدون أي إيموجيز.'
    }, requestKey);

    res.json({
      challenge: response.text || '',
      modelUsed
    });
  } catch (err) {
    console.error('Quiz challenge error:', err);
    res.status(500).json({ error: err.message || 'فشل توليد التحدي البرمجي.' });
  }
});

// NEW FEATURE: Daily AI Programming Tip Generator
app.post('/api/gemini/daily-tip', async (req, res) => {
  try {
    const requestKey = req.headers['x-gemini-api-key'] || req.body?.apiKey;
    const { category = 'all', topic = '' } = req.body;
    const prompt = `قدم نصيحة برمجية احترافية ومفيدة للمطورين والطلاب في منصة سرمد.
مجال النصيحة: ${category} ${topic ? `(تركيز إضافي: ${topic})` : ''}

نسق النصيحة كالتالي:
- **عنوان النصيحة:** (سطر واحد جذاب ومعبر)
- **المفهوم / المشكلة:** (شرح مبسط ومباشر للمفهوم أو الخطأ الشائع)
- **الحل العملي وكود توضيحي:** (كود قصير ومباشر باللغة المناسبة مثل JS, TS, Python, SQL)
- **الأثر والفائدة:** (لماذا هذا مهم في بيئات الإنتاج الحقيقية)

شروط أساسية:
1. باللغة العربية الفصحى التقنية السليمة.
2. ممنوع استخدام أي رموز تعبيرية (Emojis) إطلاقاً.`;

    const contents = [{ role: 'user', parts: [{ text: prompt }] }];
    const { response, modelUsed } = await callGeminiWithFallback('gemini-3.5-flash', contents, {
      systemInstruction: 'أنت مهندس برمجيات محنك يقدم نصائح تقنية دقيقة وسريعة خالية تماماً من الإيموجيز.'
    }, requestKey);

    res.json({
      tip: response.text || '',
      modelUsed
    });
  } catch (err) {
    console.error('Daily tip error:', err);
    res.status(500).json({ error: err.message || 'فشل توليد النصيحة البرمجية.' });
  }
});

// ============================================================================
// INTERACTIVE CODING LABS: Python & SQL Code Execution Engine
// ============================================================================
app.post('/api/lab/execute', async (req, res) => {
  try {
    const { language = 'python', code = '', input = '' } = req.body;
    if (!code || !code.trim()) {
      return res.status(400).json({ error: 'الكود البرمجي مطلوب للتشغيل.' });
    }

    const startTime = Date.now();
    const timeoutMs = 6000;

    if (language === 'python') {
      const runnerCode = `
import sys, io
code = sys.stdin.read()
try:
    compiled = compile(code, '<sarmad_lab>', 'exec')
    exec(compiled, {'__name__': '__main__'})
except Exception as e:
    import traceback
    traceback.print_exc(file=sys.stderr)
`;
      const proc = spawn('python3', ['-c', runnerCode], {
        timeout: timeoutMs,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (d) => { if (stdout.length < 50000) stdout += d.toString(); });
      proc.stderr.on('data', (d) => { if (stderr.length < 50000) stderr += d.toString(); });

      proc.stdin.write(code);
      proc.stdin.end();

      proc.on('close', (codeStatus) => {
        const executionTimeMs = Date.now() - startTime;
        res.json({
          language: 'python',
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode: codeStatus,
          executionTimeMs,
          success: codeStatus === 0 && !stderr.includes('Traceback')
        });
      });

      proc.on('error', (err) => {
        res.status(500).json({ error: 'فشل تشغيل بيئة بايثون: ' + err.message });
      });

    } else if (language === 'sql') {
      // Python SQLite runner with pre-seeded relational database schema
      const sqlRunnerScript = `
import sys, json, sqlite3

db = sqlite3.connect(':memory:')
cur = db.cursor()

# Pre-seed sample tables for educational queries
cur.executescript('''
CREATE TABLE students (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  track TEXT,
  level TEXT,
  xp INTEGER DEFAULT 0
);
CREATE TABLE courses (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT,
  hours INTEGER,
  price REAL
);
CREATE TABLE enrollments (
  id INTEGER PRIMARY KEY,
  student_id INTEGER,
  course_id INTEGER,
  grade REAL,
  completed_at TEXT,
  FOREIGN KEY(student_id) REFERENCES students(id),
  FOREIGN KEY(course_id) REFERENCES courses(id)
);

INSERT INTO students VALUES
  (1, 'أسامة محمد', 'osama@sarmad.edu', 'تطوير الويب الشامل', 'متقدم', 1420),
  (2, 'مريم أحمد', 'maryam@sarmad.edu', 'الذكاء الاصطناعي وبايثون', 'متوسط', 980),
  (3, 'خالد البربري', 'khaled@sarmad.edu', 'أمن المعلومات والسيبراني', 'متقدم', 1850),
  (4, 'نورة العتيبي', 'noura@sarmad.edu', 'هندسة البيانات وSQL', 'مبتدئ', 450),
  (5, 'عمر الفاروق', 'omar@sarmad.edu', 'تطوير الويب الشامل', 'متوسط', 720);

INSERT INTO courses VALUES
  (101, 'مبادئ لغة جافاسكريبت الحديثة', 'Frontend', 24, 0.0),
  (102, 'هياكل البيانات والخوارزميات في بايثون', 'Computer Science', 36, 150.0),
  (103, 'تصميم وإدارة قواعد بيانات PostgreSQL و SQLite', 'Backend', 30, 120.0),
  (104, 'الذكاء الاصطناعي التوليدي ونماذج اللغة', 'AI & ML', 40, 200.0);

INSERT INTO enrollments VALUES
  (1, 1, 101, 98.5, '2026-02-15'),
  (2, 1, 103, 94.0, '2026-03-01'),
  (3, 2, 102, 91.0, '2026-02-28'),
  (4, 2, 104, 96.0, '2026-03-10'),
  (5, 3, 101, 89.0, '2026-01-20'),
  (6, 3, 103, 99.0, '2026-02-10'),
  (7, 4, 103, 85.0, '2026-03-12'),
  (8, 5, 101, 92.5, '2026-03-05');
''')
db.commit()

query = sys.stdin.read().strip()

try:
    statements = [s.strip() for s in query.split(';') if s.strip()]
    columns = []
    rows = []
    affected_rows = 0

    for st in statements:
        cur.execute(st)
        if cur.description:
            columns = [col[0] for col in cur.description]
            rows = [list(r) for r in cur.fetchall()]
        else:
            affected_rows += cur.rowcount

    db.commit()

    print(json.dumps({
        "success": True,
        "columns": columns,
        "rows": rows,
        "rowCount": len(rows),
        "affectedRows": affected_rows,
        "message": f"تم استرجاع {len(rows)} صفوف بنجاح" if columns else f"تم تنفيذ الاستعلام بنجاح (تأثر {affected_rows} صفوف)"
    }, ensure_ascii=False))
except Exception as e:
    print(json.dumps({
        "success": False,
        "error": str(e)
    }, ensure_ascii=False))
`;

      const proc = spawn('python3', ['-c', sqlRunnerScript], {
        timeout: timeoutMs,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });

      proc.stdin.write(code);
      proc.stdin.end();

      proc.on('close', (exitCode) => {
        const executionTimeMs = Date.now() - startTime;
        if (stderr && !stdout) {
          return res.status(400).json({ error: stderr.trim(), executionTimeMs });
        }
        try {
          const parsed = JSON.parse(stdout);
          parsed.executionTimeMs = executionTimeMs;
          res.json(parsed);
        } catch (e) {
          res.status(500).json({ error: 'فشل معالجة مخرجات الاستعلام: ' + stdout, executionTimeMs });
        }
      });

      proc.on('error', (err) => {
        res.status(500).json({ error: 'فشل تشغيل محرك SQL: ' + err.message });
      });

    } else {
      res.status(400).json({ error: 'لغة البرمجة غير مدعومة في بيئة الخادم. استخدم معمل الويب لتشغيل JavaScript محلياً.' });
    }
  } catch (err) {
    console.error('Lab execute error:', err);
    res.status(500).json({ error: err.message || 'فشل تشغيل الكود في المعمل البرمجي.' });
  }
});

// NEW FEATURE: Lab AI Assistant (Explain, Debug, Optimize, Test Cases, Challenges)
app.post('/api/gemini/lab-assist', async (req, res) => {
  try {
    const requestKey = req.headers['x-gemini-api-key'] || req.body?.apiKey;
    const { action = 'explain', language = 'javascript', code = '', query = '' } = req.body;
    if (!code && action !== 'challenge') {
      return res.status(400).json({ error: 'الكود البرمجي مطلوب للمساعد الذكي.' });
    }

    let prompt = '';
    if (action === 'debug') {
      prompt = `أنت مهندس فحص وتصحيح أكواد خبير في منصة سرمد.
افحص الكود التالي المكتوب بلغة (${language}):
\`\`\`${language}
${code}
\`\`\`
1. **تحديد الأخطاء:** هل توجد أخطاء في الصياغة (Syntax)، أو أخطاء منطقية (Logic)، أو أخطاء وقت التشغيل (Runtime)؟
2. **الكود المصحح بالكامل:** قدم النسخة المصححة والمضمونة للعمل.
3. **توضيح أسباب التصحيح:** شرح علمي لما تم تعديله ولماذا.
ملاحظة صارمة: لا تستخدم أي رموز تعبيرية (Emojis) نهائياً.`;
    } else if (action === 'optimize') {
      prompt = `أنت خبير كفاءة برمجية وهياكل بيانات في منصة سرمد.
قم بتحسين أداء وجودة الكود التالي المكتوب بلغة (${language}):
\`\`\`${language}
${code}
\`\`\`
1. **تحليل التعقيد الزمني والمكاني الحالي:** Big-O notation.
2. **الكود بعد التحسين والتنظيف:** تطبيق معايير Clean Code وكفاءة التنفيذ.
3. **المقارنة والفوائد:** ما الذي تحسن وما هو الفرق في الأداء.
ملاحظة صارمة: لا تستخدم أي رموز تعبيرية (Emojis) نهائياً.`;
    } else if (action === 'test') {
      prompt = `أنت مهندس اختبار جودة البرمجيات (QA & Test Automation) في منصة سرمد.
قم بإنشاء مجموعة اختبارات شاملة (Unit Test Cases) للكود التالي (${language}):
\`\`\`${language}
${code}
\`\`\`
1. **حالات الاختبار الأساسية (Happy Path):** المدخلات والمخرجات المتوقعة.
2. **الحالات الحدية والشاذة (Edge Cases):** مثل القيم الفارغة، الأرقام السالبة، المصفوفات الفارغة.
3. **كود الاختبارات التنفيذية:** جاهز للتشغيل والتحقق.
ملاحظة صارمة: لا تستخدم أي رموز تعبيرية (Emojis) نهائياً.`;
    } else if (action === 'challenge') {
      prompt = `اقترح تحدياً برمجياً تفاعلياً جديداً ومثيراً للاهتمام بلغة (${language}) يناسب المعامل البرمجية في منصة سرمد.
${query ? `تركيز إضافي: ${query}` : ''}
نسق التحدي كالتالي:
- **عنوان التحدي**
- **وصف المشكلة والمتطلبات**
- **قالب الكود المبدئي (Starter Code)**
- **حالات الاختبار للتحقق (Test Cases)**
- **تلميح برمجي ذكي**
ملاحظة صارمة: لا تستخدم أي رموز تعبيرية (Emojis) نهائياً.`;
    } else {
      // explain
      prompt = `أنت معلم ومهندس برمجيات محترف في منصة سرمد.
اشرح الكود التالي المكتوب بلغة (${language}) شرحاً معمارياً مبسطاً وشاملاً:
\`\`\`${language}
${code}
\`\`\`
${query ? `سؤال إضافي: ${query}` : ''}
1. **الفكرة والوظيفة العامة للكود**
2. **تتبع التدفق خطوة بخطوة (Step-by-step Flow)**
3. **المفاهيم البرمجية المطبقة وأفضل الممارسات**
ملاحظة صارمة: لا تستخدم أي رموز تعبيرية (Emojis) نهائياً.`;
    }

    const contents = [{ role: 'user', parts: [{ text: prompt }] }];
    const { response, modelUsed } = await callGeminiWithFallback('gemini-3.5-flash', contents, {
      systemInstruction: 'أنت مهندس ومصحح أكواد تعليمي في منصة سرمد، تقدم إجابات احترافية دقيقة خالية تماماً من الإيموجيز.'
    }, requestKey);

    res.json({
      output: response.text || '',
      action,
      language,
      modelUsed
    });
  } catch (err) {
    console.error('Lab assist error:', err);
    res.status(500).json({ error: err.message || 'فشل مساعد المعمل البرمجي.' });
  }
});

// API: Science - Protein Structure Fetcher (AlphaFold DB & RCSB PDB)
app.get('/api/science/protein/:id', async (req, res) => {
  try {
    const rawId = req.params.id.trim();
    const cleanId = rawId.toUpperCase();
    
    // Check if it looks like a PDB ID (4 characters)
    if (cleanId.length === 4 && /^[0-9][A-Z0-9]{3}$/.test(cleanId)) {
      const pdbUrl = `https://files.rcsb.org/download/${cleanId}.cif`;
      const metaRes = await fetch(`https://data.rcsb.org/rest/v1/core/entry/${cleanId}`);
      let meta = {};
      if (metaRes.ok) {
        meta = await metaRes.json();
      }
      return res.json({
        type: 'pdb',
        id: cleanId,
        title: meta.struct?.title || `PDB Entry ${cleanId}`,
        cifUrl: pdbUrl,
        source: 'RCSB Protein Data Bank (Experimental)',
        details: meta
      });
    }

    // Otherwise UniProt / AlphaFold DB
    const afRes = await fetch(`https://alphafold.ebi.ac.uk/api/prediction/${cleanId}`);
    if (afRes.ok) {
      const afData = await afRes.json();
      if (Array.isArray(afData) && afData.length > 0) {
        const item = afData[0];
        return res.json({
          type: 'alphafold',
          id: cleanId,
          gene: item.gene || cleanId,
          uniprotId: item.uniprotId,
          uniprotDescription: item.uniprotDescription,
          organism: item.organismScientificName,
          sequenceLength: item.uniprotEnd,
          cifUrl: item.cifUrl,
          bcifUrl: item.bcifUrl,
          pdbUrl: item.pdbUrl,
          paeImageUrl: item.paeImageUrl,
          source: 'AlphaFold DB (AI Predicted Structure)'
        });
      }
    }

    // Direct fallback
    res.json({
      type: 'alphafold',
      id: cleanId,
      gene: cleanId,
      cifUrl: `https://alphafold.ebi.ac.uk/files/AF-${cleanId}-F1-model_v6.cif`,
      pdbUrl: `https://alphafold.ebi.ac.uk/files/AF-${cleanId}-F1-model_v6.pdb`,
      source: 'AlphaFold DB'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Science - Chemical Compound Fetcher (PubChem)
app.get('/api/science/compound/:name', async (req, res) => {
  try {
    const name = encodeURIComponent(req.params.name.trim());
    const pcRes = await fetch(`https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${name}/JSON`);
    if (!pcRes.ok) {
      return res.status(404).json({ error: 'لم يتم العثور على المركب الكيميائي في قاعدة بيانات PubChem.' });
    }
    const data = await pcRes.json();
    const compound = data?.PC_Compounds?.[0];
    if (!compound) {
      return res.status(404).json({ error: 'بيانات المركب غير متوفرة.' });
    }

    const cid = compound.id?.id?.cid;
    let smiles = '';
    let formula = '';
    let weight = '';
    let iupacName = '';

    const props = compound.props || [];
    for (const p of props) {
      const label = p.urn?.label;
      const nameUrn = p.urn?.name;
      if (label === 'SMILES' && (nameUrn === 'Canonical' || !smiles)) {
        smiles = p.value?.sval || '';
      }
      if (label === 'Molecular Formula') {
        formula = p.value?.sval || '';
      }
      if (label === 'Molecular Weight') {
        weight = p.value?.sval || p.value?.fval || '';
      }
      if (label === 'IUPAC Name' && nameUrn === 'Preferred') {
        iupacName = p.value?.sval || '';
      }
    }

    res.json({
      cid,
      name: req.params.name,
      iupacName,
      formula,
      weight,
      smiles,
      imageUrl: cid ? `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${cid}/PNG` : null,
      pubchemUrl: cid ? `https://pubchem.ncbi.nlm.nih.gov/compound/${cid}` : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Science - Biomedical Literature Search (Europe PMC)
app.get('/api/science/literature', async (req, res) => {
  try {
    const query = req.query.q || 'bioinformatics programming';
    const epmcUrl = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(query)}&format=json&pageSize=8`;
    const r = await fetch(epmcUrl);
    if (!r.ok) {
      return res.json({ results: [] });
    }
    const data = await r.json();
    const list = (data.resultList?.result || []).map(item => ({
      id: item.id,
      source: item.source,
      title: item.title,
      authorString: item.authorString,
      journalTitle: item.journalTitle || item.journalInfo?.journal?.title,
      pubYear: item.pubYear,
      doi: item.doi,
      url: item.doi ? `https://doi.org/${item.doi}` : (item.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${item.pmid}/` : `https://europepmc.org/article/${item.source}/${item.id}`)
    }));
    res.json({ results: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// GITHUB INTEGRATION API PROXY
// ============================================================================
function getGithubHeaders(req) {
  const headers = {
    'User-Agent': 'Sarmad-Platform',
    'Accept': 'application/vnd.github.v3+json'
  };
  const token = req.headers['authorization'] || req.headers['x-github-token'] || req.query.token;
  if (token && typeof token === 'string' && token.trim()) {
    const cleanToken = token.trim();
    headers['Authorization'] = cleanToken.startsWith('Bearer ') || cleanToken.startsWith('token ') ? cleanToken : `Bearer ${cleanToken}`;
  }
  return headers;
}

app.get('/api/github/user/:username', async (req, res) => {
  try {
    const username = encodeURIComponent(req.params.username.trim());
    const r = await fetch(`https://api.github.com/users/${username}`, {
      headers: getGithubHeaders(req)
    });
    if (!r.ok) {
      return res.status(r.status).json({ error: 'لم يتم العثور على حساب GitHub أو الحساب خاص' });
    }
    const data = await r.json();
    res.json({
      login: data.login,
      name: data.name || data.login,
      avatar_url: data.avatar_url,
      html_url: data.html_url,
      bio: data.bio || '',
      public_repos: data.public_repos || 0,
      followers: data.followers || 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/github/repos/:username', async (req, res) => {
  try {
    const username = encodeURIComponent(req.params.username.trim());
    const r = await fetch(`https://api.github.com/users/${username}/repos?sort=updated&per_page=30`, {
      headers: getGithubHeaders(req)
    });
    if (!r.ok) {
      return res.status(r.status).json({ error: 'تعذر جلب مستودعات GitHub للمستخدم' });
    }
    const repos = await r.json();
    const list = Array.isArray(repos) ? repos.map(item => ({
      id: item.id,
      name: item.name,
      full_name: item.full_name,
      description: item.description || '',
      html_url: item.html_url,
      language: item.language || 'Code',
      stars: item.stargazers_count || 0,
      forks: item.forks_count || 0,
      updated_at: item.updated_at,
      default_branch: item.default_branch || 'main'
    })) : [];
    res.json({ repos: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/github/contents/:owner/:repo', async (req, res) => {
  try {
    const { owner, repo } = req.params;
    const pathQuery = req.query.path || '';
    const cleanPath = pathQuery ? encodeURIComponent(pathQuery).replace(/%2F/g, '/') : '';
    const r = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${cleanPath}`, {
      headers: getGithubHeaders(req)
    });
    if (!r.ok) {
      return res.status(r.status).json({ error: 'تعذر جلب محتويات المستودع' });
    }
    const data = await r.json();
    if (Array.isArray(data)) {
      const items = data.map(item => ({
        name: item.name,
        path: item.path,
        type: item.type,
        size: item.size,
        download_url: item.download_url
      }));
      return res.json({ type: 'dir', items });
    } else if (data.type === 'file') {
      let content = '';
      if (data.content) {
        content = Buffer.from(data.content, 'base64').toString('utf8');
      } else if (data.download_url) {
        const rawRes = await fetch(data.download_url, { headers: getGithubHeaders(req) });
        content = await rawRes.text();
      }
      return res.json({ type: 'file', name: data.name, path: data.path, content });
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Single Page Application fallback to index.html for all other GET requests
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Live API WebSocket Setup on /api/live
const wss = new WebSocketServer({ server, path: '/api/live' });

wss.on('connection', async (clientWs, req) => {
  console.log('Client connected to Live Voice WebSocket');
  let liveSession = null;

  try {
    let reqKey = null;
    try {
      if (req && req.url) {
        const parsedUrl = new URL(req.url, 'http://localhost:3000');
        reqKey = parsedUrl.searchParams.get('apiKey');
      }
    } catch (_) {}

    const liveClient = getGeminiClient(reqKey);
    if (!liveClient) {
      clientWs.send(JSON.stringify({
        type: 'error',
        error: 'Gemini API Key is not configured on the server. يرجى إدخال مفتاح API الخاص بك من إعدادات الذكاء الاصطناعي.'
      }));
      clientWs.close();
      return;
    }

    liveSession = await liveClient.live.connect({
      model: 'gemini-3.8-live',
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: 'Zephyr' }
          }
        },
        systemInstruction: 'أنت مرشد سرمد الذكي للمحادثة الصوتية التفاعلية الحية. تتحدث باللغة العربية الفصيحة بأسلوب مشجع وتعليمي ودود، وتجيب باختصار ودقة في مواضيع البرمجة والتقنية والعلوم.'
      },
      callbacks: {
        onmessage: (message) => {
          try {
            const parts = message.serverContent?.modelTurn?.parts;
            if (parts && parts.length > 0) {
              const audioData = parts[0]?.inlineData?.data;
              if (audioData) {
                clientWs.send(JSON.stringify({
                  type: 'audio',
                  audio: audioData
                }));
              }
              const textData = parts[0]?.text;
              if (textData) {
                clientWs.send(JSON.stringify({
                  type: 'text',
                  text: textData
                }));
              }
            }
            if (message.serverContent?.interrupted) {
              clientWs.send(JSON.stringify({ type: 'interrupted' }));
            }
            if (message.serverContent?.turnComplete) {
              clientWs.send(JSON.stringify({ type: 'turnComplete' }));
            }
          } catch (e) {
            console.error('Error in onmessage callback:', e);
          }
        },
        onerror: (err) => {
          console.error('Live API Session error:', err);
          try {
            clientWs.send(JSON.stringify({
              type: 'error',
              error: err.message || 'حدث خطأ في جلسة المحادثة الصوتية الحية.'
            }));
          } catch (_) {}
        },
        onclose: () => {
          console.log('Live API session closed');
          try {
            clientWs.send(JSON.stringify({ type: 'sessionClosed' }));
          } catch (_) {}
        }
      }
    });

    clientWs.send(JSON.stringify({ type: 'ready', model: 'gemini-3.8-live' }));

    clientWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'audio' && msg.audio) {
          liveSession.sendRealtimeInput({
            audio: { data: msg.audio, mimeType: 'audio/pcm;rate=16000' }
          });
        } else if (msg.type === 'text' && msg.text) {
          liveSession.sendRealtimeInput({
            text: msg.text
          });
        }
      } catch (err) {
        console.error('Error handling client message:', err);
      }
    });

    clientWs.on('close', () => {
      console.log('Client closed WebSocket');
      if (liveSession) {
        try { liveSession.close(); } catch (_) {}
      }
    });

  } catch (err) {
    console.error('Live WebSocket initialization error:', err);
    try {
      clientWs.send(JSON.stringify({
        type: 'error',
        error: err.message || 'فشل الاتصال بنموذج gemini-3.8-live'
      }));
    } catch (_) {}
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Server is running at http://${HOST}:${PORT}`);
});
