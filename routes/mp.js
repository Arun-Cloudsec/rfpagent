// ============================================================================
// routes/mp.js — Multi-agent / advanced features
// ============================================================================
// Mounted at /api/mp/*  — paths in this file are relative to that prefix.
// ----------------------------------------------------------------------------

const express = require('express');
const multer  = require('multer');
const Anthropic = require('@anthropic-ai/sdk');

const { complete, completeJson, DEFAULT_MODEL } = require('../lib/anthropic');
const extractor = require('../lib/extract');

const authRoute = require('./auth');
const requireAuth = authRoute.requireAuth;
const router = express.Router();

// All routes in this file require auth
router.use(requireAuth);

// Pull the right API key for this request — user's saved key first, env fallback
const userKey = (req) => (req.user && req.user.api_key) ? req.user.api_key : (process.env.ANTHROPIC_API_KEY || '');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// ── /api/mp/ingest — server-side text extraction for any file type ─────────
router.post('/ingest', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file is required' });
    const out = await extractor.extract(req.file.buffer, req.file.originalname);
    res.json({ success: true, ...out, filename: req.file.originalname });
  } catch (e) { next(e); }
});

// ── /api/mp/clarifications/ai-suggest ──────────────────────────────────────
router.post('/clarifications/ai-suggest', async (req, res, next) => {
  try {
    const { rfpText = '', existing = [] } = req.body || {};
    if (!rfpText) return res.status(400).json({ error: 'rfpText required' });

    const system = [
      'You are a senior bid manager. Find ambiguities, missing info, and conflicts in this RFP that the vendor should clarify with the buyer BEFORE submitting.',
      'Return STRICT JSON: an array of objects with these keys (all required):',
      '{ "id": "AI-001", "topic": string, "question": string, "rfp_reference": string,',
      '  "section": string, "page": number,',
      '  "severity": "high"|"medium"|"low", "impacts": string[] }',
      'Skip questions that match anything in EXISTING.',
      'Output ONLY the JSON array — no preamble, no markdown fences.',
    ].join('\n');

    const { data } = await completeJson({
      apiKey: userKey(req),
      system,
      messages: [{ role: 'user', content:
        `EXISTING CLARIFICATIONS:\n${(existing || []).map(e => '- ' + (e.topic || e.question || '')).join('\n') || '(none)'}\n\nRFP TEXT:\n${rfpText.slice(0, 20000)}` }],
      maxTokens: 2500,
      temperature: 0.3,
    });
    res.json({ success: true, clarifications: Array.isArray(data) ? data : (data.clarifications || []) });
  } catch (e) { next(e); }
});

// ── /api/mp/outline/check-coverage ─────────────────────────────────────────
router.post('/outline/check-coverage', async (req, res, next) => {
  try {
    const { rfpText = '', sections = [] } = req.body || {};
    if (!rfpText) return res.status(400).json({ error: 'rfpText required' });

    const system = [
      'You map an RFP\'s requirements to a vendor\'s response outline and identify GAPS.',
      'Output STRICT JSON: { "coverage": [{ "rfp_clause": string, "rfp_requirement": string,',
      '  "section": string, "page": number, "response_section": string,',
      '  "status": "Fully Addressed"|"Partially Addressed"|"To Address" }] }',
      'Output ONLY JSON — no preamble, no markdown fences.',
    ].join('\n');

    const { data } = await completeJson({
      apiKey: userKey(req),
      system,
      messages: [{ role: 'user', content:
        `RESPONSE OUTLINE:\n${(sections || []).map(s => `- ${s.num || ''} ${s.title || s.heading || ''}`).join('\n')}\n\nRFP TEXT:\n${rfpText.slice(0, 20000)}` }],
      maxTokens: 3000,
      temperature: 0.2,
    });
    res.json({ success: true, ...(data.coverage ? data : { coverage: data }) });
  } catch (e) { next(e); }
});

// ── /api/mp/section-edit ───────────────────────────────────────────────────
router.post('/section-edit', async (req, res, next) => {
  try {
    const { sectionTitle = '', currentText = '', instruction = '', rfpContext = '' } = req.body || {};
    if (!instruction) return res.status(400).json({ error: 'instruction required' });

    const { text } = await complete({
      apiKey: userKey(req),
      system: 'You are a senior bid writer. Apply the user\'s instruction to the section text. Keep RFP citations like [REQ-XXX], "Section X.Y", "Page N" intact and add new ones where appropriate. Output ONLY the rewritten section — no preamble.',
      messages: [{ role: 'user', content:
        `SECTION: ${sectionTitle}\nINSTRUCTION: ${instruction}\n\nCURRENT TEXT:\n${currentText}\n\nRFP CONTEXT (excerpt):\n${(rfpContext || '').slice(0, 6000)}` }],
      maxTokens: 3500,
      temperature: 0.4,
    });
    res.json({ success: true, text });
  } catch (e) { next(e); }
});

// ── /api/mp/section-polish ─────────────────────────────────────────────────
router.post('/section-polish', async (req, res, next) => {
  try {
    const { text = '' } = req.body || {};
    if (!text) return res.status(400).json({ error: 'text required' });

    const { text: out } = await complete({
      apiKey: userKey(req),
      system: 'You are an executive bid editor. Improve clarity, parallelism, and precision. Tighten verbose passages by 10–20%. Preserve all citations like [REQ-XXX], "Section X.Y", "Page N". Output ONLY the polished text.',
      messages: [{ role: 'user', content: text }],
      maxTokens: 3500,
      temperature: 0.3,
    });
    res.json({ success: true, text: out });
  } catch (e) { next(e); }
});

// ── /api/mp/validate-draft ─────────────────────────────────────────────────
router.post('/validate-draft', async (req, res, next) => {
  try {
    const { draft = '', rfpText = '' } = req.body || {};
    if (!draft) return res.status(400).json({ error: 'draft required' });

    const system = [
      'You are a compliance reviewer. Check the vendor draft against the RFP and produce STRICT JSON:',
      '{ "issues": [{ "severity": "high"|"medium"|"low", "category": "Compliance"|"Clarity"|"Citation"|"Tone"|"Pricing",',
      '   "where": string, "issue": string, "suggestion": string,',
      '   "rfp_section": string, "rfp_page": number }],',
      '  "summary": string, "ready_to_submit": boolean }',
      'Output ONLY JSON.',
    ].join('\n');

    const { data } = await completeJson({
      apiKey: userKey(req),
      system,
      messages: [{ role: 'user', content: `DRAFT:\n${draft.slice(0, 15000)}\n\nRFP TEXT:\n${(rfpText || '').slice(0, 12000)}` }],
      maxTokens: 3500,
      temperature: 0.2,
    });
    res.json({ success: true, ...data });
  } catch (e) { next(e); }
});

// ── /api/mp/analyze-image — multimodal vision call ─────────────────────────
router.post('/analyze-image', upload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'image required' });
    const key = userKey(req);
    if (!key) {
      const e = new Error('No Anthropic API key configured. Add yours in Settings → Anthropic API Key.');
      e.status = 503; throw e;
    }
    const c = new Anthropic({ apiKey: key });
    const mediaType = req.file.mimetype || 'image/png';
    const base64    = req.file.buffer.toString('base64');
    const prompt    = req.body.prompt || 'Describe this image in detail. If it is an architecture diagram, list the components.';

    const resp = await c.messages.create({
      model: process.env.CLAUDE_MODEL || DEFAULT_MODEL,
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: prompt },
        ],
      }],
    });
    const text = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    res.json({ success: true, text });
  } catch (e) { next(e); }
});

// ── /api/mp/project/* — placeholder so frontend save calls don't 404 ───────
// The frontend persists project state in localStorage; we only ack here.
router.all('/project/*', (req, res) => {
  res.json({ success: true, ack: true, method: req.method, path: req.path });
});

module.exports = router;
