import express from 'express';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { GoogleGenAI, Modality } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

app.use(express.json({ limit: '10mb' }));

import fs from 'fs';

// Helper to reliably retrieve valid Gemini API key
function getGeminiApiKey() {
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

function getGeminiClient() {
  const key = getGeminiApiKey();
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
  const key = getGeminiApiKey();
  res.json({
    status: 'ok',
    hasApiKey: !!key,
    keyValid: key.length > 20,
    modelsAvailable: [
      'gemini-3.5-flash',
      'gemini-3.1-flash-lite',
      'gemini-3.8-flash',
      'gemini-3.1-pro-preview',
      'gemini-3.8-live'
    ]
  });
});

// Helper for model fallback
async function callGeminiWithFallback(preferredModel, contents, config) {
  const client = getGeminiClient();
  if (!client) {
    throw new Error('مفتاح Gemini API غير مهيأ في النظام.');
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

    const { response, modelUsed } = await callGeminiWithFallback(model, contents, config);

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
    });

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
    });

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
    });

    res.json({
      challenge: response.text || '',
      modelUsed
    });
  } catch (err) {
    console.error('Quiz challenge error:', err);
    res.status(500).json({ error: err.message || 'فشل توليد التحدي البرمجي.' });
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

// Single Page Application fallback to index.html for all other GET requests
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Live API WebSocket Setup on /api/live
const wss = new WebSocketServer({ server, path: '/api/live' });

wss.on('connection', async (clientWs) => {
  console.log('Client connected to Live Voice WebSocket');
  let liveSession = null;

  try {
    const liveClient = getGeminiClient();
    if (!liveClient) {
      clientWs.send(JSON.stringify({
        type: 'error',
        error: 'Gemini API Key is not configured on the server.'
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
