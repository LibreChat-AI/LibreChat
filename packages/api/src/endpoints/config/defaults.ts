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
import { isUserProvided } from '~/utils/common';
import { mergeHeaders } from '~/utils/headers';
import { configuredModelList } from './models';
import { extractBaseURL } from '~/utils/url';

type ActiveKey = { userId: string; name: string; activeOnly: true };

export interface CatalogCredentials {
  getUserKey?: (input: ActiveKey) => Promise<string>;
  getUserKeyValues?: (input: ActiveKey) => Promise<Record<string, string>>;
}

type DefaultCatalogOptions = CatalogDiscoveryOptions & { credentials?: CatalogCredentials };

function canUseStoredKey(proxy?: string): boolean {
  if (!proxy) return true;
  const base = extractBaseURL(proxy);
  return !!base && URL.canParse(base) && ['http:', 'https:'].includes(new URL(base).protocol);
}

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
  options?: DefaultCatalogOptions,
  loaders: DefaultModelLoaders = {
    getOpenAIModels,
    getAnthropicModels,
    getGoogleModels,
    getBedrockModels,
  },
): Promise<TModelsConfig> {
  const strict = options?.strictDiscovery ? { strictDiscovery: true } : {};
  const userId = req.user?.id;
  const { getUserKey, getUserKeyValues } = options?.credentials ?? {};
  const userKey =
    options?.strictDiscovery && userId
      ? { userId, name: endpoint, activeOnly: true as const }
      : undefined;
  const allHeaders = appConfig.endpoints?.all?.headers;
  const sources: Record<string, () => string[] | Promise<string[]>> = {
    [EModelEndpoint.openAI]: () =>
      loaders.getOpenAIModels({
        user: req.user?.id,
        userObject: req.user,
        headers: mergeHeaders(allHeaders, appConfig.endpoints?.openAI?.headers),
        configuredModels: configuredModelList(appConfig, EModelEndpoint.openAI),
        ...strict,
        ...(userKey &&
        getUserKeyValues &&
        (isUserProvided(process.env.OPENAI_REVERSE_PROXY) ||
          canUseStoredKey(process.env.OPENAI_REVERSE_PROXY))
          ? {
              getUserConnection: () => getUserKeyValues(userKey),
              allowedAddresses: appConfig.endpoints?.allowedAddresses,
            }
          : {}),
      }),
    [EModelEndpoint.anthropic]: () =>
      loaders.getAnthropicModels({
        user: req.user?.id,
        userObject: req.user,
        headers: mergeHeaders(allHeaders, appConfig.endpoints?.anthropic?.headers),
        vertexModels: appConfig.endpoints?.anthropic?.vertexConfig?.modelNames,
        configuredModels: configuredModelList(appConfig, EModelEndpoint.anthropic),
        ...strict,
        ...(userKey && getUserKey && canUseStoredKey(process.env.ANTHROPIC_REVERSE_PROXY)
          ? { getUserApiKey: () => getUserKey(userKey) }
          : {}),
      }),
    [EModelEndpoint.azureOpenAI]: () =>
      loaders.getOpenAIModels({ user: req.user?.id, azure: true, ...strict }),
    [EModelEndpoint.assistants]: () => loaders.getOpenAIModels({ assistants: true, ...strict }),
    [EModelEndpoint.azureAssistants]: () => loaders.getOpenAIModels({ azure: true, ...strict }),
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
