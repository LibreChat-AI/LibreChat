import { configSchema, DEFAULT_MAX_PROVIDER_ERROR_CHARS } from './config';

describe('provider error retention configuration', () => {
  it.each([0, 32, 3000])('preserves a configured limit of %i', (maxProviderErrorChars) => {
    const config = configSchema.parse({
      version: '1.3.1',
      endpoints: { agents: { maxProviderErrorChars } },
    });
    expect(config.endpoints?.agents?.maxProviderErrorChars).toBe(maxProviderErrorChars);
  });

  it('defaults to 2000 characters', () => {
    const config = configSchema.parse({ version: '1.3.1', endpoints: { agents: {} } });
    expect(config.endpoints?.agents?.maxProviderErrorChars).toBe(DEFAULT_MAX_PROVIDER_ERROR_CHARS);
  });

  it.each([-1, 1.5, Infinity, 1_000_001])('rejects invalid limit %s', (maxProviderErrorChars) => {
    expect(
      configSchema.safeParse({ version: '1.3.1', endpoints: { agents: { maxProviderErrorChars } } })
        .success,
    ).toBe(false);
  });
});
