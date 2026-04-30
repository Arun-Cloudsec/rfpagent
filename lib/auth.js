// ============================================================================
// lib/auth.js — Password hashing + signed-cookie sessions (zero deps)
// ============================================================================
// Uses Node's built-in `crypto`. No bcrypt, no jsonwebtoken, no cookie-parser.
//
// Session token format:   <userId>.<expiryEpochSec>.<hmacBase64Url>
// Password storage format: scrypt:<saltHex>:<hashHex>
// ----------------------------------------------------------------------------

const crypto = require('crypto');

// ── Session secret ──────────────────────────────────────────────────────────
// Set SESSION_SECRET in Railway → Variables for stable sessions across deploys.
// If unset we generate a random one per-process — users are forced to re-login
// after every redeploy, which is fine for prototypes but bad for production.
let _secret = process.env.SESSION_SECRET || '';
if (!_secret) {
  _secret = crypto.randomBytes(32).toString('hex');
  console.warn('[auth] No SESSION_SECRET set — generated an ephemeral one. Set SESSION_SECRET in Railway → Variables for persistent logins.');
}
const SECRET = Buffer.from(_secret);

const SESSION_DAYS    = Number(process.env.SESSION_DAYS || 30);
const SESSION_MAX_AGE = SESSION_DAYS * 24 * 60 * 60; // seconds
const COOKIE_NAME     = 'rfp_session';

// ── Password hashing (scrypt) ──────────────────────────────────────────────
function hashPassword(plain) {
  if (typeof plain !== 'string' || plain.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(plain, salt, 64);
  return 'scrypt:' + salt.toString('hex') + ':' + hash.toString('hex');
}

function verifyPassword(plain, stored) {
  if (!plain || !stored || typeof stored !== 'string') return false;
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  try {
    const salt   = Buffer.from(parts[1], 'hex');
    const wanted = Buffer.from(parts[2], 'hex');
    const got    = crypto.scryptSync(plain, salt, wanted.length);
    return wanted.length === got.length && crypto.timingSafeEqual(wanted, got);
  } catch {
    return false;
  }
}

// ── Sessions (signed cookies, stateless) ───────────────────────────────────
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sign(payload) {
  return b64url(crypto.createHmac('sha256', SECRET).update(payload).digest());
}

function issueToken(userId) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE;
  const payload = `${userId}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  if (typeof token !== 'string' || !token) return null;
  const idx = token.lastIndexOf('.');
  if (idx === -1) return null;
  const payload = token.slice(0, idx);
  const sig     = token.slice(idx + 1);
  const expected = sign(payload);
  // Constant-time comparison
  const a = Buffer.from(sig); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const [userId, expStr] = payload.split('.');
  const exp = Number(expStr);
  if (!userId || !exp || exp < Math.floor(Date.now() / 1000)) return null;
  return { userId, exp };
}

// ── Cookie helpers (no cookie-parser dep) ──────────────────────────────────
function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(/;\s*/).forEach(part => {
    if (!part) return;
    const eq = part.indexOf('=');
    if (eq === -1) return;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function buildCookie(name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push('Path=/');
  parts.push('HttpOnly');
  parts.push('SameSite=Lax');
  if (opts.maxAge != null) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.secure || process.env.NODE_ENV === 'production') parts.push('Secure');
  return parts.join('; ');
}

function setSessionCookie(res, userId) {
  const token = issueToken(userId);
  res.setHeader('Set-Cookie', buildCookie(COOKIE_NAME, token, { maxAge: SESSION_MAX_AGE }));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', buildCookie(COOKIE_NAME, '', { maxAge: 0 }));
}

function readSession(req) {
  const cookies = parseCookies(req);
  const token = cookies[COOKIE_NAME];
  if (!token) return null;
  return verifyToken(token);
}

module.exports = {
  hashPassword, verifyPassword,
  setSessionCookie, clearSessionCookie, readSession,
  COOKIE_NAME, SESSION_MAX_AGE,
};
