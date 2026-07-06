# CSFLE Integration — api/csfle

LibreChat encrypts sensitive message fields at the MongoDB driver layer using
**Client-Side Field Level Encryption (CSFLE)**.  Encryption and decryption happen
transparently in the application process — MongoDB never sees plaintext for the
protected fields.

---

## Encrypted fields

| Collection | Field | Type | Algorithm |
|---|---|---|---|
| `messages` | `text` | string | Random |
| `messages` | `content` | array | Random |

Random encryption means ciphertext differs on every write. Equality queries on
these fields are not supported (and not used by LibreChat).

---

## Prerequisites

- `mongodb-client-encryption` npm package (already in `api/package.json`).
- `crypt_shared` or `mongocryptd` to handle BSON transformation locally.
  **Recommended:** use `crypt_shared` — it is bundled in the Docker image at
  `/app/lib/mongo_crypt_v1.so` with `MONGO_CRYPT_SHARED_LIB_PATH` pre-set.

---

## Environment variables

### Core flags

| Variable | Default | Description |
|---|---|---|
| `CSFLE_ENABLED` | — | Set `true` to activate CSFLE. When absent/false no other CSFLE vars are read. |
| `CSFLE_AUTO_MIGRATE` | `false` | When `true`, backfills existing plaintext docs at startup. |
| `CSFLE_STARTUP_POLICY` | `strict` | `strict` — abort startup on failure. `warn` — log and continue. |
| `CSFLE_FORCE_REMIGRATE` | — | Set `true` to re-run the migration even if already applied (single-use). |

### Key vault

| Variable | Default | Description |
|---|---|---|
| `MONGO_CSFLE_KEY_VAULT_NAMESPACE` | `<dbName>.__keyVault` | Override when the DB name differs. |

### Crypto backend

| Variable | Description |
|---|---|
| `MONGO_CRYPT_SHARED_LIB_PATH` | Path to `crypt_shared` inside the container. Pre-set to `/app/lib/mongo_crypt_v1.so` in the Docker image. |
| `MONGOCRYPTD_URI` | Fallback if `MONGO_CRYPT_SHARED_LIB_PATH` is not set. |
| `MONGOCRYPTD_BYPASS_SPAWN` | Set `true` when mongocryptd is managed externally. |

### KMS — local dev / CI

```sh
# Generate a 96-byte local master key (base64):
node -e "console.log(require('crypto').randomBytes(96).toString('base64'))"
```

| Variable | Description |
|---|---|
| `MONGO_CSFLE_LOCAL_MASTER_KEY` | Base64-encoded 96-byte key. Used when `GCP_KMS_PROJECT_ID` is not set. |

### KMS — production (GCP Cloud KMS + Workload Identity)

| Variable | Example |
|---|---|
| `GCP_KMS_PROJECT_ID` | `nos-gpt-prod` |
| `GCP_KMS_LOCATION` | `europe-west1` |
| `GCP_KMS_KEY_RING` | `nos-gpt-mongodb-csfle` |
| `GCP_KMS_KEY_NAME` | `nos-gpt-csfle-cmk` |
| `CSFLE_GCP_SERVICE_ACCOUNT_FILE` | `/run/secrets/csfle-sa.json` *(optional)* |

**GCP auth resolution order** (when `GCP_KMS_PROJECT_ID` is set):
1. `CSFLE_GCP_SERVICE_ACCOUNT_FILE` — path to a GCP service account JSON key file (preferred)
2. `GOOGLE_SERVICE_KEY_FILE` — fallback to the shared GCP key file used by other app integrations
3. Neither set → **ADC / K8s Workload Identity** (recommended in production, no file needed)

The JSON file must contain `client_email` and `private_key`. If a path is configured but the file is missing, unreadable, or malformed, LibreChat throws an explicit startup error naming the env var and path.

---

## Local dev setup

1. Generate a local master key and add it to your `.env`:
   ```sh
   node -e "console.log(require('crypto').randomBytes(96).toString('base64'))"
   # → paste as MONGO_CSFLE_LOCAL_MASTER_KEY=<base64>
   ```

2. Enable CSFLE in `.env`:
   ```
   CSFLE_ENABLED=true
   CSFLE_AUTO_MIGRATE=true
   CSFLE_STARTUP_POLICY=warn
   MONGO_CSFLE_LOCAL_MASTER_KEY=<your-base64-key>
   ```

3. Start LibreChat normally. On first startup the app will:
   - Create the `__keyVault` collection and `dek-messages` DEK.
   - Backfill any existing plaintext `messages.text` / `messages.content` docs.

---

## Google Cloud KMS setup

1. Create a KMS key ring and key in `europe-west1`.
2. Grant the service account / Workload Identity `roles/cloudkms.cryptoKeyEncrypterDecrypter`.
3. Set the four `GCP_KMS_*` env vars.
4. Set `CSFLE_ENABLED=true`.

**Auth options** (mutually exclusive, use one):

- **K8s Workload Identity / ADC** *(recommended in production)* — leave `CSFLE_GCP_SERVICE_ACCOUNT_FILE` and `GOOGLE_SERVICE_KEY_FILE` unset. libmongocrypt picks up credentials from the environment automatically.
- **Service account JSON file** *(local docker / CI)* — mount the key file into the container and set `CSFLE_GCP_SERVICE_ACCOUNT_FILE=/path/to/sa.json`.

```yaml
# nos-gpt-apps docker-compose example — GCP key file mount
services:
  api:
    environment:
      CSFLE_ENABLED: "true"
      GCP_KMS_PROJECT_ID: "nos-gpt-prod"
      GCP_KMS_LOCATION: "europe-west1"
      GCP_KMS_KEY_RING: "nos-gpt-mongodb-csfle"
      GCP_KMS_KEY_NAME: "nos-gpt-csfle-cmk"
      CSFLE_GCP_SERVICE_ACCOUNT_FILE: "/run/secrets/csfle-sa.json"
    volumes:
      - ./secrets/csfle-sa.json:/run/secrets/csfle-sa.json:ro
```

---

## Startup flow

```
connectDb()                              (api/db/connect.js)
  │
  ├─ CSFLE_ENABLED=true
  │    buildAutoEncryptionOptions()
  │      bootstrapKeyVault()            ← creates __keyVault + dek-messages (idempotent)
  │      fetch DEK UUID from keyVault
  │      buildSchemaMap()               ← messages.text + messages.content schema
  │    mongoose.connect(uri, { autoEncryption })
  │
  └─ CSFLE_AUTO_MIGRATE=true && !cached.migrationRan
       runStartupMigration(mongoUri)    (api/csfle/manager.js)
         │
         ├─ check __csfle_migrations for version=1
         ├─ if APPLIED and !FORCE_REMIGRATE → skip
         │
         └─ backfillCollection(messages, ['text','content'])
              for each plaintext doc: updateOne + $set
              mark APPLIED / FAILED in __csfle_migrations
              │
              on error:
                strict → throw (startup aborts)
                warn   → log, continue
```

---

## Migration state

Applied migrations are tracked in `__csfle_migrations` (same database):

```js
{
  version:     1,
  description: 'Backfill messages.text and messages.content with CSFLE encryption',
  status:      'applied' | 'failed' | 'pending',
  startedAt:   Date,
  appliedAt:   Date,
  stats:       { migrated, skipped, errors },
}
```

- `applied` → skip on next run (idempotent).
- `pending` / `failed` → retry on next run (crash recovery).

To re-run after a bug fix: set `CSFLE_FORCE_REMIGRATE=true`, restart once, then remove it.

---

## Verifying encryption

In MongoDB Compass or mongosh with a raw (non-CSFLE) client, encrypted docs show
`text` and `content` as `BinData(6, ...)`. Plaintext values indicate the migration
has not yet run or `CSFLE_ENABLED` is not set in the app.

```js
// mongosh — check a sample message
db.messages.findOne({}, { text: 1, content: 1 })
// Encrypted:  { text: BinData(6,"..."), content: BinData(6,"...") }
// Plaintext:  { text: "hello world", content: [...] }
```

---

## MeiliSearch

`messages.text` and `messages.content` are encrypted — MeiliSearch receives
`BinData` and cannot index these fields. LibreChat skips the MeiliSearch plugin
for the `messages` model when `CSFLE_ENABLED=true`. Full-text search will not
work on message content while CSFLE is enabled.

**nos-gpt-apps** should clear `MEILI_HOST` / `MEILI_MASTER_KEY` when deploying
with CSFLE, or deploy a decrypt-proxy before the MeiliSearch indexer.

---

## What lives where

| Artifact | Repo |
|---|---|
| `api/csfle/` module | **LibreChat** — application code |
| `api/db/connect.js` patch | **LibreChat** — connection + startup hook |
| `docker-compose.csfle.yml` | **nos-gpt-apps** |
| `crypt_shared` library binary | bundled in LibreChat Docker image |
| GCP KMS credentials / Workload Identity | **nos-gpt-apps** |
| Deployment smoke tests | **nos-gpt-apps** |