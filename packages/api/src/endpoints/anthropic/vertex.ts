import path from 'path';
import { GoogleAuth } from 'google-auth-library';
import { AuthKeys } from 'librechat-data-provider';
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';
import type { ClientOptions } from '@anthropic-ai/sdk';
import type { AnthropicCredentials, VertexAIClientOptions } from '~/types/anthropic';
import { loadServiceKey } from '~/utils/key';

/**
 * Options for loading Vertex AI credentials
 */
export interface VertexCredentialOptions {
  /** Path to service account key file (overrides env var) */
  serviceKeyFile?: string;
  /** Project ID for Vertex AI */
  projectId?: string;
  /** Region for Vertex AI */
  region?: string;
}

/**
 * Interface for Vertex AI configuration from YAML config.
 * This matches the TVertexAISchema from librechat-data-provider.
 */
export interface VertexAIConfigInput {
  enabled?: boolean;
  projectId?: string;
  region?: string;
  serviceKeyFile?: string;
  deploymentName?: string;
  models?: string[] | Record<string, boolean | { deploymentName?: string }>;
}

/**
 * Loads Google service account configuration for Vertex AI.
 * Supports both YAML configuration and environment variables.
 * @param options - Optional configuration from YAML or other sources
 */
export async function loadAnthropicVertexCredentials(
  options?: VertexCredentialOptions,
): Promise<AnthropicCredentials> {
  /** Path priority: options > env var > default location */
  const serviceKeyPath =
    options?.serviceKeyFile ||
    process.env.GOOGLE_SERVICE_KEY_FILE ||
    path.join(process.cwd(), 'api', 'data', 'auth.json');

  const serviceKey = await loadServiceKey(serviceKeyPath);

  if (!serviceKey) {
    throw new Error(
      `Google service account not found or could not be loaded from ${serviceKeyPath}`,
    );
  }

  return {
    [AuthKeys.GOOGLE_SERVICE_KEY]: serviceKey,
  };
}

/**
 * Creates Vertex credential options from a Vertex AI configuration object.
 * @param config - The Vertex AI configuration (from YAML config or other sources)
 */
export function getVertexCredentialOptions(config?: VertexAIConfigInput): VertexCredentialOptions {
  return {
    serviceKeyFile: config?.serviceKeyFile,
    projectId: config?.projectId,
    region: config?.region,
  };
}

/**
 * Checks if credentials are for Vertex AI (has service account key but no API key)
 */
export function isAnthropicVertexCredentials(credentials: AnthropicCredentials): boolean {
  return !!credentials[AuthKeys.GOOGLE_SERVICE_KEY] && !credentials[AuthKeys.ANTHROPIC_API_KEY];
}

/**
 * Filters anthropic-beta header values to only include those supported by Vertex AI.
 * Vertex AI handles caching differently and we use 'prompt-caching-vertex' as a
 * marker to trigger cache_control application in the agents package.
 */
function filterVertexHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }

  const filteredHeaders = { ...headers };
  const anthropicBeta = filteredHeaders['anthropic-beta'];

  if (anthropicBeta) {
    // Filter out unsupported beta values for Vertex AI
    const supportedValues = anthropicBeta
      .split(',')
      .map((v) => v.trim())
      .filter((v) => {
        // Remove prompt-caching headers (Vertex handles caching via cache_control in body)
        if (v.includes('prompt-caching')) {
          return false;
        }
        // Remove max-tokens headers (Vertex has its own limits)
        if (v.includes('max-tokens')) {
          return false;
        }
        // Remove output-128k headers
        if (v.includes('output-128k')) {
          return false;
        }
        // Remove token-efficient-tools headers
        if (v.includes('token-efficient-tools')) {
          return false;
        }
        return true;
      });

    if (supportedValues.length > 0) {
      filteredHeaders['anthropic-beta'] = supportedValues.join(',');
    } else {
      delete filteredHeaders['anthropic-beta'];
    }
  }

  return Object.keys(filteredHeaders).length > 0 ? filteredHeaders : undefined;
}

export { getVertexDeploymentName } from 'librechat-data-provider';

/**
 * Creates and configures a Vertex AI client for Anthropic.
 * Supports both YAML configuration and environment variables for region/projectId.
 * The projectId is automatically extracted from the service key if not explicitly provided.
 * @param credentials - The Google service account credentials
 * @param options - SDK client options
 * @param vertexOptions - Vertex AI specific options (region, projectId) from YAML config
 */
export function createAnthropicVertexClient(
  credentials: AnthropicCredentials,
  options?: ClientOptions,
  vertexOptions?: VertexAIClientOptions,
): AnthropicVertex {
  const serviceKey = credentials[AuthKeys.GOOGLE_SERVICE_KEY];

  if (!serviceKey) {
    throw new Error('Google service account key is required for Vertex AI');
  }

  /**
   * Priority: vertexOptions > env vars > service key project_id.
   *
   * The `us-east5` fallback only serves Sonnet 4.6 and earlier — specific
   * regional endpoints 404 on newer models (Opus 4.7+, Opus 5, Sonnet 5,
   * Fable 5), which need `global` or a multi-region (`us`/`eu`) location.
   * Kept for backwards compatibility; deployments using modern models must
   * set the region explicitly.
   */
  const region = vertexOptions?.region || process.env.ANTHROPIC_VERTEX_REGION || 'us-east5';
  const projectId =
    vertexOptions?.projectId || process.env.VERTEX_PROJECT_ID || serviceKey.project_id;

  try {
    const googleAuth = new GoogleAuth({
      credentials: serviceKey,
      scopes: 'https://www.googleapis.com/auth/cloud-platform',
      ...(projectId && { projectId }),
    });

    // Filter out unsupported anthropic-beta header values for Vertex AI
    const filteredOptions = options
      ? {
          ...options,
          defaultHeaders: filterVertexHeaders(
            options.defaultHeaders as Record<string, string> | undefined,
          ),
        }
      : undefined;

    return new AnthropicVertex({
      region: region,
      googleAuth: googleAuth,
      ...(projectId && { projectId }),
      ...filteredOptions,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to create Vertex AI client: ${message}`);
  }
}
