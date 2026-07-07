'use strict';

const fs = require('fs');

/**
 * Normalises a GCP service-account `private_key` value for libmongocrypt.
 *
 * libmongocrypt's `kmsProviders.gcp.privateKey` expects a **bare base64**
 * payload — no PEM headers, no newlines.  Standard GCP JSON key files ship
 * with a full PEM block (`-----BEGIN RSA PRIVATE KEY-----\n...\n-----END...`).
 *
 * This function:
 *   1. Strips `-----BEGIN ... KEY-----` / `-----END ... KEY-----` lines.
 *   2. Removes all whitespace (newlines, spaces, `\r`).
 *   3. Validates the result decodes to a non-empty buffer.
 *
 * If the value is already bare base64 it passes through unchanged.
 *
 * @param {string} raw  Value of `private_key` from the service-account JSON.
 * @param {string} context  Human-readable source for error messages.
 * @returns {string} Bare base64 private key payload.
 */
function normalisePemToBase64(raw, context) {
  // Strip PEM header/footer lines and collapse all whitespace.
  const base64 = raw
    .replace(/-----BEGIN[^-]*-----/g, '')
    .replace(/-----END[^-]*-----/g, '')
    .replace(/\s+/g, '');

  if (!base64) {
    throw new Error(`[CSFLE] ${context}: private_key is empty after stripping PEM headers`);
  }

  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new Error(`[CSFLE] ${context}: private_key contains non-base64 characters`);
  }

  const buf = Buffer.from(base64, 'base64');
  if (buf.length === 0) {
    throw new Error(`[CSFLE] ${context}: private_key decoded to empty buffer — invalid key`);
  }

  return base64;
}

/**
 * Resolves the GCP service account JSON file path from env vars and returns
 * the `client_email` + normalised `privateKey` fields libmongocrypt needs.
 *
 * Resolution order (when GCP_KMS_PROJECT_ID is set):
 *   1. CSFLE_GCP_SERVICE_ACCOUNT_FILE
 *   2. GOOGLE_SERVICE_KEY_FILE  (shared with other app GCP integrations)
 *   3. Neither set → return null (caller falls back to ADC / Workload Identity)
 *
 * Throws with an explicit message including the env var name and file path when
 * the file cannot be read, is invalid JSON, is missing required fields, or the
 * private key cannot be normalised to bare base64.
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
  const context = `GCP service account file at ${filePath} (from ${sourceVar})`;

  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`[CSFLE] Cannot read ${context}: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`[CSFLE] ${context} is not valid JSON: ${err.message}`);
  }

  const { client_email: email, private_key: rawPrivateKey } = parsed;

  if (!email || !rawPrivateKey) {
    throw new Error(
      `[CSFLE] ${context} is missing required fields: client_email and/or private_key`,
    );
  }

  const privateKey = normalisePemToBase64(rawPrivateKey, context);

  return { email, privateKey };
}

/**
 * Selects and builds the KMS provider configuration.
 *
 * GCP mode (when GCP_KMS_PROJECT_ID is set):
 *   - If CSFLE_GCP_SERVICE_ACCOUNT_FILE or GOOGLE_SERVICE_KEY_FILE is set,
 *     reads the JSON key file and supplies explicit credentials to libmongocrypt.
 *     The private_key PEM value is automatically normalised to bare base64.
 *   - Otherwise falls back to ADC / Workload Identity (kmsProviders.gcp = {}).
 *
 * Local mode (dev / CI):
 *   - Requires MONGO_CSFLE_LOCAL_MASTER_KEY (base64-encoded 96-byte key).
 *
 * @returns {{ provider: string, kmsProviders: object, masterKey: object | undefined }}
 */
function buildKmsProviders() {
  if (process.env.GCP_KMS_PROJECT_ID) {
    if (!process.env.GCP_KMS_KEY_NAME) {
      throw new Error('[CSFLE] GCP_KMS_KEY_NAME is required when GCP_KMS_PROJECT_ID is set');
    }

    const creds = loadGcpCredentials();

    return {
      provider: 'gcp',
      kmsProviders: {
        gcp: creds ? { email: creds.email, privateKey: creds.privateKey } : {},
      },
      masterKey: {
        projectId: process.env.GCP_KMS_PROJECT_ID,
        location: process.env.GCP_KMS_LOCATION || 'europe-west1',
        keyRing: process.env.GCP_KMS_KEY_RING || 'mongodb-csfle',
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

module.exports = { buildKmsProviders, loadGcpCredentials, normalisePemToBase64 };
