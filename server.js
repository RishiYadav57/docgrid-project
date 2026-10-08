const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const { PDFDocument, degrees, rgb } = require('pdf-lib');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for Vercel deployment
app.use(cors({ origin: '*' }));
// Large limit: the browser sends the full extracted document text for summarizing
app.use(express.json({ limit: '10mb' }));

// Serve only the front-end page (not the server source files)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Multi-file temporary upload directory
const uploadDir = path.join('/tmp', 'docgrid-uploads');
const outDir = path.join('/tmp', 'docgrid-out');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + '-' + file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_'));
  }
});
const upload = multer({ storage, limits: { fileSize: 40 * 1024 * 1024 } }); // 40MB limit

// Clean up helper
function safeUnlink(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    console.error('Error cleaning up:', err);
  }
}

// Health Check
let workingGeminiModel = null;
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    engine: 'LibreOffice Headless + Poppler',
    geminiKeyConfigured: Boolean(process.env.GEMINI_API_KEY),
    geminiModel: workingGeminiModel
  });
});

// =====================================================================
// GEMINI HELPERS
// Models get retired often, so we try several in order, remember the one
// that works, and as a last resort ask Google which models are available.
// You can force a model by setting GEMINI_MODEL in Render's environment.
// =====================================================================
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const PREFERRED_MODELS = [
  process.env.GEMINI_MODEL,
  'gemini-3-flash-preview',
  'gemini-flash-latest',
  'gemini-2.5-flash',
  'gemini-3.1-flash-lite-preview'
].filter(Boolean);

async function callGemini(model, prompt, apiKey) {
  const response = await fetch(`${GEMINI_BASE}/models/${model}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 8192 }
    })
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

function extractText(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('')
    .trim();
}

async function discoverModel(apiKey, alreadyTried) {
  const r = await fetch(`${GEMINI_BASE}/models?pageSize=200`, {
    headers: { 'x-goog-api-key': apiKey }
  });
  const d = await r.json().catch(() => ({}));
  const names = (d.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace('models/', ''))
    .filter((n) => /^gemini-/.test(n))
    .filter((n) => !/(image|tts|audio|live|embedding|robotics|computer-use|vision|learnlm|aqa|imagen|veo)/.test(n))
    .filter((n) => !alreadyTried.includes(n))
    .sort()
    .reverse();
  return names.find((n) => /flash/.test(n) && !/lite/.test(n)) || names.find((n) => /flash/.test(n)) || names[0] || null;
}

async function generateSummary(prompt, apiKey) {
  const order = [...new Set([workingGeminiModel, ...PREFERRED_MODELS].filter(Boolean))];
  const tried = [];
  let lastMessage = 'Gemini API request failed.';

  const attempt = async (model) => {
    tried.push(model);
    const result = await callGemini(model, prompt, apiKey);

    if (result.ok) {
      const text = extractText(result.data);
      if (text) {
        workingGeminiModel = model;
        return { text };
      }
      const reason = result.data?.promptFeedback?.blockReason || result.data?.candidates?.[0]?.finishReason || 'empty response';
      lastMessage = `Gemini returned no text (${reason}).`;
      return { retry: true };
    }

    lastMessage = result.data?.error?.message || `Gemini error ${result.status}`;
    console.error(`Gemini model ${model} failed (${result.status}):`, lastMessage);

    // Model retired / unavailable / busy / out of quota on this model: try the next one
    if ([404, 429, 500, 503].includes(result.status)) {
      if (model === workingGeminiModel) workingGeminiModel = null;
      return { retry: true };
    }
    // Bad key, blocked key, malformed request: trying other models will not help
    throw new Error(lastMessage);
  };

  for (const model of order) {
    const out = await attempt(model);
    if (out.text) return out.text;
  }

  // Last resort: ask Google which models this key can use
  const discovered = await discoverModel(apiKey, tried);
  if (discovered) {
    const out = await attempt(discovered);
    if (out.text) return out.text;
  }

  throw new Error(lastMessage);
}

// AI EXECUTIVE SUMMARIZER (Powered by Google Gemini)
app.post('/api/summarize', async (req, res) => {
  try {
    const { text, filename } = req.body;
    if (!text || text.trim().length < 30) {
      return res.status(400).json({ error: 'Insufficient document text provided.' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'GEMINI_API_KEY is not configured on the server.' });
    }

    const prompt = `You are an elite executive document analyst. Read the following text extracted from "${filename || 'Document'}" and provide a fluent, professional executive summary.

Write in natural, complete, human-readable sentences. Follow this exact format:

## Executive Overview
(A clear 2-3 sentence paragraph explaining what this document is, the profile/subject, and primary purpose)

## Key Highlights & Core Details
(3 to 5 bullet points written in polished, full sentences explaining major accomplishments, components, or findings)

## Notable Metrics & Credentials
(2 to 3 bullet points highlighting specific numbers, dates, tools, technologies, or quantitative results)

Document content:
"""
${text.slice(0, 30000)}
"""`;

    const aiSummary = await generateSummary(prompt, apiKey);
    res.json({ summary: aiSummary });
  } catch (err) {
    console.error('Summarization error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate summary.' });
  }
});

// 1. HIGH-FIDELITY OFFICE CONVERTER (DOCX, PPTX, XLSX to PDF)
app.post('/api/convert/to-pdf', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received.' });

  const inputPath = req.file.path;
  const fileNameWithoutExt = path.parse(req.file.filename).name;
  const expectedPdfPath = path.join(outDir, `${fileNameWithoutExt}.pdf`);

  // LibreOffice headless conversion command
  const cmd = `libreoffice --headless --convert-to pdf "${inputPath}" --outdir "${outDir}"`;

  exec(cmd, { timeout: 60000 }, (error, stdout, stderr) => {
    safeUnlink(inputPath);

    if (error) {
      console.error('LibreOffice Execution Error:', stderr || error);
      return res.status(500).json({ error: 'Document compilation failed.' });
    }

    if (!fs.existsSync(expectedPdfPath)) {
      return res.status(500).json({ error: 'Output PDF was not produced.' });
    }

    res.download(expectedPdfPath, `${path.parse(req.file.originalname).name}.pdf`, (err) => {
      safeUnlink(expectedPdfPath);
    });
  });
});

// 2. HIGH-FIDELITY PDF TO WORD (PDF to DOCX via LibreOffice)
app.post('/api/convert/to-docx', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received.' });

  const inputPath = req.file.path;
  const fileNameWithoutExt = path.parse(req.file.filename).name;
  const expectedDocxPath = path.join(outDir, `${fileNameWithoutExt}.docx`);

  const cmd = `libreoffice --headless --infilter="writer_pdf_import" --convert-to docx "${inputPath}" --outdir "${outDir}"`;

  exec(cmd, { timeout: 60000 }, (error, stdout, stderr) => {
    safeUnlink(inputPath);

    if (error) {
      console.error('LibreOffice Execution Error:', stderr || error);
      return res.status(500).json({ error: 'Conversion to Word failed.' });
    }

    if (!fs.existsSync(expectedDocxPath)) {
      return res.status(500).json({ error: 'DOCX file not generated.' });
    }

    res.download(expectedDocxPath, `${path.parse(req.file.originalname).name}.docx`, (err) => {
      safeUnlink(expectedDocxPath);
    });
  });
});

// 3. MERGE PDFS (pdf-lib)
app.post('/api/pdf/merge', upload.array('files'), async (req, res) => {
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded.' });

  try {
    const mergedDoc = await PDFDocument.create();

    for (const file of req.files) {
      const fileBytes = fs.readFileSync(file.path);
      const doc = await PDFDocument.load(fileBytes);
      const copiedPages = await mergedDoc.copyPages(doc, doc.getPageIndices());
      copiedPages.forEach((p) => mergedDoc.addPage(p));
      safeUnlink(file.path);
    }

    const mergedBytes = await mergedDoc.save();
    const outputPath = path.join(outDir, `Merged-${Date.now()}.pdf`);
    fs.writeFileSync(outputPath, mergedBytes);

    res.download(outputPath, 'DocGrid_Merged.pdf', (err) => {
      safeUnlink(outputPath);
    });
  } catch (err) {
    req.files.forEach((f) => safeUnlink(f.path));
    console.error(err);
    res.status(500).json({ error: 'Failed to merge documents.' });
  }
});

// 4. WATERMARK PDF (pdf-lib)
app.post('/api/pdf/watermark', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received.' });

  const watermarkText = req.body.text || 'CONFIDENTIAL';

  try {
    const fileBytes = fs.readFileSync(req.file.path);
    const doc = await PDFDocument.load(fileBytes);
    const pages = doc.getPages();

    pages.forEach((p) => {
      const { width, height } = p.getSize();
      p.drawText(watermarkText, {
        x: width / 4,
        y: height / 2,
        size: 40,
        color: rgb(0.8, 0.2, 0.2),
        opacity: 0.25,
        rotate: degrees(45)
      });
    });

    const outputBytes = await doc.save();
    const outputPath = path.join(outDir, `Watermarked-${Date.now()}.pdf`);
    fs.writeFileSync(outputPath, outputBytes);

    safeUnlink(req.file.path);

    res.download(outputPath, `Watermarked_${req.file.originalname}`, (err) => {
      safeUnlink(outputPath);
    });
  } catch (err) {
    safeUnlink(req.file.path);
    console.error(err);
    res.status(500).json({ error: 'Failed to apply watermark.' });
  }
});

app.listen(PORT, () => {
  console.log(`DocGrid conversion engine listening on port ${PORT}`);
});
