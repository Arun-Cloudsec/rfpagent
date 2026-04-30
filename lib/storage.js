// ============================================================================
// lib/storage.js — JSON-file collection store
// ============================================================================
// Each "collection" (library, recent, estimations) is one JSON file in DATA_DIR.
// Writes are atomic (write to .tmp then rename). On Railway the filesystem is
// EPHEMERAL — data resets on redeploy. For real persistence, add a Railway
// PostgreSQL plugin and swap this module out.
// ----------------------------------------------------------------------------

const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function fileFor(name) {
  if (!/^[a-z0-9_-]+$/i.test(name)) throw new Error('Invalid collection name');
  return path.join(DATA_DIR, name + '.json');
}

function read(name) {
  ensureDir();
  const f = fileFor(name);
  if (!fs.existsSync(f)) return [];
  try {
    const raw = fs.readFileSync(f, 'utf8');
    if (!raw.trim()) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.warn(`[storage] corrupt ${name}.json — starting empty:`, e.message);
    return [];
  }
}

function write(name, arr) {
  ensureDir();
  const f   = fileFor(name);
  const tmp = f + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(arr, null, 2), 'utf8');
  fs.renameSync(tmp, f);
}

function id() {
  return 'id_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

const list = (name) => read(name);

const insert = (name, item) => {
  const all = read(name);
  const row = { id: item.id || id(), created_at: item.created_at || new Date().toISOString(), ...item };
  all.unshift(row);
  // Cap each collection so a single deploy doesn't fill ephemeral disk
  const cap = Number(process.env.STORAGE_CAP || 500);
  while (all.length > cap) all.pop();
  write(name, all);
  return row;
};

const remove = (name, rowId) => {
  const all = read(name);
  const next = all.filter(r => r.id !== rowId);
  if (next.length === all.length) return false;
  write(name, next);
  return true;
};

const update = (name, rowId, patch) => {
  const all = read(name);
  let updated = null;
  const next = all.map(r => {
    if (r.id !== rowId) return r;
    updated = { ...r, ...patch, updated_at: new Date().toISOString() };
    return updated;
  });
  if (!updated) return null;
  write(name, next);
  return updated;
};

module.exports = { list, insert, remove, update, DATA_DIR };
