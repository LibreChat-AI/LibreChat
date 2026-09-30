import type { TClassificationProviderConfig } from 'librechat-data-provider';
import type { ProviderFetch } from './providers/transport';
import type { Classifier } from './types';
import { createHttpClassifier } from './providers/http';

export type ProviderSettings = TClassificationProviderConfig;

export const DEFAULT_API_KEY_ENV = 'CLASSIFIER_API_KEY';

/**
 * Known hosts, as settings rather than code. They all serve the same question
 * shapes over HTTP and differ only in URL, model name and how the body is
 * wrapped, so a new one is an entry here or, for an operator who cannot wait
 * for a release, the same fields written in `librechat.yaml`.
 */
export const PRESETS: Record<string, ProviderSettings> = {
  http: {
    dialect: 'port',
    apiKeyEnv: DEFAULT_API_KEY_ENV,
  },
  typesafe: {
    baseURL: 'https://api.typesafe.ai/v1/systemone',
    model: 'jev-latest',
    dialect: 'systemone',
    apiKeyEnv: 'TYPESAFE_API_KEY',
  },
  openrouter: {
    baseURL: 'https://openrouter.ai/api/alpha/decisions',
    model: '~typesafe/jev-latest',
    dialect: 'systemone',
    apiKeyEnv: 'OPENROUTER_KEY',
  },
  cloudflare: {
    /** No default URL: the account id is part of it. */
    model: 'typesafe/jev',
    dialect: 'systemone',
    requestKey: 'input',
    responseKey: 'result',
    apiKeyEnv: 'CLOUDFLARE_API_TOKEN',
  },
};

export function presetFor(name: string | undefined): ProviderSettings | null {
  if (!name) {
    return null;
  }
  return PRESETS[name] ?? null;
}

/** Operator settings win over the preset, field by field. */
export function mergeSettings(
  preset: ProviderSettings | null,
  configured: ProviderSettings | undefined,
): ProviderSettings {
  return { ...(preset ?? {}), ...(configured ?? {}) };
}

export function providerNames(): string[] {
  return Object.keys(PRESETS);
}

export function createClassifier(
  settings: ProviderSettings,
  apiKey: string,
  fetch?: ProviderFetch,
  providerId?: string,
): Classifier {
  return createHttpClassifier({
    providerId,
    apiKey,
    endpoint: settings.baseURL ?? '',
    model: settings.model,
    dialect: settings.dialect,
    requestKey: settings.requestKey,
    responseKey: settings.responseKey,
    timeoutMs: settings.timeoutMs,
    maxRetries: settings.maxRetries,
    fetch,
  });
}
