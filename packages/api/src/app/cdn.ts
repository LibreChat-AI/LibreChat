import { logger } from '@librechat/data-schemas';
import { FileSources } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import { initializeAzureBlobService } from '~/cdn/azure';
import { initializeCloudFront } from '~/cdn/cloudfront';
import { initializeFirebase } from '~/cdn/firebase';
import { initializeS3 } from '~/cdn/s3';

function initializeStrategy(strategy: FileSources, appConfig: AppConfig): void {
  if (strategy === FileSources.firebase) {
    initializeFirebase();
  } else if (strategy === FileSources.azure_blob) {
    initializeAzureBlobService().catch((error) => {
      logger.error('Error initializing Azure Blob Service:', error);
    });
  } else if (strategy === FileSources.s3) {
    initializeS3();
  } else if (strategy === FileSources.cloudfront) {
    const cloudfrontConfig = appConfig.cloudfront;
    if (!cloudfrontConfig) {
      logger.error(
        '[initializeFileStorage] CloudFront strategy requires cloudfront config in librechat.yaml',
      );
      return;
    }
    const initialized = initializeCloudFront(cloudfrontConfig);
    if (!initialized) {
      if (cloudfrontConfig.requireSignedAccess === true) {
        throw new Error(
          '[initializeFileStorage] CloudFront initialization failed and cloudfront.requireSignedAccess=true; refusing to start.',
        );
      }
      logger.error(
        '[initializeFileStorage] CloudFront initialization failed. CloudFront operations will not work.',
      );
    }
  }
}

/**
 * Initializes file storage clients based on the configured file strategies.
 * Handles fileStrategy, granular fileStrategies, and the Media Studio storage override.
 */
export function initializeFileStorage(appConfig: AppConfig): void {
  const { fileStrategy, fileStrategies } = appConfig;

  const strategiesToInit = new Set<FileSources>();

  if (fileStrategy) {
    strategiesToInit.add(fileStrategy);
  }

  // Existing originals remain readable when Media Studio is subsequently disabled.
  if (appConfig.media?.assets.source) {
    strategiesToInit.add(appConfig.media.assets.source);
  }

  if (fileStrategies) {
    for (const value of Object.values(fileStrategies)) {
      if (value) {
        strategiesToInit.add(value);
      }
    }
  }

  for (const strategy of strategiesToInit) {
    initializeStrategy(strategy, appConfig);
  }
}
