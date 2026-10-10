const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs');
const { PDFDocument, StandardFonts, degrees, rgb } = require('pdf-lib');

const execFileP = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for Vercel deployment (expose size headers used by Compress PDF)
app.use(cors({ origin: '*', exposedHeaders: ['X-Original-Size', 'X-Result-Size', 'X-Target-Met'] }));
// Large limit: the browser sends extracted document text for AI tools
app.use(express.json({ limit: '10mb' }));

// Serve only the front-end page (not the server source files)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Temporary upload / output directories
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

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------
function safeUnlink(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    console.error('Error cleaning up:', err);
  }
}

function safeRmDir(dirPath) {
  try {
    if (dirPath && fs.existsSync(dirPath)) fs.rmSync(dirPath, { recursive: true, force: true });
  } catch (err) {
    console.error('Error cleaning up folder:', err);
  }
}

function newOutPath(prefix, ext) {
  return path.join(outDir, `${prefix}-${Date.now()}-${Math.round(Math.random() * 1e9)}.${ext || 'pdf'}`);
}

function isPdfFile(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(1024);
    fs.readSync(fd, buf, 0, 1024, 0);
    fs.closeSync(fd);
    return buf.toString('latin1').includes('%PDF-');
  } catch (e) {
    return false;
  }
}

// Returns true when the upload is present and is really a PDF
function requirePdf(req, res) {
  if (!req.file) {
    res.status(400).json({ error: 'No file received.' });
    return false;
  }
  if (!isPdfFile(req.file.path)) {
    safeUnlink(req.file.path);
    res.status(400).json({ error: 'That file is not a valid PDF.' });
    return false;
  }
  return true;
}

function downloadAndClean(res, filePath, downloadName, alsoDelete) {
  res.download(filePath, downloadName, () => {
    safeUnlink(filePath);
    (alsoDelete || []).forEach(safeUnlink);
  });
}

// qpdf exit code 3 means "finished with warnings" (the output file is fine)
async function runQpdf(args) {
  try {
    await execFileP('qpdf', args, { timeout: 90000 });
  } catch (e) {
    if (e && e.code === 3) return;
    throw e;
  }
}

// LibreOffice can only run one conversion at a time reliably, so requests are queued
let libreChain = Promise.resolve();
function withLibreOffice(task) {
  const run = libreChain.then(task, task);
  libreChain = run.catch(() => {});
  return run;
}

// Converts a file with LibreOffice and returns the path of the result (written to outDir)
async function libreConvert(inputPath, targetExt, extraArgs) {
  const args = [
    '--headless',
    '--norestore',
    '-env:UserInstallation=file:///tmp/docgrid-lo-profile',
    ...(extraArgs || []),
    '--convert-to', targetExt,
    '--outdir', outDir,
    inputPath
  ];
  await withLibreOffice(() => execFileP('libreoffice', args, { timeout: 120000 }));
  const out = path.join(outDir, `${path.parse(inputPath).name}.${targetExt.split(':')[0]}`);
  if (!fs.existsSync(out)) throw new Error('The converted file was not produced.');
  return out;
}

function safeBase(filename) {
  const base = String(filename || 'document')
    .replace(/\.[^/.]+$/, '')
    .replace(/[\\/:*?"<>|\r\n]+/g, '_')
    .trim()
    .slice(0, 80);
  return base || 'document';
}

// Health Check
let workingGeminiModel = null;
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    engine: 'LibreOffice Headless + Poppler + Ghostscript + qpdf',
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

async function callGemini(model, promptOrParts, apiKey, opts) {
  const parts = Array.isArray(promptOrParts) ? promptOrParts : [{ text: promptOrParts }];
  const generationConfig = { temperature: 0.2, maxOutputTokens: 8192 };
  if (opts && opts.json) generationConfig.responseMimeType = 'application/json';

  const response = await fetch(`${GEMINI_BASE}/models/${model}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig
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

async function generateTextOnce(prompt, apiKey, opts) {
  const order = [...new Set([workingGeminiModel, ...PREFERRED_MODELS].filter(Boolean))];
  const tried = [];
  let lastMessage = 'Gemini API request failed.';
  let lastStatus = 0;

  const attempt = async (model) => {
    tried.push(model);
    const result = await callGemini(model, prompt, apiKey, opts);

    if (result.ok) {
      const text = extractText(result.data);
      if (text) {
        workingGeminiModel = model;
        return { text };
      }
      const reason = result.data?.promptFeedback?.blockReason || result.data?.candidates?.[0]?.finishReason || 'empty response';
      lastMessage = `Gemini returned no text (${reason}).`;
      lastStatus = 0;
      return { retry: true };
    }

    lastStatus = result.status;
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

  const err = new Error(lastMessage);
  if (lastStatus === 429) {
    err.quota = true;
    err.message = 'The free Gemini usage limit was reached. Please wait a minute and try again.';
  }
  throw err;
}

// Retries a few times when Google says "too many requests"
async function generateText(prompt, apiKey, opts) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      return await generateTextOnce(prompt, apiKey, opts || {});
    } catch (err) {
      lastErr = err;
      if (!err.quota) throw err;
      await sleep(6000 * (i + 1));
    }
  }
  throw lastErr;
}

function parseJsonLoose(raw) {
  const cleaned = String(raw || '').replace(/```json|```/gi, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    const a = cleaned.indexOf('{');
    const b = cleaned.lastIndexOf('}');
    if (a !== -1 && b > a) {
      try {
        return JSON.parse(cleaned.slice(a, b + 1));
      } catch (e2) {
        /* fall through */
      }
    }
  }
  throw new Error('The AI response could not be read (it may have been cut off). Please try again.');
}

function requireGeminiKey(res) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'GEMINI_API_KEY is not configured on the server.' });
    return null;
  }
  return apiKey;
}

// =====================================================================
// AI EXECUTIVE SUMMARIZER (Powered by Google Gemini)
// =====================================================================
app.post('/api/summarize', async (req, res) => {
  try {
    const { text, filename, length, language, pageCount } = req.body;
    const images = (Array.isArray(req.body.images) ? req.body.images : [])
      .filter((i) => typeof i === 'string' && i.length > 100)
      .slice(0, 12)
      .map((i) => i.replace(/^data:image\/\w+;base64,/, ''));
    const cleanText = typeof text === 'string' ? text.trim() : '';

    if (cleanText.length < 30 && !images.length) {
      return res.status(400).json({ error: 'Insufficient document text provided.' });
    }

    const apiKey = requireGeminiKey(res);
    if (!apiKey) return;

    const lengthRule = SUMMARY_LENGTHS[length] || SUMMARY_LENGTHS.standard;
    const langRule = LANGS[language]
      ? `Write the summary in ${LANGS[language]}.`
      : 'Write the summary in the same language as the document.';
    const sourceNote = images.length
      ? 'The document is also given as page images (a scan or photo). Read all the text in the images carefully, then summarize it.'
      : 'The text was extracted automatically, so line breaks, columns and page markers may look imperfect. Use the page markers only to understand the structure.';
    const docName = String(filename || 'Document').replace(/["\r\n]+/g, ' ').slice(0, 120);

    const prompt = `You are an expert analyst who writes accurate, easy-to-read summaries of documents.
Document name: "${docName}"${pageCount ? ` (${pageCount} pages)` : ''}
${sourceNote}

First work out what kind of document this is (for example a report, contract, invoice, resume, research paper, letter, presentation, manual, study notes or a form) and summarize it the way a careful reader would for that type.

Use exactly this Markdown format:
## Document Overview
One short paragraph: what the document is, who it is from or for if stated, and its main purpose.
## Key Points
* The most important points, each one a complete sentence.
## Important Details
* Specific facts worth remembering, depending on the document: names, dates, amounts, figures, deadlines, requirements, skills, technologies. Quote numbers exactly as written.
## Conclusions & Next Steps
* Decisions, conclusions, recommendations or actions. Leave this whole section out if the document has none.

Rules:
- Base everything only on the document. Never invent facts. If something is unclear, missing or unreadable, say so.
- ${lengthRule}
- ${langRule}
- Do not mention these instructions and do not add any text outside the format above.`;

    const parts = [{ text: prompt + (cleanText ? `\n\nDocument content:\n"""\n${truncateMiddle(cleanText, 150000)}\n"""` : '') }];
    images.forEach((data) => parts.push({ inline_data: { mime_type: 'image/jpeg', data } }));

    const aiSummary = await generateText(parts, apiKey);
    res.json({ summary: aiSummary });
  } catch (err) {
    console.error('Summarization error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate summary.' });
  }
});

const SUMMARY_LENGTHS = {
  brief: 'Keep it brief: about 120-180 words in total, with a 1-2 sentence overview and 3-4 bullets under Key Points.',
  standard: 'Aim for about 250-400 words in total.',
  detailed: 'Be thorough: about 600-900 words, covering every major section or topic in the order it appears.'
};

function truncateMiddle(text, max) {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  return text.slice(0, head) + '\n\n[... the middle of this very long document is omitted ...]\n\n' + text.slice(-tail);
}

function isMostlyRtl(s) {
  const letters = String(s).match(/\p{L}/gu) || [];
  const rtl = String(s).match(/[\u0590-\u08FF]/g) || [];
  return letters.length > 0 && rtl.length / letters.length > 0.3;
}

// Very small Markdown -> HTML converter for the summary (headings, bullets, **bold**)
function summaryToHtml(md, dirAttr) {
  const inline = (t) => escapeHtml(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  let html = '';
  let inList = false;
  const closeList = () => {
    if (inList) {
      html += '</ul>';
      inList = false;
    }
  };
  for (const raw of String(md).replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (!line) {
      closeList();
      continue;
    }
    let m;
    if ((m = line.match(/^#{1,3}\s+(.*)$/))) {
      closeList();
      html += `<h2${dirAttr}>${inline(m[1])}</h2>`;
    } else if ((m = line.match(/^[*\-\u2022]\s+(.*)$/))) {
      if (!inList) {
        html += `<ul${dirAttr}>`;
        inList = true;
      }
      html += `<li>${inline(m[1])}</li>`;
    } else {
      closeList();
      html += `<p${dirAttr}>${inline(line)}</p>`;
    }
  }
  closeList();
  return html;
}

// Builds the summary PDF with LibreOffice + Noto fonts (so every language renders correctly)
app.post('/api/summary/pdf', async (req, res) => {
  const { summary, filename, pageCount } = req.body;
  if (!summary || String(summary).trim().length < 10) {
    return res.status(400).json({ error: 'No summary to build the PDF from.' });
  }

  const dirAttr = isMostlyRtl(summary) ? ' dir="rtl"' : '';
  const name = safeBase(filename);
  const htmlPath = newOutPath('summary', 'html');
  let pdfPath;

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  body { font-family: 'Noto Sans', 'Noto Sans CJK SC', 'Liberation Sans', sans-serif; font-size: 10.5pt; line-height: 1.55; color: #1e293b; }
  h1 { font-size: 18pt; margin: 0 0 4pt 0; color: #0c4a6e; }
  h2 { font-size: 12.5pt; margin: 14pt 0 4pt 0; color: #0369a1; }
  p { margin: 0 0 6pt 0; }
  li { margin: 0 0 4pt 0; }
  .meta { font-size: 9pt; color: #64748b; margin: 0 0 10pt 0; }
  .foot { font-size: 8.5pt; color: #94a3b8; margin-top: 16pt; }
</style></head>
<body>
<h1>DocGrid AI Summary</h1>
<p class="meta">Document: ${escapeHtml(name)}${pageCount ? ` | ${Number(pageCount) || ''} pages` : ''} | Created ${new Date().toISOString().slice(0, 10)}</p>
${summaryToHtml(summary, dirAttr)}
<p class="foot">Created automatically with Google Gemini. Please check important details against the original document.</p>
</body></html>`;

  try {
    fs.writeFileSync(htmlPath, html, 'utf8');
    pdfPath = await libreConvert(htmlPath, 'pdf', ['--infilter=HTML (StarWriter)']);
    downloadAndClean(res, pdfPath, `Summary_${name}.pdf`, [htmlPath]);
  } catch (err) {
    safeUnlink(htmlPath);
    safeUnlink(pdfPath);
    console.error('Summary PDF error:', err.stderr || err);
    res.status(500).json({ error: 'Could not build the summary PDF.' });
  }
});

// =====================================================================
// TRANSLATE (Gemini): the browser sends the text in chunks, then asks for a PDF
// =====================================================================
const LANGS = {
  en: 'English', hi: 'Hindi', te: 'Telugu', ta: 'Tamil', kn: 'Kannada', ml: 'Malayalam',
  bn: 'Bengali', mr: 'Marathi', gu: 'Gujarati', pa: 'Punjabi', ur: 'Urdu', es: 'Spanish',
  fr: 'French', de: 'German', pt: 'Portuguese', it: 'Italian', ru: 'Russian', ar: 'Arabic',
  zh: 'Chinese (Simplified)', ja: 'Japanese', ko: 'Korean'
};
const RTL_LANGS = ['ar', 'ur'];

app.post('/api/translate', async (req, res) => {
  try {
    const { text, targetLang } = req.body;
    const langName = LANGS[targetLang];
    if (!langName) return res.status(400).json({ error: 'Unsupported target language.' });
    if (!text || text.trim().length < 2) return res.status(400).json({ error: 'No text to translate.' });

    const apiKey = requireGeminiKey(res);
    if (!apiKey) return;

    const prompt = `Translate the text below into ${langName}.
Keep the same paragraph breaks (blank lines) and line breaks.
Keep names, numbers, dates, URLs and email addresses unchanged.
Output ONLY the translated text, with no explanations, notes or quotation marks around it.

Text:
"""
${text.slice(0, 12000)}
"""`;

    const translated = await generateText(prompt, apiKey);
    res.json({ translated });
  } catch (err) {
    console.error('Translate error:', err);
    res.status(500).json({ error: err.message || 'Translation failed.' });
  }
});

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Builds a PDF from translated text using LibreOffice + Noto fonts (supports Hindi, Telugu, Arabic, CJK...)
app.post('/api/translate/pdf', async (req, res) => {
  const { text, targetLang, filename } = req.body;
  if (!LANGS[targetLang]) return res.status(400).json({ error: 'Unsupported target language.' });
  if (!text || text.trim().length < 2) return res.status(400).json({ error: 'No text to build the PDF from.' });

  const htmlPath = newOutPath('translated', 'html');
  let pdfPath;
  const dirAttr = RTL_LANGS.includes(targetLang) ? ' dir="rtl"' : '';

  const paragraphs = String(text)
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p${dirAttr}>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  body { font-family: 'Noto Sans', 'Noto Sans CJK SC', 'Liberation Sans', sans-serif; font-size: 11pt; line-height: 1.5; }
  p { margin: 0 0 8pt 0; }
</style></head>
<body>
${paragraphs}
</body></html>`;

  try {
    fs.writeFileSync(htmlPath, html, 'utf8');
    pdfPath = await libreConvert(htmlPath, 'pdf', ['--infilter=HTML (StarWriter)']);
    downloadAndClean(res, pdfPath, `${safeBase(filename)}_${targetLang}.pdf`, [htmlPath]);
  } catch (err) {
    safeUnlink(htmlPath);
    safeUnlink(pdfPath);
    console.error('Translate PDF error:', err.stderr || err);
    res.status(500).json({ error: 'Could not build the translated PDF.' });
  }
});

// =====================================================================
// PDF TO EXCEL (Gemini finds the tables, ExcelJS builds the workbook)
// =====================================================================
app.post('/api/ai/tables', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || text.trim().length < 20) {
      return res.status(400).json({ error: 'Not enough text to look for tables.' });
    }
    const apiKey = requireGeminiKey(res);
    if (!apiKey) return;

    const prompt = `You extract tables from text taken from a PDF. Columns are separated by TAB characters or runs of spaces, and each table row is on its own line.
Find every real table (rows and columns of data, including item lists with several columns). Ignore normal paragraphs.
Return ONLY valid JSON in exactly this shape: {"tables":[{"name":"short title","rows":[["cell","cell"],["cell","cell"]]}]}
Rules: copy every row and cell exactly as in the text (never summarize or invent data); the first row is the header row when the table has one; every row must have the same number of cells (use "" for empty cells); if there are no tables return {"tables":[]}.

Text:
"""
${text.slice(0, 16000)}
"""`;

    const raw = await generateText(prompt, apiKey, { json: true });
    const parsed = parseJsonLoose(raw);
    const tables = (Array.isArray(parsed && parsed.tables) ? parsed.tables : []).filter(
      (t) => t && Array.isArray(t.rows) && t.rows.length
    );
    res.json({ tables });
  } catch (err) {
    console.error('Table extraction error:', err);
    res.status(500).json({ error: err.message || 'Table extraction failed.' });
  }
});

function toCell(v) {
  const s = String(v === null || v === undefined ? '' : v);
  const t = s.trim();
  if (/^-?\d+(\.\d+)?$/.test(t) && !/^-?0\d/.test(t) && t.length < 16) return Number(t);
  return s;
}

app.post('/api/convert/tables-to-xlsx', async (req, res) => {
  try {
    const tables = req.body && req.body.tables;
    if (!Array.isArray(tables) || tables.length === 0) {
      return res.status(400).json({ error: 'No tables to export.' });
    }

    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const used = new Set();

    tables.slice(0, 50).forEach((t, i) => {
      const rows = Array.isArray(t.rows) ? t.rows.filter(Array.isArray) : [];
      if (!rows.length) return;

      let name = String(t.name || `Table ${i + 1}`).replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 28) || `Table ${i + 1}`;
      let unique = name;
      let n = 2;
      while (used.has(unique.toLowerCase())) unique = `${name.slice(0, 25)} ${n++}`;
      used.add(unique.toLowerCase());

      const ws = wb.addWorksheet(unique);
      rows.forEach((r) => ws.addRow(r.map(toCell)));
      ws.getRow(1).font = { bold: true };

      const colCount = Math.max(...rows.map((r) => r.length));
      for (let c = 1; c <= colCount; c++) {
        let max = 10;
        rows.forEach((r) => {
          max = Math.max(max, String(r[c - 1] === undefined || r[c - 1] === null ? '' : r[c - 1]).length + 2);
        });
        ws.getColumn(c).width = Math.min(max, 60);
      }
    });

    if (wb.worksheets.length === 0) return res.status(400).json({ error: 'No tables to export.' });

    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(Buffer.from(buf));
  } catch (err) {
    console.error('XLSX build error:', err);
    res.status(500).json({ error: 'Could not build the Excel file.' });
  }
});

// =====================================================================
// 1. HIGH-FIDELITY OFFICE CONVERTER (DOCX, PPTX, XLSX to PDF)
// =====================================================================
app.post('/api/convert/to-pdf', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received.' });

  const input = req.file.path;
  let out;
  try {
    out = await libreConvert(input, 'pdf');
    res.download(out, `${path.parse(req.file.originalname).name}.pdf`, () => {
      safeUnlink(out);
      safeUnlink(input);
    });
  } catch (err) {
    safeUnlink(input);
    safeUnlink(out);
    console.error('LibreOffice Execution Error:', err.stderr || err);
    res.status(500).json({ error: 'Document compilation failed. Check that the file is a valid, unprotected document.' });
  }
});

// 2. HIGH-FIDELITY PDF TO WORD (PDF to DOCX via LibreOffice)
app.post('/api/convert/to-docx', upload.single('file'), async (req, res) => {
  if (!requirePdf(req, res)) return;

  const input = req.file.path;
  let out;
  try {
    out = await libreConvert(input, 'docx', ['--infilter=writer_pdf_import']);
    res.download(out, `${path.parse(req.file.originalname).name}.docx`, () => {
      safeUnlink(out);
      safeUnlink(input);
    });
  } catch (err) {
    safeUnlink(input);
    safeUnlink(out);
    console.error('LibreOffice Execution Error:', err.stderr || err);
    res.status(500).json({ error: 'Conversion to Word failed. If the PDF is password-protected, unlock it first.' });
  }
});

// 3. PDF TO POWERPOINT (each page becomes a slide image; Poppler renders, PptxGenJS builds)
app.post('/api/convert/to-pptx', upload.single('file'), async (req, res) => {
  if (!requirePdf(req, res)) return;

  const input = req.file.path;
  const workDir = fs.mkdtempSync(path.join(outDir, 'pptx-'));
  const output = newOutPath('slides', 'pptx');

  try {
    // Slide size = size of the first PDF page (in inches)
    let dims = { w: 13.333, h: 7.5 };
    try {
      const doc = await PDFDocument.load(fs.readFileSync(input), { ignoreEncryption: true });
      const { width, height } = doc.getPage(0).getSize();
      dims = { w: width / 72, h: height / 72 };
    } catch (e) {
      /* keep default widescreen size */
    }

    // Render up to 100 pages to JPEG images
    await execFileP('pdftoppm', ['-jpeg', '-r', '110', '-l', '100', input, path.join(workDir, 'page')], {
      timeout: 180000
    });
    const images = fs.readdirSync(workDir).filter((f) => f.endsWith('.jpg')).sort();
    if (!images.length) throw new Error('No pages were rendered.');

    const pptxgen = require('pptxgenjs');
    const pres = new pptxgen();
    pres.defineLayout({ name: 'PDFPAGE', width: dims.w, height: dims.h });
    pres.layout = 'PDFPAGE';
    images.forEach((img) => {
      const slide = pres.addSlide();
      slide.addImage({ path: path.join(workDir, img), x: 0, y: 0, w: dims.w, h: dims.h });
    });
    await pres.writeFile({ fileName: output });

    const base = path.parse(req.file.originalname).name;
    safeUnlink(input);
    safeRmDir(workDir);
    downloadAndClean(res, output, `${base}.pptx`);
  } catch (err) {
    safeUnlink(input);
    safeUnlink(output);
    safeRmDir(workDir);
    console.error('PDF to PPTX error:', err.stderr || err);
    res.status(500).json({ error: 'Could not convert this PDF to PowerPoint. If it is password-protected, unlock it first.' });
  }
});

// 4. MERGE PDFS (pdf-lib) - kept as a server fallback; the page now merges in the browser
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

// 5. WATERMARK PDF (pdf-lib): centered diagonal text, sized to fit every page
app.post('/api/pdf/watermark', upload.single('file'), async (req, res) => {
  if (!requirePdf(req, res)) return;

  const input = req.file.path;
  const output = newOutPath('watermarked', 'pdf');
  const text = String(req.body.text || 'CONFIDENTIAL').trim().slice(0, 60) || 'CONFIDENTIAL';

  try {
    const doc = await PDFDocument.load(fs.readFileSync(input));
    const font = await doc.embedFont(StandardFonts.HelveticaBold);

    try {
      font.widthOfTextAtSize(text, 12);
    } catch (e) {
      safeUnlink(input);
      return res.status(400).json({ error: 'The watermark can only use English letters, numbers and common symbols.' });
    }

    const angle = Math.PI / 4;
    for (const page of doc.getPages()) {
      const { width, height } = page.getSize();
      const maxW = Math.sqrt(width * width + height * height) * 0.7;
      let size = 80;
      let tw = font.widthOfTextAtSize(text, size);
      if (tw > maxW) {
        size = (size * maxW) / tw;
        tw = maxW;
      }
      const th = font.heightAtSize(size);
      page.drawText(text, {
        x: width / 2 - (tw / 2) * Math.cos(angle) + th * 0.35 * Math.sin(angle),
        y: height / 2 - (tw / 2) * Math.sin(angle) - th * 0.35 * Math.cos(angle),
        size,
        font,
        color: rgb(0.8, 0.2, 0.2),
        opacity: 0.25,
        rotate: degrees(45)
      });
    }

    fs.writeFileSync(output, await doc.save());
    downloadAndClean(res, output, `${path.parse(req.file.originalname).name}_watermarked.pdf`, [input]);
  } catch (err) {
    safeUnlink(input);
    safeUnlink(output);
    console.error('Watermark error:', err);
    res.status(500).json({ error: 'Could not add the watermark. If the PDF is password-protected, unlock it first.' });
  }
});

// 6. COMPRESS / OPTIMIZE PDF (Ghostscript for images, qpdf for the file structure)
const COMPRESS_PRESETS = {
  low: { dpi: 200, q: 0.2 },
  recommended: { dpi: 150, q: 0.4 },
  strong: { dpi: 110, q: 0.6 },
  extreme: { dpi: 72, q: 0.9 }
};
const QUALITY_MAP = { high: 0.2, medium: 0.4, low: 0.7, verylow: 0.9 }; // Ghostscript QFactor: lower = better quality
const COMPRESS_LADDER = [
  { dpi: 150, q: 0.4 },
  { dpi: 120, q: 0.55 },
  { dpi: 96, q: 0.7 },
  { dpi: 72, q: 0.85 },
  { dpi: 60, q: 0.92 }
];

function gsCompressArgs(input, output, s, gray) {
  const dict = (q) => `<< /QFactor ${q} /Blend 1 /ColorTransform 1 /HSamples [2 1 1 2] /VSamples [2 1 1 2] >>`;
  const args = [
    '-sDEVICE=pdfwrite',
    '-dCompatibilityLevel=1.5',
    '-dPDFSETTINGS=/default',
    '-dNOPAUSE',
    '-dQUIET',
    '-dBATCH',
    '-dDetectDuplicateImages=true',
    '-dCompressFonts=true',
    '-dSubsetFonts=true',
    '-dEmbedAllFonts=true',
    '-dCompressPages=true',
    '-dDownsampleColorImages=true',
    '-dColorImageDownsampleType=/Bicubic',
    `-dColorImageResolution=${s.dpi}`,
    '-dDownsampleGrayImages=true',
    '-dGrayImageDownsampleType=/Bicubic',
    `-dGrayImageResolution=${s.dpi}`,
    '-dDownsampleMonoImages=true',
    '-dMonoImageDownsampleType=/Subsample',
    `-dMonoImageResolution=${Math.max(s.dpi, 150)}`,
    '-dAutoFilterColorImages=false',
    '-dColorImageFilter=/DCTEncode',
    '-dAutoFilterGrayImages=false',
    '-dGrayImageFilter=/DCTEncode'
  ];
  if (gray) args.push('-sColorConversionStrategy=Gray', '-dProcessColorModel=/DeviceGray');
  args.push(
    `-sOutputFile=${output}`,
    '-c',
    `<< /ColorACSImageDict ${dict(s.q)} /GrayACSImageDict ${dict(s.q)} >> setdistillerparams`,
    '-f',
    input
  );
  return args;
}

// Rewrites the PDF structure (object streams, recompressed streams); returns { path, size } or null
async function qpdfOptimize(src, tmpList) {
  const out = newOutPath('optimized', 'pdf');
  tmpList.push(out);
  try {
    await runQpdf(['--object-streams=generate', '--compress-streams=y', '--recompress-flate', '--compression-level=9', src, out]);
    return fs.existsSync(out) ? { path: out, size: fs.statSync(out).size } : null;
  } catch (e) {
    return null;
  }
}

app.post('/api/pdf/compress', upload.single('file'), async (req, res) => {
  if (!requirePdf(req, res)) return;

  const input = req.file.path;
  const tmp = [];
  const level = String(req.body.level || 'recommended');
  const gray = req.body.gray === '1' || req.body.gray === 'true';
  const targetMb = parseFloat(req.body.targetMb);
  const targetBytes = Number.isFinite(targetMb) && targetMb > 0 ? Math.round(targetMb * 1048576) : 0;

  let first;
  if (level === 'custom') {
    const dpi = Math.min(600, Math.max(36, parseInt(req.body.dpi, 10) || 150));
    const q = QUALITY_MAP[req.body.quality] !== undefined ? QUALITY_MAP[req.body.quality] : 0.4;
    first = { dpi, q };
  } else {
    first = COMPRESS_PRESETS[level] || COMPRESS_PRESETS.recommended;
  }

  // With a target size we keep trying stronger settings until the file is small enough
  const attempts = [first];
  if (targetBytes) {
    for (const step of COMPRESS_LADDER) {
      if (step.dpi < attempts[attempts.length - 1].dpi) attempts.push(step);
    }
  }

  try {
    const inSize = fs.statSync(input).size;
    const started = Date.now();
    let best = null;

    for (const s of attempts) {
      if (best && Date.now() - started > 70000) break;
      const out = newOutPath('compressed', 'pdf');
      tmp.push(out);
      try {
        await execFileP('gs', gsCompressArgs(input, out, s, gray), { timeout: 120000 });
      } catch (e) {
        if (!best) throw e;
        break;
      }
      if (!fs.existsSync(out)) continue;
      const size = fs.statSync(out).size;
      if (size > 0 && (!best || size < best.size)) best = { path: out, size };
      if (!targetBytes || size <= targetBytes) break;
    }
    if (!best) throw new Error('Ghostscript produced no output.');

    // Structure pass: often saves a little more, and sometimes helps when images were already small
    const candidates = [best];
    const o1 = await qpdfOptimize(best.path, tmp);
    if (o1) candidates.push(o1);
    if (best.size >= inSize) {
      const o2 = await qpdfOptimize(input, tmp);
      if (o2) candidates.push(o2);
    }
    candidates.sort((a, b) => a.size - b.size);
    const winner = candidates[0];
    const useCompressed = winner.size > 0 && winner.size < inSize;
    const finalSize = useCompressed ? winner.size : inSize;

    const headers = { 'X-Original-Size': String(inSize), 'X-Result-Size': String(finalSize) };
    if (targetBytes) headers['X-Target-Met'] = finalSize <= targetBytes ? '1' : '0';
    res.set(headers);

    const name = `${path.parse(req.file.originalname).name}_compressed.pdf`;
    downloadAndClean(res, useCompressed ? winner.path : input, name, [input, ...tmp]);
  } catch (err) {
    safeUnlink(input);
    tmp.forEach(safeUnlink);
    console.error('Compress error:', err.stderr || err);
    res.status(500).json({ error: 'Could not compress this PDF. If it is password-protected, unlock it first.' });
  }
});

// 7. REPAIR PDF (qpdf rewrite, Ghostscript as fallback)
app.post('/api/pdf/repair', upload.single('file'), async (req, res) => {
  if (!requirePdf(req, res)) return;

  const input = req.file.path;
  const output = newOutPath('repaired', 'pdf');
  const name = `${path.parse(req.file.originalname).name}_repaired.pdf`;

  try {
    let ok = false;
    try {
      await runQpdf([input, output]);
      ok = fs.existsSync(output) && fs.statSync(output).size > 100;
    } catch (e) {
      ok = false;
    }

    if (!ok) {
      safeUnlink(output);
      await execFileP('gs', ['-o', output, '-sDEVICE=pdfwrite', '-dPDFSETTINGS=/default', input], {
        timeout: 120000
      });
      ok = fs.existsSync(output) && fs.statSync(output).size > 100;
    }

    if (!ok) throw new Error('Repair produced no output.');
    downloadAndClean(res, output, name, [input]);
  } catch (err) {
    safeUnlink(input);
    safeUnlink(output);
    console.error('Repair error:', err.stderr || err);
    res.status(500).json({ error: 'This PDF is too damaged to repair.' });
  }
});

// 8. PROTECT PDF (qpdf, AES-256)
app.post('/api/pdf/protect', upload.single('file'), async (req, res) => {
  if (!requirePdf(req, res)) return;

  const input = req.file.path;
  const output = newOutPath('protected', 'pdf');
  const password = String(req.body.password || '');

  if (password.length < 1 || password.length > 100) {
    safeUnlink(input);
    return res.status(400).json({ error: 'Enter a password (up to 100 characters).' });
  }

  try {
    await runQpdf(['--encrypt', password, password, '256', '--', input, output]);
    if (!fs.existsSync(output)) throw new Error('No output.');
    downloadAndClean(res, output, `${path.parse(req.file.originalname).name}_protected.pdf`, [input]);
  } catch (err) {
    safeUnlink(input);
    safeUnlink(output);
    const msg = String((err && err.stderr) || err);
    console.error('Protect error:', msg);
    if (/invalid password/i.test(msg)) {
      return res.status(400).json({ error: 'This PDF already has a password. Unlock it first, then protect it again.' });
    }
    res.status(500).json({ error: 'Could not protect this PDF.' });
  }
});

// 9. UNLOCK PDF (qpdf): removes restrictions, or opens the file when the right password is given
app.post('/api/pdf/unlock', upload.single('file'), async (req, res) => {
  if (!requirePdf(req, res)) return;

  const input = req.file.path;
  const output = newOutPath('unlocked', 'pdf');
  const password = String(req.body.password || '');

  try {
    const args = ['--decrypt'];
    if (password) args.push(`--password=${password}`);
    args.push(input, output);
    await runQpdf(args);
    if (!fs.existsSync(output)) throw new Error('No output.');
    downloadAndClean(res, output, `${path.parse(req.file.originalname).name}_unlocked.pdf`, [input]);
  } catch (err) {
    safeUnlink(input);
    safeUnlink(output);
    const msg = String((err && err.stderr) || err);
    console.error('Unlock error:', msg);
    if (/invalid password/i.test(msg)) {
      return res.status(400).json({
        error: password
          ? 'That password is not correct for this PDF.'
          : 'This PDF needs a password to open. Enter it above and try again.'
      });
    }
    res.status(500).json({ error: 'Could not unlock this PDF.' });
  }
});

app.listen(PORT, () => {
  console.log(`DocGrid conversion engine listening on port ${PORT}`);
});
