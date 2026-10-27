import { AuthKeys } from 'librechat-data-provider';
import {
  createAnthropicVertexClient,
  loadAnthropicVertexCredentials,
  getVertexCredentialOptions,
  VERTEX_GATEWAY_PLACEHOLDER_PROJECT,
} from './vertex';

describe('createAnthropicVertexClient', () => {
  const credentials = {
    [AuthKeys.GOOGLE_SERVICE_KEY]: {
      project_id: 'test-project',
      client_email: 'test@test-project.iam.gserviceaccount.com',
      private_key: 'test-private-key',
    },
  };

  it('should use Vertex AI multi-region base URLs for Anthropic', () => {
    const testCases = [
      { region: 'eu', baseURL: 'https://aiplatform.eu.rep.googleapis.com/v1' },
      { region: 'us', baseURL: 'https://aiplatform.us.rep.googleapis.com/v1' },
      { region: 'global', baseURL: 'https://aiplatform.googleapis.com/v1' },
    ];

    testCases.forEach(({ region, baseURL }) => {
      const client = createAnthropicVertexClient(credentials, undefined, {
        region,
        projectId: 'test-project',
      });

      expect(client.region).toBe(region);
      expect(client.baseURL).toBe(baseURL);
    });
  });
});

describe('Anthropic Vertex gateway mode', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.ANTHROPIC_VERTEX_BASE_URL;
    delete process.env.ANTHROPIC_VERTEX_REGION;
    delete process.env.VERTEX_PROJECT_ID;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('loadAnthropicVertexCredentials with skipAuth', () => {
    it('returns a placeholder credential without touching the filesystem', async () => {
      const creds = await loadAnthropicVertexCredentials({
        skipAuth: true,
        projectId: 'my-project',
      });

      const serviceKey = creds[AuthKeys.GOOGLE_SERVICE_KEY];
      expect(serviceKey).toBeDefined();
      expect(serviceKey?.project_id).toBe('my-project');
      expect(serviceKey?.private_key).toBeUndefined();
      expect(serviceKey?.client_email).toBeUndefined();
    });

    it('falls back to a sentinel project_id when none provided', async () => {
      const creds = await loadAnthropicVertexCredentials({ skipAuth: true });
      const serviceKey = creds[AuthKeys.GOOGLE_SERVICE_KEY];
      expect(serviceKey?.project_id).toBe(VERTEX_GATEWAY_PLACEHOLDER_PROJECT);
    });
  });

  describe('getVertexCredentialOptions', () => {
    it('propagates skipAuth from YAML config', () => {
      const opts = getVertexCredentialOptions({
        projectId: 'my-project',
        region: 'us-east5',
        skipAuth: true,
        baseURL: 'https://gateway.example.com/google-vertex-ai/v1',
      });

      expect(opts.skipAuth).toBe(true);
      expect(opts.projectId).toBe('my-project');
      expect(opts.region).toBe('us-east5');
    });
  });

  describe('createAnthropicVertexClient with skipAuth', () => {
    it('overrides the base URL with the gateway URL', () => {
      const client = createAnthropicVertexClient(
        { [AuthKeys.GOOGLE_SERVICE_KEY]: { project_id: 'my-project' } },
        undefined,
        {
          region: 'us-east5',
          projectId: 'my-project',
          skipAuth: true,
          baseURL: 'https://gateway.example.com/google-vertex-ai/v1',
        },
      );

      expect(client.baseURL).toBe('https://gateway.example.com/google-vertex-ai/v1');
      expect(client.region).toBe('us-east5');
      expect(client.projectId).toBe('my-project');
    });

    it('reads ANTHROPIC_VERTEX_BASE_URL from env when not provided in options', () => {
      process.env.ANTHROPIC_VERTEX_BASE_URL = 'https://env-gateway.example.com/vertex/v1';

      const client = createAnthropicVertexClient(
        { [AuthKeys.GOOGLE_SERVICE_KEY]: { project_id: 'my-project' } },
        undefined,
        { region: 'us-east5', projectId: 'my-project', skipAuth: true },
      );

      expect(client.baseURL).toBe('https://env-gateway.example.com/vertex/v1');
    });

    it('does not attach a Google auth header when skipAuth is set', async () => {
      const client = createAnthropicVertexClient(
        { [AuthKeys.GOOGLE_SERVICE_KEY]: { project_id: 'my-project' } },
        undefined,
        {
          region: 'us-east5',
          projectId: 'my-project',
          skipAuth: true,
          baseURL: 'https://gateway.example.com/v1',
        },
      );

      // The SDK calls prepareOptions before each request, which awaits the
      // internal auth client's getRequestHeaders(). In gateway mode this must
      // return an empty header map so the gateway is the sole source of auth.
      const opts = { headers: undefined as unknown };
      // @ts-expect-error - prepareOptions is protected but reachable for testing
      await client.prepareOptions(opts);

      // The SDK stores headers in a tagged object: { values: Headers, nulls: Set }.
      // We verify no Google auth headers landed in `values`.
      const headerCarrier = opts.headers as { values?: Headers } | undefined;
      expect(headerCarrier).toBeDefined();
      const collected = headerCarrier?.values;
      expect(collected).toBeInstanceOf(Headers);
      expect(collected?.get('authorization')).toBeNull();
      expect(collected?.get('x-goog-user-project')).toBeNull();
    });

    it('still falls back to default Vertex base URL when only skipAuth is set', () => {
      // skipAuth alone (no baseURL) is still valid — e.g., for testing or a gateway
      // that mirrors the real Vertex hostname. The SDK should produce the standard URL.
      const client = createAnthropicVertexClient(
        { [AuthKeys.GOOGLE_SERVICE_KEY]: { project_id: 'my-project' } },
        undefined,
        { region: 'us-east5', projectId: 'my-project', skipAuth: true },
      );

      expect(client.baseURL).toBe('https://us-east5-aiplatform.googleapis.com/v1');
    });

    it('still uses Google auth when skipAuth is false', () => {
      // Sanity: the existing non-gateway path remains unchanged.
      const client = createAnthropicVertexClient(
        {
          [AuthKeys.GOOGLE_SERVICE_KEY]: {
            project_id: 'real-project',
            client_email: 'sa@real-project.iam.gserviceaccount.com',
            private_key: 'k',
          },
        },
        undefined,
        { region: 'us-east5', projectId: 'real-project' },
      );

      expect(client.baseURL).toBe('https://us-east5-aiplatform.googleapis.com/v1');
      expect(client.projectId).toBe('real-project');
    });
  });
});
