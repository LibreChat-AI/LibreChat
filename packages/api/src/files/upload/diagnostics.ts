import { logger } from '@librechat/data-schemas';
import type { TDefaultLLMDeliveryPathConfig } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';

/**
 * Warns about delivery settings that keep a file off the model path. Routing a type to
 * `none` is a legitimate choice, but a silent one: uploads still succeed and only a file
 * tool can reach them, so an operator who set it by accident has nothing to notice. A
 * `none` fallback is the louder case, since it covers every type no override names.
 */
export function warnOnUnreachableDeliveryPaths(appConfig?: Pick<AppConfig, 'fileConfig'>): void {
  const warnForConfig = (
    config: TDefaultLLMDeliveryPathConfig | undefined,
    scope?: string,
  ): void => {
    if (!config) {
      return;
    }
    const where = scope ? ` for "${scope}"` : '';
    if (config.fallback === 'none') {
      logger.warn(
        `[Config] defaultLLMDeliveryPath${where}: fallback is set to "none" — every type without an override will only be accessible through tool provisioning`,
      );
    }
    for (const [mimeType, destination] of Object.entries(config.overrides ?? {})) {
      if (destination !== 'none') {
        continue;
      }
      logger.warn(
        `[Config] defaultLLMDeliveryPath${where}: "${mimeType}" is set to "none" — files of this type will only be accessible through tool provisioning`,
      );
    }
  };

  warnForConfig(appConfig?.fileConfig?.defaultLLMDeliveryPath);

  const endpoints = appConfig?.fileConfig?.endpoints;
  if (!endpoints) {
    return;
  }
  for (const [endpoint, config] of Object.entries(endpoints)) {
    warnForConfig(config?.defaultLLMDeliveryPath, endpoint);
  }
}
