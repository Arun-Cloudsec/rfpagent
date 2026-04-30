// ============================================================================
// routes/auth.js — Auth stubs + library/recent/estimations CRUD
// ============================================================================
// The frontend's api() helper redirects to "/" on a 401, so /api/me MUST
// always return 200 with a user object. We ship a single demo user; swap
// this for a real auth provider (Clerk, Auth0, Supabase) when ready.
// ----------------------------------------------------------------------------

const express = require('express');
const storage = require('../lib/storage');

const router = express.Router();

// ── Demo user (single-tenant) ───────────────────────────────────────────────
const DEMO_USER = {
  email: process.env.DEMO_USER_EMAIL || 'you@example.com',
  name:  process.env.DEMO_USER_NAME  || 'RFP Agent User',
  isAdmin: process.env.DEMO_USER_IS_ADMIN === 'true',
  initials: 'YOU',
};

// /api/me — frontend hits this on every page load
router.get('/me', (_req, res) => {
  res.json({ ...DEMO_USER });
});

router.put('/me', (req, res) => {
  const { name, email } = req.body || {};
  if (typeof name === 'string')  DEMO_USER.name  = name.trim();
  if (typeof email === 'string') DEMO_USER.email = email.trim();
  res.json({ success: true, ...DEMO_USER });
});

router.put('/me/password', (req, res) => {
  const { current, newPassword } = req.body || {};
  if (!current || !newPassword) return res.json({ success: false, error: 'Both fields required' });
  if (String(newPassword).length < 8) return res.json({ success: false, error: 'New password must be ≥ 8 characters' });
  // Demo only — no real password storage
  res.json({ success: true, message: 'Password updated (demo mode — not persisted)' });
});

router.post('/auth/logout', (_req, res) => {
  res.json({ success: true });
});

// ── Library ─────────────────────────────────────────────────────────────────
router.get('/library', (_req, res) => {
  res.json(storage.list('library'));
});

router.post('/library', (req, res) => {
  const { rfp_name, industry, company, response, rfp_text, score, version } = req.body || {};
  if (!rfp_name && !response) {
    return res.status(400).json({ error: 'rfp_name or response is required' });
  }
  const row = storage.insert('library', {
    rfp_name:  rfp_name  || 'Untitled',
    industry:  industry  || '',
    company:   company   || '',
    response:  response  || '',
    rfp_text:  rfp_text  || '',
    score:     Number(score) || 0,
    version:   Number(version) || 1,
  });
  res.json(row);
});

router.delete('/library/:id', (req, res) => {
  const ok = storage.remove('library', req.params.id);
  res.json({ success: ok });
});

// ── Recent (lightweight history) ────────────────────────────────────────────
router.get('/recent', (_req, res) => {
  res.json(storage.list('recent').slice(0, 30));
});

router.post('/recent', (req, res) => {
  const { name, page, score } = req.body || {};
  const row = storage.insert('recent', {
    name:  name  || 'Untitled',
    page:  page  || '',
    score: Number(score) || 0,
  });
  res.json(row);
});

// ── Estimations ─────────────────────────────────────────────────────────────
router.get('/estimations', (_req, res) => {
  res.json(storage.list('estimations'));
});

router.delete('/estimations/:id', (req, res) => {
  const ok = storage.remove('estimations', req.params.id);
  res.json({ success: ok });
});

module.exports = router;
