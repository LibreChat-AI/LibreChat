import { ProviderId } from 'librechat-data-provider';
import type { ComponentType, SVGProps } from 'react';
import GoogleMinimalIcon from '../../svgs/GoogleMinimalIcon';
import CustomMinimalIcon from '../../svgs/CustomMinimalIcon';
import AzureMinimalIcon from '../../svgs/AzureMinimalIcon';
import AnthropicIcon from '../../svgs/AnthropicIcon';
import MoonshotIcon from '../../svgs/MoonshotIcon';
import BedrockIcon from '../../svgs/BedrockIcon';
import GeminiIcon from '../../svgs/GeminiIcon';
import GPTIcon from '../../svgs/GPTIcon';
import XAIcon from '../../svgs/XAIcon';

type ProviderArtComponent = ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;

export type ProviderArt =
  | { kind: 'component'; Component: ProviderArtComponent }
  | { kind: 'asset'; src: string };

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

const asset = (src: string): ProviderArt => ({ kind: 'asset', src });

const component = (Component: ProviderArtComponent): ProviderArt => ({
  kind: 'component',
  Component,
});

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
  [ProviderId.anyscale]: { art: asset('assets/anyscale.png'), label: 'Anyscale' },
  [ProviderId.apipie]: { art: asset('assets/apipie.png'), label: 'APIpie' },
  [ProviderId.cohere]: {
    art: asset('assets/cohere.png'),
    label: 'Cohere',
  },
  [ProviderId.deepseek]: { art: asset('assets/deepseek.svg'), label: 'DeepSeek' },
  [ProviderId.fireworks]: { art: asset('assets/fireworks.png'), label: 'Fireworks' },
  [ProviderId.groq]: { art: asset('assets/groq.png'), label: 'Groq' },
  [ProviderId.helicone]: { art: asset('assets/helicone.svg'), label: 'Helicone' },
  [ProviderId.huggingface]: { art: asset('assets/huggingface.svg'), label: 'Hugging Face' },
  [ProviderId.lemonade]: { art: asset('assets/lemonade.png'), label: 'AMD Lemonade' },
  [ProviderId.mistral]: { art: asset('assets/mistral.png'), label: 'Mistral' },
  [ProviderId.mlx]: { art: asset('assets/mlx.png'), label: 'MLX' },
  [ProviderId.ollama]: { art: asset('assets/ollama.png'), label: 'Ollama' },
  [ProviderId.openrouter]: { art: asset('assets/openrouter.png'), label: 'OpenRouter' },
  [ProviderId.perplexity]: { art: asset('assets/perplexity.png'), label: 'Perplexity' },
  [ProviderId.qwen]: { art: asset('assets/qwen.svg'), label: 'Qwen' },
  [ProviderId.shuttleai]: { art: asset('assets/shuttleai.png'), label: 'ShuttleAI' },
  [ProviderId.together]: { art: asset('assets/together.png'), label: 'Together AI' },
  [ProviderId.unify]: { art: asset('assets/unify.webp'), label: 'Unify' },
  [ProviderId.vercel]: {
    art: component(CustomMinimalIcon),
    label: 'Vercel',
    mono: true,
  },
};

/** Merges any model level refinement over the base definition for a provider. */
export function getProviderIconDef(
  provider?: ProviderId | null,
  model?: string | null,
): ProviderIconDef {
  const base = provider ? providerIcons[provider] : undefined;
  if (!base) {
    return { art: component(CustomMinimalIcon), label: 'Custom', mono: true };
  }
  const refinement = model ? base.byModel?.(model) : undefined;
  return refinement ? { ...base, ...refinement } : base;
}
