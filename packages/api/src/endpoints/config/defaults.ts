import { logger } from '@librechat/data-schemas';
import { EModelEndpoint } from 'librechat-data-provider';
import type { TModelsConfig } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types';
import {
  getOpenAIModels,
  getAnthropicModels,
  getGoogleModels,
  getBedrockModels,
} from '~/endpoints/models';
import { getSafeErrorMetadata } from '~/utils/errors';
import { mergeHeaders } from '~/utils/headers';
import { configuredModelList } from './models';

export interface DefaultModelLoaders {
  getOpenAIModels: typeof getOpenAIModels;
  getAnthropicModels: typeof getAnthropicModels;
  getGoogleModels: typeof getGoogleModels;
  getBedrockModels: typeof getBedrockModels;
}

/** Invoke only the requested provider, retaining the existing discovery/cache path. */
export async function loadDefaultEndpointModels(
  req: ServerRequest,
  appConfig: AppConfig,
  endpoint: string,
  loaders: DefaultModelLoaders = {
    getOpenAIModels,
    getAnthropicModels,
    getGoogleModels,
    getBedrockModels,
  },
): Promise<TModelsConfig> {
  const allHeaders = appConfig.endpoints?.all?.headers;
  const sources: Record<string, () => string[] | Promise<string[]>> = {
    [EModelEndpoint.openAI]: () =>
      loaders.getOpenAIModels({
        user: req.user?.id,
        userObject: req.user,
        headers: mergeHeaders(allHeaders, appConfig.endpoints?.openAI?.headers),
        configuredModels: configuredModelList(appConfig, EModelEndpoint.openAI),
      }),
    [EModelEndpoint.anthropic]: () =>
      loaders.getAnthropicModels({
        user: req.user?.id,
        userObject: req.user,
        headers: mergeHeaders(allHeaders, appConfig.endpoints?.anthropic?.headers),
        vertexModels: appConfig.endpoints?.anthropic?.vertexConfig?.modelNames,
        configuredModels: configuredModelList(appConfig, EModelEndpoint.anthropic),
      }),
    [EModelEndpoint.azureOpenAI]: () =>
      loaders.getOpenAIModels({ user: req.user?.id, azure: true }),
    [EModelEndpoint.assistants]: () => loaders.getOpenAIModels({ assistants: true }),
    [EModelEndpoint.azureAssistants]: () => loaders.getOpenAIModels({ azure: true }),
    [EModelEndpoint.google]: () => loaders.getGoogleModels(),
    [EModelEndpoint.bedrock]: () => loaders.getBedrockModels(),
  };
  if (!Object.prototype.hasOwnProperty.call(sources, endpoint)) {
    return {};
  }
  try {
    return { [endpoint]: await sources[endpoint]() };
  } catch (error) {
    logger.error('Error fetching endpoint models:', getSafeErrorMetadata(error));
    return { [endpoint]: [] };
  }
}
