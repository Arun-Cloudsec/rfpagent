// ============================================================================
// lib/usage.js — Token + cost ledger
// ============================================================================
// Every model call is recorded here so management can see what was spent,
// on what, and where the optimisation headroom is.
//
// Backed by lib/storage.js (JSON file). On Railway the filesystem is EPHEMERAL
// — the ledger resets on redeploy. For durable reporting, point DATA_DIR at a
// volume or swap storage.js for Postgres.
// ----------------------------------------------------------------------------

const storage = require('./storage');
const pricing = require('./pricing');

const COLLECTION = 'usage';

/**
 * Record one model call.
 * @param {object} p
 * @param {string} p.operation   e.g. 'brief', 'expand:risks', 'chat'
 * @param {string} p.model
 * @param {object} p.usage       Anthropic usage block
 * @param {number} [p.ms]        wall-clock duration of the call
 * @param {string} [p.userId]
 * @param {string} [p.speed]     tier the user picked
 * @param {object} [p.meta]      anything else worth showing (doc name, language)
 */
function record({ operation, model, usage = {}, ms = null, userId = null, speed = null, meta = {} }) {
  try {
    const c = pricing.costOf(model, usage);
    const row = {
      operation: operation || 'unknown',
      model,
      model_label: c.model_label,
      speed: speed || null,
      user_id: userId || null,
      ms: ms == null ? null : Math.round(ms),
      input_tokens: c.input_tokens,
      output_tokens: c.output_tokens,
      cache_read_tokens: c.cache_read_tokens,
      cache_write_tokens: c.cache_write_tokens,
      total_tokens: c.total_tokens,
      cost_total: c.cost_total,
      cost_input: c.cost_input,
      cost_output: c.cost_output,
      known_pricing: c.known_pricing,
      ...meta,
    };
    storage.insert(COLLECTION, row);
    return row;
  } catch (e) {
    // Never let accounting break the actual request
    console.warn('[usage] failed to record:', e.message);
    return null;
  }
}

/**
 * Record one text-to-speech generation. Kept in the same ledger as model calls
 * so the dashboard can show total spend across both vendors, but tagged with
 * provider so the two are never silently added together as if they were tokens.
 */
function recordTts({ model, characters, ms = null, userId = null, language = null, meta = {} }) {
  try {
    const c = pricing.costOfTts(model, characters);
    const row = {
      operation: 'tts',
      provider: 'elevenlabs',
      model,
      model_label: 'ElevenLabs ' + (c.family === 'flash' ? 'Flash/Turbo' : 'Multilingual'),
      user_id: userId || null,
      ms: ms == null ? null : Math.round(ms),
      characters: c.characters,
      credits: c.credits,
      approx_minutes: c.approx_minutes,
      language,
      // Zeroed token fields keep the row shape uniform for the summary reducer
      input_tokens: 0, output_tokens: 0, total_tokens: 0,
      cost_total: c.cost_total,
      cost_input: 0, cost_output: 0,
      known_pricing: true,
      estimated: true,
      ...meta,
    };
    storage.insert(COLLECTION, row);
    return row;
  } catch (e) {
    console.warn('[usage] failed to record tts:', e.message);
    return null;
  }
}

function all() {
  return storage.list(COLLECTION) || [];
}

/** Aggregate the ledger into the numbers a dashboard needs. */
function summarise({ since = null, userId = null } = {}) {
  let rows = all();
  if (userId) rows = rows.filter(r => r.user_id === userId);
  if (since) {
    const t = new Date(since).getTime();
    rows = rows.filter(r => new Date(r.created_at).getTime() >= t);
  }

  const zero = () => ({ calls: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0, cost_total: 0, ms: 0 });
  const add = (acc, r) => {
    acc.calls          += 1;
    acc.input_tokens   += r.input_tokens || 0;
    acc.output_tokens  += r.output_tokens || 0;
    acc.total_tokens   += r.total_tokens || 0;
    acc.cost_total     += r.cost_total || 0;
    acc.ms             += r.ms || 0;
    return acc;
  };

  const llmRows = rows.filter(r => r.provider !== 'elevenlabs');
  const ttsRows = rows.filter(r => r.provider === 'elevenlabs');

  const totals   = llmRows.reduce(add, zero());
  const ttsTotals = ttsRows.reduce((a, r) => {
    a.calls += 1;
    a.characters += r.characters || 0;
    a.credits += r.credits || 0;
    a.approx_minutes += r.approx_minutes || 0;
    a.cost_total += r.cost_total || 0;
    return a;
  }, { calls: 0, characters: 0, credits: 0, approx_minutes: 0, cost_total: 0 });
  const byModel  = {};
  const byOp     = {};
  const byDay    = {};

  for (const r of llmRows) {
    const mk = r.model_label || r.model || 'unknown';
    (byModel[mk] = byModel[mk] || zero()) && add(byModel[mk], r);
    const ok = r.operation || 'unknown';
    (byOp[ok] = byOp[ok] || zero()) && add(byOp[ok], r);
    const dk = String(r.created_at || '').slice(0, 10);
    (byDay[dk] = byDay[dk] || zero()) && add(byDay[dk], r);
  }

  const round = o => ({ ...o, cost_total: Math.round(o.cost_total * 1e6) / 1e6 });
  const mapRound = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, round(v)]));

  const grand = totals.cost_total + ttsTotals.cost_total;

  return {
    totals: {
      ...round(totals),
      avg_cost_per_call: totals.calls ? Math.round((totals.cost_total / totals.calls) * 1e6) / 1e6 : 0,
      avg_ms_per_call:   totals.calls ? Math.round(totals.ms / totals.calls) : 0,
    },
    tts: {
      ...ttsTotals,
      cost_total: Math.round(ttsTotals.cost_total * 1e6) / 1e6,
      approx_minutes: Math.round(ttsTotals.approx_minutes * 10) / 10,
      estimated: true,
      rate_note: 'Valued at ElevenLabs published API rates. Billed as credits against your ' +
                 'monthly plan allowance, so this is consumption valued at the overage rate, ' +
                 'not an invoice figure.',
    },
    grand_total_cost: Math.round(grand * 1e6) / 1e6,
    by_model:     mapRound(byModel),
    by_operation: mapRound(byOp),
    by_day:       mapRound(byDay),
    pricing_verified: pricing.PRICING_VERIFIED,
  };
}

/**
 * Optimisation guidance, derived from the ledger rather than invented.
 * Only returns a suggestion when the ledger actually supports it.
 */
function insights(tiers = []) {
  const rows = all();
  const out = [];
  if (!rows.length) return out;

  const spend = rows.reduce((a, r) => a + (r.cost_total || 0), 0);
  const totalOut = rows.reduce((a, r) => a + (r.output_tokens || 0), 0);
  const totalIn  = rows.reduce((a, r) => a + (r.input_tokens || 0), 0);

  // 1. Would a cheaper tier have covered the cheap operations?
  const cheapest = tiers.find(t => t.tier === 'fast');
  if (cheapest) {
    const dear = rows.filter(r => r.model && !/haiku/i.test(r.model));
    if (dear.length) {
      const asIs = dear.reduce((a, r) => a + (r.cost_total || 0), 0);
      const alt = dear.reduce((a, r) => a + pricing.costOf(cheapest.model, {
        input_tokens: r.input_tokens, output_tokens: r.output_tokens,
      }).cost_total, 0);
      const saving = asIs - alt;
      if (saving > 0 && asIs > 0) {
        out.push({
          kind: 'tier',
          severity: saving / spend > 0.4 ? 'high' : 'medium',
          title: 'Cheaper tier available for routine calls',
          detail: `${dear.length} call${dear.length > 1 ? 's' : ''} ran on a mid or high tier. ` +
                  `The same token volume on the Fastest tier would have cost ${pricing.fmtUsd(alt)} ` +
                  `instead of ${pricing.fmtUsd(asIs)} — a saving of ${pricing.fmtUsd(saving)} ` +
                  `(${Math.round((saving / asIs) * 100)}%). Worth testing whether quality holds for ` +
                  `extraction-style work; keep the higher tier where it genuinely reads better.`,
          saving,
        });
      }
    }
  }

  // 2. Output tokens dominate cost — they are priced ~5x input
  const outCost = rows.reduce((a, r) => a + (r.cost_output || 0), 0);
  if (spend > 0 && outCost / spend > 0.6) {
    out.push({
      kind: 'output',
      severity: 'medium',
      title: 'Output tokens are driving most of the spend',
      detail: `${Math.round((outCost / spend) * 100)}% of cost is output tokens, which are priced ` +
              `roughly 5x input. Tightening the JSON schema — shorter descriptions, fewer optional ` +
              `fields, capping list lengths — cuts cost and latency at the same time.`,
    });
  }

  // 3. No prompt caching in play
  const cached = rows.reduce((a, r) => a + (r.cache_read_tokens || 0), 0);
  if (totalIn > 50000 && cached === 0) {
    out.push({
      kind: 'cache',
      severity: 'medium',
      title: 'Prompt caching is not being used',
      detail: `${totalIn.toLocaleString()} input tokens have been sent with no cache reads. ` +
              `Cache hits cost 10% of the input rate. The deep-dive packs resend the same document ` +
              `and system prompt each time, which is exactly the pattern caching is designed for.`,
    });
  }

  // 4. Unknown pricing — flag rather than report a wrong number
  const unknown = rows.filter(r => r.known_pricing === false);
  if (unknown.length) {
    out.push({
      kind: 'unknown',
      severity: 'high',
      title: 'Some calls have no published rate',
      detail: `${unknown.length} call${unknown.length > 1 ? 's' : ''} ran on a model not in the ` +
              `pricing table (${[...new Set(unknown.map(u => u.model))].join(', ')}). Their cost is ` +
              `recorded as zero, so totals understate actual spend. Add the rate to lib/pricing.js.`,
    });
  }

  // 5. Voice-over spend worth knowing about
  const tts = rows.filter(r => r.provider === 'elevenlabs');
  if (tts.length) {
    const ttsCost = tts.reduce((a, r) => a + (r.cost_total || 0), 0);
    const chars = tts.reduce((a, r) => a + (r.characters || 0), 0);
    const onFlash = tts.filter(r => /flash|turbo/i.test(String(r.model || ''))).length;
    if (onFlash < tts.length) {
      const multi = tts.filter(r => !/flash|turbo/i.test(String(r.model || '')));
      const multiChars = multi.reduce((a, r) => a + (r.characters || 0), 0);
      const saving = multiChars * (0.10 - 0.05) / 1000;
      if (saving > 0) {
        out.push({
          kind: 'tts',
          severity: 'low',
          title: 'Voice-over could run on the cheaper ElevenLabs model',
          detail: `${multi.length} generation${multi.length > 1 ? 's' : ''} used Multilingual v2 ` +
                  `($0.10/1K chars). Flash/Turbo v2.5 is half that and also supports language ` +
                  `locking. Estimated saving on the same text: ${pricing.fmtUsd(saving)}. ` +
                  `Multilingual is the more natural read, so trade deliberately.`,
          saving,
        });
      }
    }
    if (ttsCost > 0) {
      out.push({
        kind: 'tts-total',
        severity: 'low',
        title: 'Voice-over is a second vendor on the bill',
        detail: `${tts.length} generation${tts.length > 1 ? 's' : ''} totalling ` +
                `${chars.toLocaleString()} characters (~${Math.round(chars / 1000)} min of audio), ` +
                `valued at ${pricing.fmtUsd(ttsCost)}. Regenerating the same brief in several ` +
                `languages during a demo is the usual reason this climbs.`,
      });
    }
  }

  // 6. Long calls
  const slow = rows.filter(r => (r.ms || 0) > 45000);
  if (slow.length) {
    out.push({
      kind: 'latency',
      severity: 'low',
      title: 'Some calls are running long',
      detail: `${slow.length} call${slow.length > 1 ? 's' : ''} took over 45s. Check whether the ` +
              `document is unusually large, or whether a lower tier would land inside the target.`,
    });
  }

  return out.sort((a, b) => (b.saving || 0) - (a.saving || 0));
}

function reset() { storage.replace(COLLECTION, []); }

module.exports = { record, recordTts, all, summarise, insights, reset, COLLECTION };
