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
      '  • Priority levels: "P1 incident", "P2 priority", "Severity 1" — also clickable',
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
// Language handling — shared by the brief + expand endpoints
// ════════════════════════════════════════════════════════════════════════════
// The frontend historically posted the target language as `language` while the
// server read `output_language`, so the target was silently ignored and every
// brief came back in English. We now accept BOTH names.
// ----------------------------------------------------------------------------
const LANG_NAMES = {
  en: 'English',    ar: 'Arabic',     fr: 'French',   es: 'Spanish',
  de: 'German',     it: 'Italian',    pt: 'Portuguese', ru: 'Russian',
  zh: 'Chinese',    ja: 'Japanese',   ko: 'Korean',   hi: 'Hindi',
  ta: 'Tamil',      tr: 'Turkish',    nl: 'Dutch',    af: 'South African English',
  id: 'Indonesian', pl: 'Polish',     sv: 'Swedish',  uk: 'Ukrainian',
};

/** Resolve the requested output language from a request body, accepting either
 *  field name and either a code ("ar") or a display name ("Arabic"). */
function resolveOutputLanguage(body = {}) {
  const raw = String(
    body.output_language || body.language || body.outputLanguage || ''
  ).trim();
  if (!raw) return 'English';
  const lower = raw.toLowerCase();
  if (LANG_NAMES[lower]) return LANG_NAMES[lower];        // was a code
  return raw;                                             // already a name
}

function resolveSourceLanguage(body = {}) {
  const name = String(body.source_language_name || '').trim();
  if (name && !/^auto/i.test(name)) return name;
  const code = String(body.source_language || '').trim().toLowerCase();
  if (code && code !== 'auto' && LANG_NAMES[code]) return LANG_NAMES[code];
  return '';                                              // auto-detect
}

/** A deliberately loud translation directive. This sits at the TOP of the
 *  system prompt — a one-line hint buried mid-prompt was being ignored. */
function langDirective(outLang, srcLang) {
  return [
    '═══════ OUTPUT LANGUAGE — THIS OVERRIDES EVERYTHING BELOW ═══════',
    `Write ALL free-text output in ${outLang}.`,
    srcLang
      ? `The source document is written in ${srcLang}. Read it in ${srcLang}, then TRANSLATE your analysis into ${outLang}.`
      : `The source document may be in ANY language (Arabic, French, Tamil, Spanish, Chinese...). Detect it, read it, then TRANSLATE your analysis into ${outLang}.`,
    `Every string VALUE you emit — summaries, scope, titles, reasons, questions, risks, event names, skill names — must be written in ${outLang}.`,
    'JSON KEYS stay in English exactly as specified in the schema. Only VALUES get translated.',
    'Leave these untranslated even inside a translated sentence: organisation and company names, RFP reference numbers, requirement IDs (REQ-001), standard and certification names (ISO 27001, NIST, SOC 2), currency codes (AED, USD), product names (Microsoft Azure), and any enum value the schema lists literally (GO, NO GO, MANDATORY, HIGH, AMBIGUITY...).',
    `If the source document is already in ${outLang}, pass the content through without translating.`,
    outLang.toLowerCase().startsWith('english')
      ? 'Target language is English — translate any non-English source into English.'
      : `Do NOT reply in English. The reader does not read English. Reply in ${outLang}.`,
    '═════════════════════════════════════════════════════════════════',
  ].join('\n');
}

// ════════════════════════════════════════════════════════════════════════════
// POST /api/analyze-rfp (multipart) — FAST executive summary ONLY
// ════════════════════════════════════════════════════════════════════════════
//
// FormData: rfpDoc (file), output_language (or language), source_language,
//           source_language_name
// Returns:  { success: true, brief: {...}, source: {...} }
//
// Deliberately LEAN. Clarifications, risk registers, decision-criteria
// matrices and effort modelling are NOT produced here — they are separate
// on-demand calls to POST /api/brief/expand. The old version asked for all of
// that in one 12k-token JSON blob, which is why the brief took ~60s. This
// version asks for roughly a tenth of the output and returns in seconds.
// ----------------------------------------------------------------------------
router.post('/analyze-rfp', upload.single('rfpDoc'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'rfpDoc file is required' });

    const outLang = resolveOutputLanguage(req.body);
    const srcLang = resolveSourceLanguage(req.body);
    const ext     = await extractor.extract(req.file.buffer, req.file.originalname);

    const system = [
      langDirective(outLang, srcLang),
      '',
      'You are a senior bid manager. In under 60 seconds a busy executive must understand what this RFP is and whether we should bid.',
      'Produce ONLY an executive summary as STRICT JSON. Output a single JSON object — no preamble, no markdown fences.',
      '',
      'SCHEMA (all keys required; use null or [] when the document does not say):',
      '{',
      '  "title": string,                    // the opportunity in one line',
      '  "ref": string,                      // RFP reference / tender number',
      '  "issuer": string,',
      '  "industry": string,',
      '  "contract_value": string,           // include the currency',
      '  "contract_duration": string,',
      '  "submission_date": string,          // YYYY-MM-DD where possible',
      '  "qa_deadline": string,',
      '  "award_date": string,',
      '  "scope": string,                    // 2-3 sentences: what the buyer wants delivered',
      '  "executive_summary": string,        // 3-4 sentences: what this is, why it matters, what it takes to win',
      '  "headlines": string[],              // 3-5 single-line facts leadership must know',
      '  "go_nogo": "GO" | "CONDITIONAL GO" | "NO GO",',
      '  "go_nogo_reason": string,           // 1-2 sentences',
      '  "win_probability": number,          // 0-100',
      '  "key_requirements": [               // TOP 5 ONLY — do not exceed 5',
      '    { "id": "REQ-001", "title": string, "description": string,',
      '      "priority": "MANDATORY"|"HIGH"|"MEDIUM", "section": string, "page": number }',
      '  ],',
      '  "eval_criteria": [{ "criterion": string, "weight": string }],',
      '  "compliance_standards": string[],   // max 8',
      '  "timeline": [{ "date": string, "event": string }]   // max 5, chronological',
      '}',
      '',
      'RULES:',
      '• Keep it SHORT. This is a summary, not an analysis. Descriptions max 20 words.',
      '• Do NOT output risks, clarification questions, mitigation plans, effort estimates, staffing or decision-criteria matrices. Those are requested separately.',
      '• Use the [[PAGE n]] markers in the text to fill "page". Use the document\'s own numbering for "section". Omit the key rather than inventing a value.',
      '• Never invent dates, values or certifications that are not in the document.',
    ].join('\n');

    const { data: brief } = await completeJson({
      apiKey: userKey(req),
      model: process.env.BRIEF_MODEL || undefined,
      system,
      messages: [{ role: 'user', content:
        `RFP DOCUMENT (${ext.kind}, ${ext.pages} pages, ${ext.words} words):\n\n${ext.text.slice(0, 16000)}` }],
      maxTokens: 3000,
      temperature: 0.2,
    });

    // Echo the language back so the UI can label / direction the slide correctly
    brief.output_language = outLang;
    brief.source_language = srcLang || 'auto-detected';

    storage.insert('recent', {
      name: brief.title || req.file.originalname,
      page: 'briefing',
      score: Number(brief.win_probability) || 0,
    });

    res.json({
      success: true,
      brief,
      source: { words: ext.words, pages: ext.pages, kind: ext.kind },
    });
  } catch (e) { next(e); }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/brief/expand (multipart) — on-demand deep-dive sections
// ════════════════════════════════════════════════════════════════════════════
//
// FormData / JSON: kind, rfpDoc (file) OR rfpText, output_language, ...
// kind ∈ clarifications | risks | rationale | effort | requirements
//
// Each pack is a separate, small model call so the user only pays the latency
// for the section they actually asked for.
// ----------------------------------------------------------------------------
const EXPAND_PACKS = {
  clarifications: {
    maxTokens: 3500,
    schema: [
      'Surface the questions the bidder must send the issuer BEFORE submitting.',
      'Return: { "clarifications": [ { "question": string, "kind": "AMBIGUITY"|"CONTRADICTION"|"GAP"|"RULE", "where": string, "impact": "HIGH"|"MEDIUM"|"LOW" } ] }',
      'AMBIGUITY = vague or undefined terms. CONTRADICTION = two parts of the document that conflict. GAP = something a bidder must know to price or scope but the document omits. RULE = a rule needing official confirmation.',
      'Be specific, not generic. Bad: "What is the budget?" Good: "Section 2.3 gives an indicative value of AED 9-14M but Annex B requires fixed-fee pricing — confirm whether that figure is a cap or indicative."',
      '"where" must cite a section or page. Aim for 5-10 items.',
    ],
  },
  risks: {
    maxTokens: 3000,
    schema: [
      'Identify delivery, commercial and compliance risks in this opportunity, plus the obligations the bidder would be signing up to.',
      'Return: { "risk_flags": [ { "risk": string, "severity": "HIGH"|"MEDIUM"|"LOW", "category": "Delivery"|"Commercial"|"Compliance"|"Technical"|"Resourcing", "where": string, "mitigation": string } ], "obligations": [ { "obligation": string, "where": string } ], "win_factors": string[], "recommended_actions": string[] }',
      'Aim for 5-8 risks, 3-6 obligations, 3-4 win factors, 3-4 actions. Cite a section or page in "where".',
    ],
  },
  rationale: {
    maxTokens: 2500,
    schema: [
      'Evaluate the major criteria that drive the bid / no-bid decision.',
      'Return: { "go_nogo_criteria": [ { "criterion": string, "verdict": "MET"|"GAP"|"PARTIAL"|"UNKNOWN", "rationale": string, "weight": "HIGH"|"MEDIUM"|"LOW" } ] }',
      'Cover mandatory certifications, headcount minimums, data residency, compliance standards and local-content thresholds where the document sets them.',
      'Judge against a typical regional MSP. Use UNKNOWN where the answer depends on the specific bidder. Cite a Section / Page / REQ id in "rationale". Aim for 4-7 criteria.',
    ],
  },
  requirements: {
    maxTokens: 4000,
    schema: [
      'Extract the full requirements list.',
      'Return: { "key_requirements": [ { "id": "REQ-001", "title": string, "description": string, "priority": "MANDATORY"|"HIGH"|"MEDIUM", "section": string, "page": number } ] }',
      'Use the [[PAGE n]] markers for "page" and the document\'s own numbering for "section". Omit those keys rather than inventing them. Aim for 10-25 requirements.',
    ],
  },
  effort: {
    maxTokens: 4000,
    schema: [
      'Produce an end-to-end delivery effort estimate.',
      'Return: { "effort_breakdown": { "phases": [ { "phase": "Design"|"Hardware Deployment"|"Implementation"|"Integration & Testing"|"Go-Live & Hypercare", "duration_weeks": number, "teams": [ { "team": "Infrastructure"|"DevOps"|"Application"|"AI/Data"|"Security"|"PMO"|"QA", "fte_count": number, "person_days": number, "skills": string[] } ] } ], "total_person_days": number, "critical_skills": string[], "team_summary": [ { "team": string, "total_person_days": number, "fte_peak": number } ] } }',
      'Scale person_days to the size described (users, sites, integrations). Skills must be specific ("Microsoft Sentinel KQL", not "Security"). team_summary must reconcile with phases[].teams[].',
    ],
  },
};

router.post('/brief/expand', upload.single('rfpDoc'), async (req, res, next) => {
  try {
    const kind = String(req.body.kind || '').trim().toLowerCase();
    const pack = EXPAND_PACKS[kind];
    if (!pack) {
      return res.status(400).json({
        success: false,
        error: `Unknown kind "${kind}". Expected one of: ${Object.keys(EXPAND_PACKS).join(', ')}`,
      });
    }

    let rfpText = String(req.body.rfpText || '').trim();
    if (req.file && !rfpText) {
      const ext = await extractor.extract(req.file.buffer, req.file.originalname);
      rfpText = ext.text;
    }
    if (!rfpText) return res.status(400).json({ success: false, error: 'Provide rfpDoc or rfpText' });

    const outLang = resolveOutputLanguage(req.body);
    const srcLang = resolveSourceLanguage(req.body);

    const system = [
      langDirective(outLang, srcLang),
      '',
      'You are a senior bid manager analysing an RFP for a vendor.',
      'Output ONLY a single STRICT JSON object — no preamble, no markdown fences.',
      '',
      ...pack.schema,
    ].join('\n');

    const context = req.body.briefContext
      ? `EXECUTIVE SUMMARY ALREADY PRODUCED (for context, do not repeat it):\n${String(req.body.briefContext).slice(0, 2000)}\n\n`
      : '';

    const { data } = await completeJson({
      apiKey: userKey(req),
      model: process.env.BRIEF_MODEL || undefined,
      system,
      messages: [{ role: 'user', content: `${context}RFP DOCUMENT (with [[PAGE n]] markers):\n\n${rfpText.slice(0, 20000)}` }],
      maxTokens: pack.maxTokens,
      temperature: 0.25,
    });

    res.json({ success: true, kind, data, output_language: outLang });
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
