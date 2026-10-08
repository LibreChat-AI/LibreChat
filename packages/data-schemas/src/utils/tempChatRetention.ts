import { RetentionMode } from 'librechat-data-provider';
import type { AppConfig } from '~/types';
import logger from '~/config/winston';

/**
 * Default retention period for temporary chats in hours
 */
export const DEFAULT_RETENTION_HOURS: number = 24 * 30; // 30 days

/**
 * Minimum allowed retention period in hours
 */
export const MIN_RETENTION_HOURS = 1;

/**
 * Maximum allowed retention period in hours (1 year = 8760 hours)
 */
export const MAX_RETENTION_HOURS = 8760;

/**
 * Gets the temporary chat retention period from environment variables or config
 * @param interfaceConfig - The custom configuration object
 * @returns The retention period in hours
 */
export function getTempChatRetentionHours(
  interfaceConfig?: AppConfig['interfaceConfig'] | null,
): number {
  let retentionHours = DEFAULT_RETENTION_HOURS;

  // Check environment variable first
  if (process.env.TEMP_CHAT_RETENTION_HOURS) {
    const envValue = parseInt(process.env.TEMP_CHAT_RETENTION_HOURS, 10);
    if (!isNaN(envValue)) {
      retentionHours = envValue;
    } else {
      logger.warn(
        `Invalid TEMP_CHAT_RETENTION_HOURS environment variable: ${process.env.TEMP_CHAT_RETENTION_HOURS}. Using default: ${DEFAULT_RETENTION_HOURS} hours.`,
      );
    }
  }

  // Check config file (takes precedence over environment variable)
  if (interfaceConfig?.temporaryChatRetention !== undefined) {
    const configValue = interfaceConfig.temporaryChatRetention;
    if (typeof configValue === 'number' && !isNaN(configValue)) {
      retentionHours = configValue;
    } else {
      logger.warn(
        `Invalid temporaryChatRetention in config: ${configValue}. Using ${retentionHours} hours.`,
      );
    }
  }

  // Validate the retention period
  if (retentionHours < MIN_RETENTION_HOURS) {
    logger.warn(
      `Temporary chat retention period ${retentionHours} is below minimum ${MIN_RETENTION_HOURS} hours. Using minimum value.`,
    );
    retentionHours = MIN_RETENTION_HOURS;
  } else if (retentionHours > MAX_RETENTION_HOURS) {
    logger.warn(
      `Temporary chat retention period ${retentionHours} exceeds maximum ${MAX_RETENTION_HOURS} hours. Using maximum value.`,
    );
    retentionHours = MAX_RETENTION_HOURS;
  }

  return retentionHours;
}

/**
 * Creates an expiration date for temporary chats
 * @param interfaceConfig - The custom configuration object
 * @returns The expiration date
 */
export function createTempChatExpirationDate(interfaceConfig?: AppConfig['interfaceConfig']): Date {
  const retentionHours = getTempChatRetentionHours(interfaceConfig);
  return new Date(Date.now() + retentionHours * 60 * 60 * 1000);
}

/** Regular chats fall back to the temporary retention policy for existing configurations. */
export function createChatExpirationDate(
  interfaceConfig?: AppConfig['interfaceConfig'],
  isTemporary: boolean = false,
): Date {
  if (
    isTemporary ||
    interfaceConfig?.retentionMode !== RetentionMode.ALL ||
    interfaceConfig.generalChatRetention === undefined
  ) {
    return createTempChatExpirationDate(interfaceConfig);
  }

  return createTempChatExpirationDate({
    ...interfaceConfig,
    temporaryChatRetention: interfaceConfig.generalChatRetention,
  });
}
