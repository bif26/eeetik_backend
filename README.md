# eeetik backend

Secure and scalable NestJS backend for TikTok metadata + download workflows.

## 🚀 Quick Start

### Local Development

1. Copy environment values:
   ```bash
   cp .env.example .env
   ```

2. Install dependencies:
   ```bash
   npm ci
   ```

3. Start local Redis (for development):
   ```bash
   # Using Docker (optional for local dev only)
   docker run -d -p 6379:6379 redis:7-alpine
   
   # Or install Redis locally
   # Ubuntu: sudo apt-get install redis-server
   # macOS: brew install redis
   ```

4. Configure MongoDB Atlas:
   - Create a free cluster at [MongoDB Atlas](https://www.mongodb.com/cloud/atlas)
   - Get your connection string
   - Update `MONGO_URI` in `.env`

5. Run API and worker:
   ```bash
   npm run start:dev
   npm run start:worker:dev
   ```

### Production Deployment

Deploy to DigitalOcean Droplet with GitHub Actions:

```bash
# Configure GitHub Secrets (see Deployment Guide below)
# Push to main branch triggers automatic deployment
git push origin main
```

See the [Deployment Guide](#deployment-guide) for detailed setup instructions.

---

## Architecture

### Services
- **API service**: metadata fetch, prepare request, status polling, ad policy checks
- **Worker service**: background media transfer, file processing, ZIP generation
- **Redis**: metadata cache and BullMQ transport (self-hosted on server)
- **MongoDB Atlas**: metadata + download logs (managed cloud service)
- **Local Storage**: File storage on server disk

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
    participant Storage as Local Storage
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
        Backend->>Storage: Save transformed thumbnail/images
        Backend->>MongoDB: Save metadata + source URLs
      end
      Backend->>Redis: Cache metadata (24h)
    end
    Backend-->>Frontend: { success: true, data: preview metadata }

    User->>Frontend: Choose HD/SD/Audio/ZIP
    Frontend->>Backend: POST /api/v2/model/download/tiktok/prepare
    Backend->>MongoDB: Insert download_log(status=processing)
    Backend->>Bull: Enqueue job
    Backend->>Backend: Wait up to ~7s for completion
    alt completed quickly (cache hit/duplicate)
      Backend-->>Frontend: { jobId, status: "completed", downloadUrl, filename, filesize, expiresIn }
    else still processing
      Backend-->>Frontend: { jobId, status: "processing" }
    end

    Bull->>MongoDB: Read metadata by uniqueId
    alt HD/SD/Audio
      Bull->>TikTok: Stream source media
      Bull->>Storage: Save media file
    else ZIP
      Bull->>Storage: Read prepared images
      Bull->>Bull: Build ZIP archive
      Bull->>Storage: Save ZIP file
    end
    Bull->>Backend: Generate download URL
    Bull->>MongoDB: Update download_log(status=completed, downloadUrl)

    Frontend->>Backend: GET /api/v2/model/download/tiktok/status/:jobId
    Backend-->>Frontend: processing/completed + downloadUrl
```

## API endpoints

- `POST /api/v2/model/download/tiktok`
  - Body: `{ "url": "https://www.tiktok.com/..." }`
  - Returns `{ success: true, data }` where `data` includes `uniqueId`, `type`, `author`, `stats`, `hashtags`, `availableFormats`
  - `type: "video"` includes `thumbnail` + `duration` (no direct TikTok CDN URLs are returned)
  - `type: "image"` includes signed image URLs
- `POST /api/v2/model/download/tiktok/prepare`
  - Body: `{ "uniqueId": "...", "requestType": "hd|sd|audio|zip", "adToken": "...", "adDurationSeconds": 30 }`
  - Returns one of:
    - `{ jobId, status: "completed", downloadUrl, filename, filesize, expiresIn }`
    - `{ jobId, status: "processing" }` (use status endpoint to poll)
- `GET /api/v2/model/download/tiktok/status/:jobId`
  - Returns job status and download URL when complete
- `GET /api/v2/files/:uniqueId/:filename?expires=...&sig=...`
  - Serves signed local files
- `GET /api/v2/health/live`
- `GET /api/v2/health/ready`
- `GET /api/v2/metrics` (Prometheus format)

## Deployment Guide

### Prerequisites

1. **DigitalOcean Droplet**
   - Ubuntu 22.04 LTS or later
   - Minimum 2GB RAM, 1 CPU, 25GB SSD
   - Recommended: 4GB RAM, 2 CPUs, 50GB SSD

2. **MongoDB Atlas** (Free tier available)
   - Create cluster at [https://www.mongodb.com/cloud/atlas](https://www.mongodb.com/cloud/atlas)
   - Get connection string
   - Whitelist Droplet IP address

3. **GitHub Repository Secrets**
   Configure these secrets in your GitHub repository (Settings → Secrets and variables → Actions):
   - `DROPLET_HOST`: Your Droplet's IP address
   - `DROPLET_USERNAME`: SSH username (usually `root`)
   - `DROPLET_SSH_KEY`: Private SSH key for authentication
   - `DROPLET_PORT`: SSH port (default: 22)

### Droplet Initial Setup

SSH into your Droplet and run:

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install PM2 globally
sudo npm install -g pm2

# Install Redis
sudo apt install redis-server -y
sudo systemctl enable redis-server
sudo systemctl start redis-server

# Configure Redis (optional: set password, persistence)
sudo nano /etc/redis/redis.conf
# Uncomment and set: requirepass your_strong_password
# Save and restart: sudo systemctl restart redis-server

# Create deployment directory
sudo mkdir -p /var/www/eeetik_backend
sudo chown -R $USER:$USER /var/www/eeetik_backend

# Setup PM2 startup script
pm2 startup
# Run the command it outputs

# Setup firewall
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

### Environment Configuration

Create `.env` file on your Droplet at `/var/www/eeetik_backend/.env`:

```bash
NODE_ENV=production
PORT=3000
API_PREFIX=api/v2
CORS_ORIGINS=https://yourdomain.com
SITE_DOMAIN_ALLOWLIST=yourdomain.com
API_PUBLIC_BASE_URL=https://api.yourdomain.com
REQUEST_BODY_LIMIT=1mb
LOG_LEVEL=info
LOG_DIR=./logs

# MongoDB Atlas connection string
MONGO_URI=mongodb+srv://username:password@cluster.mongodb.net/eeetik?retryWrites=true&w=majority

# Local Redis
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=your_redis_password

# Throttle settings
THROTTLE_TTL_MS=60000
THROTTLE_LIMIT=120
THROTTLE_EXPENSIVE_TTL_MS=60000
THROTTLE_EXPENSIVE_LIMIT=30

# Local file storage
STORAGE_PATH=./data/uploads
STORAGE_MAX_MONTHLY_BYTES=10737418240
FILE_CLEANUP_ENABLED=true
FILE_CLEANUP_TTL_HOURS=1
URL_SIGNING_SECRET=your-32-char-min-secret
SIGNED_URL_EXPIRY_SECONDS=600

# Metadata cache
METADATA_CACHE_TTL_SECONDS=86400
METADATA_CACHE_URL_TTL_SECONDS=86400
METADATA_CACHE_UID_TTL_SECONDS=86400
CDN_URL_CACHE_TTL_SECONDS=3600
METADATA_SINGLEFLIGHT_LOCK_TTL_MS=15000
METADATA_SINGLEFLIGHT_WAIT_RETRY_MS=150
METADATA_SINGLEFLIGHT_MAX_RETRIES=40

# Ad policy
AD_HD_MIN_SECONDS=30
AD_SD_MIN_SECONDS=15
AD_AUDIO_MIN_SECONDS=10
AD_ZIP_MIN_SECONDS=20

# Prepare response window + duplicate request lock behavior
PREPARE_WAIT_TIMEOUT_MS=7000
PREPARE_WAIT_POLL_INTERVAL_MS=250
DOWNLOAD_LOCK_TTL_MS=15000
DOWNLOAD_LOCK_WAIT_MS=7000
DOWNLOAD_LOCK_WAIT_POLL_MS=250
```

### Deployment Addendum (Storage + Signed URLs)

1. Generate and set a strong `URL_SIGNING_SECRET` (minimum 32 characters).
2. Ensure `STORAGE_PATH` has write permissions for both API and worker processes.
3. Verify Redis persistence is enabled (required for metadata/CDN cache and lock continuity).
4. Monitor disk usage (`du -sh /var/www/eeetik_backend/data/uploads`) and tune:
   - `FILE_CLEANUP_TTL_HOURS`
   - `STORAGE_MAX_MONTHLY_BYTES`
5. Validate signed file delivery:
   - Request metadata
   - Trigger prepare
   - Confirm `downloadUrl` is `/api/v2/files/{uniqueId}/{filename}?expires=...&sig=...`
6. Validate duplicate handling:
   - Send 2 prepare requests for same `uniqueId` + `requestType`
   - Confirm second request reuses existing file or waits for same locked result

### Deploy with GitHub Actions

1. Push to main branch:
   ```bash
   git push origin main
   ```

2. GitHub Actions will automatically:
   - Build the application
   - Transfer files to your Droplet
   - Restart PM2 services

3. Monitor deployment:
   - Check GitHub Actions tab for deployment status
   - SSH to Droplet and run `pm2 logs` to view application logs

### Manual Deployment

If you need to deploy manually:

```bash
# On your local machine
npm ci
npm run build
tar -czf deploy.tar.gz dist node_modules package.json ecosystem.config.js

# Copy to Droplet
scp deploy.tar.gz user@droplet_ip:/var/www/eeetik_backend/

# On Droplet
cd /var/www/eeetik_backend
tar -xzf deploy.tar.gz
pm2 restart ecosystem.config.js
pm2 save
```

### Setup Nginx (Optional but Recommended)

For production, use Nginx as reverse proxy:

```bash
sudo apt install nginx -y

# Create Nginx config
sudo nano /etc/nginx/sites-available/eeetik
```

Nginx configuration:

```nginx
server {
    listen 80;
    server_name api.yourdomain.com;

    client_max_body_size 100M;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable and restart:

```bash
sudo ln -s /etc/nginx/sites-available/eeetik /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx

# Install SSL with Let's Encrypt
sudo apt install certbot python3-certbot-nginx -y
sudo certbot --nginx -d api.yourdomain.com
```

### Monitoring and Maintenance

```bash
# View PM2 status
pm2 status

# View logs
pm2 logs
pm2 logs eeetik-api
pm2 logs eeetik-worker

# Restart services
pm2 restart all

# Monitor resources
pm2 monit

# Check disk usage
df -h
du -sh /var/www/eeetik_backend/data/uploads

# Redis status
redis-cli ping
redis-cli info
```

## Build, test, lint

```bash
npm run lint
npm run test -- --runInBand
npm run build
npm run loadtest:k6:seed
npm run loadtest:k6
```

## Load validation

Run e2e load validation against your deployed server:

```bash
LOADTEST_MODE=e2e BASE_URL=https://api.yourdomain.com SAMPLE_TIKTOK_URL=https://www.tiktok.com/@.../video/... npm run loadtest:k6:e2e
```

Set `STORAGE_MAX_MONTHLY_BYTES` to your storage policy limit before running production traffic. When current-month storage usage reaches this limit, new prepare requests are paused until the limit is increased.

## Troubleshooting

### Storage Issues
- **Disk full**: Monitor disk usage with `df -h` and clean old files from `STORAGE_PATH`
- **Permission denied**: Ensure the deployment user owns the storage directory
- **Files not found**: Check that `STORAGE_PATH` is correctly configured in `.env`

### Redis Connection Issues
- **Connection refused**: Check Redis is running: `sudo systemctl status redis-server`
- **Authentication failed**: Verify `REDIS_PASSWORD` in `.env` matches Redis configuration

### MongoDB Atlas Issues
- **Connection timeout**: Whitelist your Droplet's IP in MongoDB Atlas Network Access
- **Authentication failed**: Verify connection string and credentials

### PM2 Issues
- **Process not starting**: Check PM2 logs: `pm2 logs`
- **Out of memory**: Increase `max_memory_restart` in `ecosystem.config.js`
- **Auto-restart loop**: Check application logs for startup errors

## Security notes

- Keep storage files secure with proper file permissions
- Use strong Redis password in production
- Route traffic through Nginx with TLS/SSL
- Set strict `SITE_DOMAIN_ALLOWLIST` and `CORS_ORIGINS` for your frontend domain(s)
- Keep secrets in environment variables, not in source code
- Regularly update Node.js and npm packages
- Monitor server logs for suspicious activity
- Implement file retention policies to manage disk usage
- Consider using MongoDB Atlas IP whitelist for additional security
