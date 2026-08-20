// ============================================================================
// routes/integrations.js — Azure (cost mgmt) + ElevenLabs (TTS)
// ============================================================================
// Both are OPTIONAL. If env vars are missing we return helpful 503-style JSON
// rather than throwing — so the rest of the app works unchanged.
// ----------------------------------------------------------------------------

const express = require('express');
const router = express.Router();
const authRoute = require('./auth');
const requireAuth = authRoute.requireAuth;

// All integration routes require auth
router.use(requireAuth);

const azureConfigured = () =>
  !!(process.env.AZURE_TENANT_ID && process.env.AZURE_CLIENT_ID && process.env.AZURE_CLIENT_SECRET);

// Per-request ElevenLabs key — user's first, env fallback
const elevenKey = (req) => (req.user && req.user.eleven_labs_key) ? req.user.eleven_labs_key : (process.env.ELEVENLABS_API_KEY || '');

// ── Azure: connection test ─────────────────────────────────────────────────
router.get('/azure/test', async (_req, res) => {
  if (!azureConfigured()) {
    return res.status(503).json({
      error: 'Azure not configured. Add AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET (and optionally AZURE_SUBSCRIPTION_ID) in Railway → Variables, then redeploy.',
    });
  }
  try {
    // Minimal token request to verify creds — Azure Management endpoint
    const params = new URLSearchParams();
    params.set('grant_type', 'client_credentials');
    params.set('client_id', process.env.AZURE_CLIENT_ID);
    params.set('client_secret', process.env.AZURE_CLIENT_SECRET);
    params.set('resource', 'https://management.azure.com/');
    const r = await fetch(`https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/token`, {
      method: 'POST', body: params,
    });
    if (!r.ok) {
      const txt = await r.text();
      return res.status(r.status).json({ error: 'Azure auth failed: ' + txt.slice(0, 200) });
    }
    res.json({
      success: true,
      subscriptions: process.env.AZURE_SUBSCRIPTION_ID
        ? [{ id: process.env.AZURE_SUBSCRIPTION_ID, name: process.env.AZURE_SUBSCRIPTION_NAME || 'Default', state: 'Enabled' }]
        : [],
      message: 'Auth OK. List subscriptions via /api/azure/billing/subscriptions.',
    });
  } catch (e) {
    res.status(502).json({ error: 'Azure test failed: ' + e.message });
  }
});

router.put('/azure/credentials', (req, res) => {
  // We never write secrets to disk; tell the user to use Railway Variables.
  res.json({
    success: false,
    error: 'For security, set Azure credentials via Railway → Variables (AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET). The server does not persist credentials submitted from the UI.',
  });
});

router.get('/azure/billing/subscriptions', (_req, res) => {
  if (!azureConfigured()) return res.status(503).json({ error: 'Azure not configured.' });
  // Minimal stub — wire up the Cost Management Query API for full data.
  res.json({
    subscriptions: process.env.AZURE_SUBSCRIPTION_ID
      ? [{ id: process.env.AZURE_SUBSCRIPTION_ID, name: process.env.AZURE_SUBSCRIPTION_NAME || 'Default', state: 'Enabled' }]
      : [],
  });
});

router.post('/azure/billing/chat', (_req, res) => {
  res.status(503).json({
    error: 'Azure billing chat requires connecting the Azure Cost Management API. This open-source backend ships a stub — implement the call to /providers/Microsoft.CostManagement/query in your own deployment.',
  });
});

router.post('/azure/billing/recommend', (_req, res) => {
  res.status(503).json({ error: 'Azure recommendations stub. See routes/integrations.js to wire up Advisor API.' });
});

// ── ElevenLabs: text-to-speech ─────────────────────────────────────────────
//
// Three bugs were fixed here:
//   1. /elevenlabs/test referenced `req` while the handler bound `_req`, so it
//      threw ReferenceError, never sent a response, and hung the browser.
//   2. /elevenlabs/speak streamed raw audio/mpeg but the frontend calls
//      resp.json() and reads {ok, url}. It now writes the mp3 and returns JSON.
//   3. `language_code` was sent with eleven_multilingual_v2, which does NOT
//      support language enforcement — ElevenLabs 400s the request. Only
//      Turbo v2.5 and Flash v2.5 accept it, so we now gate the field on model.
// ----------------------------------------------------------------------------

const fs   = require('fs');
const path = require('path');

// Models that accept the `language_code` field. Sending it to any other model
// is a hard error from the ElevenLabs API.
const LANG_ENFORCING_MODELS = new Set(['eleven_turbo_v2_5', 'eleven_flash_v2_5']);
const DEFAULT_TTS_MODEL = process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2';

// Languages eleven_multilingual_v2 / flash v2.5 can actually speak.
const TTS_SUPPORTED = new Set([
  'en','ja','zh','de','hi','fr','ko','pt','it','es','id','nl','tr','fil','pl',
  'sv','bg','ro','ar','cs','el','fi','hr','ms','sk','da','ta','uk','ru','hu','no','vi',
]);

// The app uses 'af' as the code for "South African English" — that is English,
// not Afrikaans (which ElevenLabs does not support). Map it back to English.
const TTS_LANG_ALIASES = { af: 'en', 'en-za': 'en', 'zh-cn': 'zh', 'pt-br': 'pt' };

function normaliseTtsLang(code) {
  const c = String(code || '').trim().toLowerCase();
  if (!c) return '';
  return TTS_LANG_ALIASES[c] || c.split('-')[0];
}

// Where generated mp3s land. Served statically by express from /public.
const AUDIO_DIR = path.join(__dirname, '..', 'public', 'temp');

function ensureAudioDir() {
  if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });
}

// Drop clips older than an hour so an ephemeral dyno doesn't fill up.
function sweepOldAudio() {
  try {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const f of fs.readdirSync(AUDIO_DIR)) {
      if (!f.endsWith('.mp3')) continue;
      const p = path.join(AUDIO_DIR, f);
      if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
    }
  } catch { /* best effort */ }
}

router.get('/elevenlabs/test', async (req, res) => {
  const key = elevenKey(req);
  if (!key) {
    return res.status(503).json({
      error: 'ElevenLabs not configured. Add your key in Settings → ElevenLabs Voice API Key, or set ELEVENLABS_API_KEY in Railway → Variables.',
    });
  }
  try {
    const r = await fetch('https://api.elevenlabs.io/v1/user', { headers: { 'xi-api-key': key } });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return res.status(r.status).json({
        error: `ElevenLabs returned ${r.status}${body ? ': ' + body.slice(0, 200) : ''}`,
      });
    }
    const data = await r.json();
    res.json({
      success: true,
      subscription: data.subscription || null,
      model: DEFAULT_TTS_MODEL,
    });
  } catch (e) {
    res.status(502).json({ error: 'ElevenLabs test failed: ' + e.message });
  }
});

// List the voices on the account so the UI can offer real, current options.
router.get('/elevenlabs/voices', async (req, res) => {
  const key = elevenKey(req);
  if (!key) return res.status(503).json({ error: 'ElevenLabs not configured.' });
  try {
    const r = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': key } });
    if (!r.ok) return res.status(r.status).json({ error: 'ElevenLabs returned ' + r.status });
    const data = await r.json();
    res.json({
      success: true,
      voices: (data.voices || []).map(v => ({
        voice_id: v.voice_id,
        name: v.name,
        labels: v.labels || {},
      })),
    });
  } catch (e) {
    res.status(502).json({ error: 'ElevenLabs voices failed: ' + e.message });
  }
});

router.post('/elevenlabs/speak', async (req, res) => {
  const key = elevenKey(req);
  if (!key) return res.status(503).json({ error: 'ElevenLabs not configured. Add your key in Settings → ElevenLabs Voice API Key.' });

  const { text, voice_id, language_code, model_id } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'text required' });

  const voice = voice_id || 'nPczCjzI2devNBz1zQrb';
  const model = model_id || DEFAULT_TTS_MODEL;
  const lang  = normaliseTtsLang(language_code);

  // Warn (but still try) when the requested language isn't one ElevenLabs speaks.
  const warning = lang && !TTS_SUPPORTED.has(lang)
    ? `ElevenLabs does not list "${lang}" as a supported speech language — the voice may fall back to an accented reading.`
    : null;

  const payload = {
    text: String(text),
    model_id: model,
    voice_settings: { stability: 0.55, similarity_boost: 0.75, style: 0.2, use_speaker_boost: true },
  };
  // ONLY Turbo v2.5 / Flash v2.5 accept language_code. Sending it to
  // multilingual_v2 makes ElevenLabs reject the whole request.
  if (lang && LANG_ENFORCING_MODELS.has(model)) payload.language_code = lang;

  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
      body: JSON.stringify(payload),
    });

    if (!r.ok) {
      const errBody = await r.text().catch(() => '');
      return res.status(r.status).json({
        error: `ElevenLabs error ${r.status}: ${errBody.slice(0, 250)}`,
        model, language_code: payload.language_code || null,
      });
    }

    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) return res.status(502).json({ error: 'ElevenLabs returned an empty audio stream.' });

    ensureAudioDir();
    sweepOldAudio();
    const name = `brief_${lang || 'en'}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp3`;
    fs.writeFileSync(path.join(AUDIO_DIR, name), buf);

    // Shape matches what the frontend player expects: { ok, url, size }.
    res.json({
      ok: true,
      url: `/temp/${name}`,
      size: buf.length,
      model,
      language_code: payload.language_code || null,
      language_enforced: !!payload.language_code,
      warning,
    });
  } catch (e) {
    res.status(502).json({ error: 'ElevenLabs request failed: ' + e.message });
  }
});

module.exports = router;
