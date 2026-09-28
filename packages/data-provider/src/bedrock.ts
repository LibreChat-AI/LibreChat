import { z } from 'zod';
import * as s from './schemas';

export const THINKING_BINDING_BETA = 'thinking-binding-controls-2026-08-01';

const DEFAULT_THINKING_BUDGET = 2000;
const BEDROCK_CLAUDE_SONNET_4_6_MAX_OUTPUT = 64000;
export const BEDROCK_OUTPUT_128K_BETA = 'output-128k-2025-02-19';
export const BEDROCK_FINE_GRAINED_TOOL_STREAMING_BETA = 'fine-grained-tool-streaming-2025-05-14';

/** Betas LibreChat injects itself, safe to strip from persisted AMRF when a
 * model no longer supports them; anything else in `anthropic_beta` is a user opt-in. */
const GENERATED_BEDROCK_BETAS = new Set<string>([
  BEDROCK_OUTPUT_128K_BETA,
  BEDROCK_FINE_GRAINED_TOOL_STREAMING_BETA,
  THINKING_BINDING_BETA,
]);

const bedrockReasoningConfigValues = new Set<string>(Object.values(s.BedrockReasoningConfig));

type ThinkingConfig =
  | { type: 'enabled'; budget_tokens: number }
  | {
      type: 'adaptive';
      display?: s.ThinkingDisplayWireValue;
      block_binding?: typeof OPUS_55_BLOCK_BINDING;
    }
  | { type: 'disabled' };

/**
 * Resolves the final `thinking.display` value for an adaptive-thinking request.
 *
 * Starting with Claude Opus 4.7, the Messages API returns empty `thinking`
 * blocks unless the request sets `thinking.display`. This helper encodes the
 * three user-facing modes — `'auto'` (LibreChat decides), `'summarized'`, and
 * `'omitted'` — into the wire value (or `undefined` when the field should be
 * left off).
 *
 * See https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-7#thinking-content-omitted-by-default
 */
/**
 * Safely extracts a nested `thinking.display` string from a persisted
 * `additionalModelRequestFields` object, returning `undefined` if the shape
 * isn't what we expect.
 */
function extractPersistedDisplay(amrf: unknown): string | undefined {
  if (typeof amrf !== 'object' || amrf === null) {
    return undefined;
  }
  const thinking = (amrf as Record<string, unknown>).thinking;
  if (typeof thinking !== 'object' || thinking === null) {
    return undefined;
  }
  const display = (thinking as Record<string, unknown>).display;
  return typeof display === 'string' ? display : undefined;
}

export function resolveThinkingDisplay(
  model: string,
  explicit?: s.ThinkingDisplay | string | null,
): s.ThinkingDisplayWireValue | undefined {
  if (explicit === s.ThinkingDisplay.summarized) {
    return s.ThinkingDisplay.summarized;
  }
  if (explicit === s.ThinkingDisplay.omitted) {
    return s.ThinkingDisplay.omitted;
  }
  if (omitsThinkingByDefault(model)) {
    return s.ThinkingDisplay.summarized;
  }
  return undefined;
}

type AnthropicReasoning = {
  thinking?: ThinkingConfig | boolean;
  thinkingBudget?: number;
};

type AnthropicInput = BedrockConverseInput & {
  additionalModelRequestFields: BedrockConverseInput['additionalModelRequestFields'] &
    AnthropicReasoning;
};

/** Extracts opus major/minor version from both naming formats */
function parseOpusVersion(model: string): { major: number; minor: number } | null {
  const nameFirst = model.match(/claude-opus[-.]?(\d+)(?:[-.](\d{1,2})(?!\d))?/);
  if (nameFirst) {
    return {
      major: parseInt(nameFirst[1], 10),
      minor: nameFirst[2] != null ? parseInt(nameFirst[2], 10) : 0,
    };
  }
  const numFirst = model.match(/claude-(\d+)(?:[-.](\d{1,2})(?!\d))?-opus/);
  if (numFirst) {
    return {
      major: parseInt(numFirst[1], 10),
      minor: numFirst[2] != null ? parseInt(numFirst[2], 10) : 0,
    };
  }
  return null;
}

/** Opus 5.5 has an always-on, conversation-bound thinking contract unlike Opus 5. */
export function isOpus55Model(model: string): boolean {
  const opus = parseOpusVersion(model);
  return opus?.major === 5 && opus.minor === 5;
}

/** LibreChat permits edits and compaction of earlier turns; drop only invalidated blocks. */
export const OPUS_55_BLOCK_BINDING = {
  prefix_mismatch_behavior: 'drop_block',
} as const;

/** Extracts sonnet major/minor version from both naming formats.
 *  Uses bounded minor capture to avoid matching date suffixes (e.g., -20250514). */
function parseSonnetVersion(model: string): { major: number; minor: number } | null {
  const nameFirst = model.match(/claude-sonnet[-.]?(\d+)(?:[-.](\d{1,2})(?!\d))?/);
  if (nameFirst) {
    return {
      major: parseInt(nameFirst[1], 10),
      minor: nameFirst[2] != null ? parseInt(nameFirst[2], 10) : 0,
    };
  }
  const numFirst = model.match(/claude-(\d+)(?:[-.](\d{1,2})(?!\d))?-sonnet/);
  if (numFirst) {
    return {
      major: parseInt(numFirst[1], 10),
      minor: numFirst[2] != null ? parseInt(numFirst[2], 10) : 0,
    };
  }
  return null;
}

/**
 * Mythos-class detection (Claude Fable / Mythos) lives in `schemas.ts` as
 * `isMythosClassModel` — the single source of truth for the family names.
 * The helpers below OR it in alongside the `opus`/`sonnet` version parsers.
 */

/** Checks if a model supports adaptive thinking (Opus 4.6+, Sonnet 4.6+, Fable/Mythos) */
export function supportsAdaptiveThinking(model: string): boolean {
  const opus = parseOpusVersion(model);
  if (opus && (opus.major > 4 || (opus.major === 4 && opus.minor >= 6))) {
    return true;
  }
  const sonnet = parseSonnetVersion(model);
  if (sonnet != null && (sonnet.major > 4 || (sonnet.major === 4 && sonnet.minor >= 6))) {
    return true;
  }
  if (s.isMythosClassModel(model)) {
    return true;
  }
  return false;
}

/**
 * Checks if a model omits `thinking` content from responses by default.
 *
 * Starting with Claude Opus 4.7, the Messages API returns empty `thinking`
 * blocks unless the request explicitly opts in via `thinking.display =
 * "summarized"`. This helper narrows the opt-in to Opus 4.7+ (and any future
 * major Opus version) so older adaptive-thinking models are left untouched.
 *
 * See https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-7#thinking-content-omitted-by-default
 */
export function omitsThinkingByDefault(model: string): boolean {
  const opus = parseOpusVersion(model);
  if (opus && (opus.major > 4 || (opus.major === 4 && opus.minor >= 7))) {
    return true;
  }
  const sonnet = parseSonnetVersion(model);
  if (sonnet != null && sonnet.major >= 5) {
    return true;
  }
  if (s.isMythosClassModel(model)) {
    return true;
  }
  return false;
}

export function omitsSamplingParameters(model: string): boolean {
  const opus = parseOpusVersion(model);
  if (opus && (opus.major > 4 || (opus.major === 4 && opus.minor >= 7))) {
    return true;
  }
  const sonnet = parseSonnetVersion(model);
  if (sonnet != null && sonnet.major >= 5) {
    return true;
  }
  if (s.isMythosClassModel(model)) {
    return true;
  }
  return false;
}

/**
 * Whether disabling thinking requires sending an explicit `{ type: 'disabled' }`
 * config rather than simply omitting the `thinking` field.
 *
 * Sonnet 5 and Opus 5 treat an omitted `thinking` field as adaptive thinking ON
 * by default, so honoring a user who turns thinking off means sending the
 * disabled config explicitly. Opus 4.7/4.8 run without thinking when the field
 * is omitted, and Fable/Mythos reject an explicit disabled config (400,
 * thinking always on), so both are excluded.
 *
 * See https://platform.claude.com/docs/en/about-claude/models/migration-guide#migrating-to-claude-sonnet-5
 */
export function requiresExplicitThinkingDisabled(model: string): boolean {
  if (isOpus55Model(model)) {
    return false;
  }
  const sonnet = parseSonnetVersion(model);
  if (sonnet != null && sonnet.major >= 5) {
    return true;
  }
  const opus = parseOpusVersion(model);
  return opus != null && opus.major >= 5;
}

/** Effort levels Opus 5 rejects while thinking is explicitly disabled. */
const EFFORTS_REJECTED_WHEN_THINKING_DISABLED = new Set<string>([
  s.AnthropicEffort.xhigh,
  s.AnthropicEffort.max,
]);

/**
 * Whether the model caps `output_config.effort` while thinking is disabled.
 *
 * Opus 5 rejects `xhigh`/`max` in that combination with a 400: "output_config
 * .effort 'xhigh' is not supported when thinking is disabled on this model. Use
 * effort 'high' or below, or enable thinking." Opus 4.7/4.8, Sonnet 5, and
 * Sonnet 4.6 accept every effort level they otherwise support with thinking
 * off, so the cap is Opus 5+ only.
 */
export function capsEffortWhenThinkingDisabled(model: string): boolean {
  if (isOpus55Model(model)) {
    return false;
  }
  const opus = parseOpusVersion(model);
  return opus != null && opus.major >= 5;
}

/**
 * Lowers an effort level the model would reject while thinking is disabled to
 * the highest accepted value (`high`, which is also the API default). Returns
 * the effort unchanged when the combination is valid.
 */
export function clampEffortForDisabledThinking(model: string, effort: string): string {
  if (
    capsEffortWhenThinkingDisabled(model) &&
    EFFORTS_REJECTED_WHEN_THINKING_DISABLED.has(effort)
  ) {
    return s.AnthropicEffort.high;
  }
  return effort;
}

/** An `output_config` container carrying a usable effort level. */
function hasStringEffort(value: unknown): value is { effort: string } {
  if (typeof value !== 'object' || value === null || !('effort' in value)) {
    return false;
  }
  return typeof value.effort === 'string';
}

/**
 * Clamps an `output_config.effort` in place when the model would reject it
 * while thinking is disabled. No-op when the container carries no string
 * effort, so callers can pass a possibly-absent config directly.
 */
export function clampOutputConfigEffort(model: string, outputConfig: unknown): void {
  if (!hasStringEffort(outputConfig)) {
    return;
  }
  outputConfig.effort = clampEffortForDisabledThinking(model, outputConfig.effort);
}

/** Whether a resolved thinking config is an explicit `{ type: 'disabled' }`. */
export function isThinkingDisabled(thinking: unknown): boolean {
  if (typeof thinking !== 'object' || thinking === null || !('type' in thinking)) {
    return false;
  }
  return thinking.type === 'disabled';
}

/** Checks if a model has a 1M context window (Sonnet 4.6+, Opus 4.6+, Opus 5+, Fable/Mythos) */
export function supportsContext1m(model: string): boolean {
  const sonnet = parseSonnetVersion(model);
  if (sonnet != null && (sonnet.major > 4 || (sonnet.major === 4 && sonnet.minor >= 6))) {
    return true;
  }
  const opus = parseOpusVersion(model);
  if (opus && (opus.major > 4 || (opus.major === 4 && opus.minor >= 6))) {
    return true;
  }
  if (s.isMythosClassModel(model)) {
    return true;
  }
  return false;
}

/**
 * Checks whether a native Anthropic Claude model supports prompt caching.
 *
 * This uses the configured model ID directly. Resolving it through a token
 * map first can collapse a newly released Claude model to the generic
 * `claude-` fallback and incorrectly disable cache control.
 */
export function supportsPromptCache(model: string): boolean {
  if (model.includes('claude-3-5-sonnet-latest') || model.includes('claude-3.5-sonnet-latest')) {
    return false;
  }

  return (
    /claude-3[-.]7/.test(model) ||
    /claude-3[-.]5-(?:sonnet|haiku)/.test(model) ||
    /claude-3-(?:sonnet|haiku|opus)?/.test(model) ||
    /claude-(?:sonnet|opus|haiku)[-.]?(?:[4-9]|\d{2,})/.test(model) ||
    /claude-(?:[4-9]|\d{2,})(?:[-.](?:sonnet|opus|haiku))?/.test(model) ||
    s.isMythosClassModel(model)
  );
}

/**
 * A Bedrock Claude model ID may be prefixed (`anthropic.claude-*`,
 * `us.anthropic.claude-*`, `global.anthropic.claude-*`) or bare (`claude-*`,
 * used when the LibreChat model ID maps to an application inference profile).
 * Match on the `claude` family token so every form is recognized — requiring
 * the literal `anthropic.` prefix silently dropped thinking config, beta
 * headers, and sampling handling for inference-profile deployments.
 */
const BEDROCK_CLAUDE_4PLUS_THINKING =
  /claude-(?:[4-9](?:\.\d+)?(?:-\d+)?-(?:sonnet|opus|haiku)|(?:sonnet|opus|haiku)-[4-9])/;

/** Whether a Bedrock model ID is an Anthropic Claude model (prefixed or bare). */
function isBedrockClaudeModel(model: string): boolean {
  return model.includes('claude');
}

/**
 * Gets the appropriate anthropic_beta headers for Bedrock Anthropic models.
 * Bedrock uses `anthropic_beta` (with underscore) in additionalModelRequestFields.
 *
 * @param model - The Bedrock model identifier (e.g., "anthropic.claude-sonnet-4-6")
 * @returns Array of beta header strings, or empty array if not applicable
 */
function getBedrockAnthropicBetaHeaders(model: string): string[] {
  if (isOpus55Model(model)) {
    return [THINKING_BINDING_BETA];
  }
  const betaHeaders: string[] = [];

  /** Mythos-class (Fable/Mythos) is intentionally not matched: these betas are built-in/no-op for the
   * 4.7+ generation (Fable has native 128K output), so omitting them on Bedrock is lossless. */
  const isClaude4PlusModel = BEDROCK_CLAUDE_4PLUS_THINKING.test(model);
  const isClaudeThinkingModel = model.includes('claude-3-7-sonnet') || isClaude4PlusModel;

  if (isClaudeThinkingModel) {
    betaHeaders.push(BEDROCK_OUTPUT_128K_BETA);
  }

  if (isClaude4PlusModel) {
    betaHeaders.push(BEDROCK_FINE_GRAINED_TOOL_STREAMING_BETA);
  }

  return betaHeaders;
}

/** Flatten an anthropic_beta value (array, single string, or comma-delimited
 * string) into trimmed, non-empty header tokens. */
function normalizeBetaHeaders(value: unknown): string[] {
  let values: unknown[] = [];
  if (Array.isArray(value)) {
    values = value;
  } else if (typeof value === 'string') {
    values = [value];
  }
  const headers: string[] = [];
  values.forEach((entry) => {
    if (typeof entry !== 'string') {
      return;
    }
    entry
      .split(',')
      .map((header) => header.trim())
      .filter(Boolean)
      .forEach((header) => headers.push(header));
  });
  return headers;
}

function mergeBedrockAnthropicBetaHeaders(existing: unknown, generated: string[]): string[] {
  const generatedSet = new Set(generated);
  const betaHeaders = new Set<string>();

  [...normalizeBetaHeaders(existing), ...generated].forEach((header) => {
    /** Drop a generated beta carried over from a prior model that the current
     * model does not generate (e.g. fine-grained-tool-streaming on a 3.7
     * profile); user opt-ins are always preserved. */
    if (GENERATED_BEDROCK_BETAS.has(header) && !generatedSet.has(header)) {
      return;
    }
    betaHeaders.add(header);
  });

  return Array.from(betaHeaders);
}

export const bedrockInputSchema = s.tConversationSchema
  .pick({
    /* LibreChat params; optionType: 'conversation' */
    chatProjectId: true,
    modelLabel: true,
    promptPrefix: true,
    resendFiles: true,
    iconURL: true,
    greeting: true,
    spec: true,
    maxOutputTokens: true,
    maxContextTokens: true,
    artifacts: true,
    /* Bedrock params; optionType: 'model' */
    region: true,
    system: true,
    model: true,
    maxTokens: true,
    temperature: true,
    topP: true,
    stop: true,
    thinking: true,
    thinkingBudget: true,
    effort: true,
    thinkingDisplay: true,
    reasoning_effort: true,
    promptCache: true,
    promptCacheTtl: true,
    /* Catch-all fields */
    topK: true,
    additionalModelRequestFields: true,
  })
  .transform((obj) => {
    if ((obj as AnthropicInput).additionalModelRequestFields?.thinking != null) {
      const _obj = obj as AnthropicInput;
      const thinking = _obj.additionalModelRequestFields.thinking;
      const isDisabled =
        typeof thinking === 'object' &&
        thinking !== null &&
        (thinking as { type?: string }).type === 'disabled';
      obj.thinking = isDisabled ? false : !!thinking;
      obj.thinkingBudget =
        typeof thinking === 'object' && 'budget_tokens' in thinking
          ? thinking.budget_tokens
          : undefined;
      if (obj.thinkingDisplay == null) {
        const persistedDisplay = extractPersistedDisplay({ thinking });
        if (
          persistedDisplay === s.ThinkingDisplay.summarized ||
          persistedDisplay === s.ThinkingDisplay.omitted
        ) {
          obj.thinkingDisplay = persistedDisplay as s.ThinkingDisplay;
        }
      }
      delete obj.additionalModelRequestFields;
    }
    return s.removeNullishValues(obj);
  })
  .catch(() => ({}));

export type BedrockConverseInput = z.infer<typeof bedrockInputSchema>;

export const bedrockInputParser = s.tConversationSchema
  .pick({
    /* LibreChat params; optionType: 'conversation' */
    chatProjectId: true,
    modelLabel: true,
    promptPrefix: true,
    resendFiles: true,
    iconURL: true,
    greeting: true,
    spec: true,
    artifacts: true,
    maxOutputTokens: true,
    maxContextTokens: true,
    /* Bedrock params; optionType: 'model' */
    region: true,
    model: true,
    maxTokens: true,
    temperature: true,
    topP: true,
    stop: true,
    thinking: true,
    thinkingBudget: true,
    effort: true,
    thinkingDisplay: true,
    reasoning_effort: true,
    promptCache: true,
    promptCacheTtl: true,
    /* Catch-all fields */
    topK: true,
    additionalModelRequestFields: true,
  })
  .catchall(z.any())
  .transform((data) => {
    const knownKeys = [
      'chatProjectId',
      'modelLabel',
      'promptPrefix',
      'resendFiles',
      'iconURL',
      'greeting',
      'spec',
      'maxOutputTokens',
      'artifacts',
      'additionalModelRequestFields',
      'region',
      'model',
      'maxTokens',
      'temperature',
      'topP',
      'stop',
      'promptCache',
      'promptCacheTtl',
    ];

    const additionalFields: Record<string, unknown> = {};
    const typedData = data as Record<string, unknown>;
    const shouldOmitSamplingParameters =
      typeof typedData.model === 'string' && omitsSamplingParameters(typedData.model);

    Object.entries(typedData).forEach(([key, value]) => {
      if (!knownKeys.includes(key)) {
        if (key === 'topK') {
          additionalFields['top_k'] = value;
        } else {
          additionalFields[key] = value;
        }
        delete typedData[key];
      }
    });

    /**
     * Persisted `model_parameters` can carry a prior "thinking off" only inside
     * `additionalModelRequestFields.thinking = { type: 'disabled' }` (a known
     * key that isn't spread into `additionalFields`). `initializeBedrock` feeds
     * those params straight through this parser, so surface that as
     * `thinking: false` — otherwise the disabled branch is skipped and the
     * config rebuilds adaptive, flipping a user's Sonnet 5 setting back on.
     */
    const persistedThinking = (
      typedData.additionalModelRequestFields as { thinking?: unknown } | undefined
    )?.thinking;
    if (
      additionalFields.thinking === undefined &&
      typeof persistedThinking === 'object' &&
      persistedThinking !== null &&
      (persistedThinking as { type?: string }).type === 'disabled'
    ) {
      additionalFields.thinking = false;
    }

    /** Bedrock thinking-capable Claude models: 3.7 Sonnet, Claude 4+ (opus/sonnet/haiku), and Mythos-class (Fable/Mythos). */
    const isThinkingModel =
      typeof typedData.model === 'string' &&
      (typedData.model.includes('claude-3-7-sonnet') ||
        BEDROCK_CLAUDE_4PLUS_THINKING.test(typedData.model) ||
        s.isMythosClassModel(typedData.model));

    if (isThinkingModel) {
      const isAdaptive = supportsAdaptiveThinking(typedData.model as string);

      if (isAdaptive) {
        /** Persisted AMRF is spread into the final request, so clearing only
         * `additionalFields` leaves a stale value from a prior selection. */
        const persistedAmrf = typedData.additionalModelRequestFields as
          | Record<string, unknown>
          | undefined;
        const thinkingDisabled =
          additionalFields.thinking === false && !isOpus55Model(typedData.model as string);
        const effort = additionalFields.effort;
        if (typeof effort === 'string' && effort !== '') {
          additionalFields.output_config = { effort };
        } else if (effort !== undefined && persistedAmrf) {
          /** Explicit unset ('' or null) clears the persisted effort. An absent
           * effort (agent resume, where the prior llmConfig persisted
           * `output_config` but no top-level `effort`) preserves it. */
          delete persistedAmrf.output_config;
        }
        delete additionalFields.effort;

        /**
         * Opus 5 rejects `xhigh`/`max` effort while thinking is disabled, so
         * clamp both the effort derived above and any effort still carried in
         * persisted AMRF (agent resume sends `output_config` with no top-level
         * `effort`, so the branch above leaves it untouched).
         */
        if (thinkingDisabled) {
          [additionalFields, persistedAmrf].forEach((target) =>
            clampOutputConfigEffort(typedData.model as string, target?.output_config),
          );
        }

        if (thinkingDisabled) {
          delete additionalFields.thinkingBudget;
          delete additionalFields.thinkingDisplay;
          if (requiresExplicitThinkingDisabled(typedData.model as string)) {
            additionalFields.thinking = { type: 'disabled' };
          } else {
            delete additionalFields.thinking;
            /** Disable-by-omission models (Opus 4.7+): drop the persisted
             * adaptive config so turning thinking off actually disables it. */
            if (persistedAmrf) {
              delete persistedAmrf.thinking;
            }
          }
        } else {
          /**
           * Persisted agent `model_parameters` round-trip back through this
           * parser with the prior `thinking.display` embedded in
           * `additionalModelRequestFields`. Surface it as the resolver's
           * explicit value when no top-level `thinkingDisplay` is set so the
           * prior user choice (e.g. 'omitted') survives instead of being
           * clobbered by the Opus 4.7+ auto → 'summarized' fallback.
           */
          const topLevelDisplay = additionalFields.thinkingDisplay as
            | s.ThinkingDisplay
            | string
            | null
            | undefined;
          const persistedDisplay = extractPersistedDisplay(typedData.additionalModelRequestFields);
          const thinkingConfig: ThinkingConfig = { type: 'adaptive' };
          if (isOpus55Model(typedData.model as string)) {
            thinkingConfig.block_binding = { ...OPUS_55_BLOCK_BINDING };
          }
          const display = resolveThinkingDisplay(
            typedData.model as string,
            topLevelDisplay ?? persistedDisplay,
          );
          if (display) {
            thinkingConfig.display = display;
          }
          additionalFields.thinking = thinkingConfig;
          delete additionalFields.thinkingBudget;
          delete additionalFields.thinkingDisplay;
        }
      } else {
        if (additionalFields.thinking === undefined) {
          additionalFields.thinking = true;
        } else if (additionalFields.thinking === false) {
          delete additionalFields.thinking;
          delete additionalFields.thinkingBudget;
        }

        if (additionalFields.thinking === true && additionalFields.thinkingBudget === undefined) {
          additionalFields.thinkingBudget = DEFAULT_THINKING_BUDGET;
        }
        delete additionalFields.effort;
        delete additionalFields.thinkingDisplay;

        /** A bare non-adaptive thinking profile (e.g. `claude-3-7-sonnet`) must
         * not inherit an adaptive/disabled thinking object or `output_config`
         * persisted from another model; this branch's own fields are authoritative. */
        const persistedAmrf = typedData.additionalModelRequestFields as
          | Record<string, unknown>
          | undefined;
        if (persistedAmrf) {
          delete persistedAmrf.thinking;
          delete persistedAmrf.output_config;
        }
      }

      /** Anthropic uses 'effort' via output_config, not reasoning_config */
      delete additionalFields.reasoning_effort;

      if (isBedrockClaudeModel(typedData.model as string)) {
        const betaHeaders = getBedrockAnthropicBetaHeaders(typedData.model as string);
        if (betaHeaders.length > 0) {
          const existingBetaHeaders = (
            typedData.additionalModelRequestFields as Record<string, unknown> | undefined
          )?.anthropic_beta;
          additionalFields.anthropic_beta = mergeBedrockAnthropicBetaHeaders(
            existingBetaHeaders,
            betaHeaders,
          );
        }
      }
    } else {
      delete additionalFields.thinking;
      delete additionalFields.thinkingBudget;
      delete additionalFields.effort;
      delete additionalFields.thinkingDisplay;
      delete additionalFields.output_config;
      delete additionalFields.anthropic_beta;

      const reasoningEffort = additionalFields.reasoning_effort;
      delete additionalFields.reasoning_effort;
      if (
        typeof reasoningEffort === 'string' &&
        bedrockReasoningConfigValues.has(reasoningEffort)
      ) {
        additionalFields.reasoning_config = reasoningEffort;
      }
    }

    const isAnthropicModel =
      typeof typedData.model === 'string' && isBedrockClaudeModel(typedData.model);

    /** Strip stale fields from previously-persisted additionalModelRequestFields */
    if (
      typeof typedData.additionalModelRequestFields === 'object' &&
      typedData.additionalModelRequestFields != null
    ) {
      const amrf = typedData.additionalModelRequestFields as Record<string, unknown>;
      if (!isAnthropicModel) {
        delete amrf.anthropic_beta;
        delete amrf.thinking;
        delete amrf.thinkingBudget;
        delete amrf.effort;
        delete amrf.output_config;
        delete amrf.reasoning_config;
      } else {
        delete amrf.reasoning_config;
        delete amrf.reasoning_effort;
        /** A Claude model that does not support Bedrock thinking (e.g. a bare
         * `claude-3-5-sonnet` inference profile) must not carry stale thinking
         * fields from a previously-selected thinking model. Drop only the
         * LibreChat-generated betas (output-128k, fine-grained tool streaming);
         * user opt-ins in `anthropic_beta` are preserved. */
        if (!isThinkingModel) {
          delete amrf.thinking;
          delete amrf.thinkingBudget;
          delete amrf.effort;
          delete amrf.output_config;
          if (amrf.anthropic_beta !== undefined) {
            const kept = normalizeBetaHeaders(amrf.anthropic_beta).filter(
              (header) => !GENERATED_BEDROCK_BETAS.has(header),
            );
            if (kept.length > 0) {
              amrf.anthropic_beta = kept;
            } else {
              delete amrf.anthropic_beta;
            }
          }
        }
      }

      if (shouldOmitSamplingParameters) {
        delete amrf.temperature;
        delete amrf.topP;
        delete amrf.top_p;
        delete amrf.topK;
        delete amrf.top_k;
      }
    }

    if (shouldOmitSamplingParameters) {
      delete typedData.temperature;
      delete typedData.topP;
      delete additionalFields.temperature;
      delete additionalFields.topP;
      delete additionalFields.top_p;
      delete additionalFields.topK;
      delete additionalFields.top_k;
    }

    /** Default promptCache for claude and nova models, if not defined */
    if (
      typeof typedData.model === 'string' &&
      (typedData.model.includes('claude') || typedData.model.includes('nova'))
    ) {
      if (typedData.promptCache === undefined) {
        typedData.promptCache = true;
      }
    } else if (typedData.promptCache === true) {
      typedData.promptCache = undefined;
    }

    /**
     * A cache TTL is meaningless without caching — tie it to promptCache. When
     * caching is off or unsupported for the model (cleared above), drop the TTL
     * so an unsupported `1h` is never sent on a non-caching Bedrock request.
     */
    if (typedData.promptCache !== true) {
      typedData.promptCacheTtl = undefined;
    }

    if (Object.keys(additionalFields).length > 0) {
      typedData.additionalModelRequestFields = {
        ...((typedData.additionalModelRequestFields as Record<string, unknown> | undefined) || {}),
        ...additionalFields,
      };
    }

    if (typedData.maxOutputTokens !== undefined) {
      typedData.maxTokens = typedData.maxOutputTokens;
    } else if (typedData.maxTokens !== undefined) {
      typedData.maxOutputTokens = typedData.maxTokens;
    }

    return s.removeNullishValues(typedData) as BedrockConverseInput;
  })
  .catch(() => ({}));

/**
 * Configures the "thinking" parameter based on given input and thinking options.
 *
 * @param data - The parsed Bedrock request options object
 * @returns The object with thinking configured appropriately
 */
/**
 * `anthropicSettings.maxOutputTokens.reset` only matches the canonical
 * family-first id (`claude-sonnet-5`); Bedrock also accepts number-first
 * aliases (`claude-5-sonnet`, `claude-4-7-sonnet`) that this file gates as
 * thinking models. Canonicalize to family-first so those aliases resolve to the
 * real ceiling instead of the 8192 fallback.
 */
function toFamilyFirstClaudeId(model: string): string {
  return model.replace(/claude-(\d+(?:[-.]\d+)?)-(sonnet|opus|haiku)/, 'claude-$2-$1');
}

function isBedrockClaudeSonnet46(model: string): boolean {
  return /claude-sonnet[-.]?4[-.]?6(?=$|[^0-9])/.test(toFamilyFirstClaudeId(model));
}

/**
 * Thinking tokens share the `maxTokens` output budget with tool-call arguments
 * (e.g. a `create_file` `content`), so a low default truncates large authored
 * files mid-argument. Mirror the direct-Anthropic path and default to the
 * model's full max output when the request does not set one explicitly.
 */
function resolveThinkingMaxTokens(data: AnthropicInput): number {
  const explicit = data.maxTokens ?? data.maxOutputTokens;
  if (typeof explicit === 'number' && explicit > 0) {
    return explicit;
  }
  const model = typeof data.model === 'string' ? data.model : '';
  if (isBedrockClaudeSonnet46(model)) {
    return BEDROCK_CLAUDE_SONNET_4_6_MAX_OUTPUT;
  }
  return s.anthropicSettings.maxOutputTokens.reset(toFamilyFirstClaudeId(model));
}

function configureThinking(data: AnthropicInput): AnthropicInput {
  const updatedData = { ...data };
  const thinking = updatedData.additionalModelRequestFields?.thinking;

  if (thinking === true) {
    updatedData.maxTokens = resolveThinkingMaxTokens(updatedData);
    delete updatedData.maxOutputTokens;
    const thinkingConfig: ThinkingConfig = {
      type: 'enabled',
      budget_tokens:
        updatedData.additionalModelRequestFields?.thinkingBudget ?? DEFAULT_THINKING_BUDGET,
    };

    if (thinkingConfig.budget_tokens > updatedData.maxTokens) {
      thinkingConfig.budget_tokens = Math.floor(updatedData.maxTokens * 0.9);
    }
    updatedData.additionalModelRequestFields!.thinking = thinkingConfig;
    delete updatedData.additionalModelRequestFields!.thinkingBudget;
  } else if (
    typeof thinking === 'object' &&
    thinking != null &&
    (thinking as { type: string }).type === 'adaptive'
  ) {
    updatedData.maxTokens = resolveThinkingMaxTokens(updatedData);
    delete updatedData.maxOutputTokens;
    delete updatedData.additionalModelRequestFields!.thinkingBudget;
  }

  return updatedData;
}

/** Top-level Converse request fields (issue #14029: `system` from a preset).
 *  The input parser's catch-all routes unknown keys into
 *  additionalModelRequestFields, and Bedrock rejects any that collide with a
 *  field the request already sends (`messages`/`modelId` always,
 *  `inferenceConfig` whenever maxTokens is set, `toolConfig` for agents). */
const RESERVED_CONVERSE_FIELDS = [
  'system',
  'messages',
  'modelId',
  'toolConfig',
  'inferenceConfig',
  'guardrailConfig',
  'promptVariables',
  'requestMetadata',
  'performanceConfig',
  'additionalModelRequestFields',
  'additionalModelResponseFieldPaths',
];

export const bedrockOutputParser = (data: Record<string, unknown>) => {
  const knownKeys = [...Object.keys(s.tConversationSchema.shape), 'topK', 'top_k'];
  let result: Record<string, unknown> = {};

  // Extract known fields from the root level
  Object.entries(data).forEach(([key, value]) => {
    if (knownKeys.includes(key)) {
      result[key] = value;
    }
  });

  // Extract known fields from additionalModelRequestFields
  if (
    typeof data.additionalModelRequestFields === 'object' &&
    data.additionalModelRequestFields !== null
  ) {
    Object.entries(data.additionalModelRequestFields as Record<string, unknown>).forEach(
      ([key, value]) => {
        if (knownKeys.includes(key)) {
          if (key === 'top_k') {
            result['topK'] = value;
          } else if (key === 'thinking' || key === 'thinkingBudget') {
            return;
          } else {
            result[key] = value;
          }
        }
      },
    );
  }

  // Handle maxTokens and maxOutputTokens
  if (result.maxTokens !== undefined && result.maxOutputTokens === undefined) {
    result.maxOutputTokens = result.maxTokens;
  } else if (result.maxOutputTokens !== undefined && result.maxTokens === undefined) {
    result.maxTokens = result.maxOutputTokens;
  }

  result = configureThinking(result as AnthropicInput);
  let amrf = result.additionalModelRequestFields as Record<string, unknown> | undefined;
  // Reserved top-level Converse request fields; a copy inside
  // additionalModelRequestFields makes Bedrock reject the request
  // ("The additional field <name> conflicts with an existing field").
  // Guard against non-object values, which the schema's DocumentType permits.
  if (amrf && typeof amrf === 'object') {
    const reserved = RESERVED_CONVERSE_FIELDS.filter((key) => key in (amrf ?? {}));
    if (reserved.length > 0) {
      amrf = { ...amrf };
      for (const key of reserved) {
        delete amrf[key];
      }
      result.additionalModelRequestFields = amrf;
    }
  }
  if (!amrf || Object.keys(amrf).length === 0) {
    delete result.additionalModelRequestFields;
  }

  return result;
};
