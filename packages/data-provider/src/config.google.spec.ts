import { googleEndpointSchema } from './config';

describe('Google billing configuration', () => {
  it('accepts explicit free-tier rates', () => {
    const config = {
      tokenConfig: { 'gemini-2.5-flash': { prompt: 0, completion: 0, cacheRead: 0 } },
    };
    expect(googleEndpointSchema.parse(config)).toMatchObject(config);
  });

  it.each(['prompt', 'completion', 'cacheRead'])('rejects negative %s rates', (key) => {
    expect(
      googleEndpointSchema.safeParse({
        tokenConfig: { model: { prompt: 1, completion: 2, cacheRead: 0.1, [key]: -1 } },
      }).success,
    ).toBe(false);
  });

  it('requires an explicit cache rate so a free-tier override cannot inherit a paid rate', () => {
    expect(
      googleEndpointSchema.safeParse({ tokenConfig: { model: { prompt: 0, completion: 0 } } })
        .success,
    ).toBe(false);
  });
});
