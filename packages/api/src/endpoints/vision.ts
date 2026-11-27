import { EModelEndpoint } from 'librechat-data-provider';
import type { TEndpoint, TModelSpec } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import { getAzureModelConfig } from './openai/parameters';

type ModelEntry = string | { name: string; vision?: boolean };

/** The part of an endpoint's librechat.yaml entry that declares image input. */
interface VisionConfig {
  vision?: boolean;
  /** Built-in endpoints list models directly; custom endpoints under `default`. */
  models?: ModelEntry[] | { default?: ModelEntry[] };
}

export interface ResolveVisionParams {
  appConfig?: AppConfig;
  /** The endpoint the agent selected, before its client is resolved. */
  endpoint: string;
  model?: string | null;
  /** The custom endpoint's config, when the agent runs on one. */
  customEndpointConfig?: Partial<TEndpoint>;
  /** The model spec the agent runs under, if any. */
  modelSpec?: Pick<TModelSpec, 'vision'> | null;
  /** The agent's own text-only switch; when on, it outranks every other declaration. */
  textOnly?: boolean;
}

function getListedConfig(
  appConfig: AppConfig | undefined,
  endpoint: string,
): VisionConfig | undefined {
  switch (endpoint) {
    case EModelEndpoint.openAI:
      return appConfig?.endpoints?.openAI;
    case EModelEndpoint.google:
      return appConfig?.endpoints?.google;
    case EModelEndpoint.anthropic:
      return appConfig?.endpoints?.anthropic;
    case EModelEndpoint.bedrock:
      return appConfig?.endpoints?.bedrock;
    default:
      return undefined;
  }
}

function getModelVision(config: VisionConfig, model?: string | null): boolean | undefined {
  if (!model) {
    return undefined;
  }
  const entries = Array.isArray(config.models) ? config.models : config.models?.default;
  for (const entry of entries ?? []) {
    if (typeof entry !== 'string' && entry?.name === model) {
      return entry.vision;
    }
  }
  return undefined;
}

/**
 * Whether an agent's model reads images, by the first declaration found: the agent's own
 * text-only switch, its model spec, the model's entry in its endpoint's models list (Azure: the
 * model in its group), then the endpoint. `undefined` when nothing is declared, so images are
 * sent as before.
 */
export function resolveVision({
  appConfig,
  endpoint,
  model,
  customEndpointConfig,
  modelSpec,
  textOnly,
}: ResolveVisionParams): boolean | undefined {
  if (textOnly === true) {
    return false;
  }
  if (typeof modelSpec?.vision === 'boolean') {
    return modelSpec.vision;
  }
  if (endpoint === EModelEndpoint.azureOpenAI) {
    const { config } = getAzureModelConfig(appConfig, endpoint, model ?? undefined);
    const modelVision = typeof config === 'object' ? config.vision : undefined;
    return modelVision ?? appConfig?.endpoints?.azureOpenAI?.vision;
  }
  const config = customEndpointConfig ?? getListedConfig(appConfig, endpoint);
  if (config == null) {
    return undefined;
  }
  return getModelVision(config, model) ?? config.vision;
}
