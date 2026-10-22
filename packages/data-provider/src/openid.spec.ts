import { configSchema } from './config';

describe('OpenID browser session check configuration', () => {
  it.each([undefined, {}, { socialLogins: ['openid'] }])(
    'keeps the check disabled when registration is %p',
    (registration) => {
      expect(
        configSchema.parse({ version: '1.4.0', registration }).registration.openidSessionCheck,
      ).toBe(false);
    },
  );

  it.each([true, false])('preserves an explicit check setting of %p', (openidSessionCheck) => {
    expect(
      configSchema.parse({ version: '1.4.0', registration: { openidSessionCheck } }).registration
        .openidSessionCheck,
    ).toBe(openidSessionCheck);
  });
});
