# Kubernetes Deployment Guide

This guide explains how to deploy the eeetik_backend application to any Kubernetes cluster with self-hosted storage using MinIO.

## Architecture

The application consists of:
- **API Server** - REST API for TikTok video downloads
- **Worker** - Background job processor for video processing
- **MongoDB** - Database for metadata and logs
- **Redis** - Queue system and caching
- **MinIO** - S3-compatible object storage for media files

All services run in the `eeetik-backend` namespace with persistent volumes for data storage.

## Prerequisites

### Required Tools
- `kubectl` (v1.24+) - Kubernetes command-line tool
- Docker (for building images)
- A Kubernetes cluster (DigitalOcean, Linode, AWS EKS, GKE, bare metal, etc.)

### Cluster Requirements
- Kubernetes v1.24 or newer
- At least 4GB RAM available across nodes
- Persistent volume provisioner (most cloud providers have this by default)
- Ingress controller (nginx-ingress recommended)
- Storage: ~65GB+ of persistent storage for volumes

## Quick Start

### 1. Build and Push Docker Images

Build the API and Worker images:

```bash
# Build API image
docker build -f Dockerfile.api -t <your-registry>/eeetik-backend-api:latest .

# Build Worker image
docker build -f Dockerfile.worker -t <your-registry>/eeetik-backend-worker:latest .

# Push to registry (GitHub Container Registry, Docker Hub, etc.)
docker push <your-registry>/eeetik-backend-api:latest
docker push <your-registry>/eeetik-backend-worker:latest
```

### 2. Update Image References

Edit the deployment files to use your registry:
- `infra/k8s/api-deployment.yaml` - Update `image:` line
- `infra/k8s/worker-deployment.yaml` - Update `image:` line

Replace `ghcr.io/<owner>/` with your actual registry path.

### 3. Configure Secrets

Edit `infra/k8s/secret.template.yaml` and update credentials:

```yaml
stringData:
  REDIS_PASSWORD: ""  # Set a password if desired
  THROTTLE_REDIS_PASSWORD: ""  # Same as REDIS_PASSWORD
  S3_ACCESS_KEY_ID: "your-minio-access-key"  # Change default
  S3_SECRET_ACCESS_KEY: "your-minio-secret-key"  # Change default
```

**Important:** Change the default MinIO credentials (`minioadmin`) to secure values before production deployment.

### 4. Configure Domain and Environment

Edit `infra/k8s/configmap.yaml`:
- Update `CORS_ORIGINS` with your frontend domain
- Update `SITE_DOMAIN_ALLOWLIST` with your domain
- Adjust resource limits if needed

Edit `infra/k8s/ingress.yaml`:
- Update `host:` to your API domain (e.g., `api.yourdomain.com`)
- Update TLS secret name if using cert-manager

### 5. Deploy to Kubernetes

Use the deployment script for easy deployment:

```bash
chmod +x infra/k8s/deploy.sh
./infra/k8s/deploy.sh
```

Or deploy manually:

```bash
# Apply all manifests
kubectl apply -f infra/k8s/namespace.yaml
kubectl apply -f infra/k8s/secret.template.yaml
kubectl apply -f infra/k8s/configmap.yaml
kubectl apply -f infra/k8s/pvc.yaml
kubectl apply -f infra/k8s/mongodb-deployment.yaml
kubectl apply -f infra/k8s/redis-deployment.yaml
kubectl apply -f infra/k8s/minio-deployment.yaml
kubectl apply -f infra/k8s/api-deployment.yaml
kubectl apply -f infra/k8s/worker-deployment.yaml
kubectl apply -f infra/k8s/api-service.yaml
kubectl apply -f infra/k8s/ingress.yaml
kubectl apply -f infra/k8s/hpa.yaml
```

### 6. Verify Deployment

Check pod status:

```bash
kubectl get pods -n eeetik-backend
```

All pods should be in `Running` state. Check logs if any issues:

```bash
# Check API logs
kubectl logs -n eeetik-backend -l app=eeetik-api --tail=50

# Check Worker logs
kubectl logs -n eeetik-backend -l app=eeetik-worker --tail=50

# Check MinIO logs
kubectl logs -n eeetik-backend -l app=minio --tail=50
```

### 7. Test the Deployment

Test API health endpoint:

```bash
# Port forward to test locally
kubectl port-forward -n eeetik-backend service/eeetik-api 3000:80

# Test in another terminal
curl http://localhost:3000/api/v2/health/ready
```

Expected response: `{"status":"ok"}`

## Cloud Provider Specific Instructions

### DigitalOcean Kubernetes

1. Create cluster in DigitalOcean control panel
2. Download kubeconfig: `doctl kubernetes cluster kubeconfig save <cluster-name>`
3. Storage class `do-block-storage` is already configured
4. Install nginx-ingress:
   ```bash
   kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.8.1/deploy/static/provider/do/deploy.yaml
   ```
5. Point your domain DNS to the Load Balancer IP

### AWS EKS

1. Create EKS cluster using `eksctl` or AWS Console
2. Update storage class in `pvc.yaml` from `do-block-storage` to `gp3`
3. Install AWS Load Balancer Controller for ingress
4. Use AWS-specific ingress annotations

### Google GKE

1. Create GKE cluster via `gcloud` or Console
2. Update storage class in `pvc.yaml` to `standard-rwo`
3. GKE provides ingress controller by default
4. Configure Cloud DNS for domain

### Bare Metal / Self-Hosted

1. Install Kubernetes using kubeadm, k3s, or RKE
2. Install a storage provisioner (local-path-provisioner, NFS, etc.)
3. Update `storageClassName` in `pvc.yaml` to match your provisioner
4. Install nginx-ingress controller
5. Configure load balancer or NodePort for ingress

## Configuration Reference

### Environment Variables

Key configuration options in `configmap.yaml`:

- `CORS_ORIGINS` - Allowed frontend origins (comma-separated)
- `S3_ENDPOINT` - MinIO endpoint (default: `http://minio:9000`)
- `S3_BUCKET` - Storage bucket name (default: `media-private`)
- `MONGO_URI` - MongoDB connection string
- `REDIS_HOST` - Redis host
- `THROTTLE_LIMIT` - API rate limit per minute

### Storage Configuration

Persistent volumes in `pvc.yaml`:
- MongoDB: 10GB (adjust based on expected data)
- Redis: 5GB
- MinIO: 50GB (adjust based on media storage needs)

To increase storage:
1. Edit `pvc.yaml` and change `storage:` values
2. Apply changes: `kubectl apply -f infra/k8s/pvc.yaml`
3. Some cloud providers support automatic volume expansion

### Scaling

Horizontal Pod Autoscaling is configured in `hpa.yaml`:
- API: 2-20 replicas based on CPU (65%)
- Worker: 2-30 replicas based on CPU (70%)

To manually scale:
```bash
kubectl scale deployment eeetik-api -n eeetik-backend --replicas=5
kubectl scale deployment eeetik-worker -n eeetik-backend --replicas=10
```

### MinIO Access

MinIO provides a web console for storage management:

```bash
# Port forward to access MinIO console
kubectl port-forward -n eeetik-backend service/minio 9001:9001
```

Open http://localhost:9001 and login with credentials from secrets.

## Updating the Application

### Rolling Updates

1. Build and push new Docker images with a version tag:
   ```bash
   docker build -f Dockerfile.api -t <registry>/eeetik-backend-api:v1.2.0 .
   docker push <registry>/eeetik-backend-api:v1.2.0
   ```

2. Update deployment:
   ```bash
   kubectl set image deployment/eeetik-api -n eeetik-backend \
     api=<registry>/eeetik-backend-api:v1.2.0
   ```

3. Watch rollout:
   ```bash
   kubectl rollout status deployment/eeetik-api -n eeetik-backend
   ```

4. Rollback if needed:
   ```bash
   kubectl rollout undo deployment/eeetik-api -n eeetik-backend
   ```

### Configuration Updates

1. Edit configmap or secret files
2. Apply changes:
   ```bash
   kubectl apply -f infra/k8s/configmap.yaml
   kubectl apply -f infra/k8s/secret.template.yaml
   ```
3. Restart pods to pick up changes:
   ```bash
   kubectl rollout restart deployment/eeetik-api -n eeetik-backend
   kubectl rollout restart deployment/eeetik-worker -n eeetik-backend
   ```

## Monitoring and Logs

### View Logs

```bash
# API logs
kubectl logs -n eeetik-backend -l app=eeetik-api -f

# Worker logs
kubectl logs -n eeetik-backend -l app=eeetik-worker -f

# All logs in namespace
kubectl logs -n eeetik-backend --all-containers=true -f
```

### Check Resource Usage

```bash
kubectl top pods -n eeetik-backend
kubectl top nodes
```

### Describe Resources

```bash
kubectl describe pod <pod-name> -n eeetik-backend
kubectl describe deployment eeetik-api -n eeetik-backend
```

## Troubleshooting

### Pods Not Starting

1. Check pod status:
   ```bash
   kubectl get pods -n eeetik-backend
   kubectl describe pod <pod-name> -n eeetik-backend
   ```

2. Common issues:
   - Image pull errors: Check registry credentials and image name
   - Insufficient resources: Check node capacity
   - PVC binding: Ensure storage provisioner is working

### Database Connection Issues

1. Verify MongoDB and Redis are running:
   ```bash
   kubectl get pods -n eeetik-backend -l app=mongodb
   kubectl get pods -n eeetik-backend -l app=redis
   ```

2. Test connectivity from API pod:
   ```bash
   kubectl exec -it -n eeetik-backend <api-pod-name> -- sh
   nc -zv mongodb 27017
   nc -zv redis 6379
   ```

### Storage Issues

1. Check PVC status:
   ```bash
   kubectl get pvc -n eeetik-backend
   ```

2. Ensure all PVCs are `Bound` status
3. Check storage provisioner is running

### MinIO Access Issues

1. Verify MinIO pod is running
2. Check MinIO logs for errors
3. Verify bucket was created:
   ```bash
   kubectl logs -n eeetik-backend job/minio-init-bucket
   ```

## Security Best Practices

1. **Change Default Credentials** - Update MinIO credentials in secrets
2. **Use TLS** - Configure ingress with cert-manager for HTTPS
3. **Network Policies** - Restrict pod-to-pod communication
4. **Secrets Management** - Use external secrets operator or sealed secrets
5. **RBAC** - Create service accounts with minimal permissions
6. **Resource Limits** - Set appropriate limits to prevent resource exhaustion
7. **Regular Updates** - Keep Kubernetes and container images updated

## Backup and Recovery

### Database Backup

```bash
# Backup MongoDB
kubectl exec -n eeetik-backend <mongodb-pod> -- mongodump --archive > mongodb-backup.archive

# Restore MongoDB
kubectl exec -i -n eeetik-backend <mongodb-pod> -- mongorestore --archive < mongodb-backup.archive
```

### MinIO Backup

Use MinIO client to sync data:

```bash
# Install mc (MinIO client)
mc alias set myminio http://<minio-endpoint> <access-key> <secret-key>
mc mirror myminio/media-private /backup/location
```

### Disaster Recovery

1. Persistent volumes are retained even if pods are deleted
2. Backup PVC data to external storage regularly
3. Document your cluster configuration
4. Test restore procedures periodically

## Cost Optimization

1. **Right-size resources** - Monitor usage and adjust requests/limits
2. **Use spot instances** - For non-critical worker pods
3. **Storage cleanup** - Implement retention policies
4. **Autoscaling** - Let HPA scale down during low traffic
5. **Resource quotas** - Prevent over-provisioning

## Support and Additional Resources

- Kubernetes Documentation: https://kubernetes.io/docs/
- MinIO Documentation: https://min.io/docs/
- kubectl Cheat Sheet: https://kubernetes.io/docs/reference/kubectl/cheatsheet/

For application-specific issues, check the main README.md in the repository root.
