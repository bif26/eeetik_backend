# Deployment Checklist

Use this checklist to ensure a successful deployment.

## Pre-Deployment

### DigitalOcean Droplet
- [ ] Droplet created (Ubuntu 22.04 LTS)
- [ ] Droplet size appropriate (min 2GB RAM, recommended 4GB)
- [ ] SSH access verified
- [ ] Droplet IP address noted

### Domain & DNS (Optional but Recommended)
- [ ] Domain purchased
- [ ] DNS A record points to Droplet IP
- [ ] DNS propagation verified (`dig api.yourdomain.com`)

### MongoDB Atlas
- [ ] Free M0 cluster created
- [ ] Database user created with strong password
- [ ] Connection string obtained
- [ ] Droplet IP whitelisted in Network Access
- [ ] Connection tested from Droplet

### GitHub Repository
- [ ] Code pushed to GitHub
- [ ] Repository is accessible

## Droplet Setup

### System Setup
- [ ] System updated: `sudo apt update && sudo apt upgrade -y`
- [ ] Node.js 22 installed: `node --version`
- [ ] PM2 installed globally: `pm2 --version`
- [ ] Redis installed and running: `redis-cli ping`
- [ ] Firewall configured (UFW):
  - [ ] Port 22 (SSH) allowed
  - [ ] Port 80 (HTTP) allowed
  - [ ] Port 443 (HTTPS) allowed
  - [ ] Firewall enabled

### Redis Configuration
- [ ] Redis password set in `/etc/redis/redis.conf`
- [ ] Redis persistence enabled (appendonly yes)
- [ ] Redis memory limit configured
- [ ] Redis bound to localhost (bind 127.0.0.1)
- [ ] Redis restarted after configuration
- [ ] Redis authentication tested: `redis-cli -a PASSWORD ping`

### Directories
- [ ] Deployment directory created: `/var/www/eeetik_backend`
- [ ] Correct ownership set: `sudo chown -R $USER:$USER /var/www/eeetik_backend`
- [ ] Logs directory exists: `/var/www/eeetik_backend/logs`
- [ ] Storage directory exists: `/var/www/eeetik_backend/data/uploads`
- [ ] Storage directory writable

### PM2 Setup
- [ ] PM2 startup script configured: `pm2 startup`
- [ ] Startup command executed

## GitHub Actions Setup

### SSH Key
- [ ] SSH key generated: `ssh-keygen -t ed25519 -f ~/.ssh/eeetik_deploy`
- [ ] Public key copied to Droplet: `ssh-copy-id`
- [ ] SSH connection tested from local machine
- [ ] Private key content copied

### GitHub Secrets
Navigate to: Repository → Settings → Secrets and variables → Actions

- [ ] `DROPLET_HOST` added (Droplet IP address)
- [ ] `DROPLET_USERNAME` added (usually `root`)
- [ ] `DROPLET_SSH_KEY` added (private key content)
- [ ] `DROPLET_PORT` added (default: `22`)
- [ ] All secrets verified (no trailing spaces)

## Environment Configuration

### Create .env File
Location: `/var/www/eeetik_backend/.env`

#### Required Variables
- [ ] `NODE_ENV=production`
- [ ] `PORT=3000`
- [ ] `API_PREFIX=api/v2`
- [ ] `MONGO_URI=mongodb+srv://...` (MongoDB Atlas connection string)
- [ ] `REDIS_HOST=127.0.0.1`
- [ ] `REDIS_PORT=6379`
- [ ] `REDIS_PASSWORD=...` (Redis password)
- [ ] `STORAGE_PATH=./data/uploads`
- [ ] `API_PUBLIC_BASE_URL=https://api.yourdomain.com`

#### Optional but Recommended
- [ ] `CORS_ORIGINS` configured with your frontend domain
- [ ] `SITE_DOMAIN_ALLOWLIST` configured
- [ ] `LOG_LEVEL` set appropriately
- [ ] `THROTTLE_*` settings reviewed
- [ ] `STORAGE_MAX_MONTHLY_BYTES` set
- [ ] Metadata cache settings reviewed
- [ ] Ad policy settings configured

## First Deployment

### Manual Test (Recommended First)
- [ ] Build locally: `npm ci && npm run build`
- [ ] Create archive: `tar -czf deploy.tar.gz dist node_modules package.json ecosystem.config.js`
- [ ] Copy to Droplet: `scp deploy.tar.gz root@IP:/var/www/eeetik_backend/`
- [ ] Extract on Droplet: `tar -xzf deploy.tar.gz`
- [ ] Start with PM2: `pm2 start ecosystem.config.js`
- [ ] Save PM2 config: `pm2 save`
- [ ] Check status: `pm2 status`
- [ ] Check logs: `pm2 logs`
- [ ] Test API health: `curl http://localhost:3000/api/v2/health/live`

### Automated Deployment
- [ ] Code committed and pushed to main branch
- [ ] GitHub Actions workflow triggered
- [ ] Workflow completed successfully
- [ ] PM2 services restarted on Droplet
- [ ] Health check passed

## Post-Deployment Verification

### Application Health
- [ ] API service running: `pm2 list | grep eeetik-api`
- [ ] Worker service running: `pm2 list | grep eeetik-worker`
- [ ] No restart loops: `pm2 status` (check restart count)
- [ ] Health endpoint responds: `curl http://localhost:3000/api/v2/health/live`
- [ ] Ready endpoint responds: `curl http://localhost:3000/api/v2/health/ready`

### Database Connections
- [ ] MongoDB connection successful (check logs)
- [ ] Redis connection successful (check logs)
- [ ] No connection errors in logs

### Storage
- [ ] Storage directory writable
- [ ] Test file upload works
- [ ] Files accessible via download endpoint
- [ ] Disk space adequate: `df -h`

## Nginx Setup (Recommended)

### Installation
- [ ] Nginx installed: `sudo apt install nginx -y`
- [ ] Nginx service enabled: `sudo systemctl enable nginx`
- [ ] Nginx running: `sudo systemctl status nginx`

### Configuration
- [ ] Site configuration created: `/etc/nginx/sites-available/eeetik`
- [ ] Configuration includes proxy settings
- [ ] Client max body size set (100M recommended)
- [ ] Site enabled: `ln -s /etc/nginx/sites-available/eeetik /etc/nginx/sites-enabled/`
- [ ] Configuration tested: `sudo nginx -t`
- [ ] Nginx restarted: `sudo systemctl restart nginx`
- [ ] HTTP access works: `curl http://api.yourdomain.com/api/v2/health/live`

### SSL/TLS (Let's Encrypt)
- [ ] Certbot installed: `sudo apt install certbot python3-certbot-nginx -y`
- [ ] SSL certificate obtained: `sudo certbot --nginx -d api.yourdomain.com`
- [ ] Certificate auto-renewal tested: `sudo certbot renew --dry-run`
- [ ] HTTPS access works: `curl https://api.yourdomain.com/api/v2/health/live`
- [ ] HTTP redirects to HTTPS

## Monitoring Setup

### Logging
- [ ] Application logs working: `tail -f /var/www/eeetik_backend/logs/operations.log`
- [ ] PM2 logs accessible: `pm2 logs`
- [ ] Nginx logs accessible: `sudo tail -f /var/log/nginx/access.log`
- [ ] Log rotation configured (PM2): `pm2 install pm2-logrotate`

### Monitoring
- [ ] PM2 monitoring works: `pm2 monit`
- [ ] System resources monitored: `htop` or `top`
- [ ] Disk usage monitored: `df -h`
- [ ] Redis stats available: `redis-cli -a PASSWORD info`

### Alerts (Optional)
- [ ] PM2 Plus configured (optional paid service)
- [ ] Email alerts for crashes (optional)
- [ ] Disk space alerts (optional)

## Security Hardening

### SSH Security
- [ ] Password authentication disabled (key-only)
- [ ] Root login reviewed (consider disabling)
- [ ] SSH port changed (optional, update firewall if changed)
- [ ] Fail2ban installed (optional): `sudo apt install fail2ban -y`

### Application Security
- [ ] Strong Redis password set
- [ ] MongoDB Atlas password is strong
- [ ] Environment variables contain no hardcoded secrets
- [ ] CORS configured correctly
- [ ] Rate limiting enabled
- [ ] File upload validation in place

### Firewall
- [ ] Only necessary ports open (22, 80, 443)
- [ ] Redis port (6379) NOT exposed publicly
- [ ] MongoDB port NOT exposed (using Atlas)

## Testing

### Functional Tests
- [ ] Health endpoint: `curl https://api.yourdomain.com/api/v2/health/live`
- [ ] Ready endpoint: `curl https://api.yourdomain.com/api/v2/health/ready`
- [ ] Metrics endpoint: `curl https://api.yourdomain.com/api/v2/metrics`
- [ ] TikTok metadata endpoint (POST /api/v2/model/download/tiktok)
- [ ] Download prepare endpoint
- [ ] Status polling endpoint
- [ ] File download endpoint

### Performance Tests
- [ ] Response time acceptable (<1s for health checks)
- [ ] No memory leaks (monitor with `pm2 monit`)
- [ ] No CPU spikes under normal load
- [ ] Storage writes working

### Error Handling
- [ ] Invalid requests return proper errors
- [ ] Rate limiting works
- [ ] File not found returns 404
- [ ] Service gracefully handles Redis downtime
- [ ] Service gracefully handles MongoDB issues

## Backup Strategy

### Data Backup
- [ ] MongoDB backups enabled in Atlas
- [ ] Local file backup strategy defined
- [ ] Redis persistence verified
- [ ] Backup restoration tested

### Configuration Backup
- [ ] `.env` file backed up securely
- [ ] Nginx configuration backed up
- [ ] Redis configuration backed up
- [ ] PM2 ecosystem config in version control

## Documentation

- [ ] Deployment documented
- [ ] Environment variables documented
- [ ] Troubleshooting steps documented
- [ ] Team members have access to:
  - [ ] MongoDB Atlas
  - [ ] GitHub repository
  - [ ] DigitalOcean Droplet
  - [ ] Domain registrar (if applicable)

## Rollback Plan

- [ ] Previous deployment archived
- [ ] Rollback procedure documented
- [ ] GitHub rollback possible (revert commit, push)
- [ ] Manual rollback tested

## Sign-Off

Deployment completed by: ___________________

Date: ___________________

Verified by: ___________________

Date: ___________________

## Post-Deployment Monitoring (First 24-48 hours)

- [ ] Hour 1: Check logs every 15 minutes
- [ ] Hour 2-4: Check logs hourly
- [ ] Hour 4-24: Check logs every 4 hours
- [ ] Day 2: Check logs twice daily
- [ ] Monitor CPU/Memory/Disk usage
- [ ] Monitor error rates
- [ ] Monitor response times
- [ ] Check for any crash-restart loops

## Support Contacts

**Technical Issues:**
- GitHub: [Repository Issues](https://github.com/Bif12/eeetik_backend/issues)
- Team Lead: ___________________
- DevOps: ___________________

**Service Providers:**
- DigitalOcean Support: https://www.digitalocean.com/support/
- MongoDB Atlas Support: https://www.mongodb.com/support
- Domain Registrar: ___________________

---

**Notes:**
- This checklist should be completed in order
- Skip optional items if not applicable to your setup
- Keep this checklist for future deployments
- Update checklist based on lessons learned
