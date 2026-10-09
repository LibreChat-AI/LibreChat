import {
  DEFAULT_AGENT_MODEL_RESPONSE_BODY_TIMEOUT_MS,
  DEFAULT_AGENT_MODEL_RESPONSE_HEADERS_TIMEOUT_MS,
} from 'librechat-data-provider';
import type { TAgentsEndpoint } from 'librechat-data-provider';
import { CREATE_FILE_TOOL_NAME } from '~/agents/tools';

const DEFAULT_RECURSION_LIMIT = 50;

export interface ModelTransportTimeouts {
  bodyTimeout: number;
  headersTimeout: number;
}

export function resolveModelTransportTimeouts(
  agentsEConfig: Partial<TAgentsEndpoint> | undefined,
): ModelTransportTimeouts {
  return {
    bodyTimeout:
      agentsEConfig?.modelResponseBodyTimeoutMs ?? DEFAULT_AGENT_MODEL_RESPONSE_BODY_TIMEOUT_MS,
    headersTimeout:
      agentsEConfig?.modelResponseHeadersTimeoutMs ??
      DEFAULT_AGENT_MODEL_RESPONSE_HEADERS_TIMEOUT_MS,
  };
}

/**
 * Mirrors `RECURSION_MULTIPLIER` in `@librechat/agents` `SubagentExecutor`,
 * which derives a subagent's graph `recursionLimit` as `maxTurns * 3`. Keep in
 * sync with the SDK so a subagent's effective recursion limit matches the
 * resolved value it is configured for.
 */
const SUBAGENT_RECURSION_MULTIPLIER = 3;

/**
 * Resolves the effective recursion limit for an agent run via a 3-step cascade:
 * 1. YAML endpoint config default (falls back to 50)
 * 2. Per-agent DB override (if set and positive)
 * 3. Global max cap from YAML (if set and positive)
 */
export function resolveRecursionLimit(
  agentsEConfig: Partial<TAgentsEndpoint> | undefined,
  agent: { recursion_limit?: number } | undefined,
): number {
  let limit = agentsEConfig?.recursionLimit ?? DEFAULT_RECURSION_LIMIT;

  if (typeof agent?.recursion_limit === 'number' && agent.recursion_limit > 0) {
    limit = agent.recursion_limit;
  }

  if (
    typeof agentsEConfig?.maxRecursionLimit === 'number' &&
    agentsEConfig.maxRecursionLimit > 0 &&
    limit > agentsEConfig.maxRecursionLimit
  ) {
    limit = agentsEConfig.maxRecursionLimit;
  }

  return limit;
}

/**
 * Resolves a subagent's `maxTurns` so its graph `recursionLimit`
 * (`maxTurns * SUBAGENT_RECURSION_MULTIPLIER` in the SDK) tracks the same
 * resolved recursion limit as a top-level run. Without this, subagents ignore
 * both the YAML `recursionLimit`/`maxRecursionLimit` and the per-agent
 * `recursion_limit`, always running at the SDK default of 75 graph steps.
 *
 * `floor` keeps the effective graph limit at or below the resolved value, which
 * (since `resolveRecursionLimit` already caps at `maxRecursionLimit`) also keeps
 * it within the admin cap — so a lowered limit applies to subagents too, and
 * `maxTurns * 3` never overshoots the ceiling. A resolved limit below the
 * multiplier yields 0 turns: like a top-level run with `recursionLimit < 3`, the
 * child can't take a full step, and the SDK returns a graceful recursion error
 * rather than silently granting more steps than the cap allows.
 */
export function resolveSubagentMaxTurns(
  agentsEConfig: Partial<TAgentsEndpoint> | undefined,
  agent: { recursion_limit?: number } | undefined,
): number {
  const limit = resolveRecursionLimit(agentsEConfig, agent);
  return Math.floor(limit / SUBAGENT_RECURSION_MULTIPLIER);
}

/** Mirrors `StreamLimits` in `@librechat/agents` (agents#381). */
export interface StreamLimitsConfig {
  maxToolCallArgBytes?: number;
  maxToolCallArgBytesByTool?: Record<string, number>;
  maxDeltaEventsPerTurn?: number;
}

/**
 * LibreChat's shipped per-tool override: create_file legitimately streams
 * whole documents as its content argument (production p99 of 80.6 KiB versus
 * under 10 KiB for every other tool class), so it runs at twice the SDK's
 * 64 KiB global default instead of loosening the cap for all tools.
 */
const CREATE_FILE_MAX_TOOL_CALL_ARG_BYTES = 131_072;

/**
 * Maps the librechat.yaml stream circuit-breaker fields
 * (`endpoints.agents.maxToolCallArgBytes` / `maxToolCallArgBytesByTool` /
 * `maxDeltaEventsPerTurn`) to the SDK's `RunConfig.streamLimits`. Unset
 * global fields keep the SDK defaults (64 KiB per streamed tool call's
 * arguments, per-turn delta event cap off), while the per-tool map always
 * ships the create_file override; a yaml entry for the same tool wins. Value
 * normalization (0 disables, NaN falls back) lives in the SDK's
 * `resolveStreamLimits`.
 */
export function resolveStreamLimits(
  agentsEConfig: Partial<TAgentsEndpoint> | undefined,
): StreamLimitsConfig {
  const maxToolCallArgBytes = agentsEConfig?.maxToolCallArgBytes;
  const maxDeltaEventsPerTurn = agentsEConfig?.maxDeltaEventsPerTurn;
  return {
    ...(maxToolCallArgBytes != null && { maxToolCallArgBytes }),
    maxToolCallArgBytesByTool: {
      [CREATE_FILE_TOOL_NAME]: CREATE_FILE_MAX_TOOL_CALL_ARG_BYTES,
      ...agentsEConfig?.maxToolCallArgBytesByTool,
    },
    ...(maxDeltaEventsPerTurn != null && { maxDeltaEventsPerTurn }),
  };
}
