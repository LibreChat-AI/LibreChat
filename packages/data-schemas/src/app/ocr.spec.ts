import { OCRStrategy } from 'librechat-data-provider';
import { loadOCRConfig } from './ocr';

describe('loadOCRConfig', () => {
  it('returns undefined when no config is provided', () => {
    expect(loadOCRConfig(undefined)).toBeUndefined();
  });

  it('preserves allowedAddresses so the exemption survives config load', () => {
    const loaded = loadOCRConfig({
      apiKey: '${OCR_API_KEY}',
      baseURL: 'https://ocr.internal:8080',
      strategy: OCRStrategy.MISTRAL_OCR,
      allowedAddresses: ['ocr.internal:8080'],
    });
    expect(loaded?.allowedAddresses).toEqual(['ocr.internal:8080']);
  });

  it('leaves allowedAddresses undefined when it is not configured', () => {
    const loaded = loadOCRConfig({
      apiKey: 'key',
      baseURL: 'https://api.mistral.ai',
      strategy: OCRStrategy.MISTRAL_OCR,
    });
    expect(loaded?.allowedAddresses).toBeUndefined();
  });

  it('spells out the default OCR_API_KEY reference when librechat.yaml sets no key', () => {
    for (const apiKey of [undefined, '', '  ']) {
      const loaded = loadOCRConfig({
        apiKey,
        baseURL: 'https://ocr.internal/v1',
        strategy: OCRStrategy.MISTRAL_OCR,
      } as Parameters<typeof loadOCRConfig>[0]);
      expect(loaded?.apiKey).toBe('${OCR_API_KEY}');
      expect(loaded?.baseURL).toBe('https://ocr.internal/v1');
    }
  });

  it('keeps a key librechat.yaml sets', () => {
    const loaded = loadOCRConfig({
      apiKey: '${AZURE_OCR_KEY}',
      strategy: OCRStrategy.AZURE_MISTRAL_OCR,
    } as Parameters<typeof loadOCRConfig>[0]);
    expect(loaded?.apiKey).toBe('${AZURE_OCR_KEY}');
    expect(loaded?.baseURL).toBe('');
  });
});
