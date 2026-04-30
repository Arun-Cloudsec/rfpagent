// ============================================================================
// RFP Agent — Express server (Railway)
// ============================================================================
// Loads env, mounts routes, serves the static frontend from /public, and
// listens on the port Railway injects via $PORT.
// ----------------------------------------------------------------------------

require('dotenv').config();

const path        = require('path');
const express     = require('express');
const compression = require('compression');
const helmet      = require('helmet');
const cors        = require('cors');
const morgan      = require('morgan');
const rateLimit   = require('express-rate-limit');

const auth         = require('./routes/auth');
const ai           = require('./routes/ai');
const fill         = require('./routes/fill');
const integrations = require('./routes/integrations');
const mp           = require('./routes/mp');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Trust the proxy Railway puts in front of us (so req.ip is right) ────────
app.set('trust proxy', 1);

// ── Security & parsing middleware ───────────────────────────────────────────
// helmet's default CSP is too strict for our inline-script frontend; we set our
// own CSP inside index.html (see <meta http-equiv="Content-Security-Policy">),
// so we disable helmet's CSP to avoid the duplicate-header warning.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));
app.use(compression());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ── Per-route rate limiting (separate buckets for AI vs everything else) ────
const aiLimiter = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.AI_RATE_PER_MIN || 30),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many AI requests — slow down a bit.' },
});

const generalLimiter = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.GENERAL_RATE_PER_MIN || 240),
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api', generalLimiter);

// ── Health check (Railway pings this) ───────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'rfp-agent',
    uptime_s: Math.floor(process.uptime()),
    anthropic_configured: !!process.env.ANTHROPIC_API_KEY,
    azure_configured: !!(process.env.AZURE_TENANT_ID && process.env.AZURE_CLIENT_ID),
    elevenlabs_configured: !!process.env.ELEVENLABS_API_KEY,
    node: process.version,
    env: process.env.NODE_ENV || 'development',
  });
});

// ── API routes ──────────────────────────────────────────────────────────────
app.use('/api',          auth);                 // /me, /auth/*, /library, /recent, /estimations
app.use('/api',          aiLimiter, ai);        // /chat, /generate, /improve, /analyze-rfp, /estimate-effort
app.use('/api',          aiLimiter, fill);      // /fill-docx, /fill-pdf, /fill-xlsx
app.use('/api',          integrations);         // /azure/*, /elevenlabs/*
app.use('/api/mp',       aiLimiter, mp);        // /mp/* multi-agent endpoints

// ── Static frontend (must come after /api so API routes win on collision) ──
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  index: 'index.html',
}));

// SPA-style catch-all: any non-/api GET serves index.html
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Centralised error handler ───────────────────────────────────────────────
// Always returns JSON for /api routes so the frontend's api() helper can read .error
app.use((err, req, res, _next) => {
  console.error(`[ERR] ${req.method} ${req.url} →`, err);
  const status = err.status || err.statusCode || 500;
  if (req.path.startsWith('/api/')) {
    return res.status(status).json({ error: err.message || 'Internal server error' });
  }
  res.status(status).type('text/plain').send(err.message || 'Internal server error');
});

// ── Boot ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✓ RFP Agent listening on :${PORT}`);
  console.log(`  Anthropic:   ${process.env.ANTHROPIC_API_KEY ? '✓ configured' : '✗ missing ANTHROPIC_API_KEY'}`);
  console.log(`  Model:       ${process.env.CLAUDE_MODEL || 'claude-sonnet-4-6 (default)'}`);
  console.log(`  Storage:     ${process.env.DATA_DIR || './data'}`);
  console.log(`  Health:      http://localhost:${PORT}/health`);
});

// Soft-fail on uncaught — Railway will restart us if we crash hard
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException',  (e) => console.error('[uncaughtException]', e));
