import { FileSources, FileContext } from 'librechat-data-provider';
import type { FileStorage } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';

/** Generated images and videos use the configured image storage policy. */
export function getFileStrategy(
  appConfig: Pick<AppConfig, 'fileStrategy' | 'fileStrategies'>,
  {
    isAvatar = false,
    isImage = false,
    context,
  }: { isAvatar?: boolean; isImage?: boolean; context?: FileContext | null } = {},
): FileStorage {
  const strategies = appConfig.fileStrategies;
  const fallback = strategies?.default || appConfig.fileStrategy || FileSources.local;
  if (!strategies) return fallback;
  if (isAvatar || context === FileContext.avatar) return strategies.avatar || fallback;
  if (context === FileContext.skill_file) {
    return strategies.skills || (isImage ? strategies.image : strategies.document) || fallback;
  }
  if (
    isImage ||
    context === FileContext.image_generation ||
    context === FileContext.video_generation
  ) {
    return strategies.image || fallback;
  }
  return strategies.document || fallback;
}
