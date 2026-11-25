import { defaultHiddenModels } from 'librechat-data-provider';
import type { TConfig, TEndpointsConfig } from 'librechat-data-provider';

/**
 * Explicit user choices about what the model selector offers, stored per browser.
 * A missing entry means "follow the default", so a newly configured provider or a
 * model the catalog adds later appears without the user revisiting Settings.
 */
export type ModelVisibility = {
  /** Endpoint value -> whether the selector offers it. */
  endpoints?: Record<string, boolean>;
  /** Endpoint value -> model name -> whether the selector offers it. */
  models?: Record<string, Record<string, boolean>>;
};

export const emptyModelVisibility: ModelVisibility = {};

/** A provider is configured when the server holds a credential for it, or it needs none. */
export function isEndpointConfigured(config?: TConfig | null): boolean {
  if (config == null) {
    return false;
  }
  if (config.userProvide === true) {
    return false;
  }
  return config.keyProvided !== false;
}

/** Whether the selector should offer `endpoint`, by explicit choice or by default. */
export function isEndpointVisible(
  endpoint: string,
  config: TConfig | null | undefined,
  visibility: ModelVisibility,
): boolean {
  const choice = visibility.endpoints?.[endpoint];
  if (choice != null) {
    return choice;
  }
  return isEndpointConfigured(config);
}

/** Whether the selector should offer `model` on `endpoint`. */
export function isModelVisible(
  endpoint: string,
  model: string,
  visibility: ModelVisibility,
): boolean {
  const choice = visibility.models?.[endpoint]?.[model];
  if (choice != null) {
    return choice;
  }
  return defaultHiddenModels[endpoint]?.includes(model) !== true;
}

/** The catalog models the selector may offer, preserving server order. */
export function filterVisibleModels(
  endpoint: string,
  models: string[] | undefined,
  visibility: ModelVisibility,
): string[] | undefined {
  if (models == null) {
    return undefined;
  }
  return models.filter((model) => isModelVisible(endpoint, model, visibility));
}

/**
 * The endpoints a new chat may open with. Explicit selections still restore a
 * conversation on a hidden endpoint; this only decides what an empty composer uses.
 */
export function visibleEndpointsConfig(
  endpointsConfig: TEndpointsConfig | undefined,
  visibility: ModelVisibility,
): TEndpointsConfig {
  const visible: TEndpointsConfig = {};
  for (const [endpoint, config] of Object.entries(endpointsConfig ?? {})) {
    if (isEndpointVisible(endpoint, config, visibility)) {
      visible[endpoint] = config;
    }
  }
  return visible;
}

export function withEndpointVisible(
  visibility: ModelVisibility,
  endpoint: string,
  visible: boolean,
): ModelVisibility {
  return {
    ...visibility,
    endpoints: { ...visibility.endpoints, [endpoint]: visible },
  };
}

export function withModelVisible(
  visibility: ModelVisibility,
  endpoint: string,
  model: string,
  visible: boolean,
): ModelVisibility {
  return {
    ...visibility,
    models: {
      ...visibility.models,
      [endpoint]: { ...visibility.models?.[endpoint], [model]: visible },
    },
  };
}
