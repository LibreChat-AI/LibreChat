import { logger } from '@librechat/data-schemas';
import { Providers } from '@librechat/agents';

/**
 * Joins additional instructions with per-request tool context. The dynamic part
 * (e.g. the current date/time) goes last so that provider-side prefix caches
 * can reuse the static part, such as the artifacts prompt, across requests.
 */
export function buildAdditionalInstructions(
  additionalInstructions: string | null | undefined,
  dynamicToolInstructions: string,
): string {
  return [additionalInstructions ?? '', dynamicToolInstructions].join('\n').trim();
}

/**
 * Mirrors the SDK condition under which `additional_instructions` is relocated into a
 * separate message right before the last user message (Anthropic and OpenRouter with
 * `promptCache: true`). That position shifts every turn, so no request starts with the
 * bytes of the previous one. A contract test runs the SDK against this predicate.
 * TODO: drop with the merge once the SDK carries `conversation_instructions`.
 */
export function sdkMovesDynamicInstructions(
  provider: string | undefined,
  clientOptions?: object,
): boolean {
  return (
    (provider === Providers.ANTHROPIC || provider === Providers.OPENROUTER) &&
    (clientOptions as { promptCache?: unknown } | undefined)?.promptCache === true
  );
}

/** How the run context was split when it was applied to the agent. */
export interface AdditionalInstructionsSplit {
  /** `additional_instructions` without the volatile parts. */
  stable?: string;
  /** Parts that change between turns without a user action (memory, RAG, queued files). */
  volatile?: string;
  /** The `additional_instructions` the split was made from; a mismatch means it is stale. */
  source?: string;
}

export interface InstructionPlanInput {
  /** `endpoints.agents.promptCache.stableContext` */
  stableContext: boolean;
  isSubagent: boolean;
  provider?: string;
  clientOptions?: object;
  /** Joined `toolContextMap`. */
  toolInstructions: string;
  instructions?: string | null;
  additionalInstructions?: string | null;
  /** `dynamicToolContextMap`: per-request tool context such as the current date. */
  dynamicContextMap?: Record<string, unknown>;
  /** Context key whose value lasts for one turn only (files queued by an upload). */
  oneTurnContextKey?: string;
  split?: AdditionalInstructionsSplit;
}

export interface InstructionPlan {
  instructions: string;
  additionalInstructions: string | undefined;
}

export function joinInstructionMap(map?: Record<string, unknown>): string {
  return Object.values(map ?? {})
    .filter((value): value is string => typeof value === 'string' && value !== '')
    .join('\n')
    .trim();
}

/**
 * Decides what goes into the system `instructions` and what into
 * `additional_instructions`.
 *
 * - Without `stableContext` the request is built as before: dynamic tool
 *   context ahead of the additional instructions, everything in
 *   `additional_instructions`.
 * - With it, the dynamic tool context goes last. Where the SDK would move the
 *   whole additional part into a message ahead of the last user message (whose
 *   position shifts every turn), the conversation-stable part is merged into
 *   `instructions` instead, and only the volatile and one-turn parts stay in
 *   `additional_instructions`, where moving them is the right behavior.
 */
export function planInstructions(input: InstructionPlanInput): InstructionPlan {
  const systemContent = [input.toolInstructions, input.instructions ?? ''].join('\n').trim();
  const dynamicToolInstructions = joinInstructionMap(input.dynamicContextMap);

  if (!input.stableContext) {
    const additional = [dynamicToolInstructions, input.additionalInstructions ?? '']
      .join('\n')
      .trim();
    return { instructions: systemContent, additionalInstructions: additional || undefined };
  }

  const additional = buildAdditionalInstructions(
    input.additionalInstructions,
    dynamicToolInstructions,
  );
  const unmerged = { instructions: systemContent, additionalInstructions: additional || undefined };
  if (
    input.isSubagent ||
    additional === '' ||
    !sdkMovesDynamicInstructions(input.provider, input.clientOptions)
  ) {
    return unmerged;
  }

  const split = input.split;
  const recorded =
    split != null && (split.stable != null || split.volatile != null || split.source != null)
      ? split
      : undefined;
  if (recorded != null && recorded.source !== input.additionalInstructions) {
    logger.warn(
      '[planInstructions] additional_instructions changed after the run context was applied; keeping it unsplit',
    );
    return unmerged;
  }

  const { [input.oneTurnContextKey ?? '']: oneTurnContext, ...stableContextMap } =
    input.dynamicContextMap ?? {};
  const moved = [
    recorded?.volatile?.trim() ?? '',
    typeof oneTurnContext === 'string' ? oneTurnContext.trim() : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  const stableAdditional = buildAdditionalInstructions(
    (recorded != null ? recorded.stable : input.additionalInstructions)?.trim(),
    joinInstructionMap(stableContextMap),
  );
  return {
    instructions: [systemContent, stableAdditional].filter(Boolean).join('\n\n'),
    additionalInstructions: moved || undefined,
  };
}
