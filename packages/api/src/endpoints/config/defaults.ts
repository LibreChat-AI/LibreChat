import { logger } from '@librechat/data-schemas';
import { EModelEndpoint } from 'librechat-data-provider';
import type { TModelsConfig } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { CatalogDiscoveryOptions } from '~/endpoints/models';
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
  options?: CatalogDiscoveryOptions,
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
        ...options,
      }),
    [EModelEndpoint.anthropic]: () =>
      loaders.getAnthropicModels({
        user: req.user?.id,
        userObject: req.user,
        headers: mergeHeaders(allHeaders, appConfig.endpoints?.anthropic?.headers),
        vertexModels: appConfig.endpoints?.anthropic?.vertexConfig?.modelNames,
        configuredModels: configuredModelList(appConfig, EModelEndpoint.anthropic),
        ...options,
      }),
    [EModelEndpoint.azureOpenAI]: () =>
      loaders.getOpenAIModels({ user: req.user?.id, azure: true, ...options }),
    [EModelEndpoint.assistants]: () => loaders.getOpenAIModels({ assistants: true, ...options }),
    [EModelEndpoint.azureAssistants]: () => loaders.getOpenAIModels({ azure: true, ...options }),
    [EModelEndpoint.google]: () => loaders.getGoogleModels(),
    [EModelEndpoint.bedrock]: () => loaders.getBedrockModels(),
  };
  if (!Object.prototype.hasOwnProperty.call(sources, endpoint)) {
    return {};
  }
  try {
    return { [endpoint]: await sources[endpoint]() };
  } catch (error) {
    if (options?.strictDiscovery) {
      throw error;
    }
    logger.error('Error fetching endpoint models:', getSafeErrorMetadata(error));
    return { [endpoint]: [] };
  }
}
