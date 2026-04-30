// ============================================================================
// lib/extract.js — Server-side text extraction
// ============================================================================
// Mirrors the frontend extractor but runs server-side, so we can handle
// uploads even when the client lacks the libs. Preserves [[PAGE n]] markers
// in PDF output so the chat AI can ground answers in real page numbers.
// ----------------------------------------------------------------------------

const path     = require('path');
const mammoth  = require('mammoth');
const XLSX     = require('xlsx');

// pdf-parse v1.1.1 has a debug-mode quirk that runs sample-PDF tests when
// require()'d directly. Calling its underlying export avoids that.
const pdfParse = require('pdf-parse/lib/pdf-parse.js');

/**
 * Extract text from an uploaded file buffer.
 * @param {Buffer} buffer
 * @param {string} originalName - e.g. "RFP.pdf"
 * @returns {Promise<{text: string, words: number, pages: number, kind: string}>}
 */
async function extract(buffer, originalName = 'file') {
  if (!buffer || !buffer.length) throw new Error('Empty file');
  const ext = path.extname(originalName || '').toLowerCase().replace('.', '');

  if (ext === 'pdf') return extractPdf(buffer);
  if (ext === 'docx' || ext === 'doc') return extractDocx(buffer);
  if (ext === 'xlsx' || ext === 'xls') return extractXlsx(buffer);
  if (ext === 'txt' || ext === 'md' || ext === 'csv' || ext === 'tsv' || !ext) {
    const text = buffer.toString('utf8');
    return summary(text, ext || 'txt', 1);
  }

  // Last-ditch: try as utf8 text
  return summary(buffer.toString('utf8'), ext, 1);
}

async function extractPdf(buffer) {
  // pdf-parse exposes a per-page hook via `pagerender`. We use it to inject
  // [[PAGE n]] markers between pages so downstream prompts can cite pages.
  let currentPage = 0;
  const opts = {
    pagerender: async (pageData) => {
      currentPage += 1;
      const tc = await pageData.getTextContent({ normalizeWhitespace: true });
      const txt = tc.items.map(i => i.str).join(' ');
      return `[[PAGE ${currentPage}]] ${txt}\n`;
    },
  };
  const data = await pdfParse(buffer, opts);
  const text = (data.text || '').trim();
  if (!text) {
    const e = new Error('No text could be extracted — PDF may be scanned or image-based.');
    e.status = 422;
    throw e;
  }
  return summary(text, 'pdf', data.numpages || currentPage || 1);
}

async function extractDocx(buffer) {
  const r = await mammoth.extractRawText({ buffer });
  const text = (r.value || '').trim();
  if (!text) {
    const e = new Error('No text in DOCX (file may be empty or corrupted).');
    e.status = 422;
    throw e;
  }
  return summary(text, 'docx', 1);
}

async function extractXlsx(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  let out = '';
  wb.SheetNames.forEach(name => {
    out += `Sheet: ${name}\n`;
    out += XLSX.utils.sheet_to_csv(wb.Sheets[name]);
    out += '\n\n';
  });
  return summary(out.trim(), 'xlsx', wb.SheetNames.length);
}

function summary(text, kind, pages) {
  const words = (text.match(/\S+/g) || []).length;
  return { text, words, pages, kind, chars: text.length };
}

module.exports = { extract };
