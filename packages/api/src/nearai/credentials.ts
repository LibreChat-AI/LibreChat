import { envVarRegex, extractEnvVariable } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { GetUserKeyValuesFunction } from '~/types/endpoints';
import type { NearAICredentials } from './types';
import { getCustomEndpointConfig } from '~/app/config';
import { isNearAIEndpoint } from './attestation';
import { isUserProvided } from '~/utils/common';

/**
 * Resolves credentials for a NEAR AI custom endpoint from app config.
 * Returns undefined for other endpoints and user-provided URLs. User keys are resolved
 * through the caller's authenticated user and the same database method used by Chat.
 */
export async function getNearAICredentials(
  appConfig: AppConfig | undefined,
  endpoint: string,
  userKey?: {
    userId?: string;
    tenantId?: string | null;
    getUserKeyValues?: GetUserKeyValuesFunction;
  },
): Promise<NearAICredentials | undefined> {
  if (!appConfig) return undefined;
  const endpointConfig = getCustomEndpointConfig({ endpoint, appConfig });
  if (!isNearAIEndpoint(endpointConfig)) return undefined;
  let apiKey = extractEnvVariable(endpointConfig?.apiKey ?? '');
  const baseURL = extractEnvVariable(endpointConfig?.baseURL ?? '');
  if (!apiKey || apiKey.match(envVarRegex)) throw new Error('nearai_credentials_unavailable');
  if (isUserProvided(apiKey)) {
    if (!userKey?.userId || !userKey.getUserKeyValues) {
      throw new Error('nearai_credentials_unavailable');
    }
    const values = await userKey.getUserKeyValues({ userId: userKey.userId, name: endpoint });
    if (typeof values.apiKey !== 'string' || !values.apiKey || isUserProvided(values.apiKey)) {
      throw new Error('nearai_credentials_unavailable');
    }
    apiKey = values.apiKey;
  }
  return {
    apiKey,
    baseURL,
    owner: JSON.stringify([userKey?.tenantId, userKey?.userId]),
    ...(appConfig?.config?.nearai && {
      verificationTimeoutMs: appConfig.config.nearai.verificationTimeoutMs,
      sessionCacheMax: appConfig.config.nearai.sessionCacheMax,
      reportCacheMax: appConfig.config.nearai.reportCacheMax,
      reportCacheTtlMs: appConfig.config.nearai.reportCacheTtlMs,
    }),
  };
}
