import { resolveMediaConfig, FileSources } from 'librechat-data-provider';
import { sanitizeMediaStartupConfig, resolveMediaStartupConfig } from './config';

describe('sanitizeMediaStartupConfig', () => {
  const access = { authenticated: true, canUse: true, canCreate: true };
  const config = resolveMediaConfig({
    enabled: true,
    integrations: [
      {
        id: 'private-connection',
        api: 'openrouter.images',
        endpointRef: { kind: 'custom', name: 'Private endpoint' },
        catalog: { kind: 'configured', models: ['publisher/model'] },
        operations: ['image.generate'],
      },
    ],
  });

  it('does not expose media before authentication', () => {
    expect(sanitizeMediaStartupConfig({ ...access, config, authenticated: false })).toBeUndefined();
  });

  it('projects only safe availability and cadence fields', () => {
    expect(sanitizeMediaStartupConfig({ ...access, config })).toEqual({
      enabled: true,
      studio: true,
      chat: true,
      tools: false,
      events: true,
      canCreate: true,
      clientPollIntervalMs: 5_000,
      clientCatchUpIntervalMs: 30_000,
    });
  });

  it('keeps absent/disabled deployments off and enforces explicit role denial', () => {
    expect(sanitizeMediaStartupConfig(access)).toMatchObject({ enabled: false, canCreate: false });
    expect(sanitizeMediaStartupConfig({ ...access, config, canUse: false })).toMatchObject({
      enabled: false,
      studio: false,
      chat: false,
      canCreate: false,
    });
  });

  it('keeps reconciliation visible without admitting new paid work after removal', () => {
    expect(sanitizeMediaStartupConfig({ ...access, reconciliationAvailable: true })).toMatchObject({
      enabled: true,
      studio: true,
      canCreate: false,
    });
  });
});

it('publishes startup key descriptors from static config without catalog discovery', () => {
  const startup = resolveMediaStartupConfig({
    appConfig: {
      config: {},
      fileStrategy: FileSources.local,
      imageOutputType: 'png',
      media: resolveMediaConfig({
        enabled: true,
        integrations: [
          {
            id: 'studio',
            label: 'Studio provider',
            api: 'bfl.images',
            endpointRef: { kind: 'direct', apiKey: 'user_provided' },
            catalog: { kind: 'configured', models: ['black-forest-labs/flux.2-pro'] },
            operations: ['image.generate'],
          },
        ],
      }),
    },
    authenticated: true,
    environment: {},
  });
  expect(startup?.integrations).toEqual([
    {
      connectionId: 'studio',
      connectionName: 'Studio provider',
      userKey: { keyName: 'studio', encoding: 'apiKey', userProvideURL: false },
    },
  ]);
});
