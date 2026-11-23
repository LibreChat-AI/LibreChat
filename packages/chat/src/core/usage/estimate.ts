import { Tools, Constants, inputTokensIncludesCache } from 'librechat-data-provider';
import type { TTokenUsageEvent } from 'librechat-data-provider';
import { normalizeTokenCount } from './types';

export interface ToolTokenGroups {
  system: number;
  mcp: number;
  skills: number;
  subagents: number;
  systemDeferred: number;
  mcpDeferred: number;
}

export const EMPTY_TOOL_GROUPS: ToolTokenGroups = {
  system: 0,
  mcp: 0,
  skills: 0,
  subagents: 0,
  systemDeferred: 0,
  mcpDeferred: 0,
};

/**
 * Classifies per-tool schema tokens into display groups: built-in system
 * tools, MCP tools, skills, and subagents, with deferred (on-demand) tools
 * split out for the system/MCP groups.
 */
export function groupToolTokens(
  toolTokenCounts?: Record<string, number>,
  deferredToolNames?: string[],
): ToolTokenGroups {
  if (toolTokenCounts == null) {
    return EMPTY_TOOL_GROUPS;
  }
  const deferred = new Set(deferredToolNames ?? []);
  const groups = { ...EMPTY_TOOL_GROUPS };
  for (const [name, rawTokens] of Object.entries(toolTokenCounts)) {
    const tokens = normalizeTokenCount(rawTokens);
    if (tokens === 0) {
      continue;
    }
    if (name === Tools.skill) {
      groups.skills += tokens;
    } else if (name === Constants.SUBAGENT) {
      groups.subagents += tokens;
    } else if (name.includes(Constants.mcp_delimiter)) {
      if (deferred.has(name)) {
        groups.mcpDeferred += tokens;
      } else {
        groups.mcp += tokens;
      }
    } else if (deferred.has(name)) {
      groups.systemDeferred += tokens;
    } else {
      groups.system += tokens;
    }
  }
  return groups;
}

export function getOutputChars(part: unknown): number | null {
  if (part == null || typeof part !== 'object') {
    return null;
  }
  const { text, think } = part as { text?: unknown; think?: unknown };
  if (typeof text === 'string') {
    return text.length;
  }
  if (typeof think === 'string') {
    return think.length;
  }
  return null;
}

/**
 * Chars of the contiguous text/think parts at the very END of aggregated
 * content, the output the model is actively producing on the current call,
 * which the latest pre-invoke context snapshot does not yet account for.
 *
 * Crucially this does NOT skip a trailing tool-call part: once the model has
 * emitted a tool call, that call's text is already folded into the next
 * snapshot's `messageTokens`, so counting it would double-count against the
 * snapshot. A tool call at the end therefore yields 0 (nothing new in flight).
 */
export function countTrailingOutputChars(content?: unknown[] | null): number {
  if (!Array.isArray(content) || content.length === 0) {
    return 0;
  }
  let chars = 0;
  for (let i = content.length - 1; i >= 0; i--) {
    const partChars = getOutputChars(content[i]);
    if (partChars == null) {
      break;
    }
    chars += partChars;
  }
  return chars;
}

/** Rough live estimate for streaming text, calibrated by the last known provider ratio */
export function estimateTokens(charCount: number, calibrationRatio = 1): number {
  const chars = normalizeTokenCount(charCount);
  const ratio =
    typeof calibrationRatio === 'number' &&
    Number.isFinite(calibrationRatio) &&
    calibrationRatio > 0
      ? calibrationRatio
      : 1;
  return normalizeTokenCount(Math.round((chars / 4) * ratio));
}

/** Billable token quantities of one or more model calls, normalized for pricing */
export interface CostUnits {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/**
 * Normalizes one call's usage into billable units, mirroring the backend's
 * authoritative `splitUsage`/`resolveCompletionTokens`
 * (packages/api/src/agents/usage.ts):
 *   - cache classification is by provider, not magnitude, Bedrock keeps cache
 *     additive (input is uncached-only); Anthropic and OpenAI fold cache into
 *     `input_tokens`. Falls back to a magnitude heuristic only when
 *     the provider is unknown.
 *   - completion is repaired for providers (e.g. Vertex) that under-report
 *     `output_tokens` but carry the gap in `total_tokens`.
 * Applied per event so units stay correct when summed across calls.
 */
export function normalizeUsageUnits(usage: TTokenUsageEvent): CostUnits {
  const rawInput = normalizeTokenCount(usage.input_tokens);
  const rawOutput = normalizeTokenCount(usage.output_tokens);
  const total = normalizeTokenCount(usage.total_tokens);
  const cacheWrite = normalizeTokenCount(usage.input_token_details?.cache_creation);
  const cacheRead = normalizeTokenCount(usage.input_token_details?.cache_read);

  const includesCache =
    usage.provider != null
      ? inputTokensIncludesCache(usage.provider)
      : cacheWrite + cacheRead <= rawInput;

  const cacheAdjustment = includesCache ? 0 : cacheRead + cacheWrite;
  const output =
    total > rawInput + rawOutput + cacheAdjustment ? total - rawInput - cacheAdjustment : rawOutput;

  return {
    input: includesCache ? Math.max(0, rawInput - cacheRead - cacheWrite) : rawInput,
    output,
    cacheWrite,
    cacheRead,
  };
}
