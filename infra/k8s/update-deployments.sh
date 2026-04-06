#!/bin/bash

# Script to update Kubernetes deployments with latest Docker images
# Run this after GitHub Actions builds and pushes new images

set -e

NAMESPACE="eeetik-backend"

echo "========================================"
echo "Updating Kubernetes Deployments"
echo "========================================"
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if kubectl is available
if ! command -v kubectl &> /dev/null; then
    echo "Error: kubectl is not installed"
    exit 1
fi

# Check if we can connect to cluster
if ! kubectl cluster-info &> /dev/null; then
    echo "Error: Cannot connect to Kubernetes cluster"
    exit 1
fi

echo "Connected to cluster: $(kubectl config current-context)"
echo ""

# Function to update deployment
update_deployment() {
    local deployment=$1
    local image=$2
    
    echo "Updating $deployment..."
    
    # Update image
    kubectl set image deployment/$deployment $deployment=$image -n $NAMESPACE
    
    # Wait for rollout
    if kubectl rollout status deployment/$deployment -n $NAMESPACE --timeout=300s; then
        echo -e "${GREEN}✓ $deployment updated successfully${NC}"
    else
        echo -e "${YELLOW}Warning: $deployment rollout timed out${NC}"
        return 1
    fi
    echo ""
}

# Update API deployment
update_deployment "eeetik-api" "bif12/eeetik-backend-api:latest"

# Update Worker deployment
update_deployment "eeetik-worker" "bif12/eeetik-backend-worker:latest"

echo "========================================"
echo "Deployment Update Complete!"
echo "========================================"
echo ""

# Show pod status
echo "Current pod status:"
kubectl get pods -n $NAMESPACE
echo ""

# Show deployment details
echo "Deployment images:"
kubectl get deployment -n $NAMESPACE -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.template.spec.containers[0].image}{"\n"}{end}'
echo ""

echo -e "${GREEN}All deployments updated!${NC}"
