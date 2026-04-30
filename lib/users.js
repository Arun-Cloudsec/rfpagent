// ============================================================================
// lib/users.js — User store on top of the JSON-file collection
// ============================================================================

const storage = require('./storage');
const { hashPassword, verifyPassword } = require('./auth');

const COLLECTION = 'users';

function all() { return storage.list(COLLECTION); }

function findByEmail(email) {
  if (!email) return null;
  const lc = String(email).trim().toLowerCase();
  return all().find(u => (u.email || '').toLowerCase() === lc) || null;
}

function findById(id) {
  if (!id) return null;
  return all().find(u => u.id === id) || null;
}

// Strip secrets before sending to the client
function publicView(u) {
  if (!u) return null;
  const { password, ...rest } = u;
  // Mask the API key — frontend can show "sk-...XXXX" without seeing it whole
  if (rest.api_key) rest.api_key_masked = maskKey(rest.api_key);
  delete rest.api_key;
  if (rest.eleven_labs_key) rest.eleven_labs_key_masked = maskKey(rest.eleven_labs_key);
  delete rest.eleven_labs_key;
  return rest;
}

function maskKey(k) {
  if (!k || typeof k !== 'string') return '';
  if (k.length <= 12) return '•'.repeat(k.length);
  return k.slice(0, 8) + '•'.repeat(8) + k.slice(-4);
}

async function create({ email, password, name = '', org_name = '' }) {
  if (!email || !password) throw new Error('email and password required');
  if (findByEmail(email)) {
    const e = new Error('An account with that email already exists');
    e.status = 409;
    throw e;
  }
  const passwordHash = hashPassword(password);
  const isFirst = all().length === 0;
  const row = storage.insert(COLLECTION, {
    email: String(email).trim().toLowerCase(),
    password: passwordHash,
    name: name || org_name || '',
    org_name: org_name || '',
    org_industry: '',
    org_years: '',
    org_bio: '',
    api_key: '',
    eleven_labs_key: '',
    isAdmin: isFirst,         // First user becomes admin
  });
  return row;
}

function checkPassword(user, plain) {
  if (!user) return false;
  return verifyPassword(plain, user.password);
}

function update(id, patch) {
  // Whitelist updatable fields — never let a request overwrite password/email/id
  const allowed = ['name', 'org_name', 'org_industry', 'org_years', 'org_bio', 'api_key', 'eleven_labs_key'];
  const safe = {};
  allowed.forEach(k => { if (patch[k] !== undefined) safe[k] = patch[k]; });
  return storage.update(COLLECTION, id, safe);
}

function setPassword(id, newPlain) {
  const u = findById(id);
  if (!u) return null;
  return storage.update(COLLECTION, id, { password: hashPassword(newPlain) });
}

module.exports = { findByEmail, findById, publicView, create, checkPassword, update, setPassword };
