// ============================================================================
// lib/anthropic.js — Single Anthropic client + helpers
// ============================================================================

const Anthropic = require('@anthropic-ai/sdk');

const _clients = new Map(); // apiKey → Anthropic client (cache so we don't re-instantiate)
function client(apiKey) {
  // Priority: explicit per-call key > env var
  const key = apiKey || process.env.ANTHROPIC_API_KEY;
  if (!key) {
    const err = new Error(
      'No Anthropic API key configured. Add yours in Settings → Anthropic API Key, or set ANTHROPIC_API_KEY in Railway → Variables.'
    );
    err.status = 503;
    throw err;
  }
  let c = _clients.get(key);
  if (!c) {
    c = new Anthropic({ apiKey: key });
    _clients.set(key, c);
  }
  return c;
}

// Default model — override per-request or via $CLAUDE_MODEL env.
// Sonnet 5 is the quality-per-second pick: performance close to Opus 4.8, but
// faster and cheaper than the Sonnet 4.6 this used to default to ($2/$10 vs
// $3/$15). Straight upgrade on all three axes.
const DEFAULT_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5';

// ── Tokenizer generations ───────────────────────────────────────────────────
// Claude 4.7 and later (Opus 4.7/4.8/5, Sonnet 5, Fable 5, Mythos 5) use a
// newer tokenizer that emits roughly 30% more tokens for the same text.
// A max_tokens budget tuned on Sonnet 4.6 will therefore TRUNCATE on Sonnet 5 —
// which surfaces as a bogus "model did not return valid JSON" error. Scale the
// budget with the tokenizer so the same prompt keeps producing complete output.
const NEW_TOKENIZER = /(opus-?5|sonnet-?5|fable-?5|mythos-?5|opus-?4[.-]7|opus-?4[.-]8)/i;

function usesNewTokenizer(model) {
  return NEW_TOKENIZER.test(String(model || DEFAULT_MODEL));
}

/** Scale a max_tokens budget for the model's tokenizer. */
function scaleTokens(maxTokens, model) {
  return usesNewTokenizer(model) ? Math.ceil(maxTokens * 1.35) : maxTokens;
}

/**
 * Send a single-turn text completion to Claude.
 * @param {object} opts
 * @param {string} opts.system    - System prompt (string)
 * @param {Array}  opts.messages  - Anthropic-format messages
 * @param {number} [opts.maxTokens=2048]
 * @param {number} [opts.temperature=0.4]
 * @param {string} [opts.model]
 * @returns {Promise<{text: string, raw: object, stopReason: string, usage: object}>}
 */
async function complete({ system, messages, maxTokens = 2048, temperature = 0.4, model, apiKey, scaleForTokenizer = true } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('complete() requires a non-empty messages array');
  }
  const c = client(apiKey);
  const useModel = model || DEFAULT_MODEL;
  const budget = scaleForTokenizer ? scaleTokens(maxTokens, useModel) : maxTokens;
  let resp;
  try {
    resp = await c.messages.create({
      model: useModel,
      max_tokens: budget,
      temperature,
      ...(system ? { system } : {}),
      messages,
    });
  } catch (err) {
    // Convert SDK errors to predictable HTTP-mapped errors for our routes
    const wrapped = new Error(err.message || 'Anthropic request failed');
    wrapped.status = err.status || (err.statusCode || 502);
    wrapped.cause  = err;
    throw wrapped;
  }
  const text = (resp.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();
  return { text, raw: resp, stopReason: resp.stop_reason, usage: resp.usage, model: useModel, maxTokensUsed: budget };
}

/**
 * Same as complete(), but parses the response as JSON.
 * Strips ```json fences and any preamble before the first `{` / `[`.
 * Throws a clear error if the model didn't return valid JSON.
 */
async function completeJson(opts = {}) {
  let out = await complete(opts);

  // Truncated output is not a JSON formatting problem — it is a budget problem.
  // Retry once with a bigger budget rather than reporting "invalid JSON", which
  // sends whoever is debugging this in entirely the wrong direction.
  if (out.stopReason === 'max_tokens') {
    const bigger = Math.min(Math.ceil((out.maxTokensUsed || 2048) * 1.6), 16000);
    console.warn(`[anthropic] hit max_tokens on ${out.model} (${out.maxTokensUsed}) — retrying at ${bigger}`);
    out = await complete({ ...opts, maxTokens: bigger, scaleForTokenizer: false });
    if (out.stopReason === 'max_tokens') {
      const err = new Error(
        `Model output was cut off at the token limit (${bigger}) and could not be completed. ` +
        'Try a shorter document, or raise the limit for this request.'
      );
      err.status = 502;
      throw err;
    }
  }

  return { data: extractJson(out.text), text: out.text, raw: out.raw, usage: out.usage,
           stopReason: out.stopReason, model: out.model, maxTokensUsed: out.maxTokensUsed };
}

/**
 * Robust JSON extractor — handles fenced blocks, leading prose, trailing chatter.
 */
function extractJson(text) {
  if (!text || typeof text !== 'string') {
    throw new Error('Empty response from model');
  }
  // 1) Strip ```json fences
  let s = text.replace(/^```(?:json|JSON)?\s*/m, '').replace(/```\s*$/m, '').trim();
  // 2) Find the first '{' or '['
  const firstObj = s.indexOf('{');
  const firstArr = s.indexOf('[');
  let start = -1;
  if (firstObj === -1) start = firstArr;
  else if (firstArr === -1) start = firstObj;
  else start = Math.min(firstObj, firstArr);
  if (start > 0) s = s.slice(start);
  // 3) Trim trailing prose past last matching bracket
  const lastObj = s.lastIndexOf('}');
  const lastArr = s.lastIndexOf(']');
  const end = Math.max(lastObj, lastArr);
  if (end !== -1 && end < s.length - 1) s = s.slice(0, end + 1);
  try {
    return JSON.parse(s);
  } catch (e) {
    const snippet = s.length > 240 ? s.slice(0, 240) + '…' : s;
    const err = new Error('Model did not return valid JSON. First 240 chars: ' + snippet);
    err.status = 502;
    throw err;
  }
}

module.exports = { complete, completeJson, extractJson, DEFAULT_MODEL, usesNewTokenizer, scaleTokens };
