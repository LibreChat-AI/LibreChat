import logger from '~/config/winston';
import {
  Capabilities,
  EModelEndpoint,
  assistantEndpointSchema,
  defaultAssistantsVersion,
} from 'librechat-data-provider';
import type { TCustomConfig, TAssistantEndpoint } from 'librechat-data-provider';

/**
 * Sets up the minimum, default Assistants configuration if Azure OpenAI Assistants option is enabled.
 * @returns The Assistants endpoint configuration.
 */
export function azureAssistantsDefaults(): {
  capabilities: TAssistantEndpoint['capabilities'];
  version: TAssistantEndpoint['version'];
} {
  return {
    capabilities: [Capabilities.tools, Capabilities.actions, Capabilities.code_interpreter],
    version: defaultAssistantsVersion.azureAssistants,
  };
}

/**
 * Sets up the Assistants configuration from the config (`librechat.yaml`) file.
 * @param config - The loaded custom configuration.
 * @param assistantsEndpoint - The Assistants endpoint name.
 * - The previously loaded assistants configuration from Azure OpenAI Assistants option.
 * @param [prevConfig]
 * @returns The Assistants endpoint configuration.
 */
export function assistantsConfigSetup(
  config: Partial<TCustomConfig>,
  assistantsEndpoint: EModelEndpoint.assistants | EModelEndpoint.azureAssistants,
  prevConfig: Partial<TAssistantEndpoint> = {},
): Partial<TAssistantEndpoint> {
  const assistantsConfig = config.endpoints?.[assistantsEndpoint];
  const parsedConfig = assistantEndpointSchema.parse(assistantsConfig);
  if (assistantsConfig?.supportedIds?.length && assistantsConfig.excludedIds?.length) {
    logger.warn(
      `Configuration conflict: The '${assistantsEndpoint}' endpoint has both 'supportedIds' and 'excludedIds' defined. The 'excludedIds' will be ignored.`,
    );
  }
  if (
    assistantsConfig?.privateAssistants &&
    (assistantsConfig.supportedIds?.length || assistantsConfig.excludedIds?.length)
  ) {
    logger.warn(
      `Configuration conflict: The '${assistantsEndpoint}' endpoint has both 'privateAssistants' and 'supportedIds' or 'excludedIds' defined. The 'supportedIds' and 'excludedIds' will be ignored.`,
    );
  }

  return {
    ...prevConfig,
    version:
      assistantsConfig?.version != null
        ? parsedConfig.version
        : (prevConfig.version ?? parsedConfig.version),
    retrievalModels: parsedConfig.retrievalModels,
    disableBuilder: parsedConfig.disableBuilder,
    pollIntervalMs: parsedConfig.pollIntervalMs,
    supportedIds: parsedConfig.supportedIds,
    capabilities: parsedConfig.capabilities,
    excludedIds: parsedConfig.excludedIds,
    privateAssistants: parsedConfig.privateAssistants,
    timeoutMs: parsedConfig.timeoutMs,
    streamRate: parsedConfig.streamRate,
    titlePrompt: parsedConfig.titlePrompt,
    titleMethod: parsedConfig.titleMethod,
    titleModel: parsedConfig.titleModel,
    titleEndpoint: parsedConfig.titleEndpoint,
    titlePromptTemplate: parsedConfig.titlePromptTemplate,
  };
}
