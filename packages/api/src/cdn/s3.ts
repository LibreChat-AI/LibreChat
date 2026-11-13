import { S3Client } from '@aws-sdk/client-s3';
import { fromTemporaryCredentials, fromTokenFile } from '@aws-sdk/credential-providers';
import { logger } from '@librechat/data-schemas';
import { isEnabled } from '~/utils/common';

let s3: S3Client | null = null;

/**
 * Initializes and returns an instance of the AWS S3 client.
 *
 * Credential precedence:
 * 1. If AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are provided, they will be used.
 * 2. If AWS_ROLE_NAME is provided, uses IRSA (or other token-based auth) to assume that role for S3 access.
 *    This is useful in Kubernetes with IRSA or other environments where you need to assume a role.
 * 3. Otherwise, the AWS SDK's default credentials chain (including IRSA, instance profiles,
 *    AWS profiles, environment variables, etc.) is used.
 *
 * @returns An instance of S3Client if the region is provided; otherwise, null.
 */
export const initializeS3 = (): S3Client | null => {
  if (s3) {
    return s3;
  }

  const region = process.env.AWS_REGION;
  if (!region) {
    logger.error('[initializeS3] AWS_REGION is not set. Cannot initialize S3.');
    return null;
  }

  if (!process.env.AWS_BUCKET_NAME) {
    throw new Error(
      '[S3] AWS_BUCKET_NAME environment variable is required for S3 operations. ' +
        'Please set this environment variable to enable S3 storage.',
    );
  }

  const endpoint = process.env.AWS_ENDPOINT_URL;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const awsRoleArn = process.env.AWS_ROLE_NAME;

  const config = {
    region,
    requestChecksumCalculation: 'WHEN_REQUIRED' as const,
    ...(endpoint ? { endpoint } : {}),
    ...(isEnabled(process.env.AWS_FORCE_PATH_STYLE) ? { forcePathStyle: true } : {}),
  };

  if (accessKeyId && secretAccessKey) {
    s3 = new S3Client({
      ...config,
      credentials: { accessKeyId, secretAccessKey },
    });
    logger.info('[initializeS3] S3 initialized with provided credentials.');
  } else if (awsRoleArn) {
    // Use IRSA (or other token-based auth) to assume specified role for S3 access
    s3 = new S3Client({
      ...config,
      credentials: fromTemporaryCredentials({
        masterCredentials: fromTokenFile(),
        params: {
          RoleArn: awsRoleArn,
          RoleSessionName: 'librechat-s3-session',
        },
      }),
    });
    logger.info(`[initializeS3] S3 initialized with assumed role: ${awsRoleArn}`);
  } else {
    // Fallback to default credentials chain (IRSA, instance profiles, etc.)
    s3 = new S3Client(config);
    logger.info('[initializeS3] S3 initialized using default credentials (IRSA).');
  }

  return s3;
};
