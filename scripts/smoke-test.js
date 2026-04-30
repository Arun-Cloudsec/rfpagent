#!/usr/bin/env node
// ============================================================================
// scripts/smoke-test.js — Hit every key endpoint and report pass/fail.
// ============================================================================
// Usage:
//   BASE_URL=https://your-app.up.railway.app node scripts/smoke-test.js
//   (defaults to http://localhost:3000)
// ----------------------------------------------------------------------------

const BASE = process.env.BASE_URL || 'http://localhost:3000';

const tests = [
  { name: 'health',         method: 'GET',  url: '/health',         expect: r => r.ok === true },
  { name: 'me',             method: 'GET',  url: '/api/me',         expect: r => typeof r.email === 'string' },
  { name: 'library list',   method: 'GET',  url: '/api/library',    expect: r => Array.isArray(r) },
  { name: 'recent list',    method: 'GET',  url: '/api/recent',     expect: r => Array.isArray(r) },
  { name: 'estim. list',    method: 'GET',  url: '/api/estimations', expect: r => Array.isArray(r) },
  { name: 'lib insert',     method: 'POST', url: '/api/library',
    body: { rfp_name: 'Smoke Test', industry: 'IT', response: 'Hello', score: 70, version: 1 },
    expect: r => r.id && r.rfp_name === 'Smoke Test' },
  { name: 'chat (AI)',      method: 'POST', url: '/api/chat',
    body: { message: 'Reply with the word PONG only.', context: { page: 'test' } },
    expect: r => typeof r.text === 'string' && r.text.toUpperCase().includes('PONG'),
    requiresAnthropic: true },
];

async function run() {
  console.log('▶ Smoke testing', BASE, '\n');
  let pass = 0, fail = 0, skip = 0;

  // First check if Anthropic is configured
  let anthropicReady = false;
  try {
    const h = await fetch(BASE + '/health').then(r => r.json());
    anthropicReady = !!h.anthropic_configured;
    if (!anthropicReady) console.log('  ⚠  ANTHROPIC_API_KEY not set — AI tests will be skipped\n');
  } catch (_) {}

  for (const t of tests) {
    if (t.requiresAnthropic && !anthropicReady) {
      console.log(`  ⏭  ${t.name} — skipped (no Anthropic key)`);
      skip++;
      continue;
    }
    try {
      const res = await fetch(BASE + t.url, {
        method: t.method,
        headers: { 'Content-Type': 'application/json' },
        ...(t.body ? { body: JSON.stringify(t.body) } : {}),
      });
      const json = await res.json();
      if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + JSON.stringify(json).slice(0, 200));
      if (!t.expect(json)) throw new Error('Assertion failed. Got: ' + JSON.stringify(json).slice(0, 200));
      console.log(`  ✓  ${t.name}`);
      pass++;
    } catch (e) {
      console.log(`  ✗  ${t.name}  →  ${e.message}`);
      fail++;
    }
  }

  console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
  process.exit(fail ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(2); });
