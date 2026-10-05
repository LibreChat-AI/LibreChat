import { z } from 'zod';
import { createHash } from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';
import { resolveMediaConfig } from 'librechat-data-provider';
import type { GoogleServiceKey } from '~/utils/key';
import { MediaServiceError } from './errors';

interface VertexTokenClient {
  credentials: { expiry_date?: number | null };
  eagerRefreshThresholdMillis: number;
  getAccessToken(): Promise<{ token?: string | null }>;
}

interface VertexAuthOptions {
  credentials?: GoogleServiceKey;
  projectId?: string;
  timeoutMs: number;
}

const credentialIdentitySchema = z
  .object({
    project_id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .optional(),
    client_email: z.string().min(1).optional(),
  })
  .passthrough();

interface VertexAuthClient {
  getClient(): Promise<VertexTokenClient>;
  getProjectId(): Promise<string>;
  getCredentials(): Promise<{ client_email?: string }>;
}

export type MediaVertexCredentialProvider = (input: {
  keyFile?: string;
  projectId?: string;
  minValidityMs: number;
  timeoutMs: number;
}) => Promise<{ projectId: string; accessToken: string; revision: string }>;

/** Concrete SDK boundary; the host supplies it to the credential provider. */
export function createGoogleMediaAuthClient(options: VertexAuthOptions): VertexAuthClient {
  return new GoogleAuth({
    credentials: options.credentials,
    projectId: options.projectId,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    clientOptions: { transporterOptions: { timeout: options.timeoutMs } },
  });
}

/** Reuse renewable tokens, while binding saved jobs to the service account, not its token. */
export function createVertexMediaCredentialProvider({
  loadServiceKey,
  defaultServiceKeyFile,
  createAuth,
  now,
  maxCacheEntries,
}: {
  loadServiceKey(path: string): Promise<GoogleServiceKey | null>;
  defaultServiceKeyFile?: string;
  createAuth(options: VertexAuthOptions): VertexAuthClient;
  now(): number;
  maxCacheEntries?: number;
}): MediaVertexCredentialProvider {
  const capacity = resolveMediaConfig({ catalog: { maxCacheEntries } }).catalog.maxCacheEntries;
  const cache = new Map<
    string,
    {
      revision: string;
      timeoutMs: number;
      client: Promise<VertexTokenClient>;
      project: Promise<string>;
      auth: VertexAuthClient;
    }
  >();
  return async ({ keyFile, projectId, minValidityMs, timeoutMs }) => {
    try {
      const source = keyFile ?? defaultServiceKeyFile;
      const credentials = source ? ((await loadServiceKey(source)) ?? undefined) : undefined;
      if (credentials) credentialIdentitySchema.parse(credentials);
      if (keyFile && !credentials)
        throw new MediaServiceError(
          'credentials_required',
          403,
          'The configured Vertex service key is unavailable.',
        );
      const configuredProject = projectId ?? credentials?.project_id;
      let revision = createHash('sha256')
        .update(JSON.stringify(credentials ?? { source: 'application-default' }))
        .digest('hex');
      const cacheKey = createHash('sha256')
        .update(JSON.stringify([source ?? 'application-default', configuredProject]))
        .digest('hex');
      let cached = cache.get(cacheKey);
      if (!cached || cached.revision !== revision || cached.timeoutMs !== timeoutMs) {
        const auth = createAuth({
          ...(credentials ? { credentials } : {}),
          projectId: configuredProject,
          timeoutMs,
        });
        cached = {
          revision,
          timeoutMs,
          client: auth.getClient(),
          project: configuredProject ? Promise.resolve(configuredProject) : auth.getProjectId(),
          auth,
        };
      }
      cache.delete(cacheKey);
      cache.set(cacheKey, cached);
      while (cache.size > capacity) cache.delete(cache.keys().next().value!);
      let client: VertexTokenClient;
      let project: string;
      try {
        [client, project] = await Promise.all([
          cached.client,
          credentials || configuredProject ? cached.project : cached.auth.getProjectId(),
        ]);
        if (!/^[a-z0-9][a-z0-9-]*$/.test(project))
          throw new MediaServiceError('not_ready', 422, 'The Vertex project is unavailable.');
      } catch {
        if (cache.get(cacheKey) === cached) cache.delete(cacheKey);
        throw new MediaServiceError('credentials_required', 403, 'Vertex authentication failed.');
      }
      if (!credentials) {
        const principal = (await cached.auth.getCredentials()).client_email;
        if (!principal)
          throw new MediaServiceError(
            'not_ready',
            422,
            'Vertex application default credentials must identify a principal.',
          );
        revision = createHash('sha256')
          .update(JSON.stringify({ principal, project }))
          .digest('hex');
      }
      client.eagerRefreshThresholdMillis = Math.max(
        client.eagerRefreshThresholdMillis,
        minValidityMs,
      );
      const { token } = await client.getAccessToken();
      if (
        !token ||
        !client.credentials.expiry_date ||
        client.credentials.expiry_date <= now() + minValidityMs
      ) {
        throw new MediaServiceError(
          'credentials_expired',
          403,
          'The Vertex access token has expired.',
        );
      }
      return { projectId: project, accessToken: token, revision };
    } catch (error) {
      if (error instanceof MediaServiceError) throw error;
      /** File and SDK errors can contain credential material; never surface their payloads. */
      throw new MediaServiceError('credentials_required', 403, 'Vertex authentication failed.');
    }
  };
}
