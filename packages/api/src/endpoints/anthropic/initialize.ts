import { EModelEndpoint, AuthKeys } from 'librechat-data-provider';
import type {
  InitializeResultBase,
  AnthropicConfigOptions,
  ProviderInitializeParams,
} from '~/types';
import { loadAnthropicVertexCredentials, getVertexCredentialOptions } from './vertex';
import { checkUserKeyExpiry, isEnabled, mergeHeaders } from '~/utils';
import { resolveEndpointRuntime } from '~/types';
import { getLLMConfig } from './llm';

/**
 * Initializes Anthropic endpoint configuration.
 * Supports both direct API key authentication and Google Cloud Vertex AI.
 *
 * @param params - Configuration parameters
 * @returns Promise resolving to Anthropic configuration options
 * @throws Error if API key is not provided (when not using Vertex AI)
 */
export async function initializeAnthropic(
  params: ProviderInitializeParams,
): Promise<InitializeResultBase> {
  const { endpoint, model_parameters, db } = params;
  const { appConfig, user, requestBody } = resolveEndpointRuntime(params);
  void endpoint;
  const { ANTHROPIC_API_KEY, ANTHROPIC_REVERSE_PROXY, PROXY } = process.env;
  const { key: expiresAt } = requestBody;

  let credentials: Record<string, unknown> = {};
  let vertexOptions:
    | { region?: string; projectId?: string; skipAuth?: boolean; baseURL?: string }
    | undefined;

  /** @type {undefined | import('librechat-data-provider').TVertexAIConfig} */
  const vertexConfig = appConfig?.endpoints?.[EModelEndpoint.anthropic]?.vertexConfig;

  // Check for Vertex AI configuration: YAML config takes priority over env var
  // When vertexConfig exists and enabled is not explicitly false, Vertex AI is enabled
  const useVertexAI =
    (vertexConfig && vertexConfig.enabled !== false) || isEnabled(process.env.ANTHROPIC_USE_VERTEX);

  if (useVertexAI) {
    // Gateway mode: when ANTHROPIC_VERTEX_SKIP_AUTH is set (or skipAuth in YAML),
    // route Anthropic Vertex requests through an upstream proxy that owns auth.
    // YAML config takes priority over the env var.
    const skipAuth =
      vertexConfig?.skipAuth === true ||
      (vertexConfig?.skipAuth === undefined && isEnabled(process.env.ANTHROPIC_VERTEX_SKIP_AUTH));
    const baseURL = vertexConfig?.baseURL || process.env.ANTHROPIC_VERTEX_BASE_URL || undefined;

    // Load credentials with optional YAML config overrides. In skipAuth mode this
    // returns a placeholder credential without touching any service-account file.
    // The resolved `skipAuth` already takes the env var into account; merge it
    // back so env-only gateway mode (no YAML config) and YAML-only both work.
    let credentialOptions: ReturnType<typeof getVertexCredentialOptions> | undefined;
    if (vertexConfig) {
      credentialOptions = { ...getVertexCredentialOptions(vertexConfig), skipAuth };
    } else if (skipAuth) {
      credentialOptions = { skipAuth: true };
    }
    credentials = await loadAnthropicVertexCredentials(credentialOptions);

    // Store vertex options for client creation
    if (vertexConfig || skipAuth || baseURL) {
      vertexOptions = {
        region: vertexConfig?.region,
        projectId: vertexConfig?.projectId,
        skipAuth,
        baseURL,
      };
    }
  } else {
    const isUserProvided = ANTHROPIC_API_KEY === 'user_provided';

    const anthropicApiKey = isUserProvided
      ? await db.getUserKey({ userId: user?.id ?? '', name: EModelEndpoint.anthropic })
      : ANTHROPIC_API_KEY;

    if (!anthropicApiKey) {
      throw new Error('Anthropic API key not provided. Please provide it again.');
    }

    if (expiresAt && isUserProvided) {
      checkUserKeyExpiry(expiresAt, EModelEndpoint.anthropic);
    }

    credentials[AuthKeys.ANTHROPIC_API_KEY] = anthropicApiKey;
  }

  const anthropicConfig = appConfig?.endpoints?.[EModelEndpoint.anthropic];
  const allConfig = appConfig?.endpoints?.all;

  const headers = mergeHeaders(allConfig?.headers, anthropicConfig?.headers);

  const clientOptions: AnthropicConfigOptions = {
    proxy: PROXY ?? undefined,
    reverseProxyUrl: ANTHROPIC_REVERSE_PROXY ?? undefined,
    modelOptions: {
      ...(model_parameters ?? {}),
      user: user?.id,
    },
    ...(headers && { headers }),
    // Pass Vertex AI options if configured
    ...(vertexOptions && { vertexOptions }),
    // Pass full Vertex AI config including model mappings
    ...(vertexConfig && { vertexConfig }),
  };

  const result = getLLMConfig(credentials, clientOptions);

  if (anthropicConfig?.streamRate != null) {
    result.llmConfig._lc_stream_delay = anthropicConfig.streamRate;
  }

  if (allConfig?.streamRate != null) {
    result.llmConfig._lc_stream_delay = allConfig.streamRate;
  }

  return result;
}
