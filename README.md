# RFP Agent — Railway Deployment

AI-powered RFP analysis and response generation. Single-service Node.js/Express
backend that serves the static frontend and proxies AI calls to Anthropic.

---

## 1 · What's in this package

```
rfp-agent-railway/
├── server.js                # Express entry point
├── package.json             # Dependencies + start script
├── railway.json             # Railway build/deploy config
├── nixpacks.toml            # Pins Node 20
├── Procfile                 # Fallback start command
├── .env.example             # Every env var, documented
├── .gitignore
├── public/
│   └── index.html           # The fixed frontend (drop in / replace)
├── routes/
│   ├── auth.js              # /api/me, /library, /recent, /estimations
│   ├── ai.js                # /api/chat, /generate, /improve, /analyze-rfp
│   ├── fill.js              # /api/fill-docx (real), /fill-pdf, /fill-xlsx
│   ├── integrations.js      # /api/azure/*, /api/elevenlabs/*
│   └── mp.js                # /api/mp/* (multi-agent endpoints)
├── lib/
│   ├── anthropic.js         # Anthropic SDK wrapper + JSON extractor
│   ├── storage.js           # JSON-file collection store
│   └── extract.js           # PDF/DOCX/XLSX text extraction
├── data/                    # Auto-created — JSON file store lives here
└── scripts/
    └── smoke-test.js        # Run after deploy: hits every endpoint
```

---

## 2 · Deploy to Railway (3 minutes)

### Option A — From the Railway dashboard (easiest)

1. **Get an Anthropic API key** at <https://console.anthropic.com/> → API Keys.
2. Push this folder to a GitHub repo (see "Push to GitHub" below if you haven't yet).
3. Go to <https://railway.com> → **New Project** → **Deploy from GitHub repo** → pick your repo.
4. After the first deploy, click the service → **Variables** tab → add:
    - `ANTHROPIC_API_KEY` = `sk-ant-api03-…`
    - `CLAUDE_MODEL` = `claude-sonnet-4-6` *(optional override)*
5. Railway will auto-redeploy. Click **Settings → Generate Domain** to get your public URL.
6. Open the URL — the app is live.

### Option B — Railway CLI

```bash
npm i -g @railway/cli
railway login
cd rfp-agent-railway
railway init                 # create a new project
railway variables set ANTHROPIC_API_KEY=sk-ant-api03-...
railway up                   # deploys
railway domain               # public URL
```

### Push to GitHub (if needed)

```bash
cd rfp-agent-railway
git init && git add . && git commit -m "Initial commit"
gh repo create rfp-agent --public --source=. --push       # GitHub CLI
# or: create a repo on github.com, then:
# git remote add origin git@github.com:USER/rfp-agent.git
# git branch -M main && git push -u origin main
```

---

## 3 · Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | **Yes** | — | Get from console.anthropic.com |
| `CLAUDE_MODEL` | No | `claude-sonnet-4-6` | `claude-opus-4-7` for highest quality, `claude-haiku-4-5` for cheapest |
| `PORT` | No | `3000` | Railway sets this automatically |
| `DATA_DIR` | No | `./data` | Set to `/data` if you mount a Railway Volume |
| `DEMO_USER_EMAIL` / `DEMO_USER_NAME` | No | demo values | Shows in the top-right of the UI |
| `AI_RATE_PER_MIN` | No | `30` | Per-IP cap on AI calls |
| `GENERAL_RATE_PER_MIN` | No | `240` | Per-IP cap on everything else |
| `STORAGE_CAP` | No | `500` | Rows per JSON collection |
| `AZURE_TENANT_ID` / `_CLIENT_ID` / `_CLIENT_SECRET` | No | — | Azure Cost Management integration |
| `ELEVENLABS_API_KEY` | No | — | TTS for the executive brief audio player |

---

## 4 · Persistence (important)

Railway's default filesystem is **ephemeral** — the JSON files in `./data` reset
on every redeploy. The app works fine for prototypes & demos, but for production
do one of these:

**Quick fix — Railway Volume:** in the service → **Settings → Volumes**, mount one
at `/data`, then set `DATA_DIR=/data`. Now data survives redeploys.

**Real fix — swap to Postgres:** add a Railway PostgreSQL plugin, then replace
`lib/storage.js` with a Postgres-backed implementation. The interface is just
four functions (`list`, `insert`, `remove`, `update`) so the swap is small.

---

## 5 · Local development

```bash
cd rfp-agent-railway
cp .env.example .env                   # then edit .env to add your key
npm install
npm run dev                            # auto-reloads on file changes
# open http://localhost:3000
```

Smoke-test after a change:

```bash
npm run test:smoke                                                    # local
BASE_URL=https://your-app.up.railway.app npm run test:smoke           # remote
```

---

## 6 · Updating the frontend

The frontend is a single file: **`public/index.html`**. Drop in a new copy and
redeploy — that's it. The static-file middleware in `server.js` serves it as-is
and rolls cache for an hour in production.

---

## 7 · Troubleshooting

**The page loads but every action says "Error — please try again."**
The frontend redirects to `/` on a 401 from `/api/me`. Open `/health` — if
`anthropic_configured: false`, set `ANTHROPIC_API_KEY`. If everything looks OK,
check Railway → Service → Logs for the actual error message.

**"ANTHROPIC_API_KEY is not set" on AI calls.**
Set the variable in Railway → Variables and **redeploy** (variables don't
hot-reload). Verify with `curl https://your-app.up.railway.app/health`.

**Upload says "0 words" / "Could not extract text."**
1. The frontend tries client-side extraction first (PDF.js / mammoth / xlsx
   from CDN). The fixed CSP in `index.html` allows `cdnjs.cloudflare.com` and
   `cdn.jsdelivr.net` — confirm your browser hasn't blocked them.
2. If client extraction fails, the new `/api/mp/ingest` endpoint extracts on
   the server. Check Railway logs for the actual error.
3. **Scanned PDFs require OCR** — convert with Acrobat or Google Docs first.

**Long requests timing out.**
Railway's default request timeout is generous, but big RFPs can take 30–60s
to analyze. The frontend shows an overlay during this. If you hit a hard
limit, lower `CLAUDE_MODEL` to `claude-haiku-4-5` for faster responses.

**Rate-limit errors from Anthropic.**
Lower `AI_RATE_PER_MIN` in Railway Variables, or upgrade your Anthropic plan.

**"Network error — check your connection" in the UI.**
The frontend hit a non-2xx response with no JSON body. Open browser DevTools
→ Network tab → look at the failing request. Most often it's a CORS issue
from running the frontend off a different origin than the backend — keep
both on the same Railway service to avoid this.

---

## 8 · Endpoint reference

| Method | Path | Purpose |
|---|---|---|
| GET  | `/health`                          | Service health + config status |
| GET  | `/api/me`                          | Demo user info (frontend gates on this) |
| PUT  | `/api/me` / `/api/me/password`     | Update profile / password (demo) |
| POST | `/api/auth/logout`                 | Logout stub |
| GET/POST | `/api/library`                 | List / save library entries |
| DELETE | `/api/library/:id`               | Delete library entry |
| GET/POST | `/api/recent`                  | Recent activity |
| GET/DELETE | `/api/estimations[/:id]`     | Saved estimates |
| POST | `/api/chat`                        | **Conversational AI w/ citations** |
| POST | `/api/generate`                    | Full RFP response draft |
| POST | `/api/improve`                     | Polish/edit text |
| POST | `/api/analyze-rfp`                 | Multipart — generate executive brief JSON |
| POST | `/api/estimate-effort`             | Multipart — generate effort estimate JSON |
| POST | `/api/fill-docx`                   | Multipart — return a filled .docx |
| POST | `/api/fill-pdf` / `/api/fill-xlsx` | 501 — use `/api/fill-docx` |
| POST | `/api/mp/ingest`                   | Server-side text extraction |
| POST | `/api/mp/clarifications/ai-suggest` | Suggest clarification questions |
| POST | `/api/mp/outline/check-coverage`   | Map RFP → response outline |
| POST | `/api/mp/section-edit` / `-polish` | Edit / polish a single section |
| POST | `/api/mp/validate-draft`           | Compliance check the full draft |
| POST | `/api/mp/analyze-image`            | Multimodal — describe an image |
| GET  | `/api/azure/test`                  | Verify Azure credentials |
| POST | `/api/elevenlabs/speak`            | Generate audio (TTS) |

---

## 9 · License

This deployment package is provided as-is. The frontend (`public/index.html`)
retains its original license. The backend code in this folder is MIT-licensed —
adapt it freely.
