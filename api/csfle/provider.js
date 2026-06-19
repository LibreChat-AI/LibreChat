'use strict';

/**
 * Selects and builds the KMS provider configuration.
 *
 * - When GCP_KMS_PROJECT_ID is set: uses GCP Cloud KMS with ADC / Workload Identity.
 * - Otherwise: falls back to local master key (dev / CI).
 *
 * @returns {{ provider: string, kmsProviders: object, masterKey: object | undefined }}
 */
function buildKmsProviders() {
  if (process.env.GCP_KMS_PROJECT_ID) {
    return {
      provider: 'gcp',
      kmsProviders: { gcp: {} },
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

module.exports = { buildKmsProviders };
