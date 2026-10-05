import { EModelEndpoint, FileSources, resolveMediaConfig } from 'librechat-data-provider';
import type { MediaIntegration } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import { createRESTMediaAdapters } from '../adapters/rest';
import { createMediaCredentialResolver } from './index';
import { createMediaCatalog } from '../catalog';
import { MediaServiceError } from '../errors';

const scope = { ownerId: 'owner-one', tenantId: 'tenant-one' };
const direct = (
  endpointRef: Extract<MediaIntegration['endpointRef'], { kind: 'direct' }>,
): MediaIntegration => ({
  id: 'native-images',
  api: 'bfl.images',
  endpointRef,
  catalog: { kind: 'configured', models: ['black-forest-labs/flux.2-pro'] },
  operations: ['image.generate'],
});
const appConfig: AppConfig = {
  config: {},
  fileStrategy: FileSources.local,
  imageOutputType: 'png',
};
const request = (integration: MediaIntegration, config = appConfig) => ({
  scope,
  integration,
  appConfig: config,
  minValidityMs: 1000,
});
function fixture(options: Partial<Parameters<typeof createMediaCredentialResolver>[0]> = {}) {
  const repository = {
    getUserKeySnapshot: jest.fn(async (_input: unknown) => ({
      value: JSON.stringify({ apiKey: 'saved-user-key', baseURL: 'https://user.example/v1' }),
      expiresAt: null as string | null,
      id: 'revision-one',
    })),
  };
  const resolve = createMediaCredentialResolver({
    environment: {},
    repository,
    decrypt: async (value) => value,
    now: () => 0,
    adapters: createRESTMediaAdapters(),
    ...options,
  });
  return { resolve, repository };
}

describe('Media provider key setup matches chat credential storage', () => {
  const google: MediaIntegration = {
    id: 'google-images',
    api: 'google.generateContent',
    endpointRef: { kind: 'builtin', endpoint: EModelEndpoint.google },
    catalog: { kind: 'configured', models: ['gemini-2.5-flash-image'] },
    operations: ['image.generate'],
  };

  it('uses the documented Google key precedence and distinguishes a saved service account', async () => {
    const deployed = fixture({
      environment: { GOOGLE_KEY: 'chat-key', GEMINI_API_KEY: 'tool-key' },
    });
    expect((await deployed.resolve(request(google))).headers['x-goog-api-key']).toBe('chat-key');
    expect(deployed.repository.getUserKeySnapshot).not.toHaveBeenCalled();
    const fallback = fixture({ environment: { GEMINI_API_KEY: 'tool-key' } });
    expect((await fallback.resolve(request(google))).headers['x-goog-api-key']).toBe('tool-key');
    const saved = fixture({
      environment: { GOOGLE_KEY: 'user_provided', GEMINI_API_KEY: 'tool-key' },
    });
    saved.repository.getUserKeySnapshot.mockResolvedValue({
      id: 'service',
      expiresAt: null,
      value: JSON.stringify({
        GOOGLE_SERVICE_KEY: { client_email: 'user@example.test', private_key: 'never-return' },
      }),
    });
    await expect(saved.resolve(request(google))).rejects.toMatchObject({
      code: 'gemini_key_required',
    });
    expect(saved.resolve.describe(request(google))?.encoding).toBe('google');
  });

  it.each([
    [{ GOOGLE_CLOUD_LOCATION: 'europe-west1', GOOGLE_LOC: 'us-east1' }, 'europe-west1'],
    [{ GOOGLE_LOC: 'global' }, 'global'],
    [{}, 'us-central1'],
  ])('inherits the Google location configuration %j', async (environment, location) => {
    const vertexCredentials = jest.fn(async () => ({
      projectId: 'vertex-project',
      accessToken: 'token',
      revision: 'principal',
    }));
    const { resolve } = fixture({ environment, vertexCredentials });
    const connection = await resolve(request({ ...google, endpointRef: { kind: 'vertex' } }));
    expect(connection.baseURL).toContain(`/locations/${location}/`);
    expect(new URL(connection.baseURL).hostname).toBe(
      location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`,
    );
  });

  it('exposes only safe setup fields and does not read saved keys while describing configuration', () => {
    const { resolve, repository } = fixture({ environment: { NATIVE_KEY: 'user_provided' } });
    const input = request(
      direct({
        kind: 'direct',
        apiKey: '${NATIVE_KEY}',
        credentialName: 'My Native Account',
        headers: { 'X-Private': 'admin-secret' },
      }),
    );
    expect(resolve.describe(input)).toEqual({
      keyName: 'My Native Account',
      encoding: 'apiKey',
      userProvideURL: false,
    });
    expect(repository.getUserKeySnapshot).not.toHaveBeenCalled();
    expect(JSON.stringify(resolve.describe(input))).not.toContain('admin-secret');
  });

  it.each(['${MISSING_KEY}', 'server-managed-key'])(
    'does not offer user override for %s',
    (apiKey) => {
      const { resolve } = fixture();
      expect(resolve.describe(request(direct({ kind: 'direct', apiKey })))).toBeUndefined();
    },
  );

  it('uses the integration ID by default and retains setup when separate Sourceful configuration is missing', async () => {
    const { resolve, repository } = fixture();
    const integration = {
      ...direct({ kind: 'direct', apiKey: 'user_provided' }),
      api: 'sourceful.images' as const,
    };
    expect(resolve.describe(request(integration))).toEqual({
      keyName: 'native-images',
      encoding: 'apiKey',
      userProvideURL: false,
    });
    await expect(resolve(request(integration))).rejects.toMatchObject({ code: 'not_ready' });
    expect(repository.getUserKeySnapshot).not.toHaveBeenCalled();
  });

  it('preserves case-distinct custom key names and only normalizes Ollama', async () => {
    const { resolve } = fixture();
    const config = {
      ...appConfig,
      endpoints: {
        custom: [
          { name: 'Router', apiKey: 'user_provided', baseURL: 'https://one.example/v1' },
          { name: 'router', apiKey: 'user_provided', baseURL: 'https://two.example/v1' },
          { name: 'Ollama', apiKey: 'user_provided', baseURL: 'https://three.example/v1' },
        ],
      },
    };
    const custom = (name: string) => ({
      ...direct({ kind: 'direct', apiKey: '' }),
      endpointRef: { kind: 'custom' as const, name },
    });
    expect(resolve.describe(request(custom('Router'), config))?.keyName).toBe('Router');
    expect(resolve.describe(request(custom('router'), config))?.keyName).toBe('router');
    expect(resolve.describe(request(custom('OLLAMA'), config))?.keyName).toBe('ollama');
    await expect(resolve(request(custom('ROUTER'), config))).rejects.toMatchObject({
      code: 'not_ready',
    });
    const single = { ...config, endpoints: { custom: config.endpoints.custom.slice(0, 1) } };
    expect(resolve.describe(request(custom('ROUTER'), single))?.keyName).toBe('Router');
  });

  it('allows shared key slots with different URL expectations and ignores the saved URL for fixed roots', async () => {
    const { resolve } = fixture();
    const fixed = direct({ kind: 'direct', apiKey: 'user_provided', credentialName: 'shared' });
    const editable = {
      ...direct({
        kind: 'direct',
        apiKey: 'user_provided',
        credentialName: 'shared',
        baseURL: 'user_provided',
      }),
      id: 'editable',
    };
    const config = { ...appConfig, media: resolveMediaConfig({ integrations: [fixed, editable] }) };
    expect(resolve.describe(request(fixed, config))?.userProvideURL).toBe(false);
    expect(resolve.describe(request(editable, config))?.userProvideURL).toBe(true);
    expect((await resolve(request(fixed, config))).baseURL).toBe('https://api.bfl.ai/v1');
    expect((await resolve(request(editable, config))).baseURL).toBe('https://user.example/v1');
  });

  it('rejects incompatible credential encodings for the shared Google chat slot', async () => {
    const { resolve, repository } = fixture();
    const input = request(
      direct({ kind: 'direct', apiKey: 'user_provided', credentialName: 'google' }),
    );
    expect(() => resolve.describe(input)).toThrow();
    await expect(resolve(input)).rejects.toMatchObject({ code: 'not_ready' });
    expect(repository.getUserKeySnapshot).not.toHaveBeenCalled();
  });

  it('ignores disabled media slots when checking active credential format conflicts', () => {
    const { resolve } = fixture({ environment: { GOOGLE_KEY: 'user_provided' } });
    const google: MediaIntegration = {
      id: 'google-images',
      api: 'google.generateContent',
      endpointRef: { kind: 'builtin', endpoint: EModelEndpoint.google },
      catalog: { kind: 'configured', models: ['gemini-2.5-flash-image'] },
      operations: ['image.generate'],
    };
    const incompatible = {
      ...direct({ kind: 'direct', apiKey: 'user_provided', credentialName: 'google' }),
      enabled: false,
    };
    const config = {
      ...appConfig,
      media: resolveMediaConfig({ integrations: [google, incompatible] }),
    };
    expect(resolve.describe(request(google, config))).toEqual({
      keyName: 'google',
      encoding: 'google',
      userProvideURL: false,
    });
    config.media.integrations[1].enabled = true;
    expect(() => resolve.describe(request(google, config))).toThrow();
  });

  it.each(['bedrock', 'azureOpenAI', 'azureAssistants', 'anthropic'])(
    'preserves the incompatible chat credential slot %s',
    async (credentialName) => {
      const { resolve, repository } = fixture();
      const input = request(direct({ kind: 'direct', apiKey: 'user_provided', credentialName }));
      expect(() => resolve.describe(input)).toThrow();
      await expect(resolve(input)).rejects.toMatchObject({ code: 'not_ready' });
      expect(repository.getUserKeySnapshot).not.toHaveBeenCalled();
    },
  );

  it('uses only user-owned credentials and protocol headers at a user-selected native URL', async () => {
    const { resolve } = fixture();
    const integration = {
      ...direct({
        kind: 'direct',
        apiKey: 'deployment-key',
        baseURL: 'user_provided',
        headers: { Authorization: 'deployment-authorization', 'X-Credential': 'deployment-header' },
      }),
      api: 'runway.videos' as const,
    };
    const connection = await resolve(request(integration));
    expect(connection.headers).toEqual({
      Authorization: 'Bearer saved-user-key',
      'X-Runway-Version': '2024-11-06',
    });
    expect(connection.baseURL).toBe('https://user.example/v1');
    expect(JSON.stringify(connection)).not.toMatch(
      /deployment-key|deployment-authorization|deployment-header/,
    );
  });

  it('requires a user key even when the selected URL is the only user_provided field', async () => {
    const repository = {
      getUserKeySnapshot: jest.fn(async () => ({
        value: JSON.stringify({ baseURL: 'https://user.example' }),
        expiresAt: null,
        id: 'one',
      })),
    };
    const { resolve } = fixture({ repository });
    await expect(
      resolve(
        request(direct({ kind: 'direct', apiKey: 'deployment-key', baseURL: 'user_provided' })),
      ),
    ).rejects.toMatchObject({ code: 'credentials_required' });
  });

  it('fails closed instead of forwarding arbitrary configured options to a user URL', async () => {
    const { resolve, repository } = fixture();
    const input = request(
      direct({
        kind: 'direct',
        apiKey: 'user_provided',
        baseURL: 'user_provided',
        options: { deployments: { 'gpt-image-1': 'production-image' } },
      }),
    );
    input.integration.api = 'openai.images';
    expect(resolve.describe(input)?.userProvideURL).toBe(true);
    await expect(resolve(input)).rejects.toMatchObject({ code: 'not_ready' });
    expect(repository.getUserKeySnapshot).not.toHaveBeenCalled();
  });

  it('resolves admin-encrypted custom keys through the injected decoder without decrypting setup metadata', async () => {
    const encrypted = `v3:${'a'.repeat(32)}:1234abcd`;
    const resolveConfigSecret = jest.fn(() => 'decrypted-server-key');
    const { resolve, repository } = fixture({ resolveConfigSecret });
    const config = {
      ...appConfig,
      endpoints: {
        custom: [{ name: 'Router', apiKey: encrypted, baseURL: 'https://router.example/v1' }],
      },
    };
    const input = request(
      {
        ...direct({ kind: 'direct', apiKey: '' }),
        endpointRef: { kind: 'custom', name: 'Router' },
      },
      config,
    );
    expect(resolve.describe(input)).toBeUndefined();
    expect(resolveConfigSecret).not.toHaveBeenCalled();
    expect((await resolve(input)).headers).toEqual({ 'x-key': 'decrypted-server-key' });
    expect(resolveConfigSecret).toHaveBeenCalledWith(encrypted);
    expect(repository.getUserKeySnapshot).not.toHaveBeenCalled();
    expect(config.endpoints.custom[0].apiKey).toBe(encrypted);
    await expect(fixture().resolve(input)).rejects.toMatchObject({ code: 'not_ready' });
  });

  it('preserves literal v3-prefixed keys that are not admin encryption envelopes', async () => {
    const { resolve } = fixture();
    const config = {
      ...appConfig,
      endpoints: {
        custom: [
          { name: 'Router', apiKey: 'v3:literal-key', baseURL: 'https://router.example/v1' },
        ],
      },
    };
    const input = request(
      {
        ...direct({ kind: 'direct', apiKey: '' }),
        endpointRef: { kind: 'custom', name: 'Router' },
      },
      config,
    );
    expect((await resolve(input)).headers).toEqual({ 'x-key': 'v3:literal-key' });
  });

  it('uses the shared owner-scoped snapshot reader and never expands a saved user key as server configuration', async () => {
    const { resolve, repository } = fixture({ environment: { SERVER_SECRET: 'must-not-expand' } });
    repository.getUserKeySnapshot.mockResolvedValue({
      value: JSON.stringify({ apiKey: '${SERVER_SECRET}' }),
      expiresAt: null,
      id: 'same',
    });
    const input = request(direct({ kind: 'direct', apiKey: 'user_provided' }));
    const first = await resolve(input);
    const second = await resolve({
      ...input,
      scope: { ownerId: 'owner-two', tenantId: 'tenant-two' },
    });
    expect(repository.getUserKeySnapshot.mock.calls).toEqual([
      [{ userId: scope.ownerId, tenantId: scope.tenantId, name: 'native-images' }],
      [{ userId: 'owner-two', tenantId: 'tenant-two', name: 'native-images' }],
    ]);
    expect(first.headers).toEqual({ 'x-key': '${SERVER_SECRET}' });
    expect(second.binding).not.toBe(first.binding);
  });

  it('checks expiry on each resolution before decrypting and reacts immediately to key revocation', async () => {
    let saved: { value: string; expiresAt: string | null; id: string } | null = {
      value: '{}',
      expiresAt: new Date(500).toISOString(),
      id: 'one',
    };
    const decrypt = jest.fn(async (value) => value as string);
    const { resolve } = fixture({
      decrypt,
      repository: { getUserKeySnapshot: async () => saved },
    });
    const input = request(direct({ kind: 'direct', apiKey: 'user_provided' }));
    await expect(resolve(input)).rejects.toMatchObject({ code: 'credentials_expired' });
    expect(decrypt).not.toHaveBeenCalled();
    saved = { value: JSON.stringify({ apiKey: 'saved' }), expiresAt: null, id: 'two' };
    await expect(resolve(input)).resolves.toMatchObject({ headers: { 'x-key': 'saved' } });
    saved = null;
    await expect(resolve(input)).rejects.toMatchObject({ code: 'credentials_required' });
  });

  it('accepts the existing Google API-key envelope with URL while excluding service-account fields', async () => {
    const { resolve, repository } = fixture({
      environment: { GOOGLE_KEY: 'deployment-key', GOOGLE_REVERSE_PROXY: 'user_provided' },
    });
    repository.getUserKeySnapshot.mockResolvedValue({
      value: JSON.stringify({
        GOOGLE_API_KEY: 'google-user-key',
        GOOGLE_SERVICE_KEY: JSON.stringify({ private_key: 'never-a-header' }),
        baseURL: 'https://user.example/v1',
      }),
      expiresAt: null,
      id: 'one',
    });
    const input = request({
      ...direct({ kind: 'direct', apiKey: '' }),
      api: 'google.generateContent',
      endpointRef: { kind: 'builtin', endpoint: EModelEndpoint.google },
    });
    expect(resolve.describe(input)).toEqual({
      keyName: 'google',
      encoding: 'google',
      userProvideURL: true,
    });
    expect((await resolve(input)).headers).toEqual({ 'x-goog-api-key': 'google-user-key' });
    repository.getUserKeySnapshot.mockResolvedValue({
      value: JSON.stringify({ GOOGLE_SERVICE_KEY: 'never-a-header' }),
      expiresAt: null,
      id: 'two',
    });
    await expect(resolve(input)).rejects.toMatchObject({ code: 'gemini_key_required' });
  });

  it.each(['credentials_required', 'credentials_expired'] as const)(
    'keeps %s and setup metadata when OpenRouter discovery has no model rows',
    async (code) => {
      const config = resolveMediaConfig({
        integrations: [
          {
            id: 'router',
            api: 'openrouter.images',
            endpointRef: { kind: 'custom', name: 'Router' },
            catalog: { kind: 'discovered', allModels: true },
            operations: ['image.generate'],
          },
        ],
      });
      const catalog = createMediaCatalog({
        adapters: createRESTMediaAdapters(),
        now: () => 0,
        transport: { json: jest.fn(), stream: jest.fn() },
      });
      const resolve = async () => {
        throw new MediaServiceError(code, 403, 'Saved key unavailable');
      };
      const first = await catalog.read(
        config,
        resolve,
        { ownerId: 'owner', tenantId: null },
        () => ({
          keyName: 'Router',
          encoding: 'apiKey',
          userProvideURL: false,
        }),
      );
      expect(first.catalog.offerings).toEqual([]);
      expect(first.catalog.integrations?.[0]).toMatchObject({
        unavailableReason: code,
        userKey: { keyName: 'Router', encoding: 'apiKey', userProvideURL: false },
      });
      const changed = await catalog.read(
        config,
        resolve,
        { ownerId: 'owner', tenantId: null },
        () => ({
          keyName: 'Router',
          encoding: 'apiKey',
          userProvideURL: true,
        }),
      );
      expect(changed.catalog.version).not.toBe(first.catalog.version);
    },
  );
  it.each(['${JWT_SECRET}', '${MISSING}'])(
    'refuses unresolved or sensitive configuration references: %s',
    async (reference) => {
      const { resolve } = fixture({ environment: { JWT_SECRET: 'never-expose' } });
      for (const endpointRef of [
        { kind: 'direct' as const, apiKey: reference },
        { kind: 'direct' as const, apiKey: 'key', baseURL: `https://example.com/${reference}` },
        { kind: 'direct' as const, apiKey: 'key', headers: { 'X-Secret': reference } },
        { kind: 'direct' as const, apiKey: 'key', options: { brandId: reference } },
      ]) {
        await expect(resolve(request(direct(endpointRef)))).rejects.toMatchObject({
          code: 'not_ready',
        });
      }
    },
  );
  it.each(['http://redis:6379', 'https://x.internal'])(
    'refuses restricted user API roots: %s',
    async (baseURL) => {
      const { resolve, repository } = fixture();
      repository.getUserKeySnapshot.mockResolvedValue({
        id: 'key',
        value: JSON.stringify({ apiKey: 'saved', baseURL }),
        expiresAt: null,
      });
      await expect(
        resolve(
          request(direct({ kind: 'direct', apiKey: 'user_provided', baseURL: 'user_provided' })),
        ),
      ).rejects.toMatchObject({ code: 'not_ready' });
    },
  );
});
