import { EModelEndpoint } from 'librechat-data-provider';
import type {
  TEndpoint,
  TCustomConfig,
  TAgentsEndpoint,
  TAnthropicEndpoint,
} from 'librechat-data-provider';
import type { AppConfig } from '~/types';
import { azureAssistantsDefaults, assistantsConfigSetup } from './assistants';
import { agentsConfigSetup } from './agents';
import { vertexConfigSetup } from './vertex';
import { azureConfigSetup } from './azure';

/**
 * Loads custom config endpoints
 * @param [config]
 * @param [agentsDefaults]
 */
export const loadEndpoints = (
  config: Partial<TCustomConfig>,
  agentsDefaults?: Partial<TAgentsEndpoint>,
): {
  allowedAddresses?: string[];
  openAI?: Partial<import('librechat-data-provider').TEndpoint>;
  google?: Partial<import('librechat-data-provider').TEndpoint>;
  bedrock?: Partial<import('librechat-data-provider').TEndpoint>;
  anthropic?: Partial<TAnthropicEndpoint> & {
    vertexConfig?: import('librechat-data-provider').TVertexAIConfig;
  };
  azureOpenAI?: import('librechat-data-provider').TAzureConfig;
  assistants?: Partial<import('librechat-data-provider').TAssistantEndpoint>;
  azureAssistants?: Partial<import('librechat-data-provider').TAssistantEndpoint>;
  all?: Partial<import('librechat-data-provider').TEndpoint>;
  agents?: Partial<TAgentsEndpoint>;
  custom?: import('librechat-data-provider').TCustomEndpoints;
} => {
  const loadedEndpoints: AppConfig['endpoints'] = {};
  const endpoints = config?.endpoints;

  if (endpoints?.[EModelEndpoint.azureOpenAI]) {
    loadedEndpoints[EModelEndpoint.azureOpenAI] = azureConfigSetup(config);
  }

  if (endpoints?.[EModelEndpoint.azureOpenAI]?.assistants) {
    loadedEndpoints[EModelEndpoint.azureAssistants] = azureAssistantsDefaults();
  }

  if (endpoints?.[EModelEndpoint.azureAssistants]) {
    loadedEndpoints[EModelEndpoint.azureAssistants] = assistantsConfigSetup(
      config,
      EModelEndpoint.azureAssistants,
      loadedEndpoints[EModelEndpoint.azureAssistants],
    );
  }

  if (endpoints?.[EModelEndpoint.assistants]) {
    loadedEndpoints[EModelEndpoint.assistants] = assistantsConfigSetup(
      config,
      EModelEndpoint.assistants,
      loadedEndpoints[EModelEndpoint.assistants],
    );
  }

  loadedEndpoints[EModelEndpoint.agents] = agentsConfigSetup(config, agentsDefaults);

  // Handle Anthropic endpoint with Vertex AI configuration
  if (endpoints?.[EModelEndpoint.anthropic]) {
    const anthropicConfig = endpoints[EModelEndpoint.anthropic] as TAnthropicEndpoint;
    const vertexConfig = vertexConfigSetup(config);

    loadedEndpoints[EModelEndpoint.anthropic] = {
      ...anthropicConfig,
      // If Vertex AI is enabled, use the visible model names from vertex config
      // Otherwise, use the models array from anthropic config
      ...(vertexConfig?.modelNames && { models: vertexConfig.modelNames }),
      // Attach validated Vertex AI config if present
      ...(vertexConfig && { vertexConfig }),
    };
  }

  const endpointKeys = [
    EModelEndpoint.openAI,
    EModelEndpoint.google,
    EModelEndpoint.custom,
    EModelEndpoint.bedrock,
  ];

  endpointKeys.forEach((key) => {
    const currentKey = key as keyof typeof endpoints;
    if (endpoints?.[currentKey]) {
      loadedEndpoints[currentKey] = endpoints[currentKey];
    }
  });

  if (endpoints?.all) {
    /**
     * `DeepPartial<TCustomConfig>` widens record values to `string | undefined`
     * (e.g. `headers`), so cast to the concrete endpoint type — mirrors the
     * `anthropicConfig as TAnthropicEndpoint` cast above.
     */
    loadedEndpoints.all = endpoints.all as Partial<TEndpoint>;
  }

  if (endpoints?.allowedAddresses) {
    loadedEndpoints.allowedAddresses = endpoints.allowedAddresses;
  }

  return loadedEndpoints;
};
