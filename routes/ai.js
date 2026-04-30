// ============================================================================
// routes/ai.js — Core AI endpoints
// ============================================================================
// Uses Claude for: chat, RFP response generation, polish, executive brief,
// effort estimation. All endpoints return JSON; multipart endpoints accept
// uploaded RFP files and extract text server-side.
// ----------------------------------------------------------------------------

const express = require('express');
const multer  = require('multer');

const { complete, completeJson } = require('../lib/anthropic');
const storage   = require('../lib/storage');
const extractor = require('../lib/extract');
const authRoute = require('./auth');
const requireAuth = authRoute.requireAuth;

const router = express.Router();

// ALL AI routes require an authenticated user
router.use(requireAuth);

// Helper — pull the right API key for this request (user's first, env fallback)
const userKey = (req) => (req.user && req.user.api_key) ? req.user.api_key : (process.env.ANTHROPIC_API_KEY || '');

// 25MB cap covers most RFPs comfortably
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/chat — Conversational + actionable chat
// ════════════════════════════════════════════════════════════════════════════
//
// Request:  { message, context, briefLoaded, briefFileName }
// Response: { text, action? }
//
// `action` is returned when the user message looks like an instruction the
// frontend can execute deterministically (e.g. "add Senior PM at 4500/day").
// We keep it conservative — only fire actions for clearly-shaped intents.
// ----------------------------------------------------------------------------
router.post('/chat', async (req, res, next) => {
  try {
    const { message, context = {} } = req.body || {};
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message is required' });
    }

    const system = [
      'You are an expert RFP bid manager assisting a vendor responding to a Request for Proposal.',
      'You give concise, professional, evidence-based answers grounded in the actual RFP text.',
      '',
      'CRITICAL — BE SPECIFIC, NEVER VAGUE:',
      '• Lead with the direct answer in the FIRST sentence. No preamble, no "Great question".',
      '• Quote exact numbers, percentages, dates, thresholds, certification names, and time windows from the RFP — do NOT paraphrase them.',
      '• When the RFP states a rule, quote the rule verbatim in quotation marks (max 14 words per quote).',
      '• If a question has a yes/no answer, start with "Yes" or "No", then justify in one sentence with a citation.',
      '• Banned hedging words unless the RFP itself uses them: "typically", "generally", "may", "could", "often", "usually", "perhaps", "tends to". Replace with the actual rule from the RFP.',
      '• If the RFP is silent on something, say so explicitly: "The RFP does not specify X." — do NOT guess.',
      '• Prefer bullets when listing 3+ facts. One fact per bullet. Each bullet must end with a citation.',
      '',
      'CRITICAL — CITATIONS (every factual claim needs one):',
      'When you state a fact from the RFP, attribute it using these EXACT formats (the UI converts these into clickable pills):',
      '  • Requirement IDs: "[REQ-001]" with square brackets',
      '  • RFP sections:    "Section 4.2"',
      '  • Page references: "Page 7"',
      'Use the Requirements Map below for IDs / sections / pages, and use [[PAGE n]] markers in the RFP snippet to find page numbers for any other quote.',
      'Every numerical value, threshold, deadline, and rule must carry at least one citation.',
      'If you cannot cite a claim because the RFP does not contain that information, say so explicitly: "Not specified in the RFP."',
      '',
      'STYLE:',
      '• Default: 1–4 short paragraphs OR a tight bulleted list. Pick whichever conveys the facts most clearly.',
      '• No emoji clutter; keep it executive-grade.',
      '• Markdown is fine; no HTML.',
      '',
      'CURRENT CONTEXT:',
      `Page: ${context.page || 'unknown'}`,
      `RFP file: ${context.rfpFileName || '(none)'}`,
      context.citationDirective ? `\n${context.citationDirective}` : '',
      context.requirementsMap   ? `\nREQUIREMENTS MAP:\n${context.requirementsMap}` : '',
      context.briefContext      ? `\nEXECUTIVE BRIEF:\n${context.briefContext}` : '',
      context.rfpSnippet        ? `\nRFP TEXT (first 4k chars, with [[PAGE n]] markers):\n${context.rfpSnippet}` : '',
      context.currentResp       ? `\nCURRENT VENDOR RESPONSE DRAFT (first 4k chars):\n${context.currentResp}` : '',
    ].filter(Boolean).join('\n');

    const { text } = await complete({
      apiKey: userKey(req),
      system,
      messages: [{ role: 'user', content: message }],
      maxTokens: 1500,
      temperature: 0.5,
    });

    // Light intent detector for "add role X at Y AED/day" — keeps the existing
    // frontend "Apply Changes" card working when users phrase requests clearly.
    const action = detectAction(message);

    res.json({ text, action });
  } catch (e) { next(e); }
});

function detectAction(msg) {
  // "add <role> at <rate> AED/day" → add_role
  const m = /add\s+([a-z][a-z\s/]+?)\s+(?:at|@)\s+(?:aed\s+)?([0-9][0-9,]+)\s*(?:aed)?\s*\/?\s*day/i.exec(msg);
  if (m) {
    return {
      type: 'add_role',
      data: {
        role: m[1].trim().replace(/\s+/g, ' '),
        phase: /qa|test/i.test(msg) ? 'Test' : /architect|design/i.test(msg) ? 'Design' : 'Build',
        daily_rate_aed: Number(m[2].replace(/,/g, '')),
        days: 60,
      },
    };
  }
  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// POST /api/generate — Full RFP response draft
// ════════════════════════════════════════════════════════════════════════════
router.post('/generate', async (req, res, next) => {
  try {
    const { rfpText = '', industry = '', company = '', references = [], hints = '' } = req.body || {};
    if (!rfpText || rfpText.length < 30) {
      return res.status(400).json({ error: 'rfpText is required and must be substantive' });
    }
    const refsBlock = (references || []).slice(0, 3)
      .map((r, i) => `--- Reference ${i + 1} ---\n${String(r).slice(0, 4000)}`)
      .join('\n\n');

    const system = [
      'You are a senior RFP bid writer. Produce a complete, professional vendor response in clean markdown.',
      'Sections: Executive Summary, Understanding of Requirements, Proposed Solution, Implementation Approach, Compliance Matrix, Team & Experience, Risk Management, Pricing Approach, References, Why Us.',
      'Match the RFP\'s tone (formal/government if applicable). Cite RFP requirements inline as [REQ-001], "Section X.Y", or "Page N" where supported by the source text.',
      'Do NOT invent certifications, partner statuses, or client names that are not in the references.',
    ].join('\n');

    const userContent = [
      `INDUSTRY: ${industry || 'Not specified'}`,
      `VENDOR COMPANY: ${company || 'Not specified'}`,
      hints ? `WRITER HINTS: ${hints}` : '',
      '',
      'RFP TEXT:',
      rfpText.slice(0, 25000),
      '',
      refsBlock ? `PRIOR RESPONSES (use as STYLE references, do not copy verbatim):\n${refsBlock}` : '',
    ].filter(Boolean).join('\n');

    const { text } = await complete({
      apiKey: userKey(req),
      system,
      messages: [{ role: 'user', content: userContent }],
      maxTokens: 6000,
      temperature: 0.5,
    });

    // Cheap heuristic scoring so the UI can show some numbers
    const scores = {
      requirements: Math.min(95, 60 + Math.floor(text.length / 500)),
      technical:    Math.min(95, 65 + Math.floor((text.match(/\bAzure|AWS|GCP|cloud|architecture\b/gi) || []).length * 1.5)),
      compliance:   Math.min(95, 60 + (text.match(/\b(ISO|NIST|GDPR|SOC2|REQ-)\b/gi) || []).length * 2),
      clarity:      Math.min(95, 65 + Math.floor(text.split(/##\s/).length * 1.5)),
      win_probability: 0,
    };
    scores.win_probability = Math.round(
      (scores.requirements * 0.3 + scores.technical * 0.3 + scores.compliance * 0.25 + scores.clarity * 0.15)
    );
    res.json({ response: text, scores });
  } catch (e) { next(e); }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/improve — Polish a section or whole response
// ════════════════════════════════════════════════════════════════════════════
router.post('/improve', async (req, res, next) => {
  try {
    const { text = '', instruction = 'Make it sharper and more professional.' } = req.body || {};
    if (!text || text.length < 10) return res.status(400).json({ error: 'text required' });

    const { text: out } = await complete({
      apiKey: userKey(req),
      system: 'You are a senior bid editor. You rewrite text per the user\'s instruction without losing factual content. Output ONLY the rewritten text — no preamble, no markdown fences.',
      messages: [{ role: 'user', content: `INSTRUCTION:\n${instruction}\n\nTEXT:\n${text}` }],
      maxTokens: 4000,
      temperature: 0.4,
    });
    res.json({ text: out });
  } catch (e) { next(e); }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/analyze-rfp (multipart) — Build the executive brief JSON
// ════════════════════════════════════════════════════════════════════════════
//
// FormData fields: rfpDoc (file), output_language, source_language, source_language_name
// Returns: { success: true, brief: { ... } }
// ----------------------------------------------------------------------------
router.post('/analyze-rfp', upload.single('rfpDoc'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'rfpDoc file is required' });
    const outLang = req.body.output_language || 'English';
    const ext = await extractor.extract(req.file.buffer, req.file.originalname);

    const system = [
      'You are a senior bid manager analysing an RFP for a vendor. Produce a structured Executive Brief as STRICT JSON.',
      'Output ONLY a single JSON object — no preamble, no markdown fences.',
      '',
      `Output language for free-text fields: ${outLang}.`,
      '',
      'JSON shape (all fields required, use null/empty array if unknown):',
      '{',
      '  "title": string,',
      '  "ref": string,                      // RFP reference / number',
      '  "issuer": string,',
      '  "industry": string,',
      '  "contract_value": string,           // formatted, with currency',
      '  "contract_duration": string,',
      '  "submission_date": string,          // YYYY-MM-DD or natural date',
      '  "qa_deadline": string,',
      '  "award_date": string,',
      '  "scope": string,                    // 2-4 sentences describing scope',
      '  "executive_summary": string,        // 3-5 sentences',
      '  "go_nogo": "GO" | "CONDITIONAL GO" | "NO GO",',
      '  "go_nogo_reason": string,',
      '  "win_probability": number,         // 0-100',
      '  "key_requirements": [',
      '    { "id": "REQ-001", "title": string, "description": string, "priority": "MANDATORY"|"HIGH"|"MEDIUM",',
      '      "section": string, "page": number }   // section/page MUST be filled where the source identifies them',
      '  ],',
      '  "eval_criteria":   [{ "criterion": string, "weight": string }],',
      '  "compliance_standards": string[],',
      '  "win_factors":     string[],',
      '  "risk_flags":      string[],',
      '  "recommended_actions": string[],',
      '  "local_content":   string,',
      '  "timeline":        [{ "date": string, "event": string }]',
      '}',
      '',
      'IMPORTANT — section/page mapping:',
      '• Use the [[PAGE n]] markers in the RFP text to populate "page" for each requirement.',
      '• Use the RFP\'s own numbering (e.g. "4.2") for "section". If the RFP uses bare headings, use the heading text.',
      '• If you genuinely cannot find a page or section, omit those keys (do NOT invent values).',
    ].join('\n');

    const { data: brief } = await completeJson({
      apiKey: userKey(req),
      system,
      messages: [{ role: 'user', content: `RFP TEXT (${ext.kind}, ${ext.pages} pages, ${ext.words} words):\n\n${ext.text.slice(0, 30000)}` }],
      maxTokens: 8000,
      temperature: 0.2,
    });

    // Persist a tiny breadcrumb so /api/recent shows it
    storage.insert('recent', {
      name: brief.title || req.file.originalname,
      page: 'briefing',
      score: Number(brief.win_probability) || 0,
    });

    res.json({ success: true, brief, source: { words: ext.words, pages: ext.pages, kind: ext.kind } });
  } catch (e) { next(e); }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/estimate-effort (multipart) — Build effort estimate JSON
// ════════════════════════════════════════════════════════════════════════════
router.post('/estimate-effort', upload.single('rfpDoc'), async (req, res, next) => {
  try {
    let rfpText = (req.body.rfpText || '').trim();
    if (req.file && !rfpText) {
      const ext = await extractor.extract(req.file.buffer, req.file.originalname);
      rfpText = ext.text;
    }
    if (!rfpText) return res.status(400).json({ error: 'Provide rfpDoc file or rfpText' });

    const projectScope    = req.body.projectScope    || '';
    const deploymentType  = req.body.deploymentType  || 'Cloud';
    const months          = Number(req.body.months)  || 6;

    const system = [
      'You are a delivery / pre-sales architect. Produce an effort estimate for a vendor responding to this RFP as STRICT JSON.',
      'Output ONLY a single JSON object — no preamble, no markdown fences.',
      '',
      'JSON shape:',
      '{',
      '  "deploymentType": string,',
      '  "months": number,',
      '  "totalDays": number,',
      '  "costs": { "labour_aed": number, "azure_monthly_aed": number, "total_aed": number },',
      '  "roles": [',
      '    { "role": string, "phase": "Discovery"|"Design"|"Build"|"Test"|"Deploy"|"Run",',
      '      "daily_rate_aed": number, "total_days": number, "total_aed": number }',
      '  ],',
      '  "azure_services": [{ "service": string, "monthly_aed": number, "notes": string }],',
      '  "assumptions": string[],',
      '  "risks":       string[]',
      '}',
      'Use AED rates typical for UAE consulting (Junior 1500–2500, Senior 3500–5500, Principal 6000–8000).',
    ].join('\n');

    const { data } = await completeJson({
      apiKey: userKey(req),
      system,
      messages: [{ role: 'user', content:
        `DEPLOYMENT: ${deploymentType}\nMONTHS: ${months}\nSCOPE: ${projectScope}\n\nRFP TEXT:\n${rfpText.slice(0, 20000)}` }],
      maxTokens: 6000,
      temperature: 0.3,
    });

    storage.insert('estimations', {
      name: req.body.name || (req.file && req.file.originalname) || 'Estimate',
      ...data,
    });
    res.json({ success: true, estimate: data });
  } catch (e) { next(e); }
});

module.exports = router;
