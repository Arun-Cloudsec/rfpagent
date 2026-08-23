// ============================================================================
// lib/pricing.js — Claude model pricing + per-request cost calculation
// ============================================================================
// Rates are USD per million tokens, taken from Anthropic's published pricing
// page and verified on 2026-08-21:
//   https://platform.claude.com/docs/en/about-claude/pricing
//
// Prompt caching multipliers are applied relative to base input:
//   5-minute cache write = 1.25x   1-hour cache write = 2x   cache read = 0.1x
// The API reports cache_creation_input_tokens and cache_read_input_tokens
// separately from input_tokens, so cached traffic is costed correctly rather
// than being billed at the full input rate.
// ----------------------------------------------------------------------------

const PRICING_VERIFIED = '2026-08-21';

// model-id fragment → { in, out } USD per million tokens
const RATES = [
  // Frontier tier
  [/fable-?5|mythos-?5/i,          { in: 10.00, out: 50.00, label: 'Claude Fable/Mythos 5' }],
  // Opus
  [/opus-?5/i,                     { in:  5.00, out: 25.00, label: 'Claude Opus 5' }],
  [/opus-?4[.-]?8/i,               { in:  5.00, out: 25.00, label: 'Claude Opus 4.8' }],
  [/opus-?4[.-]?7/i,               { in:  5.00, out: 25.00, label: 'Claude Opus 4.7' }],
  [/opus-?4[.-]?6/i,               { in:  5.00, out: 25.00, label: 'Claude Opus 4.6' }],
  [/opus-?4[.-]?5/i,               { in:  5.00, out: 25.00, label: 'Claude Opus 4.5' }],
  [/opus-?4[.-]?1/i,               { in: 15.00, out: 75.00, label: 'Claude Opus 4.1 (retired)' }],
  // Sonnet
  [/sonnet-?5/i,                   { in:  2.00, out: 10.00, label: 'Claude Sonnet 5' }],
  [/sonnet-?4[.-]?6/i,             { in:  3.00, out: 15.00, label: 'Claude Sonnet 4.6' }],
  [/sonnet-?4[.-]?5/i,             { in:  3.00, out: 15.00, label: 'Claude Sonnet 4.5' }],
  [/sonnet-?4/i,                   { in:  3.00, out: 15.00, label: 'Claude Sonnet 4' }],
  // Haiku
  [/haiku-?4[.-]?5/i,              { in:  1.00, out:  5.00, label: 'Claude Haiku 4.5' }],
  [/haiku-?3[.-]?5/i,              { in:  0.80, out:  4.00, label: 'Claude Haiku 3.5 (retired)' }],
  // Broad fallbacks, checked last
  [/opus/i,                        { in:  5.00, out: 25.00, label: 'Claude Opus (assumed)' }],
  [/sonnet/i,                      { in:  3.00, out: 15.00, label: 'Claude Sonnet (assumed)' }],
  [/haiku/i,                       { in:  1.00, out:  5.00, label: 'Claude Haiku (assumed)' }],
];

// Fast mode (Opus 5 / 4.8 only) bills at 2x base.
const FAST_MODE_MULTIPLIER = 2;
// US-only inference (inference_geo:"us") on Claude 4.6+ bills at 1.1x.
const US_GEO_MULTIPLIER = 1.1;

const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2.0;
const CACHE_READ     = 0.1;

/** Look up per-MTok rates for a model id. Never throws — unknown models return
 *  a zero-rate entry flagged `known:false` so cost shows as unavailable rather
 *  than silently wrong. */
function ratesFor(model) {
  const m = String(model || '');
  for (const [re, r] of RATES) {
    if (re.test(m)) return { ...r, known: true };
  }
  return { in: 0, out: 0, label: m || 'unknown model', known: false };
}

/**
 * Cost a single API response.
 * @param {string} model
 * @param {object} usage  Anthropic usage block
 * @param {object} [opts] { fastMode, usGeo, batch }
 */
function costOf(model, usage = {}, opts = {}) {
  const r = ratesFor(model);

  const inTok    = Number(usage.input_tokens || 0);
  const outTok   = Number(usage.output_tokens || 0);
  const cacheW   = Number(usage.cache_creation_input_tokens || 0);
  const cacheR   = Number(usage.cache_read_input_tokens || 0);

  let mult = 1;
  if (opts.fastMode) mult *= FAST_MODE_MULTIPLIER;
  if (opts.usGeo)    mult *= US_GEO_MULTIPLIER;
  if (opts.batch)    mult *= 0.5;

  const per = n => (n / 1_000_000);
  const inCost    = per(inTok)  * r.in  * mult;
  const outCost   = per(outTok) * r.out * mult;
  // Cache writes default to the 5-minute rate; pass cacheWrite1h for the longer TTL
  const wRate     = opts.cacheWrite1h ? CACHE_WRITE_1H : CACHE_WRITE_5M;
  const cacheWCost = per(cacheW) * r.in * wRate * mult;
  const cacheRCost = per(cacheR) * r.in * CACHE_READ * mult;

  const total = inCost + outCost + cacheWCost + cacheRCost;

  return {
    model,
    model_label: r.label,
    rate_in: r.in,
    rate_out: r.out,
    known_pricing: r.known,
    input_tokens: inTok,
    output_tokens: outTok,
    cache_write_tokens: cacheW,
    cache_read_tokens: cacheR,
    total_tokens: inTok + outTok + cacheW + cacheR,
    cost_input: round6(inCost),
    cost_output: round6(outCost),
    cost_cache_write: round6(cacheWCost),
    cost_cache_read: round6(cacheRCost),
    cost_total: round6(total),
    multiplier: mult,
  };
}

function round6(n) { return Math.round(n * 1e6) / 1e6; }

/** What the same call would have cost on each other tier — the basis for the
 *  "you could save X" guidance in the dashboard. */
function compareTiers(usage, models) {
  return models.map(m => {
    const c = costOf(m.model, usage);
    return { tier: m.tier, model: m.model, label: c.model_label, cost_total: c.cost_total };
  });
}

/** Format USD sensibly across six orders of magnitude. */
function fmtUsd(n) {
  const v = Number(n || 0);
  if (v === 0) return '$0.00';
  if (v < 0.01) return '$' + v.toFixed(4);
  if (v < 1)    return '$' + v.toFixed(3);
  return '$' + v.toFixed(2);
}

// ════════════════════════════════════════════════════════════════════════════
// ElevenLabs text-to-speech
// ════════════════════════════════════════════════════════════════════════════
// Billed per CHARACTER, not per token, and metered as "credits" drawn against a
// monthly subscription allowance rather than invoiced per call. The figures
// below are the published API rates (verified 2026-08-21) and are best read as
// "what this generation consumed, valued at the overage rate" — not a precise
// invoice line. Your effective rate depends on your plan tier.
//
//   Multilingual v2 / v3 → $0.10 per 1,000 chars   (1 credit  per character)
//   Flash / Turbo v2.5   → $0.05 per 1,000 chars   (0.5 credits per character)
// Override with TTS_RATE_MULTILINGUAL / TTS_RATE_FLASH if your plan differs.
const TTS_RATES = {
  multilingual: Number(process.env.TTS_RATE_MULTILINGUAL || 0.10) / 1000,
  flash:        Number(process.env.TTS_RATE_FLASH        || 0.05) / 1000,
};
const TTS_VERIFIED = '2026-08-21';

function ttsFamily(model) {
  return /flash|turbo/i.test(String(model || '')) ? 'flash' : 'multilingual';
}

/**
 * Cost one TTS generation.
 * @param {string} model  ElevenLabs model_id
 * @param {number} chars  characters submitted
 */
function costOfTts(model, chars = 0) {
  const family = ttsFamily(model);
  const rate = TTS_RATES[family];
  const n = Number(chars) || 0;
  // Credits: 1/char on multilingual, 0.5/char on flash & turbo
  const credits = family === 'flash' ? n * 0.5 : n;
  return {
    provider: 'elevenlabs',
    model,
    family,
    characters: n,
    credits,
    rate_per_1k: rate * 1000,
    cost_total: Math.round(n * rate * 1e6) / 1e6,
    // ~1,000 characters is roughly a minute of speech
    approx_minutes: Math.round((n / 1000) * 10) / 10,
    estimated: true,          // plan-dependent — never present as exact
  };
}

module.exports = {
  RATES, ratesFor, costOf, compareTiers, fmtUsd,
  TTS_RATES, TTS_VERIFIED, ttsFamily, costOfTts,
  PRICING_VERIFIED, FAST_MODE_MULTIPLIER, US_GEO_MULTIPLIER,
  CACHE_WRITE_5M, CACHE_WRITE_1H, CACHE_READ,
};
