import { loadConfig } from './config';

const required = {
  CHANNEL_SERVICE_TOKEN: 'private-service-token',
  CHANNEL_TENANT_ID: 'tenant-1',
  CHANNEL_ID: 'channel-1',
};

describe('gateway configuration', () => {
  test('loads generic deployment defaults without private branding or optional Slack authority', () => {
    expect(loadConfig(required)).toMatchObject({
      APP_TITLE: 'LibreChat',
      PORT: 8080,
      LISTEN_HOST: '0.0.0.0',
      SLACK_TRANSPORT: 'webhook',
      SLACK_NATIVE_SESSIONS: false,
      SLACK_LIFECYCLE_REACTIONS: false,
      LIBRECHAT_INTERNAL_URL: 'http://localhost:3080',
      SLACK_API_BASE_URL: 'https://slack.com/api/',
    });
  });

  test('supports legacy binding aliases and equal canonical/legacy values', () => {
    const legacy = {
      CHANNEL_SERVICE_TOKEN: required.CHANNEL_SERVICE_TOKEN,
      SLACK_SOCKET_TENANT_ID: 'tenant-1',
      SLACK_SOCKET_CHANNEL_ID: 'channel-1',
    };
    expect(loadConfig(legacy)).toMatchObject(required);
    expect(loadConfig({ ...legacy, ...required })).toMatchObject(required);
  });

  test.each(['CHANNEL_TENANT_ID', 'CHANNEL_ID'])(
    'never falls back from an explicitly empty canonical %s',
    (name) => {
      expect(() =>
        loadConfig({
          ...required,
          [name]: '',
          SLACK_SOCKET_TENANT_ID: 'tenant-1',
          SLACK_SOCKET_CHANNEL_ID: 'channel-1',
        }),
      ).toThrow();
    },
  );

  test('conflicting bindings fail without disclosing either identifier', () => {
    expect(() =>
      loadConfig({ ...required, SLACK_SOCKET_CHANNEL_ID: 'private-other-channel' }),
    ).toThrow('Conflicting channel bindings');
  });

  test('requires durable actor-bound execution and Socket Mode app token', () => {
    expect(() => loadConfig({ ...required, DURABLE_RUNS_ENABLED: 'false' })).toThrow(
      'Actor-bound durable execution is required',
    );
    expect(() => loadConfig({ ...required, SLACK_TRANSPORT: 'socket_mode' })).toThrow(
      'SLACK_APP_TOKEN is required',
    );
    expect(
      loadConfig({
        ...required,
        SLACK_TRANSPORT: 'socket_mode',
        SLACK_APP_TOKEN: 'private-app-token',
      }).SLACK_TRANSPORT,
    ).toBe('socket_mode');
  });

  test.each(['LIBRECHAT_INTERNAL_URL', 'SLACK_API_BASE_URL'])(
    'rejects unsafe %s values without echoing them',
    (name) => {
      for (const value of [
        'ftp://private.example',
        'https://private-user:private-password@example.com',
        'https://example.com?token=private-secret',
        'https://example.com#private-secret',
        'private-invalid-value',
      ]) {
        try {
          loadConfig({ ...required, [name]: value });
          throw new Error('accepted invalid configuration');
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          expect(String(error)).not.toContain(value);
          expect(String(error)).not.toContain('private-secret');
          expect(String(error)).not.toContain('private-password');
          expect(String(error)).not.toContain('accepted invalid configuration');
        }
      }
    },
  );

  test.each([
    'PORT',
    'API_CALL_TIMEOUT_MS',
    'AGENT_INVOKE_TIMEOUT_MS',
    'SLACK_SIGNATURE_TOLERANCE_SECS',
  ])('validates numeric %s bounds without echoing submitted values', (name) => {
    for (const value of ['0', '-1', '1.2', 'private-input']) {
      expect(() => loadConfig({ ...required, [name]: value })).toThrow(
        `Invalid gateway configuration: ${name}`,
      );
    }
    expect(() => loadConfig({ ...required, PORT: '65536' })).toThrow('PORT');
  });

  test.each(['x/y', 'x\\y', 'x?y', 'x#y', 'x:y', 'x y', 'x\ny'])(
    'rejects path/header syntax in binding %s',
    (value) => {
      expect(() => loadConfig({ ...required, CHANNEL_ID: value })).toThrow('CHANNEL_ID');
    },
  );

  test('allows single-tenant placeholder and explicit opt-in feature flags', () => {
    expect(
      loadConfig({
        ...required,
        CHANNEL_TENANT_ID: '_',
        SLACK_NATIVE_SESSIONS: 'true',
        SLACK_LIFECYCLE_REACTIONS: 'true',
      }),
    ).toMatchObject({
      CHANNEL_TENANT_ID: '_',
      SLACK_NATIVE_SESSIONS: true,
      SLACK_LIFECYCLE_REACTIONS: true,
    });
  });

  test.each(['', '<@everyone>', 'Name|URL', 'private\nsecret', 'x'.repeat(41)])(
    'rejects unsafe app title %s',
    (APP_TITLE) => {
      expect(() => loadConfig({ ...required, APP_TITLE })).toThrow('APP_TITLE');
    },
  );

  test.each(['127.0.0.1', '::1', 'localhost', '0.0.0.0'])('allows listener %s', (LISTEN_HOST) => {
    expect(loadConfig({ ...required, LISTEN_HOST }).LISTEN_HOST).toBe(LISTEN_HOST);
  });

  test.each(['example.com', '127.0.0.1:8088', 'http://localhost', '[::1]', ' ', '127.0.0.1\n'])(
    'rejects invalid listener %s',
    (LISTEN_HOST) => {
      expect(() => loadConfig({ ...required, LISTEN_HOST })).toThrow('LISTEN_HOST');
    },
  );
});
