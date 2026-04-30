// ============================================================================
// routes/auth.js — Real auth (register, login, logout) + per-user data
// ============================================================================

const express = require('express');
const users   = require('../lib/users');
const session = require('../lib/auth');
const storage = require('../lib/storage');

const router = express.Router();

// ── Middleware: require an authenticated session ───────────────────────────
function requireAuth(req, res, next) {
  const s = session.readSession(req);
  if (!s) return res.status(401).json({ error: 'Not signed in' });
  const u = users.findById(s.userId);
  if (!u) {
    session.clearSessionCookie(res);
    return res.status(401).json({ error: 'Account no longer exists' });
  }
  req.user = u;          // full user (incl. api_key) — only used server-side
  req.userId = u.id;
  next();
}

// Make this exportable so other route files can use it
router.requireAuth = requireAuth;

// ── /api/auth/register ─────────────────────────────────────────────────────
router.post('/auth/register', async (req, res, next) => {
  try {
    const { email, password, org_name, name } = req.body || {};
    if (!email || !password) return res.status(400).json({ success: false, error: 'Email and password are required' });
    if (String(password).length < 8) return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ success: false, error: 'Please enter a valid email address' });

    const u = await users.create({ email, password, org_name, name });
    session.setSessionCookie(res, u.id);
    res.json({ success: true, user: users.publicView(u) });
  } catch (e) {
    if (e.status === 409) return res.status(409).json({ success: false, error: e.message });
    next(e);
  }
});

// ── /api/auth/login ────────────────────────────────────────────────────────
router.post('/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ success: false, error: 'Email and password are required' });
  const u = users.findByEmail(email);
  if (!u || !users.checkPassword(u, password)) {
    return res.status(401).json({ success: false, error: 'Invalid email or password' });
  }
  session.setSessionCookie(res, u.id);
  res.json({ success: true, user: users.publicView(u) });
});

// ── /api/auth/logout ───────────────────────────────────────────────────────
router.post('/auth/logout', (_req, res) => {
  session.clearSessionCookie(res);
  res.json({ success: true });
});

// ── /api/me — protected ────────────────────────────────────────────────────
router.get('/me', requireAuth, (req, res) => {
  const u = req.user;
  res.json({
    email:    u.email,
    name:     u.name || u.org_name || '',
    org_name: u.org_name || '',
    org_industry: u.org_industry || '',
    org_years: u.org_years || '',
    org_bio:  u.org_bio  || '',
    isAdmin:  !!u.isAdmin,
    initials: (u.name || u.org_name || u.email || 'U').slice(0, 2).toUpperCase(),
    has_api_key: !!u.api_key,
    api_key_masked: u.api_key ? maskKey(u.api_key) : '',
    has_eleven_labs_key: !!u.eleven_labs_key,
    eleven_labs_key_masked: u.eleven_labs_key ? maskKey(u.eleven_labs_key) : '',
  });
});

function maskKey(k) {
  if (!k) return '';
  if (k.length <= 12) return '•'.repeat(k.length);
  return k.slice(0, 8) + '•'.repeat(8) + k.slice(-4);
}

// ── PUT /api/me — saves profile + API keys ─────────────────────────────────
//
// IMPORTANT: empty / masked api_key strings are treated as "leave alone"
// so re-saving the org profile doesn't wipe the user's stored key.
// ----------------------------------------------------------------------------
router.put('/me', requireAuth, (req, res) => {
  const body = req.body || {};
  const patch = {};

  if (typeof body.name === 'string')         patch.name = body.name.trim();
  if (typeof body.org_name === 'string')     patch.org_name = body.org_name.trim();
  if (typeof body.org_industry === 'string') patch.org_industry = body.org_industry;
  if (typeof body.org_years === 'string')    patch.org_years = body.org_years;
  if (typeof body.org_bio === 'string')      patch.org_bio = body.org_bio;

  if (typeof body.api_key === 'string' && body.api_key && !body.api_key.includes('•')) {
    if (!body.api_key.startsWith('sk-ant-')) {
      return res.status(400).json({ success: false, error: 'Anthropic API keys start with "sk-ant-..." — please paste the full key' });
    }
    patch.api_key = body.api_key.trim();
  }
  if (typeof body.eleven_labs_key === 'string' && body.eleven_labs_key && !body.eleven_labs_key.includes('•')) {
    patch.eleven_labs_key = body.eleven_labs_key.trim();
  }

  const updated = users.update(req.userId, patch);
  res.json({ success: true, user: users.publicView(updated) });
});

// ── PUT /api/me/password ───────────────────────────────────────────────────
router.put('/me/password', requireAuth, (req, res) => {
  const { current, newPassword } = req.body || {};
  if (!current || !newPassword) return res.json({ success: false, error: 'Both fields required' });
  if (String(newPassword).length < 8) return res.json({ success: false, error: 'New password must be at least 8 characters' });
  if (!users.checkPassword(req.user, current)) return res.json({ success: false, error: 'Current password is incorrect' });
  users.setPassword(req.userId, newPassword);
  res.json({ success: true });
});

// ════════════════════════════════════════════════════════════════════════════
// Per-user collections — library / recent / estimations
// ════════════════════════════════════════════════════════════════════════════
// One JSON file per collection; rows tagged with `user_id` so each user
// only sees their own.
// ----------------------------------------------------------------------------

function listFor(collection, userId) {
  return storage.list(collection).filter(r => r.user_id === userId);
}

router.get('/library', requireAuth, (req, res) => res.json(listFor('library', req.userId)));

router.post('/library', requireAuth, (req, res) => {
  const { rfp_name, industry, company, response, rfp_text, score, version } = req.body || {};
  if (!rfp_name && !response) return res.status(400).json({ error: 'rfp_name or response is required' });
  const row = storage.insert('library', {
    user_id:  req.userId,
    rfp_name: rfp_name || 'Untitled',
    industry: industry || '',
    company:  company  || '',
    response: response || '',
    rfp_text: rfp_text || '',
    score:    Number(score) || 0,
    version:  Number(version) || 1,
  });
  res.json(row);
});

router.delete('/library/:id', requireAuth, (req, res) => {
  const all = storage.list('library');
  const row = all.find(r => r.id === req.params.id);
  if (!row || row.user_id !== req.userId) return res.status(404).json({ success: false });
  res.json({ success: storage.remove('library', req.params.id) });
});

router.get('/recent', requireAuth, (req, res) => res.json(listFor('recent', req.userId).slice(0, 30)));

router.post('/recent', requireAuth, (req, res) => {
  const row = storage.insert('recent', {
    user_id: req.userId,
    name:  req.body.name  || 'Untitled',
    page:  req.body.page  || '',
    score: Number(req.body.score) || 0,
  });
  res.json(row);
});

router.get('/estimations', requireAuth, (req, res) => res.json(listFor('estimations', req.userId)));

router.delete('/estimations/:id', requireAuth, (req, res) => {
  const all = storage.list('estimations');
  const row = all.find(r => r.id === req.params.id);
  if (!row || row.user_id !== req.userId) return res.status(404).json({ success: false });
  res.json({ success: storage.remove('estimations', req.params.id) });
});

module.exports = router;
