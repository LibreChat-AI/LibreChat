import crypto from 'crypto';
import { logger } from '@librechat/data-schemas';
import {
  ErrorTypes,
  EModelEndpoint,
  extractEnvVariable,
  extractVariableName,
  normalizeEndpointName,
} from 'librechat-data-provider';
import type { TModelsConfig, TEndpoint } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { ServerRequest, GetUserKeyValuesFunction, UserKeyValues } from '~/types';
import type { FetchModelsParams } from '~/endpoints/models';
import type { GetAppConfigOptions } from '~/app/service';
import { fetchModels as defaultFetchModels } from '~/endpoints/models';
import { getTokenConfigKey } from '~/endpoints/custom/initialize';
import { getAppConfigOptionsFromUser } from '~/app/service';
import { resolveConfigSecret } from '~/admin/secrets';
import { validateEndpointURL } from '~/auth';
import { tokenConfigCache } from '~/cache';
import { isUserProvided } from '~/utils';

/**
 * Stable fingerprint of a headers object, used to disambiguate the
 * in-request fetch-coalescing key. Two endpoints that share the same
 * baseURL+apiKey but configure different headers must NOT share a fetch
 * promise, otherwise the first endpoint's filtered /models response would
 * be reused for the other in the same request.
 */
function headersFingerprint(headers: Record<string, string> | undefined): string {
  if (!headers || Object.keys(headers).length === 0) {
    return '';
  }
  const ordered = Object.keys(headers)
    .sort()
    .map((k) => [k, headers[k]]);
  return crypto.createHash('sha256').update(JSON.stringify(ordered)).digest('hex').slice(0, 16);
}

interface ResolvedEndpoint {
  name: string;
  endpoint: TEndpoint;
  apiKey: string;
  baseURL: string;
  apiKeyIsUserProvided: boolean;
  baseURLIsUserProvided: boolean;
}

function resolveDefaultModelNames(defaultModels: TEndpoint['models']['default']): string[] {
  return defaultModels.flatMap((model) => {
    const rawModelName = typeof model === 'string' ? model : model.name;
    const envVarName = extractVariableName(rawModelName);
    const resolvedModelName = extractEnvVariable(rawModelName);

    if (envVarName && resolvedModelName.includes(',')) {
      return resolvedModelName
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean);
    }

    return [resolvedModelName];
  });
}

export interface LoadConfigModelsDeps {
  getAppConfig: (params: GetAppConfigOptions) => Promise<AppConfig>;
  getUserKeyValues: GetUserKeyValuesFunction;
  fetchModels?: (params: FetchModelsParams) => Promise<string[]>;
}

export function createLoadConfigModels(deps: LoadConfigModelsDeps) {
  const { getAppConfig, getUserKeyValues, fetchModels = defaultFetchModels } = deps;

  return async function loadConfigModels(req: ServerRequest): Promise<TModelsConfig> {
    const appConfig = req.config ?? (await getAppConfig(getAppConfigOptionsFromUser(req.user)));
    if (!appConfig) {
      return {};
    }

    const modelsConfig: TModelsConfig = {};
    const azureConfig = appConfig.endpoints?.[EModelEndpoint.azureOpenAI];
    const { modelNames } = azureConfig ?? {};

    if (modelNames && azureConfig) {
      modelsConfig[EModelEndpoint.azureOpenAI] = modelNames;
    }

    if (azureConfig?.assistants && azureConfig.assistantModels) {
      modelsConfig[EModelEndpoint.azureAssistants] = azureConfig.assistantModels;
    }

    const bedrockConfig = appConfig.endpoints?.[EModelEndpoint.bedrock];
    if (bedrockConfig?.models && Array.isArray(bedrockConfig.models)) {
      modelsConfig[EModelEndpoint.bedrock] = bedrockConfig.models;
    }

    if (!Array.isArray(appConfig.endpoints?.[EModelEndpoint.custom])) {
      return modelsConfig;
    }

    const customEndpoints = (appConfig.endpoints[EModelEndpoint.custom] as TEndpoint[]).filter(
      (endpoint) =>
        endpoint.baseURL &&
        endpoint.apiKey &&
        endpoint.name &&
        endpoint.models &&
        (endpoint.models.fetch || endpoint.models.default),
    );

    const fetchPromisesMap: Record<string, Promise<string[]>> = {};
    const uniqueKeyToEndpointsMap: Record<string, string[]> = {};
    /** tokenKey the deduped fetch cached its token config under, so siblings
     *  sharing the fetch can be backfilled with the same config afterward */
    const uniqueKeyToTokenKey: Record<string, string> = {};
    const endpointsMap: Record<string, TEndpoint> = {};
    const tenantId = req.user?.tenantId;

    const resolved: ResolvedEndpoint[] = [];
    const userKeyEndpoints: ResolvedEndpoint[] = [];

    for (let i = 0; i < customEndpoints.length; i++) {
      const endpoint = customEndpoints[i];
      const { name: configName, baseURL, apiKey } = endpoint;
      const name = normalizeEndpointName(configName);
      endpointsMap[name] = endpoint;
      modelsConfig[name] = [];

      const resolvedApiKey = resolveConfigSecret(apiKey) ?? '';
      const resolvedBaseURL = extractEnvVariable(baseURL);
      const entry: ResolvedEndpoint = {
        name,
        endpoint,
        apiKey: resolvedApiKey,
        baseURL: resolvedBaseURL,
        apiKeyIsUserProvided: isUserProvided(resolvedApiKey),
        baseURLIsUserProvided: isUserProvided(resolvedBaseURL),
      };
      resolved.push(entry);

      if (
        endpoint.models?.fetch &&
        (entry.apiKeyIsUserProvided || entry.baseURLIsUserProvided) &&
        req.user?.id
      ) {
        userKeyEndpoints.push(entry);
      }
    }

    const userKeyMap = new Map<string, UserKeyValues | null>();
    if (userKeyEndpoints.length > 0 && req.user?.id) {
      const userId = req.user.id;
      const results = await Promise.allSettled(
        userKeyEndpoints.map((e) => getUserKeyValues({ userId, name: e.name })),
      );
      for (let i = 0; i < userKeyEndpoints.length; i++) {
        const settled = results[i];
        if (settled.status === 'fulfilled') {
          userKeyMap.set(userKeyEndpoints[i].name, settled.value);
        } else {
          const msg =
            settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
          const isKeyNotFound =
            msg.includes(ErrorTypes.NO_USER_KEY) || msg.includes(ErrorTypes.INVALID_USER_KEY);
          if (isKeyNotFound) {
            logger.debug(
              `[loadConfigModels] No user key stored for endpoint "${userKeyEndpoints[i].name}"`,
            );
          } else {
            logger.warn(
              `[loadConfigModels] Failed to retrieve user key for "${userKeyEndpoints[i].name}": ${msg}`,
            );
          }
          userKeyMap.set(userKeyEndpoints[i].name, null);
        }
      }
    }

    for (const {
      name,
      endpoint,
      apiKey: API_KEY,
      baseURL: BASE_URL,
      apiKeyIsUserProvided,
      baseURLIsUserProvided,
    } of resolved) {
      const { models, headers: endpointHeaders } = endpoint;
      // Include a fingerprint of the configured headers so two admin-trusted
      // endpoints that happen to share the same baseURL+apiKey but configure
      // different (potentially user-bound) headers don't reuse each other's
      // fetched model list within the same request.
      const uniqueKey = `${BASE_URL}__${API_KEY}__${headersFingerprint(endpointHeaders)}`;

      if (models?.fetch && !apiKeyIsUserProvided && !baseURLIsUserProvided) {
        if (!fetchPromisesMap[uniqueKey]) {
          /** User-scoped when configured headers resolve per user — the
           *  derived token config must not be cached under the shared name */
          const tokenKey = getTokenConfigKey(endpoint, name, req.user?.id ?? '', tenantId);
          uniqueKeyToTokenKey[uniqueKey] = tokenKey;
          fetchPromisesMap[uniqueKey] = fetchModels({
            name,
            apiKey: API_KEY,
            baseURL: BASE_URL,
            baseURLIsUserProvided: false,
            allowedAddresses: appConfig.endpoints?.allowedAddresses,
            user: req.user?.id,
            userObject: req.user,
            headers: endpointHeaders,
            direct: endpoint.directEndpoint,
            userIdQuery: models.userIdQuery,
            tokenKey,
          });
        }
        uniqueKeyToEndpointsMap[uniqueKey] = uniqueKeyToEndpointsMap[uniqueKey] || [];
        uniqueKeyToEndpointsMap[uniqueKey].push(name);
        continue;
      }

      if (models?.fetch && userKeyMap.has(name)) {
        const userKeyValues = userKeyMap.get(name);
        const resolvedApiKey =
          apiKeyIsUserProvided || baseURLIsUserProvided ? userKeyValues?.apiKey : API_KEY;
        const resolvedBaseURL = baseURLIsUserProvided ? userKeyValues?.baseURL : BASE_URL;

        if (resolvedApiKey && resolvedBaseURL) {
          const userFetchKey = `user:${req.user?.id}:${name}`;
          fetchPromisesMap[userFetchKey] =
            fetchPromisesMap[userFetchKey] ||
            (async () => {
              if (baseURLIsUserProvided) {
                await validateEndpointURL(
                  resolvedBaseURL,
                  name,
                  appConfig.endpoints?.allowedAddresses,
                );
              }
              return fetchModels({
                name,
                apiKey: resolvedApiKey,
                baseURL: resolvedBaseURL,
                baseURLIsUserProvided,
                allowedAddresses: appConfig.endpoints?.allowedAddresses,
                user: req.user?.id,
                userObject: req.user,
                // Do not forward header overrides when the base URL is
                // user-supplied: configured templates such as
                // {{LIBRECHAT_OPENID_ID_TOKEN}} would otherwise resolve and be
                // sent to a destination the user controls, leaking the user's
                // identity token. Header overrides are only safe for endpoints
                // whose base URL is admin-trusted.
                headers: baseURLIsUserProvided ? undefined : endpointHeaders,
                direct: endpoint.directEndpoint,
                userIdQuery: models.userIdQuery,
                skipCache: true,
                /** Fetched with the user's key/URL — always user-scoped */
                tokenKey: getTokenConfigKey(endpoint, name, req.user?.id ?? '', tenantId),
              });
            })();
          uniqueKeyToEndpointsMap[userFetchKey] = uniqueKeyToEndpointsMap[userFetchKey] || [];
          uniqueKeyToEndpointsMap[userFetchKey].push(name);
          continue;
        }
      }

      if (Array.isArray(models?.default)) {
        modelsConfig[name] = resolveDefaultModelNames(models.default);
      }
    }

    const settledResults = await Promise.allSettled(Object.values(fetchPromisesMap));
    const uniqueKeys = Object.keys(fetchPromisesMap);

    for (let i = 0; i < settledResults.length; i++) {
      const currentKey = uniqueKeys[i];
      const settled = settledResults[i];
      if (settled.status === 'rejected') {
        logger.warn(`[loadConfigModels] Model fetch failed for "${currentKey}":`, settled.reason);
      }
      const modelData = settled.status === 'fulfilled' ? settled.value : [];
      const associatedNames = uniqueKeyToEndpointsMap[currentKey];

      for (const name of associatedNames) {
        const endpoint = endpointsMap[name];
        const defaults = resolveDefaultModelNames(endpoint.models?.default ?? []);
        modelsConfig[name] = !modelData?.length ? defaults : modelData;
      }

      /** A shared fetch caches token config under one endpoint's tokenKey;
       *  copy it to the siblings so /token-config resolves each by its own
       *  name (the query is staleTime:Infinity and won't recover otherwise) */
      const winnerTokenKey = uniqueKeyToTokenKey[currentKey];
      if (settled.status === 'fulfilled' && winnerTokenKey != null && associatedNames.length > 1) {
        const cache = tokenConfigCache();
        const config = await cache.get(winnerTokenKey);
        if (config != null) {
          for (const name of associatedNames) {
            const siblingKey = getTokenConfigKey(
              endpointsMap[name],
              name,
              req.user?.id ?? '',
              tenantId,
            );
            if (siblingKey !== winnerTokenKey) {
              await cache.set(siblingKey, config);
            }
          }
        }
      }
    }

    return modelsConfig;
  };
}
