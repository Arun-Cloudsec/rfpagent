// ============================================================================
// routes/fill.js — Fill vendor responses into uploaded documents
// ============================================================================
// /api/fill-docx is the most useful flow: extract text, ask Claude for a
// vendor response, and stream back a real .docx the user can download.
// /api/fill-pdf and /api/fill-xlsx are stubbed — full template fidelity is
// non-trivial to do well, and most users prefer the .docx output.
// ----------------------------------------------------------------------------

const express = require('express');
const multer  = require('multer');

const { complete } = require('../lib/anthropic');
const extractor    = require('../lib/extract');

const authRoute = require('./auth');
const requireAuth = authRoute.requireAuth;
const router = express.Router();

// All routes in this file require auth
router.use(requireAuth);

// Pull the right API key for this request — user's saved key first, env fallback
const userKey = (req) => (req.user && req.user.api_key) ? req.user.api_key : (process.env.ANTHROPIC_API_KEY || '');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// Build a minimal-but-valid .docx using the Word HTML wrapper trick. This
// avoids pulling another library and renders cleanly in MS Word & Google Docs.
function buildDocxFromHtml(htmlBody, title = 'RFP Response') {
  const docHtml =
    `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">` +
    `<head><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
    `<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->` +
    `<style>` +
    `body{font-family:Calibri,sans-serif;font-size:11pt;color:#1f2937;line-height:1.5;margin:0}` +
    `h1{font-size:22pt;color:#272160;border-bottom:2pt solid #6D69F0;padding-bottom:6pt;margin-top:18pt}` +
    `h2{font-size:14pt;color:#272160;margin-top:14pt}` +
    `h3{font-size:12pt;color:#4a4270;margin-top:10pt}` +
    `p{margin:6pt 0}` +
    `ul{margin:6pt 0 6pt 20pt}` +
    `table{border-collapse:collapse;width:100%;margin:8pt 0}` +
    `td,th{border:1pt solid #cbd5e1;padding:6pt;vertical-align:top;font-size:10pt}` +
    `th{background:#272160;color:#fff;font-weight:600}` +
    `code{background:#f1f5f9;padding:1pt 4pt;font-family:Consolas,monospace;font-size:10pt}` +
    `</style></head><body>${htmlBody}</body></html>`;
  return Buffer.from(docHtml, 'utf8');
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Convert markdown → simple Word-friendly HTML (headings, lists, tables, paragraphs).
function mdToWordHtml(md) {
  if (!md) return '';
  const lines = md.split('\n');
  const out = [];
  let inList = false;
  let inTable = false;
  let tableRows = [];

  const flushTable = () => {
    if (!inTable) return;
    if (tableRows.length) {
      const head = tableRows[0];
      const body = tableRows.slice(2); // skip the | --- | --- | row
      out.push('<table>');
      out.push('<tr>' + head.map(c => `<th>${escapeHtml(c.trim())}</th>`).join('') + '</tr>');
      body.forEach(r => out.push('<tr>' + r.map(c => `<td>${escapeHtml(c.trim())}</td>`).join('') + '</tr>'));
      out.push('</table>');
    }
    inTable = false;
    tableRows = [];
  };
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');

    if (/^\s*\|.*\|\s*$/.test(line)) {
      closeList();
      inTable = true;
      tableRows.push(line.replace(/^\||\|$/g, '').split('|'));
      continue;
    } else if (inTable) {
      flushTable();
    }

    if (/^#\s+/.test(line))      { closeList(); out.push(`<h1>${escapeHtml(line.replace(/^#\s+/, ''))}</h1>`); continue; }
    if (/^##\s+/.test(line))     { closeList(); out.push(`<h2>${escapeHtml(line.replace(/^##\s+/, ''))}</h2>`); continue; }
    if (/^###\s+/.test(line))    { closeList(); out.push(`<h3>${escapeHtml(line.replace(/^###\s+/, ''))}</h3>`); continue; }
    if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inlineMd(line.replace(/^\s*[-*]\s+/, ''))}</li>`);
      continue;
    }
    closeList();
    if (line.trim() === '') { out.push(''); continue; }
    out.push(`<p>${inlineMd(line)}</p>`);
  }
  closeList();
  flushTable();
  return out.join('\n');
}

function inlineMd(s) {
  // Order matters: strong before em; escape first.
  let h = escapeHtml(s);
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
  return h;
}

// ── /api/fill-docx — generate a vendor response .docx from an uploaded RFP ─
router.post('/fill-docx', upload.single('rfpDoc'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'rfpDoc file is required' });
    const ext = await extractor.extract(req.file.buffer, req.file.originalname);

    const company  = req.body.company  || 'Our Company';
    const industry = req.body.industry || '';

    const { text: md } = await complete({
      apiKey: userKey(req),
      system: [
        'You are a senior RFP bid writer. Generate a complete vendor response in markdown.',
        'Sections: Executive Summary, Understanding of Requirements, Proposed Solution, Implementation Approach, Compliance Matrix (use a markdown table), Team & Experience, Risk Management, Pricing Approach, References, Why Us.',
        'Cite RFP requirements inline using [REQ-XXX], "Section X.Y", "Page N" where the RFP text supports it.',
        'Do NOT invent partner statuses or client names.',
      ].join('\n'),
      messages: [{ role: 'user', content:
        `INDUSTRY: ${industry}\nVENDOR: ${company}\n\nRFP TEXT:\n${ext.text.slice(0, 25000)}` }],
      maxTokens: 6000,
      temperature: 0.4,
    });

    const html = mdToWordHtml(md);
    const buf  = buildDocxFromHtml(html, `${company} — ${req.file.originalname}`);
    const safeName = (req.file.originalname || 'rfp').replace(/\.(docx?|pdf|xlsx?|txt)$/i, '').replace(/[^a-z0-9]+/gi, '_');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="Filled_${safeName}.docx"`);
    res.send(buf);
  } catch (e) { next(e); }
});

// ── /api/fill-pdf and /api/fill-xlsx — return a clear "use docx flow" message ─
router.post('/fill-pdf', upload.single('rfpDoc'), (_req, res) => {
  res.status(501).json({
    error: 'PDF fill is not implemented in the open-source backend. Please use the "Fill RFP Document (.docx)" flow — convert the PDF to .docx first (Word, Acrobat, or Google Docs) and re-upload.',
    suggestion: 'fill-docx',
  });
});

router.post('/fill-xlsx', upload.single('rfpDoc'), (_req, res) => {
  res.status(501).json({
    error: 'XLSX fill is not implemented in the open-source backend. Export the spreadsheet to .docx (one sheet per section) or paste the requirements into the text RFP zone.',
    suggestion: 'fill-docx',
  });
});

module.exports = router;
