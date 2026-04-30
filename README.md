# RFP Agent — Railway Deployment

AI-powered RFP analysis & response generation. Single-tenant or multi-tenant Node.js + Express app, ready to deploy to Railway.

**v1.1** — added real auth (register/login), per-user API keys settable from the UI, and brand-aligned PDF/PowerPoint exports.

---

## What's in the box

```
rfp-agent-railway/
├── public/
│   ├── auth.html       # Login + signup page (served at /)
│   └── index.html      # The full RFP Agent app (served at /app, gated)
├── server.js           # Express entry point
├── routes/
│   ├── auth.js         # Register / login / logout / profile / per-user library
│   ├── ai.js           # /api/chat, /api/generate, /api/analyze-rfp, /api/estimate-effort, ...
│   ├── fill.js         # /api/fill-docx, /api/fill-pdf
│   ├── integrations.js # Azure & ElevenLabs proxy endpoints
│   └── mp.js           # Multi-agent: clarifications, coverage, polish, validate, vision
├── lib/
│   ├── auth.js         # scrypt password hashing + HMAC-signed cookie sessions
│   ├── users.js        # User CRUD on top of storage
│   ├── anthropic.js    # SDK wrapper (accepts per-user API key)
│   ├── extract.js      # PDF/DOCX/XLSX server-side extraction
│   └── storage.js      # JSON-file collection store
├── data/               # Runtime JSON store (users.json, library.json, …)
├── railway.json        # Railway build/deploy config
├── nixpacks.toml       # Node 20 build config
├── Procfile            # `web: npm start`
└── package.json
```

---

## Architecture & flow

1. **Visitor lands on `/`** → if no session cookie, sees `auth.html` (login/signup).
2. **They register or log in** → `POST /api/auth/register` or `/api/auth/login` returns a signed-cookie session and the frontend redirects to `/app`.
3. **`/app` serves `index.html`** — the full RFP Agent SPA. Every API call sends the cookie automatically.
4. **First action: open Settings (👤 top-right) and paste your Anthropic API key.** It's saved per-user via `PUT /api/me` and used for all AI calls. Alternatively, set `ANTHROPIC_API_KEY` in Railway → Variables and every user gets to use that single shared key.
5. **AI calls** (`/api/chat`, `/api/generate`, `/api/analyze-rfp`, `/api/estimate-effort`, `/api/fill-docx`, `/api/mp/*`) all read the key from the user's record first, falling back to the env var.

The first user to register becomes admin. Sessions last 30 days (configurable via `SESSION_DAYS`).

---

## Deploying to Railway

### Option A — Dashboard

1. Push this folder to a GitHub repo.
2. In Railway → **New Project → Deploy from GitHub repo** → pick the repo.
3. Once the build finishes, open **Variables** and add:
   - `SESSION_SECRET` — a long random string (32+ chars). **Without this, sessions reset on every redeploy.**
   - `ANTHROPIC_API_KEY` — *optional*. If set, all users share this key. If unset, each user must paste their own in Settings.
4. (Recommended for production) **Storage → Volumes → Mount at `/data`**, then add `DATA_DIR=/data` to Variables. Otherwise the JSON store (users, library, etc.) is wiped on every redeploy.
5. **Settings → Domains → Generate Domain**. Done.

### Option B — CLI

```bash
npm install -g @railway/cli
railway login
railway init                              # link this folder to a new Railway project
railway up                                # deploy
railway variables set SESSION_SECRET=$(openssl rand -hex 32)
# Optional shared key:
railway variables set ANTHROPIC_API_KEY=sk-ant-...
railway domain                            # generate a public URL
```

---

## Environment variables

| Variable | Required? | Default | Notes |
|---|---|---|---|
| `SESSION_SECRET` | **Yes for prod** | random per-process | 32+ char random string. If missing, all users get logged out on every redeploy. |
| `ANTHROPIC_API_KEY` | No | — | If set, used as a fallback for users who haven't pasted their own key in Settings. |
| `CLAUDE_MODEL` | No | `claude-sonnet-4-6` | Override to test other Claude models. |
| `DATA_DIR` | No | `./data` | Set to `/data` if you mounted a Railway Volume there. |
| `SESSION_DAYS` | No | `30` | How long login sessions last. |
| `AI_RATE_PER_MIN` | No | `30` | Per-IP rate limit on `/api/*` endpoints that call AI. |
| `GENERAL_RATE_PER_MIN` | No | `240` | Per-IP rate limit on all other `/api/*` endpoints. |
| `STORAGE_CAP` | No | `500` | Max rows per JSON collection (oldest get trimmed). |
| `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` / `AZURE_SUBSCRIPTION_ID` | No | — | Enables `/api/azure/*` endpoints. |
| `ELEVENLABS_API_KEY` | No | — | Fallback voice key. Each user can override in Settings. |
| `NODE_ENV` | No | — | When `production`, session cookies are marked `Secure`. |
| `PORT` | No | `3000` | Railway sets this automatically. |

---

## Running locally

```bash
npm install
cp .env.example .env             # then edit .env to add SESSION_SECRET (recommended)
npm start                        # http://localhost:3000

# in another terminal
npm run test:smoke               # only auth-free endpoints; expect a few 401s
```

---

## How auth works (under the hood)

- **Password hashing:** Node's built-in `crypto.scryptSync` with a 16-byte salt — no `bcrypt` native compile needed.
- **Sessions:** stateless signed-cookie tokens (`<userId>.<expiry>.<hmac>`). Server validates the HMAC + expiry on every request.
- **Cookies:** `rfp_session`, `HttpOnly`, `SameSite=Lax`, `Secure` in production.
- **Per-user data:** `library.json`, `recent.json`, `estimations.json` rows are tagged with `user_id`; queries filter automatically.
- **API key storage:** plain text in `users.json`. **For production, mount a Railway Volume to `/data` so the file is encrypted at rest by Railway, and consider swapping the JSON store for Postgres + pgcrypto if you have multiple users.**

---

## API endpoints

### Public

```
POST /api/auth/register   { email, password, org_name? } → { success, user } + sets cookie
POST /api/auth/login      { email, password }            → { success, user } + sets cookie
POST /api/auth/logout                                     → { success } + clears cookie
GET  /api/health                                          → { ok, model, ... }
```

### Authenticated (cookie required)

```
GET  /api/me                                                  → user profile (api_key returned masked)
PUT  /api/me                  { name, org_name, api_key, ... } → { success, user }
PUT  /api/me/password         { current, newPassword }         → { success }

GET  /api/library                                              → user's saved responses
POST /api/library             { rfp_name, response, ... }      → row
DELETE /api/library/:id                                        → { success }

POST /api/chat                { message, context, history }    → { response }
POST /api/generate            { rfp_text, instructions, ... }  → { response }
POST /api/improve             { text, instruction }            → { text }
POST /api/analyze-rfp         { rfp_text, filename }           → { brief: {...} }
POST /api/estimate-effort     { rfp_text, ... }                → { estimation: {...} }
POST /api/fill-docx (multipart: file)                          → .docx download

POST /api/mp/clarifications   { rfp_text }                     → { clarifications }
POST /api/mp/coverage         { rfp_text, draft }              → { coverage_score, gaps }
POST /api/mp/polish           { text, instruction }            → { text }
POST /api/mp/validate         { rfp_text, draft }              → { issues }
POST /api/mp/analyze-image    (multipart: image)               → { analysis }

POST /api/azure/cost-analysis { subscription_id, ... }         → { ... }   (503 if Azure not configured)
POST /api/elevenlabs/tts      { text, voice_id }               → audio/mp3 (503 if ElevenLabs not configured)
```

`PUT /api/me` notes:
- `api_key` field is **only** updated if you send a real new value. Empty string or a string containing `•` (the masked form) means "leave it alone" — re-saving the org profile will not wipe your stored key.
- Anthropic keys must start with `sk-ant-` or the request is rejected with a 400.

---

## Branded exports

The Executive Brief page exports two formats — both styled to match the Inception/G42 brand reference:

- **PDF (`Download Brief PDF`):** 2-page A4 landscape. Page 1 is a dark-navy-gradient cover with the RFP title (one keyword highlighted in violet), reference number, issuer, value, and submission date. Page 2 is a single-page executive brief with 4 KPI tiles, 3 columns (Summary/Dates/Compliance | Top Requirements w/ source citations | Wins/Risks/Actions), and a dark footer with win-probability bar.

- **PPTX (`Download Brief PPT`):** 2 slides at 16:9 widescreen, identical content/structure to the PDF. Generated client-side with PptxGenJS (loaded from a CDN at runtime — no bundle bloat).

Both auto-pick a "hero word" from the RFP title and display it in the lighter violet accent — matching the brand reference's "Unified **Support** Model" treatment.

---

## Troubleshooting

**"Not signed in" / 401 on every API call**
You haven't set `SESSION_SECRET`, so the secret is randomized per-process and your cookie no longer validates. Set `SESSION_SECRET` in Railway → Variables.

**"No Anthropic API key configured"**
Either paste your key in Settings → Anthropic API Key (recommended) or set `ANTHROPIC_API_KEY` in Railway → Variables.

**Library / recent / users empty after redeploy**
Railway's filesystem is ephemeral by default. Mount a Volume at `/data`, add `DATA_DIR=/data` to Variables, redeploy.

**Sessions reset on every deploy**
Same fix as above — set a stable `SESSION_SECRET`.

**PDF prints as one column instead of three**
You're using a non-Chrome print engine. The export uses CSS Grid + inline-block fallback; both work in Chrome (which is what the in-app print button uses) but ancient print engines may collapse the layout.
