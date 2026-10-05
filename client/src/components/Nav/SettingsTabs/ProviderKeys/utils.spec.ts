import { EModelEndpoint } from 'librechat-data-provider';
import type {
  TConfig,
  TModelSpec,
  TEndpointsConfig,
  MediaStartupConfig,
} from 'librechat-data-provider';
import { getProviderKeyEntries, getUserKeyEndpoints, isUserProvidedEndpointConfig } from './utils';

const cfg = (overrides: Partial<TConfig> = {}): TConfig => ({ order: 0, ...overrides });

const spec = (endpoint: string): TModelSpec => ({
  name: endpoint,
  label: endpoint,
  preset: { endpoint },
});

const endpointsConfig: TEndpointsConfig = {
  openAI: cfg({ userProvide: true }),
  anthropic: cfg({ userProvide: true }),
  google: cfg({ userProvide: false }),
  bedrock: cfg({ userProvideBearerToken: true }),
  [EModelEndpoint.agents]: cfg({ allowedProviders: ['anthropic'] }),
};

describe('isUserProvidedEndpointConfig', () => {
  it('returns false for nullish config', () => {
    expect(isUserProvidedEndpointConfig(null)).toBe(false);
    expect(isUserProvidedEndpointConfig(undefined)).toBe(false);
  });

  it('returns true for an API key endpoint', () => {
    expect(isUserProvidedEndpointConfig(cfg({ userProvide: true }))).toBe(true);
  });

  it('returns true for a Bedrock credential endpoint', () => {
    expect(isUserProvidedEndpointConfig(cfg({ userProvideSecretAccessKey: true }))).toBe(true);
  });

  it('returns false for a user-provided base URL alone', () => {
    expect(isUserProvidedEndpointConfig(cfg({ userProvideURL: true }))).toBe(false);
  });

  it('returns false when no credential is user-provided', () => {
    expect(isUserProvidedEndpointConfig(cfg())).toBe(false);
  });
});

describe('getUserKeyEndpoints', () => {
  it('returns an empty list when endpoints have not loaded', () => {
    expect(getUserKeyEndpoints({ endpointsConfig: undefined, hasAgentAccess: true })).toEqual([]);
  });

  it('lists every user-provided endpoint when no modelSpecs are configured', () => {
    expect(getUserKeyEndpoints({ endpointsConfig, hasAgentAccess: true })).toEqual([
      'openAI',
      'anthropic',
      'bedrock',
    ]);
  });

  it('limits to endpoints referenced by modelSpecs', () => {
    const result = getUserKeyEndpoints({
      endpointsConfig,
      modelSpecs: { list: [spec('openAI')] },
      hasAgentAccess: true,
    });
    expect(result).toEqual(['openAI']);
  });

  it('includes addedEndpoints alongside spec endpoints', () => {
    const result = getUserKeyEndpoints({
      endpointsConfig,
      modelSpecs: { list: [spec('openAI')], addedEndpoints: ['bedrock'] },
      hasAgentAccess: true,
    });
    expect(result).toEqual(['openAI', 'bedrock']);
  });

  it('expands a reachable agents endpoint to its allowedProviders', () => {
    const result = getUserKeyEndpoints({
      endpointsConfig,
      modelSpecs: { list: [spec('openAI')], addedEndpoints: [EModelEndpoint.agents] },
      hasAgentAccess: true,
    });
    expect(result).toEqual(['openAI', 'anthropic']);
  });

  it('expands a reachable agents endpoint with no allowedProviders to all providers', () => {
    const unrestricted: TEndpointsConfig = {
      ...endpointsConfig,
      [EModelEndpoint.agents]: cfg(),
    };
    const result = getUserKeyEndpoints({
      endpointsConfig: unrestricted,
      modelSpecs: { list: [spec('openAI')], addedEndpoints: [EModelEndpoint.agents] },
      hasAgentAccess: true,
    });
    expect(result).toEqual(['openAI', 'anthropic', 'bedrock']);
  });

  it('does not expand agent providers when the user lacks agent access', () => {
    const result = getUserKeyEndpoints({
      endpointsConfig,
      modelSpecs: { list: [spec('openAI')], addedEndpoints: [EModelEndpoint.agents] },
      hasAgentAccess: false,
    });
    expect(result).toEqual(['openAI']);
  });
});

type Integration = NonNullable<MediaStartupConfig['integrations']>[number];
const media = (
  keyName: string,
  overrides: Partial<NonNullable<Integration['userKey']>> = {},
): Integration => ({
  connectionId: 'images',
  connectionName: 'Media provider',
  userKey: { keyName, encoding: 'apiKey', userProvideURL: false, ...overrides },
});

describe('getProviderKeyEntries', () => {
  it('merges image and video connections by exact saved name and includes required URLs', () => {
    const entries = getProviderKeyEntries({
      chatEndpoints: [],
      mediaIntegrations: [
        media('My key / & ?'),
        {
          ...media('My key / & ?', { userProvideURL: true }),
          connectionId: 'videos',
          connectionName: 'Video provider',
        },
        {
          connectionId: 'managed',
          connectionName: 'Managed',
        },
      ],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      endpoint: 'My key / & ?',
      keyName: 'My key / & ?',
      label: 'Media provider',
      conflict: false,
      keyConfiguration: { keyName: 'My key / & ?', encoding: 'apiKey', userProvideURL: true },
    });
  });

  it('keeps case-distinct saved credentials separate', () => {
    expect(
      getProviderKeyEntries({
        chatEndpoints: [],
        mediaIntegrations: [media('Router'), media('router')],
      }).map((entry) => entry.keyName),
    ).toEqual(['Router', 'router']);
  });

  it('keeps a compatible custom chat editor when no URL is required', () => {
    expect(
      getProviderKeyEntries({
        chatEndpoints: ['Router'],
        endpointsConfig: {
          Router: cfg({ type: EModelEndpoint.custom, userProvide: true, keyEncoding: 'apiKey' }),
        },
        mediaIntegrations: [media('Router')],
      }),
    ).toEqual([{ endpoint: 'Router', keyName: 'Router', label: 'Router', conflict: false }]);
  });

  it('adds a URL field when only Media requires one for a shared chat credential', () => {
    expect(
      getProviderKeyEntries({
        chatEndpoints: ['Router'],
        endpointsConfig: {
          Router: cfg({ type: EModelEndpoint.custom, userProvide: true, keyEncoding: 'apiKey' }),
        },
        mediaIntegrations: [media('Router', { userProvideURL: true })],
      })[0],
    ).toMatchObject({
      keyName: 'Router',
      conflict: false,
      keyConfiguration: { keyName: 'Router', encoding: 'apiKey', userProvideURL: true },
    });
  });

  it.each(['openAI', 'assistants', 'google'])(
    'requires the shared URL instead of the legacy optional URL form for %s',
    (endpoint) => {
      const encoding = endpoint === 'google' ? 'google' : 'apiKey';
      expect(
        getProviderKeyEntries({
          chatEndpoints: [endpoint],
          endpointsConfig: {
            [endpoint]: cfg({ userProvide: true, userProvideURL: true, keyEncoding: encoding }),
          },
          mediaIntegrations: [media(endpoint, { encoding })],
        })[0],
      ).toMatchObject({
        keyName: endpoint,
        conflict: false,
        keyConfiguration: { keyName: endpoint, encoding, userProvideURL: true },
      });
    },
  );

  it('preserves the existing Google chat editor for a shared Google credential', () => {
    const entries = getProviderKeyEntries({
      chatEndpoints: ['google'],
      endpointsConfig: { google: cfg({ userProvide: true, keyEncoding: 'google' }) },
      mediaIntegrations: [media('google', { encoding: 'google' })],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].conflict).toBe(false);
    expect(entries[0].keyConfiguration).toBeUndefined();
  });

  it.each(['unknown', 'azureOpenAI', 'bedrock'])(
    'blocks incompatible %s chat envelopes',
    (endpoint) => {
      const entries = getProviderKeyEntries({
        chatEndpoints: [endpoint],
        endpointsConfig: { [endpoint]: cfg({ userProvide: true }) },
        mediaIntegrations: [media(endpoint)],
      });
      expect(entries).toHaveLength(1);
      expect(entries[0].conflict).toBe(true);
    },
  );

  it('blocks conflicting Media encodings even without a chat endpoint', () => {
    expect(
      getProviderKeyEntries({
        chatEndpoints: [],
        mediaIntegrations: [media('shared'), media('shared', { encoding: 'google' })],
      })[0].conflict,
    ).toBe(true);
  });

  it('uses the actual Azure saved name when chat aliases share it', () => {
    const entries = getProviderKeyEntries({
      chatEndpoints: ['azureOpenAI', 'azureAssistants'],
      endpointsConfig: {
        azureOpenAI: cfg({ userProvide: true, azure: true }),
        azureAssistants: cfg({ userProvide: true, azure: true }),
      },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].keyName).toBe('azureOpenAI');
  });

  it('preserves chat entries when Media is unavailable', () => {
    expect(
      getProviderKeyEntries({ chatEndpoints: ['openAI', 'anthropic'] }).map(
        (entry) => entry.keyName,
      ),
    ).toEqual(['openAI', 'anthropic']);
  });
});
