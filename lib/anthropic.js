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

// Default model — override per-request or via $CLAUDE_MODEL env
const DEFAULT_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

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
async function complete({ system, messages, maxTokens = 2048, temperature = 0.4, model, apiKey } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('complete() requires a non-empty messages array');
  }
  const c = client(apiKey);
  let resp;
  try {
    resp = await c.messages.create({
      model: model || DEFAULT_MODEL,
      max_tokens: maxTokens,
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
  return { text, raw: resp, stopReason: resp.stop_reason, usage: resp.usage };
}

/**
 * Same as complete(), but parses the response as JSON.
 * Strips ```json fences and any preamble before the first `{` / `[`.
 * Throws a clear error if the model didn't return valid JSON.
 */
async function completeJson(opts = {}) {
  const { text, raw, usage } = await complete(opts);
  return { data: extractJson(text), text, raw, usage };
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

module.exports = { complete, completeJson, extractJson, DEFAULT_MODEL };
