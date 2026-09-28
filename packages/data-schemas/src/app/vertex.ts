import {
  EModelEndpoint,
  extractEnvVariable,
  envVarRegex,
  TVertexModelMap,
} from 'librechat-data-provider';
import type {
  TCustomConfig,
  TVertexAISchema,
  TVertexAIConfig,
  TAnthropicEndpoint,
  TVertexModelConfig,
} from 'librechat-data-provider';
import logger from '~/config/winston';

/**
 * Default Vertex AI models available through Google Cloud
 * These are the standard Anthropic model names as served by Vertex AI
 */
export const defaultVertexModels: string[] = [
  'claude-opus-5',
  'claude-opus-5-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-3-7-sonnet-20250219',
  'claude-3-5-sonnet-v2@20241022',
  'claude-3-5-sonnet@20240620',
  'claude-3-5-haiku@20241022',
  'claude-3-opus@20240229',
  'claude-3-haiku@20240307',
];

/** Locations that serve every model: `global` plus the `us`/`eu` multi-region endpoints. */
const MULTI_REGION_LOCATIONS = new Set(['global', 'us', 'eu']);

/**
 * Models Vertex serves only from `global` or a multi-region location. Specific
 * regional endpoints (us-east5, europe-west1, ...) carry Sonnet 4.6 and earlier
 * and return 404 for anything newer.
 */
const REQUIRES_MULTI_REGION =
  /^claude-(?:opus-(?:4-[7-9]|[5-9])|sonnet-[5-9]|fable-[5-9]|mythos-[5-9])/;

/**
 * Whether the configured location can serve models that require `global` or a
 * multi-region endpoint.
 */
function servesModernModels(region: string): boolean {
  return MULTI_REGION_LOCATIONS.has(region.trim().toLowerCase());
}

/**
 * Processes models configuration and creates deployment name mapping
 * Similar to Azure's model mapping logic
 * @param models - The models configuration (can be array or object)
 * @param defaultDeploymentName - Optional default deployment name
 * @param region - Configured Vertex location, used to filter the built-in defaults
 * @returns Object containing modelNames array and modelDeploymentMap
 */
function processVertexModels(
  models: string[] | Record<string, TVertexModelConfig> | undefined,
  defaultDeploymentName?: string,
  region?: string,
): { modelNames: string[]; modelDeploymentMap: TVertexModelMap } {
  const modelNames: string[] = [];
  const modelDeploymentMap: TVertexModelMap = {};

  if (!models) {
    /** Only filter the built-in defaults — an explicit list is the operator's
     * choice and is never silently pruned. */
    const canServeModern = region == null || servesModernModels(region);
    for (const model of defaultVertexModels) {
      if (!canServeModern && REQUIRES_MULTI_REGION.test(model)) {
        continue;
      }
      modelNames.push(model);
      modelDeploymentMap[model] = model; // Default: model name = deployment name
    }
    return { modelNames, modelDeploymentMap };
  }

  if (Array.isArray(models)) {
    // Legacy format: simple array of model names
    for (const modelName of models) {
      modelNames.push(modelName);
      // If a default deployment name is provided, use it for all models
      // Otherwise, model name is the deployment name
      modelDeploymentMap[modelName] = defaultDeploymentName || modelName;
    }
  } else {
    // New format: object with model names as keys and config as values
    for (const [modelName, modelConfig] of Object.entries(models)) {
      modelNames.push(modelName);

      if (typeof modelConfig === 'boolean') {
        // Model is set to true/false - use default deployment name or model name
        modelDeploymentMap[modelName] = defaultDeploymentName || modelName;
      } else if (modelConfig?.deploymentName) {
        // Model has its own deployment name specified
        modelDeploymentMap[modelName] = modelConfig.deploymentName;
      } else {
        // Model is an object but no deployment name - use default or model name
        modelDeploymentMap[modelName] = defaultDeploymentName || modelName;
      }
    }
  }

  return { modelNames, modelDeploymentMap };
}

/**
 * Validates and processes Vertex AI configuration
 * @param vertexConfig - The Vertex AI configuration object
 * @returns Validated configuration with errors if any
 */
export function validateVertexConfig(
  vertexConfig: TVertexAISchema | undefined,
): TVertexAIConfig | null {
  if (!vertexConfig) {
    return null;
  }

  const errors: string[] = [];

  // Extract and validate environment variables
  // projectId is optional - will be auto-detected from service key if not provided
  const projectId = vertexConfig.projectId ? extractEnvVariable(vertexConfig.projectId) : undefined;
  const region = extractEnvVariable(vertexConfig.region || 'us-east5');
  const serviceKeyFile = vertexConfig.serviceKeyFile
    ? extractEnvVariable(vertexConfig.serviceKeyFile)
    : undefined;
  const defaultDeploymentName = vertexConfig.deploymentName
    ? extractEnvVariable(vertexConfig.deploymentName)
    : undefined;

  // Check for unresolved environment variables
  if (projectId && envVarRegex.test(projectId)) {
    errors.push(
      `Vertex AI projectId environment variable "${vertexConfig.projectId}" was not found.`,
    );
  }

  if (envVarRegex.test(region)) {
    errors.push(`Vertex AI region environment variable "${vertexConfig.region}" was not found.`);
  }

  if (serviceKeyFile && envVarRegex.test(serviceKeyFile)) {
    errors.push(
      `Vertex AI serviceKeyFile environment variable "${vertexConfig.serviceKeyFile}" was not found.`,
    );
  }

  if (defaultDeploymentName && envVarRegex.test(defaultDeploymentName)) {
    errors.push(
      `Vertex AI deploymentName environment variable "${vertexConfig.deploymentName}" was not found.`,
    );
  }

  // Process models and create deployment mapping
  const { modelNames, modelDeploymentMap } = processVertexModels(
    vertexConfig.models,
    defaultDeploymentName,
    region,
  );

  // Note: projectId is optional - if not provided, it will be auto-detected from the service key file

  const isValid = errors.length === 0;

  return {
    enabled: vertexConfig.enabled !== false,
    projectId,
    region,
    serviceKeyFile,
    deploymentName: defaultDeploymentName,
    models: vertexConfig.models,
    modelNames,
    modelDeploymentMap,
    isValid,
    errors,
  };
}

/**
 * Sets up the Vertex AI configuration from the config (`librechat.yaml`) file.
 * Similar to azureConfigSetup, this processes and validates the Vertex AI configuration.
 * @param config - The loaded custom configuration.
 * @returns The validated Vertex AI configuration or null if not configured.
 */
export function vertexConfigSetup(config: Partial<TCustomConfig>): TVertexAIConfig | null {
  const anthropicConfig = config.endpoints?.[EModelEndpoint.anthropic] as
    | TAnthropicEndpoint
    | undefined;

  if (!anthropicConfig?.vertex) {
    return null;
  }

  const vertexConfig = anthropicConfig.vertex;

  // Skip if explicitly disabled (enabled: false)
  // When vertex config exists, it's enabled by default unless explicitly set to false
  if (vertexConfig.enabled === false) {
    return null;
  }

  const validatedConfig = validateVertexConfig(vertexConfig);

  if (!validatedConfig) {
    return null;
  }

  if (!validatedConfig.isValid) {
    const errorString = validatedConfig.errors.join('\n');
    const errorMessage = 'Invalid Vertex AI configuration:\n' + errorString;
    logger.error(errorMessage);
    throw new Error(errorMessage);
  }

  logger.info('Vertex AI configuration loaded successfully', {
    projectId: validatedConfig.projectId,
    region: validatedConfig.region,
    modelCount: validatedConfig.modelNames?.length || 0,
    models: validatedConfig.modelNames,
  });

  return validatedConfig;
}
