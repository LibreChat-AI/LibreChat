import { FileSources } from 'librechat-data-provider';

import type { SaveBufferParams } from './types';

import { AVATAR_BASE_PATH } from './constants';

type AvatarConfig =
  | {
      fileStrategy?: string | null;
      fileStrategies?: {
        avatar?: string | null;
        default?: string | null;
      } | null;
    }
  | null
  | undefined;

const sharedAvatarBasePathStrategies = new Set<string>([FileSources.s3, FileSources.cloudfront]);

/**
 * Resolves the storage strategy used for avatars. `fallbackStrategy` is usually
 * `process.env.CDN_PROVIDER`; undefined is valid and falls back to local storage.
 */
export function getAvatarFileStrategy(
  appConfig: AvatarConfig,
  fallbackStrategy?: string | null,
): string {
  const config: AvatarConfig =
    appConfig?.fileStrategy || appConfig?.fileStrategies
      ? appConfig
      : { fileStrategy: fallbackStrategy };

  if (!config?.fileStrategies) {
    return config?.fileStrategy ?? FileSources.local;
  }

  return (
    config.fileStrategies.avatar ??
    config.fileStrategies.default ??
    config.fileStrategy ??
    FileSources.local
  );
}

export function getAvatarSaveParams<T extends SaveBufferParams>(
  fileStrategy: string,
  params: T,
): T {
  if (!sharedAvatarBasePathStrategies.has(fileStrategy)) {
    return params;
  }

  return { ...params, basePath: AVATAR_BASE_PATH };
}
