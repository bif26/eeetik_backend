# eeetik backend

Secure and scalable NestJS backend for TikTok metadata + download workflows with:
- API app (`apps/eeetik_backend`)
- Worker app (`apps/worker`) using BullMQ
- Redis cache + queue
- MongoDB persistence
- MinIO S3-compatible object storage for media files
- Ad-gated download flow (Google AdSense + Google Tag Manager policy integration)

## Architecture

### Services
- **API service**: metadata fetch, prepare request, status polling, ad policy checks
- **Worker service**: background media transfer, ZIP generation, signed URL issuance
- **Redis**: metadata cache and BullMQ transport
- **MongoDB**: metadata + download logs
- **MinIO**: S3-compatible self-hosted object storage
- **Cloudflare** (optional): edge proxy, WAF, DDoS shielding

### Sequence flow

```mermaid
sequenceDiagram
    participant User
    participant Frontend
    participant Backend
    participant Redis
    participant MongoDB
    participant Scraper as @tobyg74/tiktok-api-dl
    participant Bull as BullMQ Worker
    participant R2 as MinIO Storage
    participant TikTok as TikTok CDN

    User->>Frontend: Paste TikTok URL
    Frontend->>Backend: POST /api/v2/model/download/tiktok
    Backend->>Redis: Lookup metadata cache
    alt cache miss
      Backend->>MongoDB: Lookup metadata
      alt mongo miss
        Backend->>Scraper: Fetch TikTok metadata
        Scraper->>TikTok: Resolve source URLs
        Scraper-->>Backend: Parsed metadata
        Backend->>R2: Upload transformed thumbnail/images
        Backend->>MongoDB: Save metadata + source URLs
      end
      Backend->>Redis: Cache metadata (24h)
    end
    Backend-->>Frontend: { success: true, data: preview metadata }

    User->>Frontend: Choose HD/SD/Audio/ZIP
    Frontend->>Backend: POST /api/v2/model/download/tiktok/prepare
    Backend->>MongoDB: Insert download_log(status=processing)
    Backend->>Bull: Enqueue job
    Backend-->>Frontend: jobId

    Bull->>MongoDB: Read metadata by uniqueId
    alt HD/SD/Audio
      Bull->>TikTok: Stream source media
      Bull->>R2: Upload media object
    else ZIP
      Bull->>R2: Read prepared images
      Bull->>Bull: Build ZIP archive
      Bull->>R2: Upload ZIP
    end
    Bull->>Backend: Generate presigned S3 URL (short TTL)
    Bull->>MongoDB: Update download_log(status=completed, downloadUrl)

    Frontend->>Backend: GET /api/v2/model/download/tiktok/status/:jobId
    Backend-->>Frontend: processing/completed + downloadUrl
```

## API endpoints

- `POST /api/v2/model/download/tiktok`
  - Body: `{ "url": "https://www.tiktok.com/..." }`
  - Returns `{ success: true, data }` where `data` includes `uniqueId`, `type`, `author`, `stats`, `hashtags`, `availableFormats`
  - `type: "video"` responses include `thumbnail` and `duration`
  - `type: "image"` responses include `images`
- `POST /api/v2/model/download/tiktok/prepare`
  - Body: `{ "uniqueId": "...", "requestType": "hd|sd|audio|zip", "adToken": "...", "adDurationSeconds": 30 }`
  - Returns `{ jobId, status }`
- `GET /api/v2/model/download/tiktok/status/:jobId`
  - Returns job status and signed URL when complete
- `GET /api/v2/health/live`
- `GET /api/v2/health/ready`
- `GET /api/v2/metrics` (Prometheus format)
- Preview response examples: `docs/preview-endpoint-output.md`

## Local development

1. Copy environment values:
   ```bash
   cp .env.example .env
   ```
2. Install dependencies:
   ```bash
   npm ci
   ```
3. Start infra:
   ```bash
   docker compose up -d mongodb redis
   docker compose ps
   ```
4. Wait until `mongodb` and `redis` are marked `healthy`, then run API and worker:
   ```bash
   npm run start:dev
   npm run start:worker:dev
   ```
5. (Optional) Run the full stack in Compose with dependency sequencing:
   ```bash
   docker compose up --build api worker
   ```

### Startup readiness diagnostics

- API and worker now perform startup dependency checks for MongoDB + Redis before NestJS initialization.
- Retries are concise (no repeated stack traces) and fail fast with actionable hints when the timeout is reached.
- Tuning knobs (see `.env.example`):
  - `STARTUP_DEPENDENCY_MAX_WAIT_MS` (default `60000`)
  - `STARTUP_DEPENDENCY_RETRY_INTERVAL_MS` (default `2500`)
  - `STARTUP_DEPENDENCY_PROBE_TIMEOUT_MS` (default `3000`)
- Metadata cache + single-flight tuning knobs:
  - `METADATA_CACHE_URL_TTL_SECONDS`, `METADATA_CACHE_UID_TTL_SECONDS`
  - `METADATA_SINGLEFLIGHT_LOCK_TTL_MS`
  - `METADATA_SINGLEFLIGHT_WAIT_RETRY_MS`, `METADATA_SINGLEFLIGHT_MAX_RETRIES`
- Troubleshooting commands:
  ```bash
  docker compose ps
  docker compose logs mongodb redis
  docker compose up -d mongodb redis
  ```

### Rate limiting

- API throttling uses Redis-backed distributed storage (shared across instances) with in-memory fallback if Redis rate-limit storage becomes unavailable.
- Global throttle env knobs:
  - `THROTTLE_TTL_MS` (default `60000`)
  - `THROTTLE_LIMIT` (default `120`)
  - `THROTTLE_BLOCK_DURATION_MS` (default: `THROTTLE_TTL_MS`)
- Expensive-route throttle knobs for:
  - `POST /api/v2/model/download/tiktok`
  - `POST /api/v2/model/download/tiktok/prepare`
  - Env: `THROTTLE_EXPENSIVE_TTL_MS`, `THROTTLE_EXPENSIVE_LIMIT`, `THROTTLE_EXPENSIVE_BLOCK_DURATION_MS`
- Redis throttle storage knobs:
  - `THROTTLE_REDIS_HOST` / `THROTTLE_REDIS_PORT` / `THROTTLE_REDIS_PASSWORD`
  - `THROTTLE_REDIS_KEY_PREFIX` (default `throttle`)
  - Unset knobs automatically fall back to `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD`
- `GET /api/v2/health/live`, `GET /api/v2/health/ready`, and `GET /api/v2/metrics` are skipped from throttling.

## Operational logging

- Structured operational logs are emitted as JSON lines and appended to:
  - `${LOG_DIR}/operations.log` (default: `.local/logs/operations.log`)
- Default structured fields include `requestId`, `route`, `statusCode`, `durationMs`, and download-flow context (`cache`, `uniqueId`, `jobId`) where available.
- Environment settings:
  - `LOG_LEVEL=debug|info|warn|error` (default: `info`)
  - `LOG_DIR=<path>` (default: `.local/logs`)
- Existing files in the log directory are preserved; logs are append-only.
- Retention recommendation: rotate daily and keep 14–30 days (for local dev, 14 days is usually enough).

## Build, test, lint

```bash
npm run lint
npm run test -- --runInBand
npm run build
npm run loadtest:k6:seed
npm run loadtest:k6
```

## Load validation

Run e2e load validation against real TikTok + R2 + CDN setup:

```bash
LOADTEST_MODE=e2e BASE_URL=https://api.eeetik.app SAMPLE_TIKTOK_URL=https://www.tiktok.com/@.../video/... npm run loadtest:k6:e2e
```

Set `STORAGE_MAX_MONTHLY_BYTES` to your storage policy limit before running production traffic. When current-month storage usage reaches this limit, new prepare requests are paused until the limit is increased.

## Container images

- API image: `Dockerfile.api`
- Worker image: `Dockerfile.worker`

```bash
docker build -f Dockerfile.api -t eeetik-api .
docker build -f Dockerfile.worker -t eeetik-worker .
```

## Kubernetes deployment

**Complete deployment guide**: See [`docs/kubernetes-deployment.md`](docs/kubernetes-deployment.md)

The application can be deployed to any Kubernetes cluster (DigitalOcean, AWS EKS, GKE, bare metal, etc.) with self-hosted MinIO storage.

### Quick deployment

1. Build and push Docker images:
   ```bash
   docker build -f Dockerfile.api -t <your-registry>/eeetik-backend-api:latest .
   docker build -f Dockerfile.worker -t <your-registry>/eeetik-backend-worker:latest .
   docker push <your-registry>/eeetik-backend-api:latest
   docker push <your-registry>/eeetik-backend-worker:latest
   ```

2. Update image references in deployment manifests:
   - `infra/k8s/api-deployment.yaml`
   - `infra/k8s/worker-deployment.yaml`

3. Configure secrets and domain:
   - Edit `infra/k8s/secret.template.yaml` with secure credentials
   - Edit `infra/k8s/configmap.yaml` with your domain
   - Edit `infra/k8s/ingress.yaml` with your API domain

4. Deploy:
   ```bash
   chmod +x infra/k8s/deploy.sh
   ./infra/k8s/deploy.sh
   ```

The deployment includes:
- API and Worker services
- MongoDB with persistent storage
- Redis with persistent storage
- MinIO (S3-compatible storage) with persistent storage
- Horizontal Pod Autoscaling
- Ingress for external access

**For detailed instructions, cloud-specific guides, and troubleshooting**, see [`docs/kubernetes-deployment.md`](docs/kubernetes-deployment.md).

## Security notes

- Keep MinIO bucket private; expose only presigned URLs.
- Use `S3_USE_SSL=true` in production with proper TLS configuration.
- Set strong MinIO credentials (change default `minioadmin` values).
- Route traffic through load balancer/ingress with TLS.
- Use managed Redis/Mongo endpoints in deployed environments.
- Set strict `SITE_DOMAIN_ALLOWLIST` and `CORS_ORIGINS` for your frontend domain(s).
- Keep secrets in Kubernetes secrets or cloud secret manager, not in source code.
- Regularly rotate access credentials and update persistent volumes backup strategy.
