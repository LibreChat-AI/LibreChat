import { EModelEndpoint, FileSources } from 'librechat-data-provider';
import type { AppConfig, KeyMethods } from '@librechat/data-schemas';
import type { MediaIntegration } from 'librechat-data-provider';
import type { MediaEnvironment } from './index';
import { createRESTMediaAdapters } from '../adapters/rest';
import { createMediaCredentialResolver } from './index';
import { isMediaConnectionBinding } from '../provider';

describe('Direct provider credentials', () => {
  const environment: MediaEnvironment = { BFL_KEY: 'test-secret', BRAND: 'brand-test' };
  const request = {
    scope: { ownerId: 'owner', tenantId: 'tenant' },
    integration: {
      id: 'bfl',
      api: 'bfl.images',
      endpointRef: { kind: 'direct', apiKey: '${BFL_KEY}' },
      catalog: { kind: 'configured', models: ['black-forest-labs/flux.2-pro'] },
      operations: ['image.generate'],
    } satisfies MediaIntegration,
    appConfig: {
      config: {},
      fileStrategy: FileSources.local,
      imageOutputType: 'png',
    } satisfies AppConfig,
    minValidityMs: 100,
  };
  const repository: Pick<KeyMethods, 'getUserKeySnapshot'> = {
    getUserKeySnapshot: async () => null,
  };
  const resolver = () =>
    createMediaCredentialResolver({
      environment: { ...environment },
      repository,
      adapters: createRESTMediaAdapters(),
      decrypt: async (value) => value,
      now: () => 0,
    });

  it('uses each provider authentication contract and does not leak secrets through bindings', async () => {
    const connection = await resolver()(request);
    expect(connection.headers).toEqual({ 'x-key': 'test-secret' });
    expect(connection.baseURL).toBe('https://api.bfl.ai/v1');
    expect(connection.binding).toMatch(/^[a-f0-9]{64}$/);
  });

  it('binds endpoint options and added headers so changing either invalidates queued work', async () => {
    const resolve = resolver();
    const input = {
      ...request,
      integration: { ...request.integration, api: 'openai.images' as const },
    };
    const first = await resolve(input);
    const changed = await resolve({
      ...input,
      integration: {
        ...input.integration,
        endpointRef: {
          ...request.integration.endpointRef,
          options: { deployments: { 'gpt-image-1': '${BRAND}' } },
          headers: { 'X-Project': '${BRAND}' },
        },
      },
    });
    expect(changed.options).toEqual({ deployments: { 'gpt-image-1': 'brand-test' } });
    expect(changed.headers).toEqual({
      'X-Project': 'brand-test',
      Authorization: 'Bearer test-secret',
    });
    expect(changed.binding).not.toBe(first.binding);
  });

  it.each(['Host', 'Content-Length', 'Connection', 'Transfer-Encoding'])(
    'rejects configured transport header %s',
    async (name) => {
      await expect(
        resolver()({
          ...request,
          integration: {
            ...request.integration,
            endpointRef: { ...request.integration.endpointRef, headers: { [name]: 'invalid' } },
          },
        }),
      ).rejects.toMatchObject({ code: 'not_ready' });
    },
  );

  it('rejects header injection and missing deployment credentials', async () => {
    await expect(
      resolver()({
        ...request,
        integration: {
          ...request.integration,
          endpointRef: { ...request.integration.endpointRef, headers: { 'X-Project': 'a\r\nb' } },
        },
      }),
    ).rejects.toMatchObject({ code: 'not_ready' });
    await expect(
      resolver()({
        ...request,
        integration: {
          ...request.integration,
          endpointRef: { kind: 'direct', apiKey: '${MISSING_KEY}' },
        },
      }),
    ).rejects.toMatchObject({ code: 'not_ready' });
  });

  it('requires Sourceful brand configuration before dispatch', async () => {
    await expect(
      resolver()({ ...request, integration: { ...request.integration, api: 'sourceful.images' } }),
    ).rejects.toMatchObject({ code: 'not_ready' });
  });

  it('uses scoped saved credentials with explicit direct credentialName', async () => {
    const lookup = jest.spyOn(repository, 'getUserKeySnapshot').mockResolvedValue({
      value: JSON.stringify({ apiKey: 'user-bfl-key' }),
      expiresAt: null,
      id: 'revision',
    });
    const connection = await resolver()({
      ...request,
      integration: {
        ...request.integration,
        endpointRef: { kind: 'direct', apiKey: 'user_provided', credentialName: 'bfl-user' },
      },
    });
    expect(lookup).toHaveBeenCalledWith({
      userId: request.scope.ownerId,
      tenantId: request.scope.tenantId,
      name: 'bfl-user',
    });
    expect(connection.headers).toEqual({ 'x-key': 'user-bfl-key' });
  });
});

describe('Google media credentials', () => {
  const integration: MediaIntegration = {
    id: 'google-images',
    api: 'google.generateContent',
    endpointRef: { kind: 'builtin', endpoint: EModelEndpoint.google },
    catalog: { kind: 'configured', models: ['gemini-3.1-flash-image'] },
    operations: ['image.generate', 'image.edit'],
  };
  const request = {
    scope: { ownerId: 'owner', tenantId: 'tenant' },
    integration,
    appConfig: {
      config: {},
      fileStrategy: FileSources.local,
      imageOutputType: 'png',
    } satisfies AppConfig,
    minValidityMs: 0,
  };
  const repository: Pick<KeyMethods, 'getUserKeySnapshot'> = {
    getUserKeySnapshot: async () => null,
  };
  const resolver = (environment: MediaEnvironment) =>
    createMediaCredentialResolver({
      environment,
      repository,
      decrypt: async (value) => value,
      now: () => 0,
    });

  it.each([undefined, ''])('uses the Gemini key when GOOGLE_KEY is %p', async (googleKey) => {
    const lookup = jest.spyOn(repository, 'getUserKeySnapshot');
    const environment = { GOOGLE_KEY: googleKey, GEMINI_API_KEY: 'gemini-deployment-key' };
    const connection = await resolver(environment)(request);

    expect(connection.headers).toEqual({ 'x-goog-api-key': 'gemini-deployment-key' });
    expect(connection.baseURL).toBe('https://generativelanguage.googleapis.com/v1beta');
    expect(lookup).not.toHaveBeenCalled();
    expect(environment.GOOGLE_KEY).toBe(googleKey);
  });

  it('preserves the configured Google key and its binding when the unused Gemini key changes', async () => {
    const environment = { GOOGLE_KEY: 'google-deployment-key', GEMINI_API_KEY: 'gemini-first' };
    const resolve = resolver(environment);
    const first = await resolve(request);
    environment.GEMINI_API_KEY = 'gemini-rotated';
    const second = await resolve(request);

    expect(second.headers).toEqual({ 'x-goog-api-key': 'google-deployment-key' });
    expect(second.binding).toBe(first.binding);
  });

  it('invalidates the credential binding when the active Gemini key rotates', async () => {
    const environment = { GEMINI_API_KEY: 'gemini-first' };
    const resolve = resolver(environment);
    const first = await resolve(request);
    environment.GEMINI_API_KEY = 'gemini-rotated';

    expect((await resolve(request)).binding).not.toBe(first.binding);
  });

  it('keeps user-provided credentials scoped to the user instead of using a deployment fallback', async () => {
    const lookup = jest.spyOn(repository, 'getUserKeySnapshot').mockResolvedValue({
      value: 'user-google-key',
      expiresAt: null,
      id: 'user-key-revision',
    });
    const connection = await resolver({
      GOOGLE_KEY: 'user_provided',
      GEMINI_API_KEY: 'gemini-deployment-key',
    })(request);

    expect(connection.headers).toEqual({ 'x-goog-api-key': 'user-google-key' });
    expect(lookup).toHaveBeenCalledWith({
      userId: request.scope.ownerId,
      tenantId: request.scope.tenantId,
      name: 'google',
    });
  });

  it('requires the user credential even when a Gemini deployment key is configured', async () => {
    await expect(
      resolver({ GOOGLE_KEY: 'user_provided', GEMINI_API_KEY: 'gemini-deployment-key' })(request),
    ).rejects.toMatchObject({ code: 'credentials_required' });
  });

  it('requires a key when neither environment variable is configured', async () => {
    await expect(resolver({})(request)).rejects.toMatchObject({ code: 'gemini_key_required' });
  });

  it('reuses global and endpoint headers with current identity and provider-managed authorization', async () => {
    const connection = await resolver({
      GOOGLE_KEY: '${LITERAL_API_SECRET}',
      GOOGLE_AUTH_HEADER: 'true',
    })({
      ...request,
      user: { name: 'Media user' },
      appConfig: {
        ...request.appConfig,
        endpoints: {
          all: {
            headers: {
              'X-Global': 'global',
              'X-User': '{{LIBRECHAT_USER_ID}}',
              'X-Tenant': '{{LIBRECHAT_USER_TENANT_ID}}',
              authorization: 'untrusted',
            },
          },
          google: { headers: { 'x-global': 'google', 'X-Name': '{{LIBRECHAT_USER_NAME}}' } },
        },
      },
    });
    expect(connection.headers).toEqual({
      'x-global': 'google',
      'X-User': 'owner',
      'X-Tenant': 'tenant',
      'X-Name': 'Media user',
      'x-goog-api-key': '${LITERAL_API_SECRET}',
      Authorization: 'Bearer ${LITERAL_API_SECRET}',
    });
  });

  it('keeps bindings stable across expiry, envelope metadata, and user profile changes', async () => {
    const initial = {
      id: 'saved-key-row',
      value: 'user-google-key',
      expiresAt: '2099-01-01T00:00:00.000Z',
    };
    const lookup = jest.spyOn(repository, 'getUserKeySnapshot').mockResolvedValue(initial);
    const resolve = resolver({ GOOGLE_KEY: 'user_provided' });
    const input = {
      ...request,
      appConfig: {
        ...request.appConfig,
        endpoints: {
          all: {
            headers: { 'X-Name': '{{LIBRECHAT_USER_NAME}}', 'X-Email': '{{LIBRECHAT_USER_EMAIL}}' },
          },
        },
      },
    };
    const first = await resolve({
      ...input,
      user: { name: 'Before', email: 'before@example.com' },
    });
    lookup.mockResolvedValue({
      ...initial,
      expiresAt: null,
      value: JSON.stringify({
        GOOGLE_API_KEY: 'user-google-key',
        GOOGLE_SERVICE_KEY: { project_id: 'unrelated' },
      }),
    });
    const refreshed = await resolve({
      ...input,
      user: { name: 'After', email: 'after@example.com' },
    });
    expect(refreshed.binding).toBe(first.binding);
    expect(refreshed.headers['X-Name']).toBe('After');
    expect(refreshed.headers['X-Email']).toBe('after@example.com');
    lookup.mockResolvedValue({ ...initial, value: 'rotated-key' });
    expect(isMediaConnectionBinding(await resolve(input), first.binding)).toBe(false);
    lookup.mockResolvedValue({ ...initial, id: 'new-row-after-revocation' });
    expect(isMediaConnectionBinding(await resolve(input), first.binding)).toBe(false);
    lookup.mockResolvedValue(null);
    await expect(resolve(input)).rejects.toMatchObject({ code: 'credentials_required' });
  });
});

describe('Vertex media connections', () => {
  const integration: MediaIntegration = {
    id: 'vertex-videos',
    api: 'google.vertex.videos',
    endpointRef: { kind: 'vertex', keyFile: '${GOOGLE_SERVICE_KEY_FILE}', location: 'us-central1' },
    catalog: { kind: 'configured', models: ['veo-3.1-fast-generate-001'] },
    operations: ['video.generate'],
  };
  const request = {
    scope: { ownerId: 'owner', tenantId: 'tenant' },
    integration,
    appConfig: {
      config: {},
      fileStrategy: FileSources.local,
      imageOutputType: 'png',
    } satisfies AppConfig,
    minValidityMs: 60_000,
  };
  function fixture() {
    let token = 'access-1';
    let revision = 'service-account-key-1';
    const boundary = {
      vertexCredentials: async () => ({ projectId: 'test-project', accessToken: token, revision }),
      getUserKeySnapshot: async () => null,
    };
    const resolve = createMediaCredentialResolver({
      environment: {
        GOOGLE_SERVICE_KEY_FILE: '/config/auth.json',
        GOOGLE_KEY: 'api-key',
        GEMINI_API_KEY: 'gemini-key',
      },
      repository: boundary,
      vertexCredentials: boundary.vertexCredentials,
      decrypt: async (value) => value,
      now: () => 0,
    });
    return {
      boundary,
      resolve,
      refresh: () => {
        token = 'access-2';
      },
      rotate: () => {
        revision = 'service-account-key-2';
      },
    };
  }

  it('uses the explicit service account instead of any configured API key', async () => {
    const { resolve, boundary } = fixture();
    const lookup = jest.spyOn(boundary, 'getUserKeySnapshot');
    const connection = await resolve(request);
    expect(connection.headers).toEqual({ Authorization: 'Bearer access-1' });
    expect(connection.baseURL).toBe(
      'https://us-central1-aiplatform.googleapis.com/v1/projects/test-project/locations/us-central1/publishers/google/',
    );
    expect(lookup).not.toHaveBeenCalled();
  });

  it('keeps the binding across access-token refresh and changes it on key rotation', async () => {
    const { resolve, refresh, rotate } = fixture();
    const first = await resolve(request);
    refresh();
    const second = await resolve(request);
    expect(second.headers).not.toEqual(first.headers);
    expect(second.binding).toBe(first.binding);
    rotate();
    expect((await resolve(request)).binding).not.toBe(first.binding);
  });

  it('scopes the binding and URL to the configured location', async () => {
    const { resolve } = fixture();
    const first = await resolve(request);
    const changed = await resolve({
      ...request,
      integration: {
        ...integration,
        endpointRef: { kind: 'vertex', keyFile: '/config/auth.json', location: 'global' },
      },
    });
    expect(changed.binding).not.toBe(first.binding);
    expect(changed.baseURL).toContain('https://aiplatform.googleapis.com/');
    expect(changed.baseURL).toContain('/locations/global/');
  });

  it('passes resolved file paths, configured timeouts, and dispatch validity to the auth boundary', async () => {
    const boundary = {
      resolve: async () => ({ projectId: 'test-project', accessToken: 'token', revision: 'key' }),
    };
    const auth = jest.spyOn(boundary, 'resolve');
    const resolve = createMediaCredentialResolver({
      environment: { GOOGLE_SERVICE_KEY_FILE: '/config/auth.json' },
      repository: { getUserKeySnapshot: async () => null },
      decrypt: async (value) => value,
      now: () => 0,
      vertexCredentials: boundary.resolve,
    });
    await resolve(request);
    expect(auth).toHaveBeenCalledWith({
      keyFile: '/config/auth.json',
      projectId: undefined,
      minValidityMs: 60_000,
      timeoutMs: 10_000,
    });
  });

  it('does not silently use Gemini when Vertex authentication is unavailable', async () => {
    const resolve = createMediaCredentialResolver({
      environment: { GEMINI_API_KEY: 'gemini-key' },
      repository: { getUserKeySnapshot: async () => null },
      decrypt: async (value) => value,
      now: () => 0,
    });
    await expect(resolve(request)).rejects.toMatchObject({ code: 'not_ready' });
  });
});
