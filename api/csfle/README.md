# CSFLE Integration Contract

This document is the **interface boundary** between LibreChat and nos-gpt-apps.

| Owns | Scope |
|------|-------|
| **LibreChat** | Application code: policy definitions, schema map, key vault bootstrap, migration manager, startup hook |
| **nos-gpt-apps** | Runtime: docker-compose wiring, KMS credentials, `crypt_shared` library, standalone migration runner |

---

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `CSFLE_ENABLED` | Set `true` to activate CSFLE. When absent/false no other CSFLE vars are read. |
| `MONGO_URI` | Standard MongoDB URI (already required). |

### Startup migration

| Variable | Default | Description |
|----------|---------|-------------|
| `CSFLE_AUTO_MIGRATE` | `false` | When `true`, LibreChat runs unapplied migration policies at startup before serving requests. |
| `CSFLE_STARTUP_POLICY` | `strict` | `strict` — abort startup on migration failure (recommended). `warn` — log and continue. |
| `CSFLE_MIGRATION_TARGET_VERSION` | *(all)* | Limit auto-migration to policies ≤ this version. Leave empty to apply all. |

### KMS — production (GCP, Workload Identity)

| Variable | Example |
|----------|---------|
| `GCP_KMS_PROJECT_ID` | `nos-gpt-prod` |
| `GCP_KMS_LOCATION` | `europe-west1` |
| `GCP_KMS_KEY_RING` | `nos-gpt-mongodb-csfle` |
| `GCP_KMS_KEY_NAME` | `nos-gpt-csfle-cmk` |

Auth via **ADC / K8s Workload Identity** — no static service-account key.

### KMS — local dev

| Variable | Description |
|----------|-------------|
| `MONGO_CSFLE_LOCAL_MASTER_KEY` | Base64-encoded 96-byte key. Generate: `node -e "console.log(require('crypto').randomBytes(96).toString('base64'))"` |

### Crypto backend

| Variable | Default | Description |
|----------|---------|-------------|
| `MONGO_CSFLE_KEY_VAULT_NAMESPACE` | `<dbName>.__keyVault` | Override when the DB name differs from the default. |
| `MONGO_CRYPT_SHARED_LIB_PATH` | *(empty)* | Absolute path to `crypt_shared` inside the container. Strongly recommended — no sidecar required. |
| `MONGOCRYPTD_URI` | `mongodb://127.0.0.1:27020` | Fallback if `MONGO_CRYPT_SHARED_LIB_PATH` is not set. |
| `MONGOCRYPTD_BYPASS_SPAWN` | `false` | Set `true` when mongocryptd is managed externally. |

---

## Mounted Paths

Mount the `crypt_shared` library into the LibreChat container:

```yaml
# nos-gpt-apps docker-compose snippet
services:
  api:
    volumes:
      - ./lib/mongo_crypt_v1.so:/app/lib/mongo_crypt_v1.so:ro
    environment:
      - MONGO_CRYPT_SHARED_LIB_PATH=/app/lib/mongo_crypt_v1.so
```

Download for Linux x86-64: https://www.mongodb.com/try/download/crypt-shared

---

## Policy System

Migration policies are versioned, pure-data files in `api/csfle/policies/`:

| File | Wave | Collections |
|------|------|-------------|
| `v1.js` | 1 — auth-critical | users, sessions, keys |
| `v2.js` | 2 — content/privacy | messages, conversations |
| `v3.js` | 3 — completeness | users (remaining), files |

Each policy defines an array of field descriptors:
```js
{ collection, field, bsonType, dek, algorithm }
```

**Rules:**
- Never remove or reorder an existing policy once applied to production.
- Never edit a policy's `fields` array after it has been applied — the manager detects checksum mismatches.
- Add new policies (v4, v5…) for future schema changes.

---

## Migration State

Applied policies are tracked in `__csfle_migrations` (same database):

```js
{
  version:     Number,   // policy version
  description: String,   // human-readable label
  checksum:    String,   // SHA-256 prefix of policy.fields (tamper detection)
  status:      'applied' | 'failed' | 'pending',
  startedAt:   Date,
  appliedAt:   Date,
  stats:       { migrated, skipped, errors },
}
```

Behaviour:
- `applied` → skip on next run (idempotent).
- `pending` → retry (handles crash recovery).
- `failed`  → retry.
- Checksum mismatch on an applied record → warns; does not re-run.

---

## Key Vault Bootstrap

LibreChat bootstraps `__keyVault` and the 6 DEKs **automatically on first startup** with `CSFLE_ENABLED=true`. The operation is idempotent.

DEK alt-names (never rename after provisioning):

| Alt-name | Covers |
|----------|--------|
| `dek-users` | users.email, openidId, googleId, name, username, avatar |
| `dek-messages` | messages.text, messages.content |
| `dek-convos` | conversations.title |
| `dek-keys` | keys.value |
| `dek-files` | files.filename, filepath |
| `dek-sessions` | sessions.refreshTokenHash |

---

## Startup Flow

```
connectDb()                              (api/db/connect.js)
  │
  ├─ if CSFLE_ENABLED=true
  │    buildAutoEncryptionOptions()      ← bootstraps __keyVault + 6 DEKs (idempotent)
  │    mongoose.connect(uri, { autoEncryption })
  │
  └─ if CSFLE_AUTO_MIGRATE=true && !cached.migrationRan
       runStartupMigration(mongoUri)     (api/csfle/manager.js)
         │
         ├─ reads CSFLE_STARTUP_POLICY  (strict | warn, default: strict)
         ├─ reads CSFLE_MIGRATION_TARGET_VERSION  (optional)
         │
         └─ runMigrations()
              for each unapplied policy:
                mark PENDING in __csfle_migrations
                backfillCollection() — replaceOne through encrypted client
                mark APPLIED in __csfle_migrations
              │
              on error:
                strict → throw (process exits, startup aborts)
                warn   → logger.warn, continue
```

---

## Migration Invocation

Set `CSFLE_AUTO_MIGRATE=true` in the LibreChat container env. The manager runs at startup, applies all unapplied policies, and tracks state in `__csfle_migrations`. No manual invocation required.

For phased rollout, set `CSFLE_MIGRATION_TARGET_VERSION=1` to apply Wave 1 only on first deploy, then remove the limit in a subsequent release.

---

## MeiliSearch (Wave 2 blocker)

Encrypting `messages.text`, `messages.content`, and `conversations.title` produces BinData that MeiliSearch cannot index.

**nos-gpt-apps must** clear `MEILI_HOST` / `MEILI_MASTER_KEY` before enabling Wave 2, or deploy a decrypt-proxy before the MeiliSearch indexer.

LibreChat model factories already skip the MeiliSearch plugin when `CSFLE_ENABLED=true`.

---

## What lives where

| Artifact | Repo |
|----------|------|
| `api/csfle/` module | **LibreChat** — application code, versioned with schema |
| `api/db/connect.js` patch | **LibreChat** — connection setup + startup hook |
| `docker-compose.csfle.yml` | **nos-gpt-apps** |
| Standalone migration runner | **nos-gpt-apps** |
| `crypt_shared` library binary | **nos-gpt-apps** |
| GCP KMS credentials / Workload Identity | **nos-gpt-apps** |
| Deployment smoke tests | **nos-gpt-apps** |
| `pymongocrypt` patch for nos-gpt-cleaner | nos-gpt-cleaner repo |
