import { getGoogleTokenConfig } from './pricing';

describe('Google token rates', () => {
  const rates = { prompt: 1.5, completion: 7.5, cacheRead: 0.075 };

  it.each(['gemini-2.5-flash', 'models/gemini-2.5-flash'])(
    'resolves bare and prefixed model ids for %s',
    (model) => {
      expect(getGoogleTokenConfig(model, { 'gemini-2.5-flash': rates })).toEqual({
        ...rates,
        read: rates.cacheRead,
      });
      expect(getGoogleTokenConfig(model, { 'models/gemini-2.5-flash': rates })).toEqual({
        ...rates,
        read: rates.cacheRead,
      });
    },
  );

  it('prefers an exact override and preserves free-tier rates', () => {
    expect(
      getGoogleTokenConfig('models/gemma-4', {
        'models/gemma-4': { prompt: 0, completion: 0, cacheRead: 0 },
        'gemma-4': rates,
      }),
    ).toEqual({ prompt: 0, completion: 0, cacheRead: 0, read: 0 });
  });

  it('leaves unconfigured models and inherited keys on existing rates', () => {
    expect(getGoogleTokenConfig('gemini-2.5-pro', { 'gemini-2.5-flash': rates })).toBeUndefined();
    expect(getGoogleTokenConfig('gemini-2.5-pro')).toBeUndefined();
    expect(getGoogleTokenConfig('constructor', {})).toBeUndefined();
  });
});
