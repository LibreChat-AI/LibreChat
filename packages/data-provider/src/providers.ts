import { EModelEndpoint, Providers } from './schemas';
import { normalizeEndpointName } from './utils';

/** Canonical provider identity used for branding across client and server. */
export enum ProviderId {
  openai = 'openai',
  anthropic = 'anthropic',
  google = 'google',
  azure = 'azure',
  bedrock = 'bedrock',
  xai = 'xai',
  moonshot = 'moonshot',
  anyscale = 'anyscale',
  apipie = 'apipie',
  cohere = 'cohere',
  deepseek = 'deepseek',
  fireworks = 'fireworks',
  groq = 'groq',
  helicone = 'helicone',
  huggingface = 'huggingface',
  lemonade = 'lemonade',
  mistral = 'mistral',
  mlx = 'mlx',
  ollama = 'ollama',
  openrouter = 'openrouter',
  perplexity = 'perplexity',
  qwen = 'qwen',
  shuttleai = 'shuttleai',
  together = 'together',
  unify = 'unify',
  vercel = 'vercel',
}

export const endpointToProvider: Partial<Record<EModelEndpoint, ProviderId>> = {
  [EModelEndpoint.openAI]: ProviderId.openai,
  [EModelEndpoint.azureOpenAI]: ProviderId.azure,
  [EModelEndpoint.anthropic]: ProviderId.anthropic,
  [EModelEndpoint.google]: ProviderId.google,
  [EModelEndpoint.bedrock]: ProviderId.bedrock,
};

const providerAliases: Record<string, ProviderId> = {
  chatgpt: ProviderId.openai,
  gpt: ProviderId.openai,
  azureopenai: ProviderId.azure,
  claude: ProviderId.anthropic,
  gemini: ProviderId.google,
  gemma: ProviderId.google,
  vertex: ProviderId.google,
  vertexai: ProviderId.google,
  palm: ProviderId.google,
  awsbedrock: ProviderId.bedrock,
  grok: ProviderId.xai,
  kimi: ProviderId.moonshot,
  moonshotai: ProviderId.moonshot,
  amdlemonade: ProviderId.lemonade,
  lemonadeserver: ProviderId.lemonade,
  mistralai: ProviderId.mistral,
  togetherai: ProviderId.together,
};

const modelCatalogAliases: Partial<Record<string, string>> = {
  [Providers.VERTEXAI]: EModelEndpoint.google,
};

const normalize = (input: string): string => input.toLowerCase().replace(/[\s._-]/g, '');

const providerByNormalizedId = Object.values(ProviderId).reduce<Record<string, ProviderId>>(
  (acc, id) => {
    acc[normalize(id)] = id;
    return acc;
  },
  {},
);

/** Resolves free-form provider text to a canonical id, ignoring case and separators. */
export function resolveProviderId(input?: string | null): ProviderId | null {
  if (!input) {
    return null;
  }
  const key = normalize(input);
  return providerByNormalizedId[key] ?? providerAliases[key] ?? null;
}

/**
 * Resolves a runtime provider to its model catalog: its own catalog when one exists, else a
 * native alias, else the name the runtime serves it under (`normalizeEndpointName`), so an
 * agent saved as `Ollama` reads the `ollama` catalog.
 */
export function resolveModelCatalogKey<T>(
  provider?: string | null,
  catalogs?: Partial<Record<string, T>>,
): string {
  const key = provider ?? '';
  return catalogs?.[key] != null ? key : (modelCatalogAliases[key] ?? normalizeEndpointName(key));
}
