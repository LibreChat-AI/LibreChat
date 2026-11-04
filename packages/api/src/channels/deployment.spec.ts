import '~/mcp/registry/__tests__/helpers/setupCredsEnv';
import { AppService } from '@librechat/data-schemas';
import { agentsEndpointSchema } from 'librechat-data-provider';
import type { TCustomConfig } from 'librechat-data-provider';
import { createSlackWorkspaceSettingsReader } from './workspaceRuntime';
import { applySlackWorkspaceEnvironment } from './deployment';
import { redactResolvedConfigSecrets } from '~/admin/secrets';

const environment = {
  SLACK_WORKSPACES_ENABLED: 'true',
  SLACK_APP_ID: 'A123',
  SLACK_CLIENT_ID: '123.456',
  SLACK_CLIENT_SECRET: 'fixture-client-secret',
  SLACK_SIGNING_SECRET: 'fixture-signature',
  SLACK_GATEWAY_URL: 'https://slack.example.com',
  DOMAIN_SERVER: 'https://chat.example.com/librechat',
};

describe('shared Slack deployment setup', () => {
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
      readAppConfig: async () => appConfig,
      publicBaseUrl: environment.DOMAIN_SERVER,
      clientBaseUrl: 'https://client.example.com/librechat',
    });
    const settings = await read();
    expect(settings.channels.maxMetadataPageSize).toBe(17);
    expect(settings.app?.gateway.workerConcurrency).toBe(2);
    expect(settings.app?.appId).toBe('A123');
    expect(settings.app?.redirectUri).toBe(
      'https://chat.example.com/librechat/api/channels/workspaces/oauth/callback',
    );
    const redacted = redactResolvedConfigSecrets(structuredClone(appConfig));
    redactResolvedConfigSecrets(redacted.config);
    const adminView = JSON.stringify(redacted);
    expect(adminView).not.toContain(environment.SLACK_CLIENT_SECRET);
    expect(adminView).not.toContain(environment.SLACK_SIGNING_SECRET);
  });

  it('uses YAML credentials when no environment replacement is supplied', () => {
    const first = applySlackWorkspaceEnvironment({}, environment);
    const second = applySlackWorkspaceEnvironment(first, {
      SLACK_WORKSPACES_ENABLED: 'true',
      DOMAIN_SERVER: environment.DOMAIN_SERVER,
    });
    expect(second.endpoints?.agents?.channels?.slackApp).toEqual(
      first.endpoints?.agents?.channels?.slackApp,
    );
    expect(second.endpoints?.agents?.channels?.gatewayUrl).toBe(environment.SLACK_GATEWAY_URL);
  });

  it.each([
    { SLACK_APP_ID: 'invalid-app' },
    { DOMAIN_SERVER: undefined },
    { DOMAIN_SERVER: '' },
    { DOMAIN_SERVER: '   ' },
    { SLACK_CLIENT_SECRET: '' },
    { SLACK_SIGNING_SECRET: 'sensitive-secret'.repeat(100) },
    { DOMAIN_SERVER: 'https://user:sensitive-secret@chat.example.com' },
    { SLACK_GATEWAY_URL: 'https://user:sensitive-secret@slack.example.com' },
  ])('rejects incomplete or invalid setup without echoing values', (override) => {
    const run = () => applySlackWorkspaceEnvironment({}, { ...environment, ...override });
    expect(run).toThrow('Invalid shared Slack setup');
    expect(run).not.toThrow('sensitive-secret');
  });
});
