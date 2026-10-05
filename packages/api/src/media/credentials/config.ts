import {
  EModelEndpoint,
  normalizeEndpointName,
  extractEnvVariable,
  mediaOptionsSchema,
} from 'librechat-data-provider';
import type { MediaIntegration, MediaUserKey, MediaProviderOptions } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { MediaProviderAdapter } from '../provider';
import type { MediaRoutingPolicy } from '../routing';
import { isEncryptedSecretPayload } from '~/admin/secrets';
import { findCustomEndpointConfig } from '~/app/config';
import { mediaRoutingPolicySchema } from '../routing';
import { isUserProvided } from '~/utils/common';
import { mergeHeaders } from '~/utils/headers';
import { MediaServiceError } from '../errors';
import { extractBaseURL } from '~/utils/url';

type SettingsInput = { integration: MediaIntegration; appConfig: AppConfig };
export interface MediaEnvironment {
  OPENAI_MODERATION?: string;
  OPENAI_MODERATION_REVERSE_PROXY?: string;
  OPENAI_MODERATION_API_KEY?: string;
  GOOGLE_KEY?: string;
  GEMINI_API_KEY?: string;
  GOOGLE_REVERSE_PROXY?: string;
  OPENAI_API_KEY?: string;
  OPENAI_REVERSE_PROXY?: string;
  OPENAI_ORGANIZATION?: string;
  GOOGLE_SERVICE_KEY_FILE?: string;
  VERTEX_PROJECT_ID?: string;
  GOOGLE_CLOUD_PROJECT?: string;
  GCLOUD_PROJECT?: string;
  GOOGLE_PROJECT_ID?: string;
  VERTEX_LOCATION?: string;
  GOOGLE_CLOUD_LOCATION?: string;
  GOOGLE_LOC?: string;
  [name: string]: string | undefined;
}
interface MediaCredentialSettings {
  apiKey?: string;
  baseURL?: string;
  keyName: string;
  userKey?: MediaUserKey;
  keyHeader: string;
  keyPrefix: string;
  headers?: Record<string, string>;
  options?: MediaProviderOptions;
  routing?: MediaRoutingPolicy;
  configuration?: MediaProviderAdapter['configuration'];
}

export interface MediaCredentialConfiguration {
  read(input: SettingsInput, resolveSecrets?: boolean): MediaCredentialSettings | undefined;
  describe(input: SettingsInput): MediaUserKey | undefined;
}

export function createMediaCredentialConfiguration({
  environment,
  adapters,
  resolveConfigSecret,
}: {
  environment: MediaEnvironment;
  adapters: readonly MediaProviderAdapter[];
  resolveConfigSecret?: (value: string) => string | undefined;
}): MediaCredentialConfiguration {
  const resolveValue = (value: string, required = true) => {
    const resolved = extractEnvVariable(value, environment);
    if (required && /\$\{[^}]+\}/.test(resolved))
      throw new MediaServiceError(
        'not_ready',
        422,
        'A configured media environment variable is unavailable.',
      );
    return resolved;
  };
  const resolveKey = (value: string, resolveSecrets: boolean) => {
    if (!resolveSecrets && isEncryptedSecretPayload(value)) return value;
    const resolved = resolveConfigSecret
      ? resolveConfigSecret(value)
      : resolveValue(value, resolveSecrets);
    if (
      resolveSecrets &&
      (!resolved || isEncryptedSecretPayload(resolved) || /\$\{[^}]+\}/.test(resolved))
    )
      throw new MediaServiceError(
        'not_ready',
        422,
        'The configured media credential is unavailable.',
      );
    return resolved;
  };

  function read({ integration, appConfig }: SettingsInput, resolveSecrets = true) {
    if (integration.endpointRef.kind === 'vertex') return undefined;
    const configuration = adapters.find(
      (adapter) => adapter.api === integration.api,
    )?.configuration;
    let apiKey: string | undefined;
    let baseURL: string | undefined;
    let keyName: string;
    let encoding: MediaUserKey['encoding'] = 'apiKey';
    let headers: Record<string, string> | undefined;
    let options: MediaProviderOptions | undefined;
    let routing: MediaRoutingPolicy | undefined;
    if (integration.endpointRef.kind === 'direct') {
      if (!configuration && resolveSecrets)
        throw new MediaServiceError('unsupported', 422, 'This direct provider is unavailable.');
      const endpoint = integration.endpointRef;
      keyName = endpoint.credentialName ?? integration.id;
      apiKey = resolveKey(endpoint.apiKey, resolveSecrets);
      baseURL = resolveValue(endpoint.baseURL ?? configuration?.baseURL ?? '', resolveSecrets);
      if (endpoint.options) {
        options = {
          ...(endpoint.options.brandId !== undefined
            ? { brandId: resolveValue(endpoint.options.brandId, resolveSecrets) }
            : {}),
          ...(endpoint.options.deployments
            ? {
                deployments: Object.fromEntries(
                  Object.entries(endpoint.options.deployments).map(([model, deployment]) => [
                    model,
                    resolveValue(deployment, resolveSecrets),
                  ]),
                ),
              }
            : {}),
        };
      }
      const parsedOptions = mediaOptionsSchema(integration.api, !resolveSecrets).safeParse(
        options ?? {},
      );
      if (resolveSecrets && !parsedOptions.success)
        throw new MediaServiceError(
          'not_ready',
          422,
          'The provider connection options are invalid.',
        );
      headers = endpoint.headers;
    } else if (integration.endpointRef.kind === 'custom') {
      let endpoint: ReturnType<typeof findCustomEndpointConfig>;
      try {
        endpoint = findCustomEndpointConfig(
          appConfig.endpoints,
          integration.endpointRef.name,
          true,
        );
      } catch {
        throw new MediaServiceError(
          'not_ready',
          422,
          'The configured media endpoint is ambiguous.',
        );
      }
      if (!endpoint?.name)
        throw new MediaServiceError(
          'not_ready',
          422,
          'The configured media endpoint does not exist.',
        );
      keyName = normalizeEndpointName(endpoint.name);
      apiKey = resolveKey(endpoint.apiKey ?? '', resolveSecrets);
      baseURL = resolveValue(endpoint.baseURL ?? '', resolveSecrets);
      headers = endpoint.headers;
      if (integration.api.startsWith('openrouter.') && endpoint.addParams?.provider !== undefined) {
        const parsed = mediaRoutingPolicySchema.safeParse(endpoint.addParams.provider);
        if (!parsed.success)
          throw new MediaServiceError(
            'not_ready',
            422,
            'The provider policy is not supported by media.',
          );
        routing = parsed.data;
      }
    } else {
      keyName = integration.endpointRef.endpoint;
      if (keyName === 'google') {
        encoding = 'google';
        apiKey = environment.GOOGLE_KEY || environment.GEMINI_API_KEY;
        baseURL =
          environment.GOOGLE_REVERSE_PROXY || 'https://generativelanguage.googleapis.com/v1beta';
        headers = appConfig.endpoints?.google?.headers;
      } else if (keyName === 'openAI') {
        apiKey = environment.OPENAI_API_KEY;
        const reverseProxy = environment.OPENAI_REVERSE_PROXY;
        baseURL = reverseProxy || 'https://api.openai.com/v1';
        if (reverseProxy && !isUserProvided(reverseProxy)) {
          baseURL = extractBaseURL(reverseProxy) ?? undefined;
        }
        headers = mergeHeaders(
          environment.OPENAI_ORGANIZATION
            ? { 'OpenAI-Organization': environment.OPENAI_ORGANIZATION }
            : undefined,
          appConfig.endpoints?.openAI?.headers,
        );
      } else
        throw new MediaServiceError('unsupported', 422, 'This native connection is not supported.');
    }
    const userProvideURL = isUserProvided(baseURL);
    const userKey: MediaUserKey | undefined =
      isUserProvided(apiKey) || userProvideURL ? { keyName, encoding, userProvideURL } : undefined;
    const keyHeader =
      configuration?.keyHeader ??
      (integration.api.startsWith('google.') ? 'x-goog-api-key' : 'Authorization');
    const keyPrefix = configuration?.keyPrefix ?? (keyHeader === 'Authorization' ? 'Bearer ' : '');
    return {
      apiKey,
      baseURL,
      keyName,
      userKey,
      keyHeader,
      keyPrefix,
      headers: mergeHeaders(appConfig.endpoints?.all?.headers, headers),
      options,
      routing,
      configuration,
    };
  }

  function describe(input: SettingsInput): MediaUserKey | undefined {
    const userKey = read(input, false)?.userKey;
    if (!userKey) return undefined;
    /** Google chat owns this key's existing envelope even without a media builtin entry. */
    if (userKey.keyName === 'google' && userKey.encoding !== 'google')
      throw new MediaServiceError(
        'not_ready',
        422,
        'This credential name uses the Google credential format.',
      );
    if (
      Object.values(EModelEndpoint).some((endpoint) => endpoint === userKey.keyName) &&
      !['openAI', 'assistants', 'google'].includes(userKey.keyName)
    )
      throw new MediaServiceError(
        'not_ready',
        422,
        'This credential name belongs to a different chat credential format.',
      );
    for (const integration of input.appConfig.media?.integrations ?? []) {
      if (integration.id === input.integration.id || integration.enabled === false) continue;
      let other: MediaUserKey | undefined;
      try {
        other = read({ ...input, integration }, false)?.userKey;
      } catch {
        continue;
      }
      if (other?.keyName === userKey.keyName && other.encoding !== userKey.encoding)
        throw new MediaServiceError(
          'not_ready',
          422,
          'Shared credential names must use the same credential format.',
        );
    }
    return userKey;
  }

  return { read, describe };
}

/** Static key metadata requires neither adapters nor credential/model lookups. */
export function describeMediaUserKey(
  input: SettingsInput,
  environment: MediaEnvironment,
): MediaUserKey | undefined {
  return createMediaCredentialConfiguration({ environment, adapters: [] }).describe(input);
}
