#!/bin/bash

# Kubernetes Deployment Script for eeetik_backend
# This script deploys the entire application stack to Kubernetes

set -e  # Exit on error

NAMESPACE="eeetik-backend"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "========================================"
echo "eeetik_backend Kubernetes Deployment"
echo "========================================"
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if kubectl is installed
if ! command -v kubectl &> /dev/null; then
    echo -e "${RED}Error: kubectl is not installed${NC}"
    echo "Please install kubectl: https://kubernetes.io/docs/tasks/tools/"
    exit 1
fi

# Check if kubectl can connect to cluster
if ! kubectl cluster-info &> /dev/null; then
    echo -e "${RED}Error: Cannot connect to Kubernetes cluster${NC}"
    echo "Please check your kubeconfig and cluster connection"
    exit 1
fi

echo -e "${GREEN}✓ kubectl is installed and connected to cluster${NC}"
echo ""

# Display cluster info
echo "Current cluster context:"
kubectl config current-context
echo ""

# Ask for confirmation
read -p "Deploy to this cluster? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Deployment cancelled"
    exit 0
fi

echo ""
echo "Starting deployment..."
echo ""

# Function to wait for resource
wait_for_resource() {
    local resource_type=$1
    local resource_name=$2
    local namespace=$3
    local timeout=${4:-300}
    
    echo "Waiting for $resource_type/$resource_name to be ready..."
    kubectl wait --for=condition=ready "$resource_type/$resource_name" \
        -n "$namespace" --timeout="${timeout}s" 2>/dev/null || {
        echo -e "${YELLOW}Warning: Timeout waiting for $resource_type/$resource_name${NC}"
        return 1
    }
    echo -e "${GREEN}✓ $resource_type/$resource_name is ready${NC}"
}

# Step 1: Create namespace
echo "Step 1/11: Creating namespace..."
kubectl apply -f "$SCRIPT_DIR/namespace.yaml"
echo -e "${GREEN}✓ Namespace created${NC}"
echo ""

# Step 2: Create secrets
echo "Step 2/11: Creating secrets..."
kubectl apply -f "$SCRIPT_DIR/secret.template.yaml"
echo -e "${GREEN}✓ Secrets created${NC}"
echo -e "${YELLOW}⚠ Remember to update default credentials in production!${NC}"
echo ""

# Step 3: Create configmap
echo "Step 3/11: Creating configmap..."
kubectl apply -f "$SCRIPT_DIR/configmap.yaml"
echo -e "${GREEN}✓ ConfigMap created${NC}"
echo ""

# Step 4: Create persistent volume claims
echo "Step 4/11: Creating persistent volume claims..."
kubectl apply -f "$SCRIPT_DIR/pvc.yaml"
echo -e "${GREEN}✓ PVCs created${NC}"
echo ""

# Wait for PVCs to be bound
echo "Waiting for PVCs to be bound..."
sleep 5
kubectl get pvc -n "$NAMESPACE"
echo ""

# Step 5: Deploy MongoDB
echo "Step 5/11: Deploying MongoDB..."
kubectl apply -f "$SCRIPT_DIR/mongodb-deployment.yaml"
echo -e "${GREEN}✓ MongoDB deployment created${NC}"
echo ""

# Step 6: Deploy Redis
echo "Step 6/11: Deploying Redis..."
kubectl apply -f "$SCRIPT_DIR/redis-deployment.yaml"
echo -e "${GREEN}✓ Redis deployment created${NC}"
echo ""

# Step 7: Deploy MinIO
echo "Step 7/11: Deploying MinIO..."
kubectl apply -f "$SCRIPT_DIR/minio-deployment.yaml"
echo -e "${GREEN}✓ MinIO deployment created${NC}"
echo ""

# Wait for databases to be ready
echo "Waiting for databases to be ready (this may take a minute)..."
sleep 10

wait_for_resource "pod" "-l app=mongodb" "$NAMESPACE" 180 || true
wait_for_resource "pod" "-l app=redis" "$NAMESPACE" 180 || true
wait_for_resource "pod" "-l app=minio" "$NAMESPACE" 180 || true
echo ""

# Step 8: Deploy API
echo "Step 8/11: Deploying API..."
kubectl apply -f "$SCRIPT_DIR/api-deployment.yaml"
echo -e "${GREEN}✓ API deployment created${NC}"
echo ""

# Step 9: Deploy Worker
echo "Step 9/11: Deploying Worker..."
kubectl apply -f "$SCRIPT_DIR/worker-deployment.yaml"
echo -e "${GREEN}✓ Worker deployment created${NC}"
echo ""

# Step 10: Create API service
echo "Step 10/11: Creating API service..."
kubectl apply -f "$SCRIPT_DIR/api-service.yaml"
echo -e "${GREEN}✓ API service created${NC}"
echo ""

# Step 11: Create ingress (optional)
if [ -f "$SCRIPT_DIR/ingress.yaml" ]; then
    echo "Step 11/11: Creating ingress..."
    kubectl apply -f "$SCRIPT_DIR/ingress.yaml" || {
        echo -e "${YELLOW}Warning: Failed to create ingress (ingress controller may not be installed)${NC}"
    }
    echo ""
fi

# Apply HPA (optional)
if [ -f "$SCRIPT_DIR/hpa.yaml" ]; then
    echo "Creating Horizontal Pod Autoscalers..."
    kubectl apply -f "$SCRIPT_DIR/hpa.yaml" || {
        echo -e "${YELLOW}Warning: Failed to create HPA (metrics-server may not be installed)${NC}"
    }
    echo ""
fi

echo "========================================"
echo "Deployment Summary"
echo "========================================"
echo ""

# Display pod status
echo "Pod Status:"
kubectl get pods -n "$NAMESPACE"
echo ""

# Display service status
echo "Service Status:"
kubectl get svc -n "$NAMESPACE"
echo ""

# Display PVC status
echo "PVC Status:"
kubectl get pvc -n "$NAMESPACE"
echo ""

echo "========================================"
echo -e "${GREEN}Deployment completed!${NC}"
echo "========================================"
echo ""
echo "Next steps:"
echo "1. Check pod logs: kubectl logs -n $NAMESPACE -l app=eeetik-api"
echo "2. Monitor pod status: kubectl get pods -n $NAMESPACE -w"
echo "3. Test API health: kubectl port-forward -n $NAMESPACE service/eeetik-api 3000:80"
echo "   Then visit: http://localhost:3000/api/v2/health/ready"
echo ""
echo "For MinIO console access:"
echo "  kubectl port-forward -n $NAMESPACE service/minio 9001:9001"
echo "  Then visit: http://localhost:9001"
echo ""
echo "Documentation: docs/kubernetes-deployment.md"
echo ""
