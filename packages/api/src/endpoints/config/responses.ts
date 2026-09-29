import { EModelEndpoint, mapModelToAzureConfig } from 'librechat-data-provider';
import type { ResponsesApiRouting } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import { getOpenAIEndpointParameters } from '../openai/parameters';
import { getBuiltInBaseURL } from '../openai/initialize';
import { getAzureCredentials } from '~/utils/azure';
import { getOpenAIConfig } from '../openai/config';
import { isUserProvided } from '~/utils/common';

/** Publish only routing booleans, never URLs, credentials, headers or addParams.
 * Uses the same request shaper as execution, so parameter precedence is not
 * reimplemented in the browser. No inference requests or database reads. */
export function getResponsesApiRouting(
  appConfig: AppConfig,
  endpoint: EModelEndpoint.openAI | EModelEndpoint.azureOpenAI,
): ResponsesApiRouting {
  const isAzure = endpoint === EModelEndpoint.azureOpenAI;
  const azureConfig = appConfig.endpoints?.azureOpenAI;
  const models =
    isAzure && azureConfig
      ? Object.keys(azureConfig.modelGroupMap ?? {})
      : ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'];
  const result: ResponsesApiRouting = {};
  for (const model of ['*', ...models]) {
    try {
      let baseURL = getBuiltInBaseURL(endpoint);
      let azure: NonNullable<Parameters<typeof getOpenAIConfig>[1]>['azure'];
      const { addParams, dropParams } = getOpenAIEndpointParameters(appConfig, endpoint, model);
      if (isAzure && azureConfig) {
        // Unknown deployments must not acquire a guessed Responses capability.
        if (model === '*') {
          result[model] = { default: false, on: false, off: false };
          continue;
        }
        const mapped = mapModelToAzureConfig({ modelName: model, ...azureConfig });
        baseURL = mapped.baseURL ?? baseURL;
        azure = mapped.serverless ? undefined : mapped.azureOptions;
      } else if (isAzure) {
        azure = getAzureCredentials();
      }
      // A user URL is unavailable without a credential read. Evaluate the
      // noncanonical case: explicit/admin-forced routes still survive, whereas
      // automatic model inference is conservatively withheld.
      if (isUserProvided(baseURL)) baseURL = 'https://user-url.invalid/v1';
      const route = (value?: boolean, webSearch?: boolean) =>
        getOpenAIConfig(
          'route-policy',
          {
            streaming: true,
            reverseProxyUrl: baseURL,
            azure,
            addParams,
            dropParams,
            modelOptions: {
              model: model === '*' ? '' : model,
              ...(value == null ? {} : { useResponsesApi: value }),
              ...(webSearch ? { web_search: true } : {}),
            },
          },
          endpoint,
        ).llmConfig.useResponsesApi === true;
      result[model] = {
        default: route(),
        on: route(true),
        off: route(false),
        withWebSearch: {
          default: route(undefined, true),
          on: route(true, true),
          off: route(false, true),
        },
      };
    } catch {
      // Incomplete configuration must not break /api/endpoints or advertise
      // uploads for a route that execution cannot construct.
      result[model] = { default: false, on: false, off: false };
    }
  }
  if (!azureConfig || !isAzure) {
    // Only environment-based routes accept discovered snapshots. Configured
    // Azure deployments are an exact allowlist and must never inherit this.
    for (const model of models) result[`${model}-*`] = result[model];
  }
  return result;
}
