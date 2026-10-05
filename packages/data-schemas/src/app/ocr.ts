import { OCRStrategy, LEGACY_LOCAL_OCR_STRATEGY } from 'librechat-data-provider';
import type { TCustomConfig } from 'librechat-data-provider';
import logger from '~/config/winston';

export function loadOCRConfig(config?: TCustomConfig['ocr']): TCustomConfig['ocr'] | undefined {
  if (!config) return;
  /* The local parser is no longer an OCR provider; it runs automatically for every
   * document type. Reporting "no OCR configured" reproduces what this strategy did,
   * without routing images at an extractor that can only refuse them. */
  if (config.strategy === LEGACY_LOCAL_OCR_STRATEGY) {
    logger.warn(
      `[loadOCRConfig] \`ocr.strategy: ${LEGACY_LOCAL_OCR_STRATEGY}\` is deprecated and ignored: documents are parsed locally by default. Remove the \`ocr\` block, or set a strategy to configure a real OCR provider.`,
    );
    return;
  }
  const baseURL = config?.baseURL ?? '';
  const apiKey = config?.apiKey ?? '';
  const mistralModel = config?.mistralModel ?? '';
  return {
    apiKey,
    baseURL,
    mistralModel,
    strategy: config?.strategy ?? OCRStrategy.MISTRAL_OCR,
    allowedAddresses: config?.allowedAddresses,
  };
}
