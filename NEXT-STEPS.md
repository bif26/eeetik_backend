# 🎯 NEXT STEPS: Deploy to DigitalOcean Droplet

## Current Status ✅

Your backend is ready for deployment with:
- ✅ GitHub Actions deployment workflow configured
- ✅ PM2 ecosystem configuration ready
- ✅ Local file storage implementation
- ✅ MongoDB Atlas support
- ✅ Redis caching ready

## Deployment Overview

The application now deploys directly to a DigitalOcean Droplet using GitHub Actions, eliminating the need for Docker and Kubernetes.

## 🚀 Quick Start

### Step 1: Setup DigitalOcean Droplet

1. **Create Droplet**:
   - OS: Ubuntu 22.04 LTS
   - Plan: Basic $24/month (4GB RAM, 2 CPUs recommended)
   - Add SSH key or use password
   
2. **Initial Setup** (SSH into Droplet):
   ```bash
   # Install Node.js 22
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt-get install -y nodejs
   
   # Install PM2
   sudo npm install -g pm2
   
   # Install Redis
   sudo apt install redis-server -y
   sudo systemctl enable redis-server
   
   # Create deployment directory
   sudo mkdir -p /var/www/eeetik_backend
   sudo chown -R $USER:$USER /var/www/eeetik_backend
   ```

### Step 2: Setup MongoDB Atlas

1. Go to [MongoDB Atlas](https://www.mongodb.com/cloud/atlas)
2. Create free M0 cluster
3. Create database user
4. Get connection string
5. **Important**: Whitelist your Droplet IP in Network Access

### Step 3: Configure GitHub Secrets

Add these secrets in GitHub (Settings → Secrets → Actions):

| Secret Name | Value |
|-------------|-------|
| `DROPLET_HOST` | Your Droplet IP address |
| `DROPLET_USERNAME` | SSH username (usually `root`) |
| `DROPLET_SSH_KEY` | Private SSH key for authentication |
| `DROPLET_PORT` | SSH port (default: `22`) |

**Generate SSH key**:
```bash
# On local machine
ssh-keygen -t ed25519 -f ~/.ssh/eeetik_deploy -N ""
ssh-copy-id -i ~/.ssh/eeetik_deploy.pub root@YOUR_DROPLET_IP

# Copy private key content for GitHub secret
cat ~/.ssh/eeetik_deploy
```

### Step 4: Configure Environment Variables

Create `.env` file on your Droplet at `/var/www/eeetik_backend/.env`:

```env
NODE_ENV=production
PORT=3000
API_PREFIX=api/v2
CORS_ORIGINS=https://yourdomain.com
API_PUBLIC_BASE_URL=https://api.yourdomain.com
LOG_LEVEL=info

# MongoDB Atlas
MONGO_URI=mongodb+srv://username:password@cluster.mongodb.net/eeetik?retryWrites=true&w=majority

# Local Redis
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=your_redis_password

# Local file storage
STORAGE_PATH=./data/uploads
STORAGE_MAX_MONTHLY_BYTES=10737418240

# Throttle settings
THROTTLE_TTL_MS=60000
THROTTLE_LIMIT=120
```

### Step 5: Deploy

```bash
# Push to main branch
git push origin main
```

GitHub Actions will automatically:
1. Build the application
2. Transfer files to your Droplet
3. Restart PM2 services

### Step 6: Setup Nginx (Recommended)

```bash
# Install Nginx
sudo apt install nginx -y

# Create config
sudo nano /etc/nginx/sites-available/eeetik
```

Add configuration:
```nginx
server {
    listen 80;
    server_name api.yourdomain.com;
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

Enable and install SSL:
```bash
sudo ln -s /etc/nginx/sites-available/eeetik /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx

# Install SSL
sudo apt install certbot python3-certbot-nginx -y
sudo certbot --nginx -d api.yourdomain.com
```

## 📖 Detailed Documentation

For complete setup instructions, see:
- **[Deployment Guide](docs/DEPLOYMENT.md)** - Complete deployment instructions
- **[README.md](README.md)** - Architecture and API documentation

## Monitoring

```bash
# View PM2 status
pm2 status

# View logs
pm2 logs

# Monitor resources
pm2 monit

# Check disk usage
df -h
du -sh /var/www/eeetik_backend/data/uploads
```

## Troubleshooting

**Deployment failed?**
- Check GitHub Actions logs
- SSH to Droplet: `pm2 logs`
- Verify environment variables in `.env`

**Can't connect to MongoDB?**
- Whitelist Droplet IP in MongoDB Atlas
- Verify connection string in `.env`

**Redis connection issues?**
- Check Redis: `sudo systemctl status redis-server`
- Verify password in `.env`

**Storage issues?**
- Check disk space: `df -h`
- Verify `STORAGE_PATH` exists and has write permissions

For more troubleshooting, see [Deployment Guide](docs/DEPLOYMENT.md).

## Architecture Changes

**What changed from previous setup:**
- ❌ Removed Docker and Kubernetes
- ❌ Removed MinIO S3 storage
- ✅ Added GitHub Actions SSH deployment
- ✅ Added PM2 process management
- ✅ Added local file storage
- ✅ Using MongoDB Atlas (managed)
- ✅ Self-hosting Redis on Droplet

**Benefits:**
- Simpler deployment process
- Lower hosting costs (no Kubernetes overhead)
- Easier troubleshooting
- Direct server access
- Suitable for small to medium traffic

#### Step 2: Update GitHub Secret

1. Go to: https://github.com/Bif12/eeetik_backend/settings/secrets/actions
2. Find or create `DOCKER_HUB_TOKEN`
3. Paste the token from Docker Hub
4. Save

#### Step 3: Trigger Workflow

```bash
cd /home/bif28/Desktop/eeetik_backend

# Push a commit to trigger the workflow
git add docs/ push-to-dockerhub.sh diagnose-github-actions.sh
git commit -m "Add Docker Hub push tools and fix documentation"
git push origin main
```

Or manually trigger at: https://github.com/Bif12/eeetik_backend/actions

**Result**: Every future push to `main` automatically builds and pushes new images

## 📊 Verification

After pushing (either way), verify:

1. **Docker Hub**:
   - API: https://hub.docker.com/r/bif12/eeetik-backend-api
   - Worker: https://hub.docker.com/r/bif12/eeetik-backend-worker

2. **Pull test**:
   ```bash
   docker pull bif12/eeetik-backend-api:latest
   docker pull bif12/eeetik-backend-worker:latest
   ```

## 🎯 What Happens Next

Once images are on Docker Hub:

### Deploy to Kubernetes

```bash
cd /home/bif28/Desktop/eeetik_backend

# First-time full deployment
./infra/k8s/deploy.sh

# Or just update existing deployments
./infra/k8s/update-deployments.sh
```

### Deploy to DigitalOcean

1. Create Kubernetes cluster on DigitalOcean
2. Connect with `doctl kubernetes cluster kubeconfig save <cluster-name>`
3. Run `./infra/k8s/deploy.sh`

### Deploy to Any VPS with Docker

```bash
# On your VPS
docker pull bif12/eeetik-backend-api:latest
docker pull bif12/eeetik-backend-worker:latest

# Use with docker-compose
docker-compose up -d
```

## 📚 Documentation Created

All guides are in `docs/` folder:

1. **docs/manual-docker-push.md** - Detailed manual push guide
2. **docs/github-actions-setup.md** - GitHub Actions setup guide
3. **docs/troubleshooting-github-actions.md** - Troubleshooting guide
4. **docs/kubernetes-deployment.md** - Full Kubernetes deployment guide

## 🛠️ Scripts Created

Automation scripts in repository root:

1. **push-to-dockerhub.sh** - Quick manual push (recommended!)
2. **diagnose-github-actions.sh** - Diagnose workflow issues
3. **infra/k8s/deploy.sh** - Deploy full Kubernetes stack
4. **infra/k8s/update-deployments.sh** - Update running deployments

## ⚡ Quick Command Reference

```bash
# Push to Docker Hub (manual)
./push-to-dockerhub.sh

# Check GitHub Actions status
./diagnose-github-actions.sh

# Deploy to Kubernetes
./infra/k8s/deploy.sh

# Update Kubernetes deployments
./infra/k8s/update-deployments.sh

# Rebuild images locally
docker build -f Dockerfile.api -t bif12/eeetik-backend-api:latest .
docker build -f Dockerfile.worker -t bif12/eeetik-backend-worker:latest .
```

## 🎉 Summary

**What's Done**:
- ✅ Removed all Heroku infrastructure
- ✅ Migrated from Cloudflare R2 to MinIO (local S3-compatible storage)
- ✅ Created complete Kubernetes deployment setup
- ✅ Fixed Docker build issues (canvas package)
- ✅ Created GitHub Actions CI/CD workflow
- ✅ Built Docker images successfully locally
- ✅ Created comprehensive documentation and scripts

**What You Need to Do**:
1. **Push images to Docker Hub** - Run `./push-to-dockerhub.sh`
2. **Optional**: Fix GitHub Actions secret for automation
3. **Deploy**: Run `./infra/k8s/deploy.sh` on your Kubernetes cluster

**Time Required**:
- Manual push: ~5 minutes
- GitHub Actions fix: ~10 minutes
- Kubernetes deployment: ~15 minutes

---

**Need Help?**

- Check workflow status: https://github.com/Bif12/eeetik_backend/actions
- View Docker images: https://hub.docker.com/u/bif12
- Run diagnostics: `./diagnose-github-actions.sh`
- Read troubleshooting: `docs/troubleshooting-github-actions.md`
