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
