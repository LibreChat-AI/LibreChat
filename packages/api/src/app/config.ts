import { logger } from '@librechat/data-schemas';
import {
  EModelEndpoint,
  removeNullishValues,
  normalizeEndpointName,
} from 'librechat-data-provider';
import type {
  TEndpoint,
  TCustomConfig,
  EndpointsDropParamsMap,
  TTransactionsConfig,
} from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import { resolveCustomEndpointSecrets } from '~/admin/secrets';
import { isEnabled } from '~/utils';

/**
 * Retrieves the balance configuration object
 * */
export function getBalanceConfig(appConfig?: AppConfig): Partial<TCustomConfig['balance']> | null {
  const isLegacyEnabled = isEnabled(process.env.CHECK_BALANCE);
  const startBalance = process.env.START_BALANCE;
  /** @type {} */
  const config: Partial<TCustomConfig['balance']> = removeNullishValues({
    enabled: isLegacyEnabled,
    startBalance: startBalance != null && startBalance ? parseInt(startBalance, 10) : undefined,
  });
  if (!appConfig) {
    return config;
  }
  return { ...config, ...(appConfig?.['balance'] ?? {}) };
}

/**
 * Retrieves the transactions configuration object
 * */
export function getTransactionsConfig(appConfig?: AppConfig): Partial<TTransactionsConfig> {
  const defaultConfig: TTransactionsConfig = { enabled: true };

  if (!appConfig) {
    return defaultConfig;
  }

  const transactionsConfig = appConfig?.['transactions'] ?? defaultConfig;
  const balanceConfig = getBalanceConfig(appConfig);

  // If balance is enabled but transactions are disabled, force transactions to be enabled
  // and log a warning
  if (balanceConfig?.enabled && !transactionsConfig.enabled) {
    logger.warn(
      'Configuration warning: transactions.enabled=false is incompatible with balance.enabled=true. ' +
        'Transactions will be enabled to ensure balance tracking works correctly.',
    );
    return { ...transactionsConfig, enabled: true };
  }

  return transactionsConfig;
}

export const getCustomEndpointConfig = ({
  endpoint,
  appConfig,
}: {
  endpoint: string | EModelEndpoint;
  appConfig?: AppConfig;
}): Partial<TEndpoint> | undefined => {
  if (!appConfig) {
    throw new Error(`Config not found for the ${endpoint} custom endpoint.`);
  }

  const customEndpoints = appConfig.endpoints?.[EModelEndpoint.custom] ?? [];
  const endpointConfig = customEndpoints.find(
    (config) => normalizeEndpointName(config.name) === normalizeEndpointName(endpoint),
  );
  return endpointConfig && resolveCustomEndpointSecrets(endpointConfig);
};

/**
 * Builds a map of normalized endpoint name -> dropParams for the endpoint shapes that
 * support per-endpoint dropParams: array-configured `custom` endpoints map directly to
 * their dropParams, while `azureOpenAI` maps to a per-model lookup (model name ->
 * dropParams) built from `modelGroupMap`/`groupMap`, mirroring the per-request group
 * resolution in `initializeOpenAI` so a parameter dropped for one group doesn't hide it
 * for models in another group.
 */
export function getEndpointsDropParamsMap(
  endpoints: AppConfig['endpoints'],
): EndpointsDropParamsMap {
  const result: EndpointsDropParamsMap = {};
  if (!endpoints) {
    return result;
  }

  endpoints[EModelEndpoint.custom]?.forEach((endpoint) => {
    if (endpoint?.dropParams && endpoint.dropParams.length > 0) {
      result[normalizeEndpointName(endpoint.name ?? '')] = endpoint.dropParams;
    }
  });

  const azureConfig = endpoints[EModelEndpoint.azureOpenAI];
  if (azureConfig?.groupMap && azureConfig?.modelGroupMap) {
    const { groupMap, modelGroupMap } = azureConfig;
    const modelDropParams: Record<string, string[]> = {};
    Object.entries(modelGroupMap).forEach(([modelName, modelConfig]) => {
      const dropParams = modelConfig && groupMap[modelConfig.group]?.dropParams;
      if (dropParams && dropParams.length > 0) {
        modelDropParams[modelName] = dropParams;
      }
    });
    if (Object.keys(modelDropParams).length > 0) {
      result[normalizeEndpointName(EModelEndpoint.azureOpenAI)] = modelDropParams;
    }
  }

  return result;
}
