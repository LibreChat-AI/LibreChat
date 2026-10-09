import path from 'path';
import { Providers } from '@librechat/agents';
import { EModelEndpoint, AuthKeys } from 'librechat-data-provider';
import type {
  InitializeResultBase,
  GoogleConfigOptions,
  GoogleCredentials,
  ProviderInitializeParams,
} from '~/types';
import {
  isEnabled,
  loadServiceKey,
  checkUserKeyExpiry,
  mergeHeaders,
  resolveHeaders,
} from '~/utils';
import { resolveEndpointRuntime } from '~/types';
import { getGoogleConfig } from './llm';

/**
 * Initializes Google/Vertex AI endpoint configuration.
 * Supports both API key authentication and service account credentials.
 *
 * @param params - Configuration parameters
 * @returns Promise resolving to Google configuration options
 * @throws Error if no valid credentials are provided
 */
export async function initializeGoogle(
  params: ProviderInitializeParams,
): Promise<InitializeResultBase> {
  const { endpoint, model_parameters, db } = params;
  const { appConfig, user, requestBody } = resolveEndpointRuntime(params);
  const { GOOGLE_KEY, GOOGLE_REVERSE_PROXY, GOOGLE_AUTH_HEADER, PROXY } = process.env;
  const isUserProvided = GOOGLE_KEY === 'user_provided';
  const isVertexEndpoint = endpoint === Providers.VERTEXAI;
  const useUserProvidedGoogleKey = !isVertexEndpoint && isUserProvided;
  const { key: expiresAt } = requestBody;

  let userKey = null;
  if (expiresAt && useUserProvidedGoogleKey) {
    checkUserKeyExpiry(expiresAt, EModelEndpoint.google);
  }
  if (useUserProvidedGoogleKey) {
    userKey = await db.getUserKey({ userId: user?.id ?? '', name: EModelEndpoint.google });
  }

  let serviceKey: Record<string, unknown> = {};

  /** Check if GOOGLE_KEY is provided at all (including 'user_provided') */
  const isGoogleKeyProvided =
    !isVertexEndpoint &&
    ((GOOGLE_KEY && GOOGLE_KEY.trim() !== '') || (useUserProvidedGoogleKey && userKey != null));

  if ((isVertexEndpoint || !isGoogleKeyProvided) && loadServiceKey) {
    /** Only attempt to load service key if GOOGLE_KEY is not provided */
    try {
      const serviceKeyPath =
        process.env.GOOGLE_SERVICE_KEY_FILE || path.join(process.cwd(), 'api', 'data', 'auth.json');
      const loadedKey = await loadServiceKey(serviceKeyPath);
      if (loadedKey) {
        serviceKey = loadedKey;
      }
    } catch {
      // Service key loading failed, but that's okay if not required
      serviceKey = {};
    }
  }

  const credentials: GoogleCredentials = useUserProvidedGoogleKey
    ? (userKey as GoogleCredentials)
    : {
        [AuthKeys.GOOGLE_SERVICE_KEY]: serviceKey,
        ...(!isVertexEndpoint && { [AuthKeys.GOOGLE_API_KEY]: GOOGLE_KEY }),
      };

  let clientOptions: GoogleConfigOptions = {};

  /** @type {undefined | TBaseEndpoint} */
  const allConfig = appConfig?.endpoints?.all;
  /** @type {undefined | TBaseEndpoint} */
  const googleConfig = appConfig?.endpoints?.[EModelEndpoint.google];

  if (googleConfig) {
    clientOptions.streamRate = googleConfig.streamRate;
    clientOptions.titleModel = googleConfig.titleModel;
  }

  if (allConfig?.streamRate != null) {
    clientOptions.streamRate = allConfig.streamRate;
  }

  /**
   * Resolve configured Google headers at init (not at request time): the native
   * Google auth header (`GOOGLE_AUTH_HEADER`) is built from the API key in
   * `getGoogleConfig` and lives in the same `customHeaders` map. Resolving the
   * admin templates here — before that key-derived header is added — keeps the
   * key out of placeholder/env expansion (a user-provided `${ENV}` key can't leak
   * server env) while still resolving admin headers (env, user, conversationId).
   * The initialization request body lacks the assistant message id, so
   * `{{LIBRECHAT_BODY_MESSAGEID}}`
   * is the one body placeholder unavailable here.
   */
  const mergedHeaders = mergeHeaders(allConfig?.headers, googleConfig?.headers);
  const headers = mergedHeaders
    ? resolveHeaders({
        headers: mergedHeaders,
        user,
        body: requestBody,
        stripUnresolved: true,
      })
    : undefined;

  clientOptions = {
    reverseProxyUrl: GOOGLE_REVERSE_PROXY ?? undefined,
    authHeader: isEnabled(GOOGLE_AUTH_HEADER) ?? undefined,
    proxy: PROXY ?? undefined,
    ...(headers && { headers }),
    modelOptions: model_parameters ?? {},
    forceVertex: isVertexEndpoint,
    projectId: isVertexEndpoint
      ? (process.env.VERTEX_PROJECT_ID ??
        process.env.GOOGLE_CLOUD_PROJECT ??
        process.env.GCLOUD_PROJECT ??
        process.env.GOOGLE_PROJECT_ID)
      : undefined,
    ...clientOptions,
  };

  const result = getGoogleConfig(credentials, clientOptions);

  if (clientOptions.streamRate != null) {
    result.llmConfig._lc_stream_delay = clientOptions.streamRate;
  }

  return result;
}
