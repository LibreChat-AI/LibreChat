import { ProviderId } from 'librechat-data-provider';
import type { ComponentType, SVGProps } from 'react';
import type { BrandMarkId } from './marks';
import GoogleMinimalIcon from '../../svgs/GoogleMinimalIcon';
import CustomMinimalIcon from '../../svgs/CustomMinimalIcon';
import AzureMinimalIcon from '../../svgs/AzureMinimalIcon';
import AnthropicIcon from '../../svgs/AnthropicIcon';
import MoonshotIcon from '../../svgs/MoonshotIcon';
import BedrockIcon from '../../svgs/BedrockIcon';
import GeminiIcon from '../../svgs/GeminiIcon';
import GPTIcon from '../../svgs/GPTIcon';
import XAIcon from '../../svgs/XAIcon';
import { brandMarks } from './marks';
import { createMark } from './Mark';

type ProviderArtComponent = ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;

export type ProviderArt = { kind: 'component'; Component: ProviderArtComponent };

export interface ProviderIconDef {
  art: ProviderArt;
  label: string;
  /** Avatar tile background. Absent means the tile renders with no background. */
  brandColor?: string;
  /** Art inherits currentColor and follows the active theme. */
  mono?: boolean;
  /** Per provider layout correction, replacing the old knownEndpointClasses map. */
  className?: string;
  /** Model level refinement merged over the base definition. */
  byModel?: (model: string) => Partial<ProviderIconDef> | undefined;
}

const component = (Component: ProviderArtComponent): ProviderArt => ({
  kind: 'component',
  Component,
});

const mark = (id: BrandMarkId): ProviderArt => component(createMark(brandMarks[id]));

const openAIBrandColor = (model: string): string => {
  const value = model.toLowerCase();
  if (/\b(o\d)\b/.test(value) || /\bgpt-[5-9](?:\.\d+)?\b/.test(value)) {
    return 'var(--provider-openai-reasoning, #000000)';
  }
  return value.includes('gpt-4')
    ? 'var(--provider-openai-gpt4, #AB68FF)'
    : 'var(--provider-openai, #19C37D)';
};

const googleByModel = (model: string): Partial<ProviderIconDef> | undefined => {
  const value = model.toLowerCase();
  if (/gemini|learnlm/.test(value)) {
    return { art: component(GeminiIcon), mono: false, label: 'Gemini' };
  }
  if (value.includes('gemma')) {
    return { art: component(GeminiIcon), mono: false, label: 'Gemma' };
  }
  return undefined;
};

export const providerIcons: Record<ProviderId, ProviderIconDef> = {
  [ProviderId.openai]: {
    art: component(GPTIcon),
    label: 'OpenAI',
    mono: true,
    brandColor: 'var(--provider-openai, #19C37D)',
    byModel: (model) => ({ brandColor: openAIBrandColor(model) }),
  },
  [ProviderId.anthropic]: {
    art: component(AnthropicIcon),
    label: 'Anthropic',
    mono: true,
    brandColor: 'var(--provider-anthropic, #d09a74)',
  },
  [ProviderId.google]: {
    art: component(GoogleMinimalIcon),
    label: 'Google',
    mono: true,
    byModel: googleByModel,
  },
  [ProviderId.azure]: {
    art: component(AzureMinimalIcon),
    label: 'Azure OpenAI',
    mono: true,
    brandColor: 'var(--provider-azure, linear-gradient(0.375turn, #61bde2, #4389d0))',
  },
  [ProviderId.bedrock]: {
    art: component(BedrockIcon),
    label: 'AWS Bedrock',
    mono: true,
    brandColor: 'var(--provider-bedrock, #268672)',
  },
  [ProviderId.xai]: { art: component(XAIcon), label: 'xAI', mono: true },
  [ProviderId.moonshot]: { art: component(MoonshotIcon), label: 'Moonshot', mono: true },
  [ProviderId.anyscale]: { art: mark('anyscale'), label: 'Anyscale', mono: true },
  [ProviderId.apipie]: { art: mark('apipie'), label: 'APIpie', mono: true },
  [ProviderId.cohere]: { art: mark('cohere'), label: 'Cohere', mono: true },
  [ProviderId.deepseek]: { art: mark('deepseek'), label: 'DeepSeek', mono: true },
  [ProviderId.fireworks]: { art: mark('fireworks'), label: 'Fireworks', mono: true },
  [ProviderId.groq]: { art: mark('groq'), label: 'Groq', mono: true },
  [ProviderId.helicone]: { art: mark('helicone'), label: 'Helicone', mono: true },
  [ProviderId.huggingface]: { art: mark('huggingface'), label: 'Hugging Face', mono: true },
  [ProviderId.mistral]: { art: mark('mistral'), label: 'Mistral', mono: true },
  [ProviderId.ollama]: { art: mark('ollama'), label: 'Ollama', mono: true },
  [ProviderId.openrouter]: { art: mark('openrouter'), label: 'OpenRouter', mono: true },
  [ProviderId.perplexity]: { art: mark('perplexity'), label: 'Perplexity', mono: true },
  [ProviderId.qwen]: { art: mark('qwen'), label: 'Qwen', mono: true },
  [ProviderId.together]: { art: mark('together'), label: 'Together AI', mono: true },
  [ProviderId.vercel]: { art: mark('vercel'), label: 'Vercel', mono: true },
  [ProviderId.lemonade]: { art: mark('lemonade'), label: 'AMD Lemonade', mono: true },
  [ProviderId.mlx]: { art: mark('mlx'), label: 'MLX', mono: true },
  [ProviderId.shuttleai]: { art: mark('shuttleai'), label: 'ShuttleAI', mono: true },
  [ProviderId.unify]: { art: mark('unify'), label: 'Unify', mono: true },
};

/**
 * The company that makes a model, matched on the model id so a model served by another host
 * (OpenRouter, Groq, Ollama, Bedrock...) shows its maker. First match wins, so ids that name
 * two families (`deepseek-r1-distill-llama`, `llama-nemotron`) list the more specific one first.
 */
const modelMakers: [RegExp, ProviderId | ProviderIconDef][] = [
  [/claude/, ProviderId.anthropic],
  [/(^|[^a-z])(chat)?gpt-|(^|[^a-z0-9])o[1-9](?![0-9])/, ProviderId.openai],
  [/gemini|gemma|learnlm/, ProviderId.google],
  [/grok/, ProviderId.xai],
  [/kimi|moonshot/, ProviderId.moonshot],
  [/deepseek/, ProviderId.deepseek],
  [/qwen|qwq/, ProviderId.qwen],
  [
    /mi[sx]tral|codestral|devstral|ministral|magistral|mathstral|pixtral|voxtral/,
    ProviderId.mistral,
  ],
  [/command-[ar]|(^|[^a-z])aya-/, ProviderId.cohere],
  [/sonar/, ProviderId.perplexity],
  [/nemotron/, { art: mark('nvidia'), label: 'NVIDIA', mono: true }],
  [/minimax|abab/, { art: mark('minimax'), label: 'MiniMax', mono: true }],
  [/(^|[^a-z])phi(-?[0-9]|:|$)/, { art: mark('microsoft'), label: 'Microsoft', mono: true }],
  [/(^|[^a-z])(chat)?glm|codegeex/, { art: mark('zhipu'), label: 'Z.ai', mono: true }],
  [/granite/, { art: mark('ibm'), label: 'IBM', mono: true }],
  [/(^|[^a-z])nova-/, { art: mark('amazon'), label: 'Amazon Nova', mono: true }],
  [/(?<!o)llama/, { art: mark('meta'), label: 'Meta', mono: true }],
];

function resolveModelMaker(model: string): ProviderId | ProviderIconDef | undefined {
  const value = model.toLowerCase();
  return modelMakers.find(([pattern]) => pattern.test(value))?.[1];
}

/**
 * Resolves the icon for a provider, preferring the model's maker when the host only serves it,
 * then merging any model level refinement over the base definition.
 */
export function getProviderIconDef(
  provider?: ProviderId | null,
  model?: string | null,
): ProviderIconDef {
  const maker = model ? resolveModelMaker(model) : undefined;
  if (maker != null && maker !== provider) {
    return typeof maker === 'string' ? getProviderIconDef(maker, model) : maker;
  }
  const base = provider ? providerIcons[provider] : undefined;
  if (!base) {
    return { art: component(CustomMinimalIcon), label: 'Custom', mono: true };
  }
  const refinement = model ? base.byModel?.(model) : undefined;
  return refinement ? { ...base, ...refinement } : base;
}
