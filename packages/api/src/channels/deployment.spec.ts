import '~/mcp/registry/__tests__/helpers/setupCredsEnv';
import mongoose from 'mongoose';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { readFileSync } from 'node:fs';
import { agentsEndpointSchema } from 'librechat-data-provider';
import { AppService, createSlackWorkspaceStorage } from '@librechat/data-schemas';
import type { TCustomConfig } from 'librechat-data-provider';
import { createSlackWorkspaceSettingsReader } from './workspaceRuntime';
import { applySlackWorkspaceEnvironment } from './deployment';

const environment = {
  SLACK_WORKSPACES_ENABLED: 'true',
  SLACK_GATEWAY_URL: 'https://slack.example.com',
  DOMAIN_SERVER: 'https://chat.example.com/librechat',
  DOMAIN_CLIENT: 'https://client.example.com/librechat',
};

describe('shared Slack deployment setup', () => {
  it('rejects the active localhost defaults shipped in .env.example', () => {
    const defaults = parseEnv(readFileSync(resolve(__dirname, '../../../../.env.example'), 'utf8'));
    expect(() =>
      applySlackWorkspaceEnvironment(
        {},
        {
          ...environment,
          DOMAIN_SERVER: defaults.DOMAIN_SERVER,
          DOMAIN_CLIENT: defaults.DOMAIN_CLIENT,
        },
      ),
    ).toThrow('public HTTPS');
    const ordinary = {};
    expect(applySlackWorkspaceEnvironment(ordinary, defaults)).toBe(ordinary);
  });

  it('accepts a public hostname starting with an IP-range prefix', () => {
    expect(() =>
      applySlackWorkspaceEnvironment(
        {},
        {
          ...environment,
          DOMAIN_SERVER: 'https://fc.example.com/librechat',
        },
      ),
    ).not.toThrow();
  });

  describe.each(['DOMAIN_SERVER', 'DOMAIN_CLIENT', 'SLACK_GATEWAY_URL'] as const)('%s', (field) => {
    it.each([
      'http://chat.example.com',
      'https://localhost',
      'https://localhost.',
      'https://chat.localhost',
      'https://127.1',
      'https://2130706433',
      'https://[::1]',
      'https://[::ffff:127.0.0.1]',
      'https://10.0.0.1',
      ' https://chat.example.com',
      'https://chat.example.com ',
      'https://chat.example.com\n',
    ])('rejects a nonpublic installation URL: %s', (value) => {
      expect(() => applySlackWorkspaceEnvironment({}, { ...environment, [field]: value })).toThrow(
        'public HTTPS',
      );
    });
  });

  it.each([undefined, '', 'false'])(
    'leaves ordinary and manual setup unchanged when %s',
    (enabled) => {
      const config = { endpoints: { agents: agentsEndpointSchema.parse({}) } };
      expect(
        applySlackWorkspaceEnvironment(config, {
          ...environment,
          SLACK_WORKSPACES_ENABLED: enabled,
        }),
      ).toBe(config);
    },
  );

  it('feeds the real base configuration and settings reader while preserving other policy', async () => {
    const config: Partial<TCustomConfig> = {
      secureImageLinks: false,
      endpoints: {
        agents: agentsEndpointSchema.parse({
          channels: { maxMetadataPageSize: 17, slackApp: { gateway: { workerConcurrency: 2 } } },
          remoteApi: {
            auth: { apiKey: { enabled: false } },
            background: { acknowledgementTimeoutMs: 7000 },
          },
        }),
      },
    };
    const configured = applySlackWorkspaceEnvironment(config, environment);
    const appConfig = await AppService({ config: configured });
    expect(configured.secureImageLinks).toBe(false);
    expect(config.endpoints?.agents?.channels?.enabled).toBe(false);
    expect(appConfig.endpoints?.agents?.remoteApi).toEqual({
      auth: { apiKey: { enabled: false } },
      background: { enabled: true, acknowledgementTimeoutMs: 7000 },
    });
    const read = createSlackWorkspaceSettingsReader({
      storage: createSlackWorkspaceStorage(new mongoose.Mongoose()),
      readAppConfig: async () => appConfig,
      publicBaseUrl: environment.DOMAIN_SERVER,
      clientBaseUrl: 'https://client.example.com/librechat',
    });
    const settings = await read();
    expect(settings.channels.maxMetadataPageSize).toBe(17);
    expect(settings.channels.slackApp?.gateway.workerConcurrency).toBe(2);
    expect(settings.app).toBeUndefined();
    expect(settings.channels.slackApp).not.toHaveProperty('clientSecret');
    expect(settings.channels.slackApp).not.toHaveProperty('signingSecret');
  });

  it('preserves YAML runtime policy without requiring app credentials', () => {
    const first = applySlackWorkspaceEnvironment({}, environment);
    const second = applySlackWorkspaceEnvironment(first, {
      SLACK_WORKSPACES_ENABLED: 'true',
      DOMAIN_SERVER: environment.DOMAIN_SERVER,
      DOMAIN_CLIENT: environment.DOMAIN_CLIENT,
    });
    expect(second.endpoints?.agents?.channels?.slackApp).toEqual(
      first.endpoints?.agents?.channels?.slackApp,
    );
    expect(second.endpoints?.agents?.channels?.gatewayUrl).toBe(environment.SLACK_GATEWAY_URL);
  });

  it.each([
    { DOMAIN_SERVER: undefined },
    { DOMAIN_SERVER: '' },
    { DOMAIN_SERVER: '   ' },
    { DOMAIN_CLIENT: undefined },
    { DOMAIN_CLIENT: '' },
    { DOMAIN_SERVER: 'https://user:sensitive-secret@chat.example.com' },
    { SLACK_GATEWAY_URL: 'https://user:sensitive-secret@slack.example.com' },
  ])('rejects incomplete or invalid setup without echoing values', (override) => {
    const run = () => applySlackWorkspaceEnvironment({}, { ...environment, ...override });
    expect(run).toThrow('Invalid shared Slack setup');
    expect(run).not.toThrow('sensitive-secret');
  });
});
