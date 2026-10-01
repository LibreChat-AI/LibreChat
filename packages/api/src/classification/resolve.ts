import { logger } from '@librechat/data-schemas';
import type { TClassificationConfig } from 'librechat-data-provider';
import type { ProviderFetch } from './providers/transport';
import type { Classifier } from './types';
import {
  presetFor,
  mergeSettings,
  createClassifier,
  providerNames,
  DEFAULT_API_KEY_ENV,
} from './registry';
import { ClassificationError } from './types';

interface CacheEntry {
  apiKey: string;
  provider: string;
  classifier: Classifier;
}

const cache = new WeakMap<TClassificationConfig, CacheEntry>();
const warned = new Set<string>();

export interface ResolveClassifierParams {
  config?: TClassificationConfig | null;
  apiKey?: string;
  fetch?: ProviderFetch;
}

export function resolveClassifier(params: ResolveClassifierParams): Classifier | null {
  const config = params.config;
  if (config == null || config.enabled !== true) {
    return null;
  }

  const providerId = config.provider;
  const configured = config.providers?.[providerId];
  const preset = presetFor(providerId);
  /** An unknown name is fine when the operator described the host in full. */
  if (preset == null && configured?.baseURL == null) {
    if (!warned.has(`unknown:${providerId}`)) {
      warned.add(`unknown:${providerId}`);
      logger.warn(
        `[classification] provider "${providerId}" has no preset and no baseURL. ` +
          `Known presets: ${providerNames().join(', ')}. Classification stays off.`,
      );
    }
    return null;
  }

  const settings = mergeSettings(preset, configured);
  if (!settings.baseURL) {
    if (!warned.has(`url:${providerId}`)) {
      warned.add(`url:${providerId}`);
      logger.warn(
        `[classification] provider "${providerId}" needs a baseURL; classification stays off.`,
      );
    }
    return null;
  }
  const apiKeyEnv = settings.apiKeyEnv ?? DEFAULT_API_KEY_ENV;
  const apiKey = (params.apiKey ?? process.env[apiKeyEnv] ?? '').trim();
  if (!apiKey) {
    if (!warned.has(`key:${providerId}`)) {
      warned.add(`key:${providerId}`);
      logger.warn(
        `[classification] provider "${providerId}" is configured but ${apiKeyEnv} is not set; ` +
          'every classification capability stays off.',
      );
    }
    return null;
  }

  const cached = cache.get(config);
  if (cached != null && cached.apiKey === apiKey && cached.provider === providerId) {
    return cached.classifier;
  }

  try {
    const classifier = createClassifier(settings, apiKey, params.fetch, providerId);
    cache.set(config, { apiKey, provider: providerId, classifier });
    return classifier;
  } catch (error) {
    logger.error(
      `[classification] could not build provider "${providerId}"; capabilities stay off`,
      error instanceof ClassificationError ? { failure: error.failure } : error,
    );
    return null;
  }
}
