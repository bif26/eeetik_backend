# eeetik_backend

NestJS backend for **eeetik** — TikTok metadata, downloads and delivery — now
**Telegram-native** on a 100% free-tier cloud stack:

- 🤖 **Telegram Bot** (grammY) is the primary interface — no web frontend required
- 🖼 **Telegram Mini App** (SvelteKit + daisyUI) for rich UX inside Telegram
- 📦 **Telegram CDN** as the media delivery layer (cached `file_id`s, zero disk usage)
- ⚡ **Upstash Redis** (free tier) for BullMQ, caching, single-flight locks and rate limiting
- 🍃 **MongoDB** (Atlas M0 / Render free) for metadata, download logs and users
- 🚀 **Render** free tier for hosting (API + worker + static Mini App)

---

## Architecture

```
                    ┌────────────────────────┐
   TikTok URL ────▶ │  Telegram Bot (grammY) │──▶ metadata preview + quality keyboard
                    │  (inside eeetik-api)   │──▶ enqueue BullMQ job (chatId attached)
                    └───────────┬────────────┘
                                │
   Telegram Mini App ── REST ─▶ │  eeetik-api (NestJS)
   (SvelteKit + daisyUI)        │   • /api/v2/model/download/tiktok/*
                                │   • /api/v2/auth/telegram, /api/v2/auth/me
                                │   • BotOrMiniAppGuard (tma initData | JWT | bot secret)
                                ▼
                    ┌────────────────────────┐
                    │  Upstash Redis (free)  │  BullMQ queue + metadata cache + locks
                    └───────────┬────────────┘
                                ▼
                    ┌────────────────────────┐
                    │  eeetik-worker (BullMQ)│  download ─▶ /tmp ─▶ Telegram upload
                    │  concurrency: 2        │  ─▶ file_id cached in Redis ─▶ rm -rf /tmp
                    └───────────────────────┘
```

**Delivery flow (worker):**

```
download to /tmp/eeetik-downloads
  → file_id cache hit?  ── yes ─▶ send cached file_id to chat (instant) ─▶ done
        │ no
  → upload to Telegram chat (sendVideo / sendAudio / sendDocument)
  → cache file_id (TTL 24h) ─▶ temp dir deleted (finally, always)
```

Render free tier has **no persistent disk** — nothing is ever written outside
`/tmp`, and every job cleans up after itself.

### Monorepo layout

| Path | Description |
|---|---|
| `apps/eeetik_backend` | NestJS API: metadata, prepare/status endpoints, bot, auth, health, metrics |
| `apps/worker` | BullMQ worker: download → Telegram upload pipeline |
| `apps/miniapp` | SvelteKit 2 + Svelte 5 + Tailwind 4 + daisyUI Mini App |
| `libs/shared` | Shared schemas (Mongoose), Redis connection helper, logging, readiness probes |

### Key API endpoints (prefix `/api/v2`)

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/model/download/tiktok` | Bot / Mini App | Fetch TikTok metadata preview |
| POST | `/model/download/tiktok/prepare` | Bot / Mini App | Enqueue a download job (REST flow) |
| GET | `/model/download/tiktok/status/:jobId` | Bot / Mini App | Poll job status |
| GET | `/model/download/tiktok/history` | Bot / Mini App | Recent downloads (Mini App library) |
| POST | `/auth/telegram` | tma initData | Exchange initData for a JWT |
| GET/PATCH | `/auth/me` | Bot / Mini App | User profile + Mini App settings |
| POST | `/bot/webhook` | webhook secret | Telegram webhook receiver |
| GET | `/health/live`, `/health/ready` | public | Health probes (Render health check) |

**`BotOrMiniAppGuard`** accepts (in order):
1. `X-Bot-Secret: <BOT_INTERNAL_SECRET>` — bot-internal calls
2. `Authorization: tma <initData>` — Telegram-signed Mini App payload
3. `Authorization: Bearer <jwt>` — token issued by `POST /auth/telegram`

Verified callers skip the legacy ad gate; unauthenticated traffic is rejected
with 401.

---

## Appwrite architecture (serverless, primary)

The repo ships a fully **Appwrite-native stack** (`appwrite/` + `appwrite.json`)
that runs entirely on Appwrite Cloud — no Render/Heroku/Redis needed:

| Resource | Id | Role |
|---|---|---|
| TablesDB database | `eeetik` | tables: `users`, `jobs`, `files`, `meta`, `history` |
| Storage bucket | `6ad1172800034a06bcf5` ("rr") | permanent media copies — every delivered file also lands here; messages carry a non-expiring **⬇️ Save file** button (`/storage/.../view` link, bucket has `read("any")`) |
| Function | `tg-bot` (every-minute schedule) | Telegram bot UX (/start, /help, /id, link → preview → quality keyboard, callbacks, web_app_data) **+** Mini App API (`auth`, `metadata`, `prepare`, `jobs`, `download`, `history`, `settings`) |
| Function | `tg-processor` (event + 5-min sweep) | row event `jobs.rows.*.create` → scrape → download to /tmp → upload to Appwrite bucket → upload to Telegram → cache `file_id` + `appwriteFileId` → deliver |
| Site | `miniapp` | SvelteKit Mini App (daisyUI) |
| Auth | Appwrite Auth | Telegram initData → HMAC-validated → Appwrite user `tg_<id>` + session |

**How a download flows**

1. User sends a TikTok link in chat (or pastes it in the Mini App).
2. `tg-bot` returns a rich preview + quality keyboard; picking a quality creates
   a `jobs` row (status `queued`).
3. The row-create event triggers `tg-processor`: it downloads the media to the
   function's /tmp, uploads a permanent copy to Storage bucket `6ad1172800034a06bcf5`,
   uploads it via the Bot API (49 MB guard, SD fallback, Images ZIP via
   archiver), caches the returned `file_id` **and** `appwriteFileId` in the
   `files` table, and marks the job `completed` (chat delivery + history row).
4. The Mini App polls job status through `tg-bot` and gets a direct
   `api.telegram.org/file/…` playback link (bucket view link preferred —
   it never expires).

**Bot delivery without a webhook domain:** the `tg-bot` function polls
`getUpdates` every minute (offset persisted in the `meta` table). If you later
attach a function domain, the same function also accepts raw Telegram webhooks
(`x-telegram-bot-api-secret-token` verified) — set the webhook to
`https://<domain>/` and delete the schedule.

### Deploy / operate

```bash
npm install -g appwrite-cli@latest
appwrite login
appwrite push functions --all   # uses appwrite.json
```

Function **variables** (Console → Functions → ⚙ Variables) — required:

| Variable | On | Value |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | tg-bot + tg-processor | BotFather token (**set** — bot `@eeetik_bot`) |
| `TELEGRAM_WEBHOOK_SECRET` | tg-bot | `openssl rand -hex 32` (already set) |
| `TELEGRAM_ALLOWED_USER_IDS` | tg-bot | comma-separated numeric ids allowed to use the bot (**set: `1673359993`** — delete the variable to make the bot public) |
| `TELEGRAM_MINI_APP_URL` | tg-bot | Mini App public URL (Mini App button + /start) — set it after connecting your domain, see below |
| `TELEGRAM_STORAGE_CHAT_ID` | tg-processor | your numeric Telegram user id, fallback upload target (**set: `1673359993`** — you must have pressed START on the bot once) |
| `APPWRITE_BUCKET_ID` | tg-bot + tg-processor | permanent-media Storage bucket (**set: `6ad1172800034a06bcf5`**) |
| `APPWRITE_API_KEY` | both | Appwrite API key with tables/users/sessions/storage scopes (pre-configured — rotate it, the console "standard" key expires!) |

All of the above are **already configured live** (verified end-to-end: a test
job downloaded, landed in the bucket, and was delivered to the owner chat).
After rotating the API key, update the `APPWRITE_API_KEY` variable on **both**
functions (Console → Functions → ⚙ Variables).

### Connect your Cloudflare domain to Appwrite

Appwrite does not take IPs to point A-records at; it gives you a **CNAME
hostname** per resource in the console. With Cloudflare:

1. **Site (Mini App) — subdomain (easiest):**
   - Appwrite Console → **Sites → miniapp → Domains tab → Add domain**.
   - Enter e.g. `app.yourdomain.com`, rule type **Active deployment**.
   - Appwrite shows a **CNAME target** (an `*.appwrite.global`-style hostname).
   - Cloudflare Dashboard → your domain → **DNS → Records → Add record**:
     `Type CNAME` · `Name app` (or whatever subdomain) · `Target <copied
     hostname>` · **Proxy status: DNS only (grey cloud)** — important, Appwrite
     issues its own TLS certificate; the orange cloud breaks verification.
   - Back in the console wait until the domain shows **Verified** (minutes to
     a few hours). HTTPS is issued automatically by Appwrite.
2. **Apex (`yourdomain.com`, no nameserver change):** same flow — Appwrite now
   supports **CNAME flattening** (March 2026): add the domain in the console,
   copy the CNAME (+ CAA, if Appwrite shows one) and create them in
   Cloudflare; Cloudflare flattens apex CNAMEs automatically. Do **not** switch
   nameservers to `ns1/ns2.appwrite.zone` — that would move your whole DNS
   (mail, etc.) out of Cloudflare.
3. **(Optional, instant bot responses) Function domain for the webhook:**
   Console → **Functions → tg-bot → Domains → Add domain** with e.g.
   `api.yourdomain.com`, add the same grey-cloud CNAME in Cloudflare, then set
   the Telegram webhook to `https://api.yourdomain.com/` and delete the
   every-minute schedule (Functions → tg-bot → Schedules) to stop the polling.
4. **Wire the Mini App into the bot:** once the site domain is verified, set
   function variable `TELEGRAM_MINI_APP_URL=https://app.yourdomain.com` on
   `tg-bot` (Console → Functions → tg-bot → Variables). The **🎵 Open Mini App**
   button appears under /start and the Mini App link opens inside Telegram.

CI template: `docs/github-actions/deploy-appwrite.yml` (auto-deploys functions
on every push to `main`; copy it into `.github/workflows/` — tokens need the
`workflow` permission for that path, see the Render section below).

> The classic NestJS deployment (Render blueprint / Heroku dynos, this README
> below) is still fully supported — both stacks share the same download
> logic; the Appwrite stack needs no Redis/Mongo and runs on the free plan.

---

## Deployment (Render free tier)

The repo ships a **Render Blueprint** (`render.yaml`) with three services:

1. `eeetik-api` — web service (Node), health check `/api/v2/health/live`
2. `eeetik-worker` — background worker running `start:worker:prod`
3. `eeetik-miniapp` — static site built from `apps/miniapp/build`

### Steps

1. **Fork/push this repo to GitHub**, then in Render: **New → Blueprint** and
   select the repo. Render creates all three services.
2. **Create Upstash Redis** (free): [console.upstash.com](https://console.upstash.com)
   → Create database (Regional, EV0 free tier) → copy the endpoint host and
   password into `UPSTASH_REDIS_HOST` / `UPSTASH_REDIS_PASSWORD` on both
   Render services.
3. **Create MongoDB** (free): Atlas M0 cluster (or Render MongoDB) → copy the
   connection string into `MONGO_URI`. Whitelist Render egress (`0.0.0.0/0`
   for Atlas free).
4. **Create the bot with @BotFather**:
   - `/newbot` → choose a name + username → copy the token into
     `TELEGRAM_BOT_TOKEN`
   - Set the Mini App: `/newapp` (or *Bot Settings → Menu Button*) → paste your
     `eeetik-miniapp.onrender.com` URL → also set it as
     `TELEGRAM_MINI_APP_URL` on the API service.
5. **Generate secrets** and set them on the API service:
   - `BOT_INTERNAL_SECRET`, `JWT_SECRET`, `TELEGRAM_WEBHOOK_SECRET`
     (`openssl rand -hex 32` each).
6. **Deploy** — the bot auto-detects `RENDER_EXTERNAL_URL` and registers the
   webhook at `https://<api-host>/api/v2/bot/webhook`. Test with `/start`.

> **Webhook vs polling:** when `RENDER_EXTERNAL_URL` (or
> `TELEGRAM_WEBHOOK_URL`) is present the bot uses webhooks; otherwise it falls
> back to long polling. Force either with `TELEGRAM_WEBHOOK_URL` or by
> leaving both unset.

> **Single-service mode:** Render free background workers may be gated on some
> accounts. If so, delete the `eeetik-worker` block in `render.yaml` and run
> `npm run start:worker:prod` as a second **web** service (it only needs
> `/api/v2/health/live` to respond — add the health module if you go this
> route), or simply keep the default blueprint.

### Automatic deploys (push to main → live on Render)

Two layers of automation are wired up:

1. **Render autoDeploy (always on).** All three blueprint services set
   `autoDeploy: true`, so every push to `main` triggers a fresh build + deploy
   on Render with zero extra configuration.
2. **GitHub Actions deploy hooks (optional).** A ready-made workflow lives at
   `docs/github-actions/deploy.yml`. Copy it to `.github/workflows/deploy.yml`
   and add the optional repository secrets `RENDER_DEPLOY_HOOK_API`,
   `RENDER_DEPLOY_HOOK_WORKER`, `RENDER_DEPLOY_HOOK_MINIAPP` (Render → service
   → Settings → Deploy Hook). On every push to `main` it pings all three hooks
   so the services redeploy in sync. Without the secrets it exits gracefully.
   > Note: updating files under `.github/workflows/` requires a token with the
   > `workflow` scope (fine-grained PATs need the *Workflows* permission). The
   > legacy DigitalOcean/PM2 workflow in `.github/workflows/deploy.yml` is
   > obsolete — replace it with the template above (or disable it in the
   > Actions tab) with such a token.

---

## Deployment on Heroku (free credits)

Heroku is a good alternative when you have credits and want dynos that
**never sleep** (Render free web services sleep after 15 idle minutes).

| Resource | Purpose | Cost |
|---|---|---|
| `web` dyno (Basic) | API + Telegram bot **+ BullMQ worker** (single-dyno mode) | ~$7/mo |
| `worker` dyno (optional) | dedicated queue processing dyno | ~$7/mo |
| `heroku-redis` (mini addon) | BullMQ + caches (`REDIS_URL` injected automatically) | ~$3/mo |
| MongoDB Atlas M0 | database — free, no credit card | $0 |
| Render static site | Mini App hosting — free, no credit card | $0 |

> Redis is covered by your credits via the `heroku-redis` mini addon, so no
> Upstash account (and no credit card) is needed. Cardless free Redis
> alternatives (Redis Cloud 30 MB) also work: just set `REDIS_URL` manually.

### Steps

1. **Create the app + Redis** (CLI or dashboard):
   ```bash
   heroku create eeetik-app
   heroku addons:create heroku-redis:mini
   # BullMQ requires noeviction – never use allkeys-lru with queues:
   heroku redis:maxmemory $(heroku config:get HEROKU_REDIS_URL -s | sed 's/.*\/\([^/]*\)$/\1/' ) --policy noeviction 2>/dev/null || heroku redis:maxmemory REDIS --policy noeviction
   ```
   Simpler via dashboard: Resources → *Heroku Key-Value Store* (mini) →
   Settings → *maxmemory policy* → `noeviction`.
2. **Set config vars** (Settings → Reveal Config Vars, or `heroku config:set`):
   ```bash
   heroku config:set \
     MONGO_URI="mongodb+srv://user:pass@cluster0.xxx.mongodb.net/eeetik?retryWrites=true&w=majority" \
     TELEGRAM_BOT_TOKEN="123456:AA-your-botfather-token" \
     TELEGRAM_MINI_APP_URL="https://your-miniapp.onrender.com" \
     TELEGRAM_WEBHOOK_SECRET="<openssl rand -hex 32>" \
     BOT_INTERNAL_SECRET="<openssl rand -hex 32>" \
     JWT_SECRET="<openssl rand -hex 32>" \
     TELEGRAM_WEBHOOK_URL="https://eeetik-app-xxxx.herokuapp.com/api/v2/bot/webhook" \
     CORS_ORIGINS="https://your-miniapp.onrender.com"
   ```
   `REDIS_URL` is created by the addon automatically and `rediss://` TLS is
   detected out of the box.
3. **Deploy**: `git push heroku main` — the `heroku-postbuild` script builds
   the shared lib, API and worker.
4. **Dyno sizing**:
   - *Single dyno (default, ~$10/mo with Redis):* `heroku ps:scale web=1 worker=0`
     — the `web` dyno runs the API, the bot **and** the worker together
     (see `scripts/start-combined.js`).
   - *Separate worker (~$17/mo with Redis):*
     `heroku config:set ENABLE_COMBINED_WORKER=false && heroku ps:scale web=1 worker=1`
   The bot only starts on the `web` dyno (detected via `DYNO`), so there are
   never Telegram polling/webhook conflicts between dynos.
5. **Mini App hosting** stays on Render (static sites are free, no card):
   *New → Static Site* → repo → build `cd apps/miniapp && npm ci && npm run build`
   → publish `apps/miniapp/build` → env `PUBLIC_API_BASE_URL=https://eeetik-app-xxxx.herokuapp.com`
   → rewrite rule `/* → /index.html`. Then match `TELEGRAM_MINI_APP_URL` /
   `CORS_ORIGINS` on Heroku to the static site URL.

> With ~$200 in credits at $8–17/month, expect **12–25 months** of uptime for
> a single-user setup.

---

## Mini App development

```bash
cd apps/miniapp
npm install
npm run dev            # SvelteKit dev server
```

- Pages: `/` (paste URL), `/preview` (metadata + quality), `/queue`
  (job polling), `/library` (past downloads), `/settings`
- UI: daisyUI 5 components with a custom `telegram` theme; light/dark follows
  Telegram's `themeParams`
- All API calls attach `Authorization: tma <initData>` automatically
- Storage: **Telegram CloudStorage via the SDK** — `localStorage` is not used
- Point it at a local API with a `.env` file:
  `PUBLIC_API_BASE_URL=http://localhost:3000`

To try it inside Telegram without deploying, expose the dev server with a
tunnel (e.g. `ngrok http 5173`) and set that URL in BotFather → Menu Button.

---

## Local development (bot + API + worker)

```bash
cp .env.example .env.local        # fill in Upstash/Mongo/bot token
npm install
npm run start:dev                 # API + bot (polling) on :3000
npm run start:worker:dev          # worker in a second terminal
```

The bot works with a local Redis via `UPSTASH_REDIS_TLS=false` +
`REDIS_HOST=127.0.0.1` (see comments in `.env.example`).

### Scripts

| Command | Description |
|---|---|
| `npm run build` | Build shared lib + API + worker |
| `npm run start:prod` | Start API from `dist` |
| `npm run start:worker:prod` | Start worker from `dist` |
| `npm run lint` | ESLint (auto-fix) |
| `npm run test` | Jest unit tests |
| `npm run test:e2e` | API + worker e2e suites |

### Environment variables

See [`.env.example`](.env.example) for the complete, commented list. The most
important additions in this migration:

| Variable | Purpose |
|---|---|
| `UPSTASH_REDIS_HOST` / `UPSTASH_REDIS_PASSWORD` | Upstash Redis endpoint (TLS auto-enabled) |
| `TELEGRAM_BOT_TOKEN` | BotFather token |
| `TELEGRAM_MINI_APP_URL` | Public Mini App URL (used in bot keyboards) |
| `TELEGRAM_FILE_ID_CACHE_TTL` | Redis TTL for cached file_ids (default 24 h) |
| `TELEGRAM_MAX_UPLOAD_MB` | Upload size guard (default 49 MB, bot API limit) |
| `TELEGRAM_STORAGE_CHAT_ID` | Optional fallback chat for jobs without a chatId |
| `TELEGRAM_WEBHOOK_URL` / `TELEGRAM_WEBHOOK_SECRET` | Webhook mode override + secret |
| `ENABLE_TELEGRAM_BOT` | `false` on the worker service |
| `TEMP_DOWNLOAD_DIR` | Worker temp dir (default `/tmp/eeetik-downloads`) |
| `WORKER_CONCURRENCY` | BullMQ worker concurrency (default 2) |
| `BOT_INTERNAL_SECRET` | Shared secret for bot-internal REST calls |
| `JWT_SECRET` / `JWT_EXPIRES_IN` | Mini App JWT session tokens |

Removed: `STORAGE_PATH`, `STORAGE_MAX_MONTHLY_BYTES`, `URL_SIGNING_SECRET`,
`SIGNED_URL_EXPIRY_SECONDS` (local-disk + signed-URL delivery is replaced by
Telegram CDN `file_id` caching; set `STORAGE_BACKEND=local` to revive the
legacy path for local experiments).

---

## Bot usage

| Command | Behavior |
|---|---|
| `/start` | Welcome + inline **🎵 Open Mini App** button |
| `/help` | Supported platforms + command list |
| `/download <url>` | Fetch metadata directly |
| paste a TikTok URL | Preview card + quality inline keyboard |
| `quality:{uniqueId}:{hd\|sd\|audio\|zip}` | Enqueue the job; media is delivered to the chat |
| Mini App `web_app_data` | Verified payload triggers preview / direct enqueue |

Quality keyboard (video posts):

```
[ HD 1080p ] [ SD 720p ]
[ Audio MP3 ]
[ 🔙 Back ]
```

Image posts get `[ Images ZIP ]` + `[ Audio MP3 ]` instead.

## CI

`.github/workflows/ci.yml` runs lint, unit tests and the full build on every
push/PR. Render auto-deploys from Git — no SSH/PM2 pipeline anymore (the old
PM2 config `ecosystem.config.js` was removed in this migration). The legacy
Droplet deploy workflow (`.github/workflows/deploy.yml`) is retained only
because the deployment PAT used for this migration lacks the GitHub
`workflow` scope required to delete workflow files — **delete it via the
GitHub UI after merging** (it is inert on this branch and its Droplet secrets
no longer exist).

## Testing checklist

- [x] `npm run build` succeeds
- [x] `npm run lint` passes
- [x] `npm run test` passes (46 specs incl. initData HMAC + guard suites)
- [ ] Bot responds to `/start` with Mini App button *(needs live token)*
- [ ] Bot fetches TikTok metadata from a URL *(needs live token)*
- [ ] Quality keyboard shows correct options *(unit-tested)*
- [ ] Download job completes and media is sent to Telegram *(needs live token)*
- [ ] `file_id` caching works (second request is instant) *(needs live token)*
- [ ] Mini App loads in Telegram WebView *(needs deployed static site)*
- [ ] Mini App auth via `initData` works *(HMAC verified by unit tests)*
- [ ] Mini App respects light/dark theme
- [ ] Health endpoints respond (`/api/v2/health/live`)
- [ ] No files remain in `/tmp` after job completion (cleanup is in `finally`)
