# LibreChat Deployment to OpenShift

This document provides comprehensive instructions for deploying LibreChat to Red Hat OpenShift with custom configuration (librechat.yaml, MCP servers, custom LLM endpoints).

**Last Tested:** 2025-11-24
**LibreChat Version:** v0.8.1-rc1
**Helm Chart Version:** 1.9.2
**OpenShift Version:** 4.x (FIPS-enabled cluster)

## Prerequisites

- OpenShift cluster access with admin or sufficient permissions
- `oc` CLI configured and authenticated
- `helm` CLI installed (version 3.x+)
- Your existing `librechat.yaml` configuration file
- Your `.env` file with API keys and credentials

## Overview

LibreChat is deployed using the official Helm chart with OpenShift-specific customizations:

1. **Components Deployed:**
   - LibreChat application (main chat interface)
   - MongoDB (database with authentication)
   - Meilisearch (search engine)

2. **OpenShift-Specific Considerations:**
   - Security Context Constraints (SCC) - images run as specific UIDs
   - Route vs Ingress for external access
   - Storage class configuration varies by cluster
   - ConfigMap mounting for custom configuration

## Quick Start (TL;DR)

For experienced users, here's the condensed deployment sequence:

```bash
# 1. Create namespace
oc new-project librechat

# 2. Create ConfigMap with your config
oc create configmap librechat-config \
  --from-file=librechat.yaml=./librechat.yaml \
  -n librechat

# 3. Create secrets (customize values!)
oc create secret generic librechat-credentials-env \
  --from-literal=MONGO_URI='mongodb://librechat:<YOUR_MONGO_PASSWORD>@librechat-mongodb:27017/LibreChat' \
  --from-literal=CREDS_KEY='<generate-your-own>' \
  --from-literal=CREDS_IV='<generate-your-own>' \
  --from-literal=JWT_SECRET='<generate-your-own>' \
  --from-literal=JWT_REFRESH_SECRET='<generate-your-own>' \
  --from-literal=MEILI_MASTER_KEY='<generate-your-own>' \
  --from-literal=OPENAI_API_KEY='<your-key>' \
  --from-literal=ANTHROPIC_API_KEY='<your-key>' \
  -n librechat

# 4. Grant SCC permissions
oc adm policy add-scc-to-user anyuid -z default -n librechat
oc adm policy add-scc-to-user anyuid -z librechat-librechat -n librechat
oc adm policy add-scc-to-user anyuid -z librechat-meilisearch -n librechat
oc adm policy add-scc-to-user anyuid -z librechat-mongodb -n librechat

# 5. Deploy via Helm (update storage class in values file first!)
helm install librechat \
  oci://ghcr.io/danny-avila/librechat-chart/librechat \
  --version 1.9.2 \
  --namespace librechat \
  --values values-openshift-minimal.yaml

# 6. Mount the librechat.yaml config
oc set volume deployment/librechat-librechat \
  --add \
  --name=librechat-config-volume \
  --type=configmap \
  --configmap-name=librechat-config \
  --mount-path=/app/librechat.yaml \
  --sub-path=librechat.yaml \
  -n librechat

# 7. Create Route
oc create route edge librechat \
  --service=librechat-librechat \
  --port=3080 \
  --insecure-policy=Redirect \
  -n librechat

# 8. Get URL
echo "https://$(oc get route librechat -n librechat -o jsonpath='{.spec.host}')"
```

## Detailed Step-by-Step Instructions

### Step 1: Create Namespace

```bash
oc new-project librechat
```

**Note:** All subsequent commands assume you're working in the `librechat` namespace. Always specify `-n librechat` in commands to avoid issues if you switch projects.

### Step 2: Determine Your Storage Class

**Important:** Before proceeding, identify your cluster's available storage classes:

```bash
oc get storageclass
```

Example output:
```
NAME                PROVISIONER       RECLAIMPOLICY   VOLUMEBINDINGMODE      ALLOWVOLUMEEXPANSION
gp2-csi             ebs.csi.aws.com   Delete          WaitForFirstConsumer   true
gp3-csi (default)   ebs.csi.aws.com   Delete          WaitForFirstConsumer   true
```

**Update `values-openshift-minimal.yaml`** to use your cluster's storage class. Common options:

| Cloud/Platform | Storage Class |
|----------------|---------------|
| AWS (EBS) | `gp3-csi` or `gp2-csi` |
| OpenShift Data Foundation | `ocs-storagecluster-ceph-rbd` |
| Azure | `managed-premium` or `managed-csi` |
| VMware | `thin` or your vSphere storage class |
| Bare Metal | Your configured storage class |

Edit the values file and replace ALL occurrences of the storage class:
- `persistence.storageClassName`
- `mongodb.persistence.storageClass`
- `meilisearch.persistence.storageClass`

### Step 3: Create ConfigMap with Your librechat.yaml

Your `librechat.yaml` contains your custom configuration including MCP servers and LLM endpoints.

```bash
oc create configmap librechat-config \
  --from-file=librechat.yaml=./librechat.yaml \
  -n librechat
```

**Verify the ConfigMap was created:**
```bash
oc get configmap librechat-config -n librechat
oc describe configmap librechat-config -n librechat
```

### Step 4: Create Secrets with Credentials

LibreChat expects a secret named `librechat-credentials-env` with all necessary environment variables.

**Generate secure values first:**
Visit https://www.librechat.ai/toolkit/creds_generator or use:
```bash
openssl rand -hex 32  # For CREDS_KEY, JWT_SECRET, JWT_REFRESH_SECRET
openssl rand -hex 16  # For CREDS_IV
openssl rand -base64 32  # For MEILI_MASTER_KEY
```

**Create the secret:**

```bash
oc create secret generic librechat-credentials-env \
  --from-literal=MONGO_URI='mongodb://librechat:<YOUR_MONGO_PASSWORD>@librechat-mongodb:27017/LibreChat' \
  --from-literal=CREDS_KEY='<your-generated-creds-key>' \
  --from-literal=CREDS_IV='<your-generated-creds-iv>' \
  --from-literal=JWT_SECRET='<your-generated-jwt-secret>' \
  --from-literal=JWT_REFRESH_SECRET='<your-generated-jwt-refresh-secret>' \
  --from-literal=MEILI_MASTER_KEY='<your-generated-meili-master-key>' \
  --from-literal=OPENAI_API_KEY='<your-openai-api-key>' \
  --from-literal=ANTHROPIC_API_KEY='<your-anthropic-api-key>' \
  --from-literal=VLLM_API_KEY='<your-vllm-api-key>' \
  --from-literal=VLLM_API_URL='<your-vllm-api-url>' \
  --from-literal=TAVILY_API_KEY='<your-tavily-api-key>' \
  -n librechat
```

**Important Notes:**
- The secret name MUST be `librechat-credentials-env` (the chart expects this)
- `MONGO_URI` must match the MongoDB credentials set in the Helm values
- Format: `mongodb://<username>:<password>@librechat-mongodb:27017/<database>`
- Add any other API keys your librechat.yaml references

**Verify the secret:**
```bash
oc get secret librechat-credentials-env -n librechat
```

### Step 5: Grant Security Context Constraints

OpenShift's security model requires explicit SCC permissions for containers running as specific UIDs.

```bash
# Grant anyuid SCC to all required service accounts
oc adm policy add-scc-to-user anyuid -z default -n librechat
oc adm policy add-scc-to-user anyuid -z librechat-librechat -n librechat
oc adm policy add-scc-to-user anyuid -z librechat-meilisearch -n librechat
oc adm policy add-scc-to-user anyuid -z librechat-mongodb -n librechat
```

**Why is this needed?**
- Bitnami MongoDB images run as UID 1000
- Meilisearch runs as UID 1000
- LibreChat runs as UID 1000 with fsGroup 2000
- OpenShift's default `restricted-v2` SCC only allows UIDs in the range 1001120000+
- `anyuid` SCC allows containers to run as any UID

**Note:** Grant these BEFORE deploying Helm. The service accounts are created during Helm install, so granting to non-existent service accounts is fine - they'll inherit the permissions when created.

### Step 6: Deploy LibreChat via Helm

Get your current context name:
```bash
oc config current-context
```

Install LibreChat:
```bash
helm install librechat \
  oci://ghcr.io/danny-avila/librechat-chart/librechat \
  --version 1.9.2 \
  --namespace librechat \
  --values values-openshift-minimal.yaml \
  --kube-context "$(oc config current-context)"
```

**Wait for pods to start:**
```bash
oc get pods -n librechat -w
```

**Expected output after 1-2 minutes:**
```
NAME                                   READY   STATUS    RESTARTS   AGE
librechat-librechat-xxxxxxxxxx-xxxxx   1/1     Running   0          90s
librechat-meilisearch-0                1/1     Running   0          90s
librechat-mongodb-xxxxxxxxxx-xxxxx     1/1     Running   0          90s
```

### Step 7: Mount librechat.yaml Configuration

The Helm chart's `extraVolumes` and `extraVolumeMounts` don't always work as expected. We patch the deployment manually to ensure the config is mounted:

```bash
oc set volume deployment/librechat-librechat \
  --add \
  --name=librechat-config-volume \
  --type=configmap \
  --configmap-name=librechat-config \
  --mount-path=/app/librechat.yaml \
  --sub-path=librechat.yaml \
  -n librechat
```

**This triggers a rolling restart.** Wait for it to complete:
```bash
oc rollout status deployment/librechat-librechat -n librechat --timeout=120s
```

**Verify the file is mounted:**
```bash
oc exec -n librechat deployment/librechat-librechat -- ls -la /app/librechat.yaml
oc exec -n librechat deployment/librechat-librechat -- head -20 /app/librechat.yaml
```

### Step 8: Create OpenShift Route for External Access

```bash
oc create route edge librechat \
  --service=librechat-librechat \
  --port=3080 \
  --insecure-policy=Redirect \
  -n librechat
```

**Route Configuration:**
- `edge`: TLS termination at the router (recommended)
- `--insecure-policy=Redirect`: HTTP requests are redirected to HTTPS
- Service: `librechat-librechat` (created by Helm chart)
- Port: `3080` (LibreChat's default port)

**Get the URL:**
```bash
echo "LibreChat URL: https://$(oc get route librechat -n librechat -o jsonpath='{.spec.host}')"
```

### Step 9: Verify Deployment

**Check all resources:**
```bash
oc get pods,svc,route,pvc -n librechat
```

**Expected output:**
```
NAME                                      READY   STATUS    RESTARTS   AGE
pod/librechat-librechat-xxxxxxxxxx-xxxxx  1/1     Running   0          5m
pod/librechat-meilisearch-0               1/1     Running   0          5m
pod/librechat-mongodb-xxxxxxxxxx-xxxxx    1/1     Running   0          5m

NAME                            TYPE        CLUSTER-IP      EXTERNAL-IP   PORT(S)     AGE
service/librechat-librechat     ClusterIP   172.30.xxx.xxx  <none>        3080/TCP    5m
service/librechat-meilisearch   ClusterIP   172.30.xxx.xxx  <none>        7700/TCP    5m
service/librechat-mongodb       ClusterIP   172.30.xxx.xxx  <none>        27017/TCP   5m

NAME                                 HOST/PORT
route.route.openshift.io/librechat   librechat-librechat.apps.cluster...

NAME                                         STATUS   VOLUME       CAPACITY
persistentvolumeclaim/librechat-librechat-images   Bound    pvc-xxx...   10Gi
persistentvolumeclaim/librechat-meilisearch        Bound    pvc-xxx...   10Gi
persistentvolumeclaim/librechat-mongodb            Bound    pvc-xxx...   8Gi
```

**Check LibreChat logs for MCP server connections:**
```bash
oc logs -n librechat deployment/librechat-librechat --tail=100 | grep -i "mcp"
```

**Successful MCP connection example:**
```
[MCP][hpc-scheduler] Creating streamable-http transport: https://...
[MCP][hpc-scheduler] Initialized in: 291ms
[MCP][hpc-scheduler] Tools: analyze_job, cancel_job, get_accounting, ...
```

**Test the URL:**
```bash
curl -sSk -o /dev/null -w "%{http_code}" "https://$(oc get route librechat -n librechat -o jsonpath='{.spec.host}')"
# Should return: 200
```

## Troubleshooting Guide

### Issue: Pods in ImagePullBackOff

**Symptom:**
```bash
librechat-mongodb-xxx-xxx   0/1   ImagePullBackOff   0   2m
```

**Cause:** MongoDB image tag doesn't exist in Docker Hub

**Solution:**
1. Check the error:
   ```bash
   oc describe pod -l app.kubernetes.io/name=mongodb -n librechat | grep -A 5 "Events:"
   ```

2. Use `latest` tag in Helm values:
   ```yaml
   mongodb:
     image:
       tag: "latest"
   ```

3. Upgrade the release:
   ```bash
   helm upgrade librechat \
     oci://ghcr.io/danny-avila/librechat-chart/librechat \
     --version 1.9.2 \
     --namespace librechat \
     --values values-openshift-minimal.yaml
   ```

### Issue: Pods in CrashLoopBackOff with SCC Errors

**Symptom:**
```bash
oc get events -n librechat | grep forbidden
# pods "librechat-meilisearch-0" is forbidden: unable to validate against any security context constraint
```

**Cause:** Service accounts don't have anyuid SCC

**Solution:**
```bash
# Grant anyuid to all service accounts
oc adm policy add-scc-to-user anyuid -z librechat-librechat -n librechat
oc adm policy add-scc-to-user anyuid -z librechat-meilisearch -n librechat
oc adm policy add-scc-to-user anyuid -z librechat-mongodb -n librechat

# Delete the stuck pods to force recreation
oc delete pod -l app.kubernetes.io/instance=librechat -n librechat
```

### Issue: PVC Pending (Storage Class Not Found)

**Symptom:**
```bash
oc get pvc -n librechat
# NAME                    STATUS    VOLUME   CAPACITY   ACCESS MODES   STORAGECLASS
# librechat-mongodb       Pending                                      ocs-storagecluster-ceph-rbd
```

**Cause:** The storage class in values file doesn't exist on this cluster

**Solution:**
1. Find available storage classes:
   ```bash
   oc get storageclass
   ```

2. Update `values-openshift-minimal.yaml` with the correct storage class

3. Delete the pending PVCs and upgrade:
   ```bash
   oc delete pvc -l app.kubernetes.io/instance=librechat -n librechat
   helm upgrade librechat ... --values values-openshift-minimal.yaml
   ```

### Issue: MongoDB Authentication Error

**Symptom in LibreChat logs:**
```
error: There was an uncaught error: Command find requires authentication
```

**Cause:** MongoDB URI in secret doesn't match MongoDB credentials

**Solution:**
1. Verify the credentials match between:
   - `values-openshift-minimal.yaml` → `mongodb.auth.username` and `mongodb.auth.password`
   - Secret → `MONGO_URI`

2. Recreate secret with correct credentials:
   ```bash
   oc delete secret librechat-credentials-env -n librechat
   oc create secret generic librechat-credentials-env \
     --from-literal=MONGO_URI='mongodb://librechat:<YOUR_MONGO_PASSWORD>@librechat-mongodb:27017/LibreChat' \
     ... (other variables)
     -n librechat
   ```

3. Restart LibreChat:
   ```bash
   oc rollout restart deployment/librechat-librechat -n librechat
   ```

### Issue: librechat.yaml Not Loading

**Symptom:** Custom endpoints or MCP servers not appearing in UI

**Verification:**
```bash
oc exec -n librechat deployment/librechat-librechat -- ls -la /app/librechat.yaml
oc exec -n librechat deployment/librechat-librechat -- head -30 /app/librechat.yaml
```

**Solution:**
```bash
# Re-mount the ConfigMap
oc set volume deployment/librechat-librechat \
  --add \
  --name=librechat-config-volume \
  --type=configmap \
  --configmap-name=librechat-config \
  --mount-path=/app/librechat.yaml \
  --sub-path=librechat.yaml \
  -n librechat

# Wait for rollout
oc rollout status deployment/librechat-librechat -n librechat
```

### Issue: MCP Server Connection Failures

**Symptom in logs:**
```
[MCP][server-name] Transport error: Error POSTing to endpoint (HTTP 404): Not Found
```

**Cause:** MCP server URL is incorrect or server is not running

**Solution:**
1. Verify MCP server is accessible:
   ```bash
   curl -I https://<mcp-server-url>
   ```

2. Update librechat.yaml with correct URL

3. Recreate ConfigMap and restart:
   ```bash
   oc delete configmap librechat-config -n librechat
   oc create configmap librechat-config \
     --from-file=librechat.yaml=./librechat.yaml \
     -n librechat
   oc rollout restart deployment/librechat-librechat -n librechat
   ```

## Updating Configuration

### Updating librechat.yaml

```bash
# 1. Update the ConfigMap
oc delete configmap librechat-config -n librechat
oc create configmap librechat-config \
  --from-file=librechat.yaml=./librechat.yaml \
  -n librechat

# 2. Restart LibreChat to reload
oc rollout restart deployment/librechat-librechat -n librechat

# 3. Wait for rollout
oc rollout status deployment/librechat-librechat -n librechat

# 4. Verify new config is loaded
oc logs -n librechat deployment/librechat-librechat --tail=50 | grep -i "mcp"
```

### Updating Secrets

```bash
# 1. Delete old secret
oc delete secret librechat-credentials-env -n librechat

# 2. Create new secret with updated values
oc create secret generic librechat-credentials-env \
  --from-literal=MONGO_URI='mongodb://librechat:<YOUR_MONGO_PASSWORD>@librechat-mongodb:27017/LibreChat' \
  --from-literal=... (all other variables)
  -n librechat

# 3. Restart pods to pick up new secret
oc rollout restart deployment/librechat-librechat -n librechat
```

### Upgrading Helm Chart Version

```bash
# Upgrade to new version
helm upgrade librechat \
  oci://ghcr.io/danny-avila/librechat-chart/librechat \
  --version <new-version> \
  --namespace librechat \
  --values values-openshift-minimal.yaml

# Monitor the upgrade
oc get pods -n librechat -w
```

## Quick Reference Commands

```bash
# Check deployment status
oc get pods,svc,route -n librechat

# Get LibreChat URL
echo "https://$(oc get route librechat -n librechat -o jsonpath='{.spec.host}')"

# Restart LibreChat
oc rollout restart deployment/librechat-librechat -n librechat

# View LibreChat logs
oc logs -n librechat deployment/librechat-librechat -f

# View MongoDB logs
oc logs -n librechat deployment/librechat-mongodb -f

# Update librechat.yaml config
oc delete configmap librechat-config -n librechat
oc create configmap librechat-config --from-file=librechat.yaml=./librechat.yaml -n librechat
oc rollout restart deployment/librechat-librechat -n librechat

# Check MCP server connectivity
oc logs -n librechat deployment/librechat-librechat | grep "\[MCP\]"

# Verify environment variables
oc exec -n librechat deployment/librechat-librechat -- env | grep -E "VLLM|ANTHROPIC|OPENAI"

# Force delete stuck pod
oc delete pod <pod-name> -n librechat --force --grace-period=0

# Port-forward for local testing
oc port-forward -n librechat service/librechat-librechat 3080:3080
# Access at http://localhost:3080
```

## Uninstalling LibreChat

```bash
# Uninstall Helm release
helm uninstall librechat -n librechat

# Delete all resources (this will delete PVCs and data!)
oc delete project librechat

# Or, if you want to keep data, delete resources individually
oc delete deployment,statefulset,service,route,configmap,secret \
  -l app.kubernetes.io/instance=librechat \
  -n librechat
# Keep PVCs for data retention
```

## FIPS Compliance Notes

If deploying to a FIPS-enabled OpenShift cluster, see `FIPS-Issues.md` for detailed compliance considerations. Key points:

- The deployment works on FIPS-enabled clusters
- Container images (Alpine/Debian-based) are not FIPS-certified
- For strict FIPS compliance, custom UBI-based images would be needed
- No blocking FIPS issues were encountered during testing

## Known Issues and Workarounds

### Bitnami MongoDB Image Tag Issues

**Problem:** Specific Bitnami MongoDB tags (e.g., `7.0-debian-12`) frequently don't exist.

**Workaround:** Always use `tag: "latest"` for MongoDB.

### Helm Chart extraVolumes May Not Work

**Problem:** The LibreChat Helm chart's `extraVolumes` and `extraVolumeMounts` don't always mount correctly.

**Workaround:** Manually patch the deployment after Helm install using `oc set volume`.

### MCP Server Disconnections

**Problem:** MCP servers may show reconnection attempts in logs.

**Solution:** Use `streamable-http` transport type (not SSE) in your librechat.yaml:
```yaml
mcpServers:
  your-server:
    type: streamable-http  # Not 'sse'
    url: https://...
    timeout: 90000
```

---

## Summary Checklist

When deploying LibreChat to a new OpenShift cluster:

- [ ] Check available storage classes: `oc get storageclass`
- [ ] Update `values-openshift-minimal.yaml` with correct storage class
- [ ] Create namespace: `oc new-project librechat`
- [ ] Create ConfigMap: `oc create configmap librechat-config --from-file=librechat.yaml=...`
- [ ] Create secret: `oc create secret generic librechat-credentials-env --from-literal=...`
- [ ] Grant SCC permissions: `oc adm policy add-scc-to-user anyuid -z ...`
- [ ] Install via Helm: `helm install librechat oci://...`
- [ ] Wait for pods: `oc get pods -n librechat -w`
- [ ] Mount librechat.yaml: `oc set volume deployment/librechat-librechat ...`
- [ ] Create Route: `oc create route edge librechat ...`
- [ ] Verify deployment: Check logs, test URL, verify MCP connections
- [ ] Test the application in browser
