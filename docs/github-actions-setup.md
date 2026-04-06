# GitHub Actions CI/CD Setup Guide

This guide explains how to set up automated Docker image builds and Kubernetes deployments using GitHub Actions.

## Overview ok

The CI/CD pipeline automatically:

1. **Builds Docker images** when code is pushed to main/master branch
2. **Pushes images to Docker Hub** with version tags
3. **Optionally deploys to Kubernetes** (if configured)

## Setup Instructions

### Step 1: Create Docker Hub Access Token

1. Go to [Docker Hub](https://hub.docker.com/)
2. Log in to your account
3. Click on your username (top right) → **Account Settings**
4. Go to **Security** → **New Access Token**
5. Give it a name (e.g., "GitHub Actions")
6. Copy the token (you won't see it again!)

### Step 2: Add Docker Hub Token to GitHub Secrets

1. Go to your GitHub repository
2. Click **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret**
4. Add the following secret:
   - **Name**: `DOCKER_HUB_TOKEN`
   - **Value**: (paste the token from Step 1)
5. Click **Add secret**

### Step 3: Verify the Workflow

The workflow file is located at `.github/workflows/docker-build-push.yml`

**Workflow triggers:**

- Push to `main` or `master` branch
- Pull requests (builds but doesn't push)
- Manual trigger via GitHub Actions UI

**What it does:**

- Builds `bif12/eeetik-backend-api` and `bif12/eeetik-backend-worker`
- Tags images with:
  - `latest` (for main branch)
  - `main-<commit-sha>` (for versioning)
  - Branch name (for feature branches)

### Step 4: Test the Workflow

1. Make a small change to your code
2. Commit and push to main branch:
   ```bash
   git add .
   git commit -m "Test GitHub Actions workflow"
   git push origin main
   ```
3. Go to your GitHub repository → **Actions** tab
4. Watch the workflow run and build your images

### Step 5: Verify Images on Docker Hub

1. Go to [Docker Hub](https://hub.docker.com/)
2. Check your repositories:
   - `bif12/eeetik-backend-api`
   - `bif12/eeetik-backend-worker`
3. You should see the `latest` tag and commit-based tags

## Using the Images in Kubernetes

### Update Deployment Files

Edit `infra/k8s/api-deployment.yaml`:

```yaml
spec:
  template:
    spec:
      containers:
        - name: api
          image: bif12/eeetik-backend-api:latest
          imagePullPolicy: Always # Always pull latest image
```

Edit `infra/k8s/worker-deployment.yaml`:

```yaml
spec:
  template:
    spec:
      containers:
        - name: worker
          image: bif12/eeetik-backend-worker:latest
          imagePullPolicy: Always
```

### Deploy to Kubernetes

After GitHub Actions pushes new images:

```bash
# Restart deployments to pull new images
kubectl rollout restart deployment/eeetik-api -n eeetik-backend
kubectl rollout restart deployment/eeetik-worker -n eeetik-backend

# Watch the rollout
kubectl rollout status deployment/eeetik-api -n eeetik-backend
kubectl rollout status deployment/eeetik-worker -n eeetik-backend
```

## Optional: Automatic Kubernetes Deployment

If you want to automatically deploy to Kubernetes after building images, follow these additional steps:

### Option A: Using kubectl (Simple)

1. Add Kubernetes credentials to GitHub Secrets:
   - `KUBE_CONFIG`: Base64-encoded kubeconfig file
2. Update the workflow (add to end of `docker-build-push.yml`):

```yaml
- name: Deploy to Kubernetes
  if: github.ref == 'refs/heads/main'
  run: |
    echo "${{ secrets.KUBE_CONFIG }}" | base64 -d > kubeconfig.yaml
    export KUBECONFIG=./kubeconfig.yaml
    kubectl rollout restart deployment/eeetik-api -n eeetik-backend
    kubectl rollout restart deployment/eeetik-worker -n eeetik-backend
    kubectl rollout status deployment/eeetik-api -n eeetik-backend
    kubectl rollout status deployment/eeetik-worker -n eeetik-backend
```

### Option B: Using ArgoCD (GitOps - Recommended)

For production deployments, consider using ArgoCD for GitOps:

1. Install ArgoCD in your Kubernetes cluster
2. Configure ArgoCD to watch your Git repository
3. ArgoCD automatically syncs changes to your cluster
4. No need to modify GitHub Actions - it just builds images

**Benefits:**

- Declarative deployments
- Easy rollbacks
- Audit trail
- Multi-cluster support

### Option C: Using Helm (Advanced)

If you use Helm charts:

1. Create a Helm chart for your application
2. Use GitHub Actions to update chart values
3. Deploy using Helm in the workflow

## Image Tagging Strategy

### Current Tags

- **`latest`**: Latest build from main branch
- **`main-<sha>`**: Specific commit version (e.g., `main-abc1234`)
- **`<branch>`**: Feature branch builds

### Recommended for Production

Use commit SHA tags for production deployments for better version control:

```yaml
# In Kubernetes deployment
image: bif12/eeetik-backend-api:main-abc1234
```

This ensures you know exactly which code version is running.

## Monitoring the Pipeline

### View Workflow Runs

1. Go to your GitHub repository
2. Click **Actions** tab
3. Click on a workflow run to see details
4. Check logs for each step

### Common Issues

**Docker Hub login fails:**

- Verify `DOCKER_HUB_TOKEN` secret is set correctly
- Check token hasn't expired
- Ensure username is correct (`bif12`)

**Build fails:**

- Check the build logs in GitHub Actions
- Verify Dockerfiles are correct
- Ensure all dependencies are available

**Images not updating in Kubernetes:**

- Check `imagePullPolicy` is set to `Always`
- Manually restart deployment: `kubectl rollout restart`
- Verify image tag is correct

## Security Best Practices

1. **Never commit secrets** to the repository
2. **Use GitHub Secrets** for all sensitive data
3. **Rotate tokens** regularly (every 3-6 months)
4. **Limit token permissions** to only what's needed
5. **Use separate tokens** for different environments (dev/staging/prod)

## Advanced: Multi-Environment Deployments

For deploying to multiple environments (dev, staging, prod):

1. Create separate workflows for each environment
2. Use environment-specific secrets in GitHub
3. Trigger workflows based on branch or tag patterns:
   - `develop` branch → dev environment
   - `staging` branch → staging environment
   - `v*` tag → production environment

Example:

```yaml
on:
  push:
    tags:
      - 'v*' # Trigger on version tags like v1.0.0
```

## Getting Kubeconfig (for Option A above)

To get your kubeconfig for GitHub Secrets:

```bash
# Base64 encode your kubeconfig
cat ~/.kube/config | base64 -w 0

# Copy the output and paste it as KUBE_CONFIG secret in GitHub
```

**Security Note**: Only use this for testing. For production, use a service account with limited permissions.

## Testing Locally

Test Docker builds locally before pushing:

```bash
# Test API build
docker build -f Dockerfile.api -t bif12/eeetik-backend-api:test .

# Test Worker build
docker build -f Dockerfile.worker -t bif12/eeetik-backend-worker:test .

# Test running the containers
docker run -p 3000:3000 bif12/eeetik-backend-api:test
```

## Support

For issues with:

- **GitHub Actions**: Check `.github/workflows/docker-build-push.yml`
- **Docker builds**: Check `Dockerfile.api` and `Dockerfile.worker`
- **Kubernetes deployment**: See `docs/kubernetes-deployment.md`

## Next Steps

1. ✅ Set up Docker Hub token in GitHub Secrets
2. ✅ Push code to trigger the workflow
3. ✅ Verify images are built and pushed
4. ✅ Update Kubernetes deployments to use new images
5. ⚡ (Optional) Set up automatic Kubernetes deployment
6. 📊 (Optional) Add monitoring and notifications
