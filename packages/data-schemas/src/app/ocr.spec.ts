import { LEGACY_LOCAL_OCR_STRATEGY, OCRStrategy } from 'librechat-data-provider';
import { loadOCRConfig } from './ocr';

describe('loadOCRConfig', () => {
  it('returns undefined when no config is provided', () => {
    expect(loadOCRConfig(undefined)).toBeUndefined();
  });

  /**
   * A v0.8.6 config could name the built-in extractor as its OCR strategy. Local
   * parsing is automatic now, so the block has to resolve to "no OCR provider":
   * keeping it would send every OCR-supported type, images included, at a parser
   * that can only refuse them.
   */
  it('drops the deprecated document_parser strategy instead of configuring OCR', () => {
    expect(
      loadOCRConfig({
        apiKey: '${OCR_API_KEY}',
        baseURL: '${OCR_BASEURL}',
        strategy: LEGACY_LOCAL_OCR_STRATEGY,
      }),
    ).toBeUndefined();
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
});
