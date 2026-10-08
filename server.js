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
app.use(express.json());

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
app.get('/health', (req, res) => {
  res.json({ status: 'ok', engine: 'LibreOffice Headless + Poppler' });
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