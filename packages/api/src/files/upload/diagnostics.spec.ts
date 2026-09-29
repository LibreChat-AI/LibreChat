import { logger } from '@librechat/data-schemas';
import { warnOnUnreachableDeliveryPaths } from './diagnostics';

jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn() },
}));

const warned = (): string[] => (logger.warn as jest.Mock).mock.calls.map(([msg]) => String(msg));

describe('warnOnUnreachableDeliveryPaths', () => {
  beforeEach(() => {
    (logger.warn as jest.Mock).mockClear();
  });

  it('warns for a fallback that routes everything off the model path', () => {
    /* The fallback covers every type no override names, so leaving it unannounced hides
     * a wider change than any single override could make. */
    warnOnUnreachableDeliveryPaths({
      fileConfig: { defaultLLMDeliveryPath: { fallback: 'none' } },
    });

    expect(warned()).toEqual([expect.stringContaining('fallback is set to "none"')]);
  });

  it('warns for an override that routes one type off the model path', () => {
    warnOnUnreachableDeliveryPaths({
      fileConfig: { defaultLLMDeliveryPath: { overrides: { 'application/pdf': 'none' } } },
    });

    expect(warned()).toEqual([expect.stringContaining('"application/pdf" is set to "none"')]);
  });

  it('names the endpoint a warning came from', () => {
    warnOnUnreachableDeliveryPaths({
      fileConfig: {
        endpoints: { openAI: { defaultLLMDeliveryPath: { fallback: 'none' } } },
      },
    });

    expect(warned()).toEqual([expect.stringContaining('for "openAI"')]);
  });

  it('stays quiet when every type still reaches the model', () => {
    warnOnUnreachableDeliveryPaths({
      fileConfig: {
        defaultLLMDeliveryPath: { fallback: 'text', overrides: { 'image/*': 'provider' } },
      },
    });

    expect(warned()).toEqual([]);
  });
});
