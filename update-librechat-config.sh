#!/bin/bash
# Update LibreChat configuration and restart deployment
# Usage: ./update-librechat-config.sh [namespace] [config-file]

set -e

NAMESPACE="${1:-librechat}"
CONFIG_FILE="${2:-./librechat.yaml}"
DEPLOYMENT="librechat-librechat"
CONFIGMAP="librechat-config"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}LibreChat Config Updater${NC}"
echo "========================="
echo "Namespace: $NAMESPACE"
echo "Config file: $CONFIG_FILE"
echo ""

# Verify config file exists
if [ ! -f "$CONFIG_FILE" ]; then
    echo -e "${RED}Error: Config file '$CONFIG_FILE' not found${NC}"
    exit 1
fi

# Verify we can access the cluster
if ! oc whoami &>/dev/null; then
    echo -e "${RED}Error: Not logged into OpenShift cluster${NC}"
    exit 1
fi

# Verify namespace exists
if ! oc get namespace "$NAMESPACE" &>/dev/null; then
    echo -e "${RED}Error: Namespace '$NAMESPACE' does not exist${NC}"
    exit 1
fi

# Step 1: Update ConfigMap
echo -e "${YELLOW}Step 1: Updating ConfigMap...${NC}"
oc delete configmap "$CONFIGMAP" -n "$NAMESPACE" 2>/dev/null || true
oc create configmap "$CONFIGMAP" --from-file=librechat.yaml="$CONFIG_FILE" -n "$NAMESPACE"
echo -e "${GREEN}✓ ConfigMap updated${NC}"

# Step 2: Scale down to release PVC (avoids stuck ContainerCreating)
echo -e "${YELLOW}Step 2: Scaling down deployment...${NC}"
oc scale deployment/"$DEPLOYMENT" -n "$NAMESPACE" --replicas=0
echo "Waiting for pods to terminate..."
sleep 15

# Step 3: Scale up with new config
echo -e "${YELLOW}Step 3: Scaling up deployment...${NC}"
oc scale deployment/"$DEPLOYMENT" -n "$NAMESPACE" --replicas=1

# Step 4: Wait for rollout
echo -e "${YELLOW}Step 4: Waiting for rollout to complete...${NC}"
if oc rollout status deployment/"$DEPLOYMENT" -n "$NAMESPACE" --timeout=180s; then
    echo -e "${GREEN}✓ Deployment rolled out successfully${NC}"
else
    echo -e "${RED}✗ Rollout timed out${NC}"
    echo "Check pod status with: oc get pods -n $NAMESPACE"
    exit 1
fi

# Step 5: Verify MCP connections
echo ""
echo -e "${YELLOW}Step 5: Checking MCP server connections...${NC}"
sleep 10  # Give servers time to initialize
echo ""
oc logs deployment/"$DEPLOYMENT" -n "$NAMESPACE" --tail=100 | grep -E "\[MCP\].*(-{2,}|Tools:|URL:|Connection failed|Failed)" | tail -30
echo ""

echo -e "${GREEN}Done! LibreChat config has been updated.${NC}"
echo ""
echo "Useful commands:"
echo "  View logs: oc logs -f deployment/$DEPLOYMENT -n $NAMESPACE"
echo "  Check MCP: oc logs deployment/$DEPLOYMENT -n $NAMESPACE | grep '\[MCP\]'"
echo "  Get route: oc get route -n $NAMESPACE"
