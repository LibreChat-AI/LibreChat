import { z } from 'zod';
import { createHash } from 'node:crypto';
import { getMediaConfig } from '@librechat/data-schemas';
import { AuthKeys, extractEnvVariable, isValidProviderBaseURL } from 'librechat-data-provider';
import type { AppConfig, KeyMethods, MediaOwnerScope } from '@librechat/data-schemas';
import type { MediaIntegration, MediaUserKey } from 'librechat-data-provider';
import type { MediaConnection, MediaProviderAdapter } from '../provider';
import type { MediaVertexCredentialProvider } from '../vertex';
import type { MediaEnvironment } from './config';
import type { SafeUserInput } from '~/utils/env';
import { mergeHeaders, resolveModelHeaders } from '~/utils/headers';
import { createMediaCredentialConfiguration } from './config';
import { validateEndpointURL } from '~/auth/domain';
import { MediaServiceError } from '../errors';
import { isEnabled } from '~/utils/common';

export type { MediaEnvironment } from './config';

export interface MediaCredentialInput {
  scope: MediaOwnerScope;
  integration: MediaIntegration;
  appConfig: AppConfig;
  minValidityMs: number;
  user?: SafeUserInput;
}

export interface MediaCredentialResolver {
  (input: MediaCredentialInput): Promise<MediaConnection>;
  describe(
    input: Pick<MediaCredentialInput, 'integration' | 'appConfig'>,
  ): MediaUserKey | undefined;
}

export function createMediaCredentialResolver({
  environment,
  repository,
  decrypt,
  now,
  vertexCredentials,
  adapters = [],
  resolveConfigSecret,
}: {
  environment: MediaEnvironment;
  repository: Pick<KeyMethods, 'getUserKeySnapshot'>;
  decrypt: (value: string) => Promise<string>;
  now: () => number;
  vertexCredentials?: MediaVertexCredentialProvider;
  adapters?: readonly MediaProviderAdapter[];
  resolveConfigSecret?: (value: string) => string | undefined;
}): MediaCredentialResolver {
  const settings = createMediaCredentialConfiguration({
    environment,
    adapters,
    resolveConfigSecret,
  });
  const resolveVertexValue = (value?: string) => {
    if (!value) return undefined;
    const resolved = extractEnvVariable(value, environment);
    if (/\$\{[^}]+\}/.test(resolved))
      throw new MediaServiceError(
        'not_ready',
        422,
        'A configured Vertex environment variable is unavailable.',
      );
    return resolved;
  };

  async function resolve({
    scope,
    integration,
    appConfig,
    minValidityMs,
    user,
  }: MediaCredentialInput): Promise<MediaConnection> {
    if (integration.endpointRef.kind === 'vertex') {
      if (!vertexCredentials) {
        throw new MediaServiceError('not_ready', 422, 'Vertex authentication is unavailable.');
      }
      const endpoint = integration.endpointRef;
      const credential = await vertexCredentials({
        keyFile: resolveVertexValue(endpoint.keyFile ?? environment.GOOGLE_SERVICE_KEY_FILE),
        projectId: resolveVertexValue(
          endpoint.projectId ??
            environment.VERTEX_PROJECT_ID ??
            environment.GOOGLE_CLOUD_PROJECT ??
            environment.GCLOUD_PROJECT ??
            environment.GOOGLE_PROJECT_ID,
        ),
        minValidityMs,
        timeoutMs: getMediaConfig(appConfig).catalog.requestTimeoutMs,
      });
      const location =
        endpoint.location ??
        environment.GOOGLE_CLOUD_LOCATION ??
        environment.GOOGLE_LOC ??
        environment.VERTEX_LOCATION ??
        'us-central1';
      if (!/^[a-z][a-z0-9-]*$/.test(location))
        throw new MediaServiceError('not_ready', 422, 'The configured Vertex location is invalid.');
      const hostname =
        location === 'global'
          ? 'aiplatform.googleapis.com'
          : `${location}-aiplatform.googleapis.com`;
      const baseURL = `https://${hostname}/v1/projects/${encodeURIComponent(credential.projectId)}/locations/${location}/publishers/google/`;
      return {
        id: integration.id,
        api: integration.api,
        baseURL,
        headers: { Authorization: `Bearer ${credential.accessToken}` },
        allowedAddresses: appConfig.endpoints?.allowedAddresses ?? [],
        binding: createHash('sha256')
          .update(
            JSON.stringify({
              api: integration.api,
              baseURL,
              revision: credential.revision,
            }),
          )
          .digest('hex'),
      };
    }
    const configured = settings.read({ integration, appConfig });
    if (!configured)
      throw new MediaServiceError('not_ready', 422, 'Media credentials are unavailable.');
    const userKey = settings.describe({ integration, appConfig });
    let { apiKey, baseURL } = configured;
    const {
      keyName: credentialName,
      keyHeader,
      keyPrefix,
      routing,
      options,
      configuration,
    } = configured;
    const headerTemplates = userKey?.userProvideURL
      ? configuration?.headers
      : mergeHeaders(configuration?.headers, configured.headers);
    if (
      Object.values(headerTemplates ?? {}).some((value) =>
        /\$\{[^}]+\}/.test(extractEnvVariable(value, environment)),
      )
    )
      throw new MediaServiceError(
        'not_ready',
        422,
        'A configured media header environment variable is unavailable.',
      );
    const headers = resolveModelHeaders({
      headers: headerTemplates,
      environment,
      user: { ...user, id: scope.ownerId },
      tenantId: scope.tenantId ?? undefined,
    });
    if (userKey?.userProvideURL && options && Object.keys(options).length)
      throw new MediaServiceError(
        'not_ready',
        422,
        'User-provided API URLs cannot be combined with configured provider options.',
      );
    let binding = `deployment:${credentialName}`;
    if (userKey) {
      const record = await repository.getUserKeySnapshot({
        userId: scope.ownerId,
        tenantId: scope.tenantId ?? null,
        name: credentialName,
      });
      if (!record) {
        throw new MediaServiceError(
          'credentials_required',
          403,
          'Save a provider credential before queueing media.',
        );
      }
      if (record.expiresAt && Date.parse(record.expiresAt) <= now() + minValidityMs) {
        throw new MediaServiceError(
          'credentials_expired',
          403,
          'The provider credential has expired.',
        );
      }
      try {
        const value = await decrypt(record.value);
        const secret = z
          .string()
          .min(1)
          .refine((key) => key.trim().length > 0 && key !== 'user_provided' && !/[\r\n]/.test(key));
        if (userKey.encoding === 'google' && !value.trim().startsWith('{')) {
          apiKey = secret.parse(value);
          if (userKey.userProvideURL) throw new Error('Missing user URL');
        } else {
          const field = userKey.encoding === 'google' ? AuthKeys.GOOGLE_API_KEY : 'apiKey';
          const saved = z
            .object({
              apiKey: z.string().optional(),
              [AuthKeys.GOOGLE_API_KEY]: z.string().optional(),
              [AuthKeys.GOOGLE_SERVICE_KEY]: z
                .union([z.string(), z.object({}).passthrough()])
                .optional(),
              baseURL: z.string().optional(),
            })
            .parse(JSON.parse(value));
          if (userKey.encoding === 'google' && !saved[field] && saved[AuthKeys.GOOGLE_SERVICE_KEY])
            throw new MediaServiceError(
              'gemini_key_required',
              403,
              'This media provider requires a Google API key. Configure a Vertex integration to use a service account.',
            );
          apiKey = secret.parse(saved[field]);
          if (userKey.userProvideURL) baseURL = z.string().min(1).parse(saved.baseURL);
        }
      } catch (error) {
        if (error instanceof MediaServiceError) throw error;
        throw new MediaServiceError(
          'credentials_required',
          403,
          'Save a valid provider credential before queueing media.',
        );
      }
      binding = `user:${scope.ownerId}:${credentialName}:${record.id}`;
    }
    if (!apiKey || !baseURL) {
      if (
        integration.endpointRef.kind === 'builtin' &&
        integration.endpointRef.endpoint === 'google'
      )
        throw new MediaServiceError(
          'gemini_key_required',
          422,
          'Configure a Gemini API key, or use endpointRef.kind: vertex for service-account or application default credentials.',
        );
      throw new MediaServiceError(
        'credentials_required',
        403,
        'The provider credential is missing.',
      );
    }
    if (
      headers &&
      Object.entries(headers).some(
        ([name, value]) =>
          !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
          /[\r\n]/.test(value) ||
          /^(host|content-length|transfer-encoding|connection)$/i.test(name),
      )
    )
      throw new MediaServiceError('not_ready', 422, 'Invalid provider headers.');
    let root: URL;
    try {
      root = new URL(baseURL);
    } catch {
      throw new MediaServiceError('not_ready', 422, 'Configure the provider API root for media.');
    }
    if (!isValidProviderBaseURL(root.href)) {
      throw new MediaServiceError('not_ready', 422, 'Configure the provider API root for media.');
    }
    if (userKey?.userProvideURL) {
      try {
        await validateEndpointURL(root.href, integration.id, appConfig.endpoints?.allowedAddresses);
      } catch {
        throw new MediaServiceError(
          'not_ready',
          422,
          'The provider API root targets a restricted or unavailable address.',
        );
      }
    }
    const digest = (identity: string, configuredHeaders: Record<string, string>) =>
      createHash('sha256')
        .update(
          JSON.stringify({
            binding: identity,
            root: root.href,
            api: integration.api,
            routing,
            ...(Object.keys(configuredHeaders).length ? { headers: configuredHeaders } : {}),
            ...(options ? { options } : {}),
            keyRevision: createHash('sha256').update(apiKey).digest('hex'),
          }),
        )
        .digest('hex');
    const authentication = {
      [keyHeader]: `${keyPrefix}${apiKey}`,
      ...(integration.endpointRef.kind === 'builtin' &&
      integration.endpointRef.endpoint === 'google' &&
      isEnabled(environment.GOOGLE_AUTH_HEADER)
        ? { Authorization: `Bearer ${apiKey}` }
        : {}),
    };
    return {
      id: integration.id,
      api: integration.api,
      baseURL: root.href,
      routing,
      options,
      binding: digest(binding, headerTemplates ?? {}),
      allowedAddresses: appConfig.endpoints?.allowedAddresses ?? [],
      headers: mergeHeaders(headers, authentication)!,
    };
  }
  return Object.assign(resolve, { describe: settings.describe });
}
