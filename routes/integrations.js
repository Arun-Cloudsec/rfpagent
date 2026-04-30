// ============================================================================
// routes/integrations.js — Azure (cost mgmt) + ElevenLabs (TTS)
// ============================================================================
// Both are OPTIONAL. If env vars are missing we return helpful 503-style JSON
// rather than throwing — so the rest of the app works unchanged.
// ----------------------------------------------------------------------------

const express = require('express');
const router = express.Router();

const azureConfigured = () =>
  !!(process.env.AZURE_TENANT_ID && process.env.AZURE_CLIENT_ID && process.env.AZURE_CLIENT_SECRET);

const elevenConfigured = () => !!process.env.ELEVENLABS_API_KEY;

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
router.get('/elevenlabs/test', async (_req, res) => {
  if (!elevenConfigured()) {
    return res.status(503).json({ error: 'ElevenLabs not configured. Add ELEVENLABS_API_KEY in Railway → Variables.' });
  }
  try {
    const r = await fetch('https://api.elevenlabs.io/v1/user', { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } });
    if (!r.ok) return res.status(r.status).json({ error: 'ElevenLabs returned ' + r.status });
    const data = await r.json();
    res.json({ success: true, subscription: data.subscription || null });
  } catch (e) {
    res.status(502).json({ error: 'ElevenLabs test failed: ' + e.message });
  }
});

router.post('/elevenlabs/speak', async (req, res) => {
  if (!elevenConfigured()) return res.status(503).json({ error: 'ElevenLabs not configured.' });
  const { text, voice_id, language_code } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text required' });
  const voice = voice_id || 'nPczCjzI2devNBz1zQrb';
  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.55, similarity_boost: 0.75, style: 0.2, use_speaker_boost: true },
        ...(language_code ? { language_code } : {}),
      }),
    });
    if (!r.ok) {
      const errBody = await r.text();
      return res.status(r.status).json({ error: 'ElevenLabs error: ' + errBody.slice(0, 250) });
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    const buf = Buffer.from(await r.arrayBuffer());
    res.send(buf);
  } catch (e) {
    res.status(502).json({ error: 'ElevenLabs request failed: ' + e.message });
  }
});

module.exports = router;
