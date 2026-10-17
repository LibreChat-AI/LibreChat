import {
  parseClientDsn,
  resolveClientErrorReporting,
  clientErrorReportingConnectSources,
} from './client';

const DSN = 'https://publickey@glitchtip.example.com/5';
const enabled = { client: { enabled: true, sampleRate: 0.5 } };

describe('parseClientDsn', () => {
  it('accepts a public https DSN and a plain-http localhost one', () => {
    expect(parseClientDsn(DSN)?.origin).toBe('https://glitchtip.example.com');
    expect(parseClientDsn('http://key@localhost:8000/1')?.origin).toBe('http://localhost:8000');
  });

  it.each([
    ['empty', ''],
    ['not a URL', 'glitchtip'],
    ['plain http to a remote host', 'http://key@glitchtip.example.com/5'],
    ['no public key', 'https://glitchtip.example.com/5'],
    ['a secret key the browser would publish', 'https://key:secret@glitchtip.example.com/5'],
    ['no project id', 'https://key@glitchtip.example.com/'],
  ])('refuses %s', (_label, value) => {
    expect(parseClientDsn(value)).toBeUndefined();
  });
});

describe('resolveClientErrorReporting', () => {
  it('stays off unless librechat.yaml enables it, even with a DSN set', () => {
    const env = { SENTRY_DSN: DSN };
    expect(resolveClientErrorReporting({ env, release: 'abc' })).toBeUndefined();
    expect(
      resolveClientErrorReporting({ config: { client: { enabled: false } }, env, release: 'abc' }),
    ).toBeUndefined();
  });

  it('stays off when enabled without a usable DSN', () => {
    expect(
      resolveClientErrorReporting({ config: enabled, env: {}, release: 'abc' }),
    ).toBeUndefined();
    expect(
      resolveClientErrorReporting({
        config: enabled,
        env: { SENTRY_DSN: 'https://key:secret@glitchtip.example.com/5' },
        release: 'abc',
      }),
    ).toBeUndefined();
  });

  it('hands the browser the DSN, environment, release and sample rate', () => {
    expect(
      resolveClientErrorReporting({
        config: enabled,
        env: { SENTRY_DSN: ` ${DSN} `, SENTRY_ENVIRONMENT: 'dev' },
        release: 'abc123',
      }),
    ).toEqual({ dsn: DSN, environment: 'dev', release: 'abc123', sampleRate: 0.5 });
  });

  it('prefers SENTRY_RELEASE and defaults the sample rate to every error', () => {
    expect(
      resolveClientErrorReporting({
        config: { client: { enabled: true } },
        env: { SENTRY_DSN: DSN, SENTRY_RELEASE: 'v1.2.3' },
        release: 'abc123',
      }),
    ).toEqual({ dsn: DSN, release: 'v1.2.3', sampleRate: 1 });
  });
});

describe('clientErrorReportingConnectSources', () => {
  it('names the collector origin only while reporting is on', () => {
    const env = { SENTRY_DSN: DSN };
    expect(clientErrorReportingConnectSources({ config: enabled, env })).toEqual([
      'https://glitchtip.example.com',
    ]);
    expect(clientErrorReportingConnectSources({ env })).toEqual([]);
    expect(clientErrorReportingConnectSources({ config: enabled, env: {} })).toEqual([]);
  });
});
