import { OCRStrategy } from 'librechat-data-provider';
import type { TCustomConfig } from 'librechat-data-provider';

/**
 * The key OCR uses when librechat.yaml sets none. Spelled out as a reference so it stays bound to
 * the YAML's own base URL: the OCR runtime fills an empty key from `OCR_API_KEY` only while the
 * base URL is the deployment's default, so a config override that points OCR elsewhere never
 * inherits it implicitly.
 */
const DEFAULT_OCR_API_KEY = '${OCR_API_KEY}';

export function loadOCRConfig(config?: TCustomConfig['ocr']): TCustomConfig['ocr'] | undefined {
  if (!config) return;
  const baseURL = config?.baseURL ?? '';
  const apiKey = config?.apiKey?.trim() ? config.apiKey : DEFAULT_OCR_API_KEY;
  const mistralModel = config?.mistralModel ?? '';
  return {
    apiKey,
    baseURL,
    mistralModel,
    strategy: config?.strategy ?? OCRStrategy.MISTRAL_OCR,
    allowedAddresses: config?.allowedAddresses,
  };
}
