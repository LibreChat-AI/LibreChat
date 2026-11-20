# FIPS 140-2/140-3 Compliance Guide

This guide describes how to build and deploy LibreChat with FIPS 140-2/140-3 compliant cryptography for use in regulated environments (government, healthcare, finance).

## Overview

The FIPS-compliant build (`Containerfile.fips`) provides:

1. **Red Hat UBI 9 base image** with FIPS-validated OpenSSL 3.0
2. **PBKDF2-HMAC-SHA256** for password hashing (replaces bcrypt)
3. **HMAC-SHA256** for TOTP 2FA (replaces HMAC-SHA1)
4. **SHA-256** for all hashing operations (replaces SHA-1)

## Cryptographic Algorithm Summary

| Component | Standard Build | FIPS Build | FIPS Status |
|-----------|---------------|------------|-------------|
| Password Hashing | bcrypt (Blowfish) | PBKDF2-HMAC-SHA256 | APPROVED |
| TOTP 2FA | HMAC-SHA1 | HMAC-SHA256 | APPROVED |
| Token Hashing | bcrypt | SHA-256 | APPROVED |
| Operation Hash | SHA-1 | SHA-256 | APPROVED |
| JWT Signing | HS256 | HS256 | APPROVED |
| AES Encryption | AES-256-CTR | AES-256-CTR | APPROVED |

## Quick Start

### Building the FIPS Image

```bash
# Build the FIPS-compliant image
podman build --platform linux/amd64 -f Containerfile.fips -t librechat-fips:latest .

# Or with Docker
docker build --platform linux/amd64 -f Containerfile.fips -t librechat-fips:latest .

# Push to your registry
podman push librechat-fips:latest your-registry.com/librechat-fips:latest
```

### Running Locally

```bash
podman run -d \
  --name librechat-fips \
  -p 3080:3080 \
  -e MONGO_URI=mongodb://localhost:27017/librechat \
  librechat-fips:latest
```

## Breaking Changes

### CRITICAL: Upgrading Existing Deployments to FIPS Mode is NOT Supported

The FIPS build uses different cryptographic algorithms that are **incompatible with existing data**:

| Data Type | Impact | Resolution |
|-----------|--------|------------|
| User Passwords | Existing bcrypt hashes will NOT verify | Users must reset passwords |
| TOTP 2FA Secrets | Existing SHA-1 secrets will NOT work | Users must re-enroll in 2FA |
| Verification Tokens | Existing bcrypt token hashes invalid | Tokens will expire naturally |

### Upgrade Path Options

**Option 1: Greenfield Deployment (Recommended)**
- Deploy FIPS build to a new environment
- Migrate users with password reset requirement
- Suitable for new projects or planned migrations

**Option 2: Forced Password Reset**
- Mark all existing passwords as expired in the database
- Require password reset on next login
- Re-enrollment required for 2FA users

**Option 3: Dual-Algorithm Support (Future Work)**
- Implement algorithm detection based on hash format
- Verify with legacy algorithm, re-hash with FIPS algorithm on login
- Not currently implemented

## Technical Details

### Base Image

```dockerfile
FROM registry.access.redhat.com/ubi9/nodejs-20:latest
```

Red Hat UBI 9 includes:
- FIPS-validated OpenSSL 3.0
- RHEL 9 crypto policies
- Automatic FIPS mode when running on FIPS-enabled hosts

### Password Hashing (PBKDF2)

Configuration in `api/server/utils/crypto.js`:
- **Algorithm:** PBKDF2-HMAC-SHA256
- **Iterations:** 310,000 (OWASP 2023 recommendation)
- **Key Length:** 256 bits (32 bytes)
- **Salt Length:** 128 bits (16 bytes)
- **Format:** `iterations:salt:hash` (hex encoded)

### TOTP 2FA (HMAC-SHA256)

Configuration in `api/server/services/twoFactorService.js`:
- **Algorithm:** HMAC-SHA256 (RFC 6238 with SHA-256)
- **Time Step:** 30 seconds
- **Code Length:** 6 digits
- **QR Code URI:** Includes `algorithm=SHA256` parameter

**Authenticator App Compatibility:**
Most modern authenticator apps support SHA-256:
- Google Authenticator
- Authy
- 1Password
- Microsoft Authenticator
- FreeOTP

## OpenShift Deployment

### Prerequisites

- OpenShift 4.x cluster (FIPS mode enabled recommended)
- Helm 3.x
- Access to push images to a container registry

### Deployment Steps

1. **Build and push the FIPS image:**

```bash
podman build --platform linux/amd64 -f Containerfile.fips -t quay.io/your-org/librechat-fips:latest .
podman push quay.io/your-org/librechat-fips:latest
```

2. **Create the namespace:**

```bash
oc new-project librechat-fips
```

3. **Create the configuration ConfigMap:**

```bash
oc create configmap librechat-config --from-file=librechat.yaml=./librechat.yaml -n librechat-fips
```

4. **Create secrets for credentials:**

```bash
oc create secret generic librechat-credentials-env \
  --from-literal=CREDS_KEY=your-32-char-key \
  --from-literal=CREDS_IV=your-16-char-iv \
  --from-literal=JWT_SECRET=your-jwt-secret \
  --from-literal=JWT_REFRESH_SECRET=your-refresh-secret \
  -n librechat-fips
```

5. **Create pull secret (if using private registry):**

```bash
oc create secret docker-registry quay-pull-secret \
  --docker-server=quay.io \
  --docker-username=your-username \
  --docker-password=your-password \
  -n librechat-fips

oc secrets link default quay-pull-secret --for=pull -n librechat-fips
```

6. **Install with Helm:**

```bash
helm install librechat oci://ghcr.io/danny-avila/librechat-chart/librechat \
  --namespace librechat-fips \
  --set image.repository=quay.io/your-org/librechat-fips \
  --set image.tag=latest \
  --set image.pullPolicy=Always \
  --set mongodb.enabled=true \
  --set meilisearch.enabled=true
```

7. **Add pull secret to deployment (if needed):**

```bash
oc patch deployment librechat-librechat -n librechat-fips \
  -p '{"spec":{"template":{"spec":{"imagePullSecrets":[{"name":"quay-pull-secret"}]}}}}'
```

8. **Create the route:**

```bash
oc create route edge librechat-fips \
  --service=librechat-librechat \
  --hostname=librechat-fips.apps.your-cluster.com \
  -n librechat-fips
```

### Verifying FIPS Mode

To verify FIPS mode is enabled on your cluster:

```bash
# Check if FIPS is enabled on cluster nodes
oc debug node/<node-name> -- chroot /host cat /proc/sys/crypto/fips_enabled
# Output: 1 (FIPS enabled) or 0 (FIPS disabled)

# Check from within a pod
oc exec -n librechat-fips deployment/librechat-librechat -- cat /proc/sys/crypto/fips_enabled
```

## Additional FIPS Considerations

### MongoDB

The Bitnami MongoDB image is not FIPS-certified. For strict compliance:
- Use MongoDB Enterprise with FIPS support
- Or use a managed MongoDB service with FIPS certification
- Enable TLS between LibreChat and MongoDB

### Meilisearch

Meilisearch does not have FIPS certification. Options:
- Accept the risk if Meilisearch handles non-sensitive data only
- Consider FIPS-certified alternatives like Elasticsearch with FIPS configuration
- Disable Meilisearch and use MongoDB text search instead

### External API Communications

LibreChat communicates with external LLM APIs over HTTPS. FIPS compliance for these connections depends on:
- The Node.js/OpenSSL TLS implementation (covered by UBI 9 base image)
- The API provider's FIPS compliance (varies by provider)

## Files Modified for FIPS Compliance

| File | Change |
|------|--------|
| `Containerfile.fips` | New UBI 9-based container build |
| `api/server/utils/crypto.js` | New FIPS-compliant crypto utilities |
| `api/models/userMethods.js` | Use PBKDF2 for password verification |
| `api/server/services/AuthService.js` | Use PBKDF2 and SHA-256 for tokens |
| `api/server/services/twoFactorService.js` | Use HMAC-SHA256 for TOTP |
| `api/server/controllers/TwoFactorController.js` | Include algorithm in QR code URI |
| `packages/data-provider/src/actions.ts` | Use SHA-256 for operation hashing |

## References

- [NIST FIPS 140-2](https://csrc.nist.gov/publications/detail/fips/140/2/final)
- [NIST FIPS 140-3](https://csrc.nist.gov/publications/detail/fips/140/3/final)
- [Red Hat UBI FIPS Documentation](https://access.redhat.com/documentation/en-us/red_hat_enterprise_linux/9/html/security_hardening/assembly_installing-the-system-in-fips-mode_security-hardening)
- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- [RFC 6238 - TOTP](https://datatracker.ietf.org/doc/html/rfc6238)
- [Node.js FIPS Mode](https://nodejs.org/api/crypto.html#crypto_crypto_fips)
- [MongoDB FIPS Configuration](https://www.mongodb.com/docs/manual/tutorial/configure-fips/)
