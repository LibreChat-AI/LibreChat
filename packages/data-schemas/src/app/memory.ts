import { DEFAULT_MEMORY_MAX_INPUT_TOKENS, memorySchema } from 'librechat-data-provider';

import type { TCustomConfig, TMemoryConfig } from 'librechat-data-provider';

import logger from '~/config/winston';

const hasValidAgent = (agent: TMemoryConfig['agent']) =>
  !!agent &&
  (('id' in agent && !!agent.id) ||
    ('provider' in agent && 'model' in agent && !!agent.provider && !!agent.model));

const isDisabled = (config?: TMemoryConfig | TCustomConfig['memory']) =>
  !config || config.disabled === true;

export function loadMemoryConfig(config: TCustomConfig['memory']): TMemoryConfig | undefined {
  if (!config) return undefined;
  if (isDisabled(config)) return config as TMemoryConfig;

  if (hasValidAgent(config.agent) && config.agent?.enabled == null) {
    logger.warn(
      '[memory] Agent config detected without explicit `enabled: true`. Automatic memory extraction is now opt-in. Add `memory.agent.enabled: true` to keep automatic memory updates.',
    );
  }

  const charLimit = memorySchema.shape.charLimit.safeParse(config.charLimit).data ?? 10000;
  const maxInputTokens =
    memorySchema.shape.maxInputTokens.safeParse(config.maxInputTokens).data ??
    DEFAULT_MEMORY_MAX_INPUT_TOKENS;

  return { ...config, charLimit, maxInputTokens };
}

export function isMemoryEnabled(config: TMemoryConfig | undefined): boolean {
  return !isDisabled(config);
}

export function isMemoryAgentEnabled(config: TMemoryConfig | undefined): boolean {
  if (!isMemoryEnabled(config)) return false;
  return config?.agent?.enabled === true && hasValidAgent(config.agent);
}
