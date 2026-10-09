import { logger } from '@librechat/data-schemas';
import type { CloudFrontConfig } from 'librechat-data-provider';
import { initializeS3 } from './s3';

export interface CloudFrontFullConfig extends NonNullable<CloudFrontConfig> {
  privateKey: string | null;
  keyPairId: string | null;
}

let cloudFrontConfig: CloudFrontFullConfig | null = null;

export function initializeCloudFront(config: CloudFrontConfig): boolean {
  if (cloudFrontConfig) {
    logger.debug('[initializeCloudFront] Already initialized; skipping re-initialization.');
    return true;
  }

  if (!config?.domain) {
    logger.error('[initializeCloudFront] CloudFront domain is required in config.');
    return false;
  }

  const s3 = initializeS3();
  if (!s3) {
    logger.error('[initializeCloudFront] S3 must be initialized for CloudFront to work.');
    return false;
  }

  const keyPairId = process.env.CLOUDFRONT_KEY_PAIR_ID ?? null;
  const privateKey = process.env.CLOUDFRONT_PRIVATE_KEY ?? null;

  const requireSignedAccess = config.requireSignedAccess === true;

  if (requireSignedAccess) {
    logger.info('[initializeCloudFront] Strict signed CloudFront access enabled at startup.');

    if (config.imageSigning !== 'cookies') {
      logger.error(
        `[initializeCloudFront] Strict startup failure: cloudfront.requireSignedAccess=true requires cloudfront.imageSigning="cookies" (got "${config.imageSigning ?? 'none'}"); signed URL mode is not yet implemented.`,
      );
      return false;
    }

    if (!keyPairId || !privateKey) {
      logger.error(
        '[initializeCloudFront] Strict startup failure: cloudfront.requireSignedAccess=true but CLOUDFRONT_KEY_PAIR_ID and/or CLOUDFRONT_PRIVATE_KEY are missing.',
      );
      return false;
    }
  }

  if (config.imageSigning === 'cookies' && (!keyPairId || !privateKey)) {
    logger.error(
      '[initializeCloudFront] imageSigning="cookies" requires CLOUDFRONT_KEY_PAIR_ID and CLOUDFRONT_PRIVATE_KEY env vars.',
    );
    return false;
  }

  cloudFrontConfig = { ...config, privateKey, keyPairId };

  if (config.imageSigning === 'cookies' && !requireSignedAccess) {
    logger.info(
      '[initializeCloudFront] CloudFront cookie signing enabled. Cookies will be set during auth.',
    );
  } else if (config.imageSigning === 'url') {
    logger.warn(
      '[initializeCloudFront] imageSigning="url" is configured but not yet implemented for images.',
    );
  }

  if (!keyPairId || !privateKey) {
    logger.info(
      '[initializeCloudFront] CloudFront initialized without signing keys (public OAC only).',
    );
  }

  if (config.invalidateOnDelete) {
    logger.info('[initializeCloudFront] Cache invalidation on delete enabled.');
  }

  return true;
}

export function getCloudFrontConfig(): Readonly<CloudFrontFullConfig> | null {
  return cloudFrontConfig;
}
