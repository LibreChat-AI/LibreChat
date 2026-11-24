import { createVerify, generateKeyPairSync } from 'node:crypto';
import type { EventConfig } from './settings';
import { eventSettings } from './settings';
import { createApp } from './github/app';
import { LIMITS } from './catalog';

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = rsa.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

const env = {
  GITHUB_APP_ID: '123456',
  GITHUB_APP_PRIVATE_KEY: PEM,
  GITHUB_APP_WEBHOOK_SECRET: 'whsec-example-0123456789abcdef',
};

const github = {
  appId: '${GITHUB_APP_ID}',
  privateKey: '${GITHUB_APP_PRIVATE_KEY}',
  webhookSecret: '${GITHUB_APP_WEBHOOK_SECRET}',
};

describe('eventSettings', () => {
  it.each([
    ['no section', undefined],
    ['a null section', null],
    ['an empty section', {}],
    ['a section turned off', { enabled: false, github }],
    ['a section that leaves the switch out', { github }],
  ])('is null for %s', (_name, config) => {
    expect(eventSettings(config, env)).toBeNull();
  });

  it('uses the catalog bounds when none are set', () => {
    expect(eventSettings({ enabled: true }, env)).toEqual({ limits: LIMITS, github: null });
  });

  it('takes each bound that is set and keeps the default for the other', () => {
    expect(eventSettings({ enabled: true, limits: { excerpt: 500 } }, env)?.limits).toEqual({
      excerpt: 500,
      fanout: LIMITS.fanout,
    });
    expect(eventSettings({ enabled: true, limits: { fanout: 3 } }, env)?.limits).toEqual({
      excerpt: LIMITS.excerpt,
      fanout: 3,
    });
  });

  it('resolves the app from the environment, on github.com with a ten second timeout', () => {
    expect(eventSettings({ enabled: true, github }, env)?.github).toEqual({
      app: { id: '123456', key: PEM.trim(), host: 'github.com', timeoutMs: 10_000 },
      secret: 'whsec-example-0123456789abcdef',
    });
  });

  it('takes the host and the request timeout that are set', () => {
    const config: Partial<EventConfig> = {
      enabled: true,
      github: { ...github, host: 'GitHub.Example.com:443', requestTimeoutSeconds: 3 },
    };
    expect(eventSettings(config, env)?.github?.app).toMatchObject({
      host: 'github.example.com',
      timeoutMs: 3_000,
    });
  });

  it.each(['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_WEBHOOK_SECRET'] as const)(
    'has no app while %s is unset or blank',
    (name) => {
      const { [name]: _unset, ...rest } = env;
      expect(eventSettings({ enabled: true, github }, rest)?.github).toBeNull();
      expect(eventSettings({ enabled: true, github }, { ...env, [name]: '  ' })?.github).toBeNull();
    },
  );

  it.each(['appId', 'privateKey', 'webhookSecret'] as const)(
    'has no app when %s holds a value instead of a reference',
    (field) => {
      const config = { enabled: true, github: { ...github, [field]: 'GITHUB_APP_ID' } };
      expect(eventSettings(config, env)?.github).toBeNull();
    },
  );

  it('has no app for a host that is not a host name', () => {
    const config = { enabled: true, github: { ...github, host: 'https://github.example.com/' } };
    expect(eventSettings(config, env)?.github).toBeNull();
  });

  it('reads a private key kept on one line into one the app can sign with', async () => {
    const escaped = PEM.trim().replace(/\n/g, '\\n');
    expect(escaped).not.toContain('\n');
    const settings = eventSettings(
      { enabled: true, github },
      { ...env, GITHUB_APP_PRIVATE_KEY: escaped },
    );
    expect(settings?.github?.app.key).toBe(PEM.trim());
    if (settings?.github == null) {
      throw new Error('expected a resolved app');
    }
    let token = '';
    const app = createApp(settings.github.app, {
      fetch: async (_input, init) => {
        token = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? '';
        return new Response('{}', { status: 500 });
      },
    });
    await expect(app.access(4400, 'example-org/widgets', 'example-author')).rejects.toThrow(
      'GitHub app request failed: upstream',
    );
    const [head, claims, signature] = token.split('.');
    expect(
      createVerify('RSA-SHA256')
        .update(`${head}.${claims}`)
        .verify(rsa.publicKey, signature, 'base64url'),
    ).toBe(true);
  });
});
