'use strict';

const fs = require('fs');

/**
 * Resolves the GCP service account JSON file path from env vars and returns
 * the `client_email` + `private_key` fields libmongocrypt needs.
 *
 * Resolution order (when GCP_KMS_PROJECT_ID is set):
 *   1. CSFLE_GCP_SERVICE_ACCOUNT_FILE
 *   2. GOOGLE_SERVICE_KEY_FILE  (shared with other app GCP integrations)
 *   3. Neither set → return null (caller falls back to ADC / Workload Identity)
 *
 * Throws with an explicit message when a path is configured but the file
 * cannot be read or is missing the required fields.
 *
 * @returns {{ email: string, privateKey: string } | null}
 */
function loadGcpCredentials() {
  const filePath =
    process.env.CSFLE_GCP_SERVICE_ACCOUNT_FILE || process.env.GOOGLE_SERVICE_KEY_FILE || null;

  if (!filePath) return null;

  const sourceVar = process.env.CSFLE_GCP_SERVICE_ACCOUNT_FILE
    ? 'CSFLE_GCP_SERVICE_ACCOUNT_FILE'
    : 'GOOGLE_SERVICE_KEY_FILE';

  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(
      `[CSFLE] Cannot read GCP service account file at ${filePath} ` +
        `(from ${sourceVar}): ${err.message}`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `[CSFLE] GCP service account file at ${filePath} (from ${sourceVar}) ` +
        `is not valid JSON: ${err.message}`,
    );
  }

  const { client_email: email, private_key: privateKey } = parsed;

  if (!email || !privateKey) {
    throw new Error(
      `[CSFLE] GCP service account file at ${filePath} (from ${sourceVar}) ` +
        'is missing required fields: client_email and/or private_key',
    );
  }

  return { email, privateKey };
}

/**
 * Selects and builds the KMS provider configuration.
 *
 * GCP mode (when GCP_KMS_PROJECT_ID is set):
 *   - If CSFLE_GCP_SERVICE_ACCOUNT_FILE or GOOGLE_SERVICE_KEY_FILE is set,
 *     reads the JSON key file and supplies explicit credentials to libmongocrypt.
 *   - Otherwise falls back to ADC / Workload Identity (kmsProviders.gcp = {}).
 *
 * Local mode (dev / CI):
 *   - Requires MONGO_CSFLE_LOCAL_MASTER_KEY (base64-encoded 96-byte key).
 *
 * @returns {{ provider: string, kmsProviders: object, masterKey: object | undefined }}
 */
function buildKmsProviders() {
  if (process.env.GCP_KMS_PROJECT_ID) {
    const creds = loadGcpCredentials();

    return {
      provider: 'gcp',
      kmsProviders: {
        gcp: creds ? { email: creds.email, privateKey: creds.privateKey } : {},
      },
      masterKey: {
        projectId: process.env.GCP_KMS_PROJECT_ID,
        location: process.env.GCP_KMS_LOCATION || 'europe-west1',
        keyRing: process.env.GCP_KMS_KEY_RING || 'nos-gpt-mongodb-csfle',
        keyName: process.env.GCP_KMS_KEY_NAME,
      },
    };
  }

  const b64 = process.env.MONGO_CSFLE_LOCAL_MASTER_KEY;
  if (!b64) {
    throw new Error(
      '[CSFLE] No KMS configured: set GCP_KMS_PROJECT_ID (production) ' +
        'or MONGO_CSFLE_LOCAL_MASTER_KEY (dev/CI)',
    );
  }

  const keyBuf = Buffer.from(b64, 'base64');
  if (keyBuf.length !== 96) {
    throw new Error(
      `[CSFLE] MONGO_CSFLE_LOCAL_MASTER_KEY must decode to exactly 96 bytes (got ${keyBuf.length})`,
    );
  }

  return {
    provider: 'local',
    kmsProviders: { local: { key: keyBuf } },
    masterKey: undefined,
  };
}

module.exports = { buildKmsProviders, loadGcpCredentials };
