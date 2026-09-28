import type { TFile } from './files';
import { inputTokensIncludesCache } from '../schemas';

export enum ContentTypes {
  TEXT = 'text',
  THINK = 'think',
  TEXT_DELTA = 'text_delta',
  TOOL_CALL = 'tool_call',
  IMAGE_FILE = 'image_file',
  IMAGE_URL = 'image_url',
  VIDEO_URL = 'video_url',
  INPUT_AUDIO = 'input_audio',
  AGENT_UPDATE = 'agent_update',
  SUMMARY = 'summary',
  ACTIVITY_LABEL = 'activity_label',
  STEER = 'steer',
  ERROR = 'error',
}

export enum StepTypes {
  TOOL_CALLS = 'tool_calls',
  MESSAGE_CREATION = 'message_creation',
}

export enum ToolCallTypes {
  FUNCTION = 'function',
  RETRIEVAL = 'retrieval',
  FILE_SEARCH = 'file_search',
  CODE_INTERPRETER = 'code_interpreter',
  /* Agents Tool Call */
  TOOL_CALL = 'tool_call',
}

/** Event names dispatched by the agent graph and consumed by step handlers. */
export enum StepEvents {
  ON_RUN_STEP = 'on_run_step',
  ON_AGENT_UPDATE = 'on_agent_update',
  ON_MESSAGE_DELTA = 'on_message_delta',
  ON_REASONING_DELTA = 'on_reasoning_delta',
  ON_RUN_STEP_DELTA = 'on_run_step_delta',
  ON_RUN_STEP_COMPLETED = 'on_run_step_completed',
  /** Terminal signal for a run step: closed with a status and timestamps. */
  ON_RUN_STEP_CLOSED = 'on_run_step_closed',
  ON_SUMMARIZE_START = 'on_summarize_start',
  ON_SUMMARIZE_DELTA = 'on_summarize_delta',
  ON_SUMMARIZE_COMPLETE = 'on_summarize_complete',
  ON_SUBAGENT_UPDATE = 'on_subagent_update',
  ON_SANDBOX_STARTING = 'on_sandbox_starting',
  ON_PTC_TOOL_CALL = 'on_ptc_tool_call',
}

/** Payload for {@link StepEvents.ON_SANDBOX_STARTING} — the stateful code
 * sandbox is cold-booting for the given code tool call. */
export type SandboxStartingEvent = {
  tool_call_id: string;
  runId?: string;
};

/** Lifecycle of one tool call made from inside a programmatic (PTC) program. */
export type PtcToolCallStatus = 'running' | 'success' | 'error';

/**
 * Payload for {@link StepEvents.ON_PTC_TOOL_CALL} — one tool invocation the
 * sandbox made on behalf of a programmatic tool-calling program. Emitted twice
 * per inner call (`running`, then `success` / `error`) so the PTC card can
 * render a live trace of what the code is doing under the code itself.
 */
export type PtcToolCallEvent = {
  /** The PTC run step's tool call id — the card this line belongs under. */
  tool_call_id: string;
  /** Stable per-program id; the settle event reuses the start event's value. */
  call_id: string;
  /** Inner tool id, e.g. `search_code_mcp_github`. */
  name: string;
  status: PtcToolCallStatus;
  /** `key=value` preview of the call's input. Start event only. */
  args?: string;
  /** Truncated failure message. `error` status only. */
  error?: string;
  /** Wall-clock time the inner call took. Settle events only. */
  durationMs?: number;
  runId?: string;
};

/** Token-tracking event names streamed to the client (separate from StepEvents dispatch). */
export enum UsageEvents {
  ON_CONTEXT_USAGE = 'on_context_usage',
  ON_TOKEN_USAGE = 'on_token_usage',
}

/**
 * Human-in-the-loop event names. Streamed to live clients when a run pauses for
 * tool approval (or an ask-user question). Reconnecting clients instead read the
 * same record from `resumeState.pendingAction` on the sync event / status route.
 */
export enum ApprovalEvents {
  ON_PENDING_ACTION = 'on_pending_action',
}

/**
 * Steering event names. `on_steer_applied` streams to live clients when a
 * queued steer message is injected at a tool-batch boundary; reconnecting
 * clients recover injected steers from `aggregatedContent` and still-queued
 * ones from `resumeState.pendingSteers`. Steers that never reach a boundary
 * ride the final/abort events as `pendingSteers`.
 */
export enum SteerEvents {
  ON_STEER_APPLIED = 'on_steer_applied',
  /** Durable capability correction for queued steers after HITL handover. */
  ON_STEER_UPDATED = 'on_steer_updated',
}

/**
 * Activity-label event names. `on_activity_label` streams to live clients
 * when a tool-batch or parent-phase label part is claimed and again when the
 * fast-model label resolves; reconnecting clients recover applied labels
 * from `aggregatedContent` like any other content part.
 */
export enum ActivityLabelEvents {
  ON_ACTIVITY_LABEL = 'on_activity_label',
}

/** Live title updates for an existing reasoning content part. */
export enum ReasoningLabelEvents {
  ON_REASONING_LABEL = 'on_reasoning_label',
  /** Internal durable budget reservation; clients intentionally do not render it. */
  ON_REASONING_LABEL_ATTEMPT = 'on_reasoning_label_attempt',
}

type TReasoningLabelEventBase = {
  /** Completion-local content index of the reasoning part being updated. */
  index: number;
  stepId: string;
  responseMessageId?: string;
  conversationId?: string;
};

/** Payload of the `on_reasoning_label` SSE event. */
export type TReasoningLabelEvent = TReasoningLabelEventBase &
  (
    | {
        /** Clears a snapshot title when its THINK slot changed during the resume gap. */
        reset: true;
        /** Step identity observed in the snapshot and exclusively eligible for this reset. */
        previousStepId: string;
        /** Latest run-global call-budget high-water, when present on fresh content. */
        attempts?: number;
      }
    | {
        reset?: false;
        /** Run-unique provider-call revision; may contain gaps after unsuccessful attempts. */
        revision: number;
        label: string;
        status: 'streaming' | 'complete';
      }
  );

/** Durable run-cumulative call-budget reservation, attributed to one reasoning step. */
export type TReasoningLabelAttemptEvent = {
  index: number;
  stepId: string;
  attempts: number;
  submittedChars: number;
};

/** Payload of the `on_activity_label` SSE event. */
export type TActivityLabelEvent = {
  /** Absolute content index the label part occupies. */
  index: number;
  part: {
    type: ContentTypes.ACTIVITY_LABEL;
    [ContentTypes.ACTIVITY_LABEL]: string;
    /** Missing means a per-batch activity label. */
    activity_label_type?: 'phase';
    tool_call_ids?: string[];
    activity_start_index?: number;
    activity_end_index?: number;
    activity_count?: number;
    agent_ids?: string[];
    counts?: {
      searches: number;
      reads: number;
      writes: number;
      commands: number;
      other: number;
    };
    status?: 'ok' | 'partial' | 'failed';
    agentId?: string;
    pending?: boolean;
  };
  responseMessageId?: string;
  conversationId?: string;
};

/** A steer message queued server-side but not yet injected into the run. */
export type TPendingSteer = {
  steerId: string;
  /** Correlates a server steer with its optimistic chip when terminal delivery
   *  races ahead of the POST response. */
  clientSteerId?: string;
  text: string;
  createdAt?: number;
  files?: Partial<TFile>[];
  /** Quoted excerpts steered with the message ("Add to chat" selections);
   *  merged into the model-bound text at the injection boundary. */
  quotes?: string[];
  /** The steer asked to interrupt generation at the next safe boundary —
   *  kept on parked/replayed chips so the "interrupting" label survives. */
  preempt?: boolean;
  /** Monotonic server revision for last-writer-wins interrupt labels. */
  preemptRevision?: number;
};

/** Payload of the `on_steer_applied` SSE event. */
export type TSteerAppliedEvent = {
  steerId: string;
  /** Correlates the applied event with the optimistic chip before the POST settles. */
  clientSteerId?: string;
  /** Absolute content index the steer part was injected at. */
  index: number;
  part: {
    type: ContentTypes.STEER;
    [ContentTypes.STEER]: string;
    steerId?: string;
    clientSteerId?: string;
    createdAt?: number;
    files?: Partial<TFile>[];
    /** Quoted excerpts steered with the message (mirrors `SteerContentPart`,
     *  which cannot be imported here without a module cycle). */
    quotes?: string[];
  };
  responseMessageId?: string;
  conversationId?: string;
};

/** A queued steer's interrupt label changed without moving its FIFO slot. */
export type TSteerUpdatedEvent = {
  conversationId: string;
  steers: Array<{
    steerId: string;
    clientSteerId?: string;
    preempt: boolean;
    preemptRevision: number;
  }>;
};

/** Mirrors TokenBudgetBreakdown from @librechat/agents (data-provider cannot import it). */
export type TTokenBudgetBreakdown = {
  maxContextTokens: number;
  instructionTokens: number;
  systemMessageTokens: number;
  dynamicInstructionTokens: number;
  toolSchemaTokens: number;
  summaryTokens: number;
  toolCount: number;
  messageCount: number;
  messageTokens: number;
  availableForMessages: number;
  /** Per-tool schema token counts (post-multiplier), keyed by tool name */
  toolTokenCounts?: Record<string, number>;
  /** Names of counted tools that are deferred (`defer_loading`) and discovered */
  deferredToolNames?: string[];
  /** Calibrated retained tool traffic: tool results plus assistant turns made only of tool calls, inline provider tool results and reasoning. A subset of messageTokens, not an additional budget category. */
  toolMessageTokens?: number;
  /** Per-tool result-message share; excludes assistant invocation overhead. */
  toolMessageTokenCounts?: Record<string, number>;
};

/** Per-model-call context snapshot, dispatched after pruning and before the LLM call. */
export type TContextUsageEvent = {
  runId?: string;
  agentId?: string;
  breakdown: TTokenBudgetBreakdown;
  /** Usable budget this call: maxContextTokens minus output reserve */
  contextBudget?: number;
  /** Calibrated instruction overhead actually applied this call */
  effectiveInstructionTokens?: number;
  /** Calibrated message tokens before pruning (excluding instructions) */
  prePruneContextTokens?: number;
  /** Tokens still free after instructions + pruned messages */
  remainingContextTokens?: number;
  calibrationRatio?: number;
  /** Model and provider of the reconciling primary call, retained across reloads. */
  model?: string;
  provider?: string;
  /** Cache portions of that call's prompt, in normalized display units. */
  cacheRead?: number;
  cacheWrite?: number;
  /** Output tokens of the response's final model call (the call this pre-invoke
   *  snapshot precedes). Saved in message metadata and used by the client so a
   *  reloaded multi-call turn adds the same post-snapshot delta the
   *  live finalizer did — not the full response `tokenCount`, which the snapshot
   *  already includes for earlier steps. */
  completedOutputTokens?: number;
  /** Completed output in a resumable job. Separate from the saved-message field
   * so older clients do not add it alongside their trailing-text estimate. */
  resumedOutputTokens?: number;
  /** Tool-result tokens retained AFTER this pre-invoke snapshot, counted with the
   *  run's own tokenizer. A run that stops at the tool-call limit keeps the result
   *  its final call's tools produced, and no later snapshot describes it: the
   *  snapshot precedes the call, and the limit means no further call is made. The
   *  client adds this the way it adds `completedOutputTokens`, so the gauge and the
   *  tool-call share include the retained result instead of missing it until the
   *  next turn's snapshot carries it as kept-message context. Counted, never
   *  estimated — the per-tool `toolMessageTokenCounts` stay a subset of the share. */
  retainedToolTokens?: number;
};

/**
 * Per-response usage rollup persisted on `responseMessage.metadata.usage`, in
 * display units (input excludes cache; output includes repaired completion).
 * Normalized per-event on the backend before summing so a reloaded conversation
 * reproduces the live branch/total usage exactly, even for mixed-provider turns
 * (summarization/subagent calls on a different provider than the primary).
 */
export type TResponseUsage = {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  /** Authoritative USD cost; present only when `interface.contextCost` was on at save */
  cost?: number;
};

/** Provider-reported usage for a single completed model call. */
export type TTokenUsageEvent = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_token_details?: {
    cache_creation?: number;
    cache_read?: number;
  };
  model?: string;
  provider?: string;
  /** Non-primary buckets fold into session cost/totals but not the live
   *  context gauge: hidden sequential-agent calls (`sequential`), summary
   *  passes (`summarization`), isolated subagent runs (`subagent`), and
   *  fast-model activity headers (`activity-label`, `activity-phase`), and
   *  live reasoning titles (`reasoning-label`) */
  usage_type?:
    | 'summarization'
    | 'subagent'
    | 'sequential'
    | 'activity-label'
    | 'activity-phase'
    | 'reasoning-label';
  runId?: string;
  /** Per-run emission sequence; keeps identical payloads from distinct model calls unique */
  seq?: number;
  /** Authoritative USD cost of this call from the backend (premium tiers, cache
   *  rates); present only when `interface.contextCost` is enabled. Clients sum
   *  this rather than re-deriving cost from base rates. */
  cost?: number;
};

const finiteNonNegativeInteger = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value)));
};

/**
 * Full prompt token count for one completed model call — the EXACT context the
 * model saw, provider-aware: additive providers (Bedrock) report `input_tokens`
 * excluding cache, so cache reads/writes are added back; subset providers
 * (Anthropic, OpenAI, …) already fold cache into `input_tokens`. When the
 * provider is absent (custom/OpenAI-compatible payloads), fall back to the same
 * magnitude heuristic `normalizeUsageUnits` uses — cache ≤ input means it's
 * already included — so cached events aren't re-inflated. The ground truth the
 * gauge reconciles its calibrated estimate to.
 */
export const promptTokensFromUsage = (event: TTokenUsageEvent): number => {
  const input = finiteNonNegativeInteger(event.input_tokens) ?? 0;
  const details = event.input_token_details ?? {};
  const cacheRead = finiteNonNegativeInteger(details.cache_read) ?? 0;
  const cacheCreation = finiteNonNegativeInteger(details.cache_creation) ?? 0;
  const includesCache =
    event.provider != null
      ? inputTokensIncludesCache(event.provider)
      : cacheRead + cacheCreation <= input;
  return includesCache
    ? input
    : Math.min(Number.MAX_SAFE_INTEGER, input + cacheRead + cacheCreation);
};

/**
 * Scales per-tool result-message counts while bounding both malformed input and
 * rounding error. Null-prototype records keep tool names as ordinary data keys;
 * cumulative apportionment preserves the scaled sum in one linear pass.
 */
const scaleToolMessageTokenCounts = (
  value: unknown,
  oldTotal: number,
  newTotal: number,
): Record<string, number> | undefined => {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const scaled: Record<string, number> = Object.create(null);
  let remaining = oldTotal;
  let cumulative = 0;
  let allocated = 0;
  let found = false;
  for (const [name, rawCount] of Object.entries(value)) {
    const count = finiteNonNegativeInteger(rawCount);
    if (count == null || count === 0) {
      continue;
    }
    const bounded = Math.min(count, remaining);
    remaining -= bounded;
    cumulative += bounded;
    const target = oldTotal > 0 ? Math.round((cumulative / oldTotal) * newTotal) : 0;
    const apportioned = target - allocated;
    allocated = target;
    if (apportioned > 0) {
      scaled[name] = apportioned;
      found = true;
    }
  }
  return found ? scaled : undefined;
};

/**
 * Reconciles a pre-invoke context snapshot's CALIBRATED estimate to a call's
 * ACTUAL prompt tokens. The SDK's calibration multiplier scales only
 * `messageTokens` (instructions/summary are raw tiktoken counts) and can
 * over-shoot badly when a provider injects server-side content the SDK never
 * counted (e.g. Anthropic web search) — pinning the gauge several× too high and
 * persisting it. Trust the provider's own prompt count: keep the raw
 * instruction/summary rows, set `messageTokens` to the remainder, recompute the
 * free space, and rescale the `toolMessageTokens` share to the new message
 * total. No-op when `promptTokens` is unusable.
 */
export const reconcileContextUsage = (
  snapshot: TContextUsageEvent,
  promptTokens: number,
): TContextUsageEvent => {
  if (!Number.isFinite(promptTokens) || promptTokens <= 0) {
    return snapshot;
  }
  const normalizedPromptTokens = Math.min(Number.MAX_SAFE_INTEGER, Math.floor(promptTokens));
  if (normalizedPromptTokens <= 0) {
    return snapshot;
  }
  const { breakdown } = snapshot;
  const instructionTokens = finiteNonNegativeInteger(breakdown.instructionTokens) ?? 0;
  const summaryTokens = finiteNonNegativeInteger(breakdown.summaryTokens) ?? 0;
  const budget =
    finiteNonNegativeInteger(snapshot.contextBudget) ??
    finiteNonNegativeInteger(breakdown.maxContextTokens);
  const nonMessageTokens = instructionTokens + summaryTokens;
  const messageTokens = Math.max(0, normalizedPromptTokens - nonMessageTokens);
  /** `toolMessageTokens` is a subset of the OLD (calibrated) `messageTokens`;
   * rescale it by the same proportion so the split tracks the provider's real
   * total. A supplied zero remains a known-zero split; absent fields stay absent
   * for older snapshots. */
  const priorMessageTokens = finiteNonNegativeInteger(breakdown.messageTokens) ?? 0;
  const priorToolMessageTokens = finiteNonNegativeInteger(breakdown.toolMessageTokens);
  let toolMessageTokens: number | undefined;
  if (priorToolMessageTokens != null) {
    toolMessageTokens = 0;
    if (priorMessageTokens > 0 && priorToolMessageTokens > 0) {
      toolMessageTokens = Math.min(
        messageTokens,
        Math.round(
          (Math.min(priorToolMessageTokens, priorMessageTokens) / priorMessageTokens) *
            messageTokens,
        ),
      );
    }
  }
  const toolMessageTokenCounts =
    toolMessageTokens != null
      ? scaleToolMessageTokenCounts(
          breakdown.toolMessageTokenCounts,
          Math.min(priorToolMessageTokens ?? 0, priorMessageTokens),
          toolMessageTokens,
        )
      : undefined;

  const nextBreakdown = {
    ...breakdown,
    instructionTokens,
    summaryTokens,
    messageTokens,
  };
  if (toolMessageTokens == null) {
    delete nextBreakdown.toolMessageTokens;
    delete nextBreakdown.toolMessageTokenCounts;
  } else {
    nextBreakdown.toolMessageTokens = toolMessageTokens;
    if (toolMessageTokenCounts == null) {
      delete nextBreakdown.toolMessageTokenCounts;
    } else {
      nextBreakdown.toolMessageTokenCounts = toolMessageTokenCounts;
    }
  }
  const result = {
    ...snapshot,
    breakdown: nextBreakdown,
  };
  if (budget != null) {
    result.remainingContextTokens = Math.max(0, budget - normalizedPromptTokens);
  } else {
    const remaining = finiteNonNegativeInteger(snapshot.remainingContextTokens);
    if (remaining == null) {
      delete result.remainingContextTokens;
    } else {
      result.remainingContextTokens = remaining;
    }
  }
  return result;
};

/** Provider output, including reasoning omitted from an under-reported output count. */
export const outputTokensFromUsage = (event: TTokenUsageEvent): number => {
  const output = finiteNonNegativeInteger(event.output_tokens) ?? 0;
  const total = finiteNonNegativeInteger(event.total_tokens) ?? 0;
  return Math.max(output, total - promptTokensFromUsage(event));
};

/** Reconcile and retain the primary call details on live, saved, and resumable snapshots. */
export const reconcileContextUsageFromEvent = (
  snapshot: TContextUsageEvent,
  event: TTokenUsageEvent,
): TContextUsageEvent => ({
  ...reconcileContextUsage(snapshot, promptTokensFromUsage(event)),
  model: event.model,
  provider: event.provider,
  completedOutputTokens: outputTokensFromUsage(event),
  cacheRead: finiteNonNegativeInteger(event.input_token_details?.cache_read) ?? 0,
  cacheWrite: finiteNonNegativeInteger(event.input_token_details?.cache_creation) ?? 0,
});

/** Lifecycle phase carried on subagent-progress envelopes (mirrors SDK SubagentUpdatePhase). */
export type SubagentUpdatePhase =
  | 'start'
  | 'run_step'
  | 'run_step_delta'
  | 'run_step_completed'
  | 'run_step_closed'
  | 'message_delta'
  | 'reasoning_delta'
  | 'stop'
  | 'error';

/** Structured root-to-leaf identity for one nested subagent execution. */
export interface SubagentAncestryEntry {
  readonly subagentRunId: string;
  readonly subagentType: string;
  readonly subagentKind: 'agent' | 'graph';
  /** Execution subject ID; synthetic for graph subagents. */
  readonly subagentAgentId: string;
  readonly parentRunId: string;
  readonly parentAgentId?: string;
  readonly parentToolCallId?: string;
}

export type SubagentIdentity = Pick<SubagentAncestryEntry, 'subagentKind' | 'subagentAgentId'>;

/** Single streamed subagent update forwarded by the SDK's SubagentExecutor. */
export interface SubagentUpdateEvent {
  runId: string;
  parentRunId?: string;
  subagentRunId: string;
  /** Host-assigned identity preserved when one detached update overlaps delivery streams. */
  activityEventId?: string;
  /** Host-assigned monotonic sequence within one detached child run. */
  activitySequence?: number;
  /** Parent-side `tool_call_id` for the `subagent` tool invocation that
   *  triggered this run. Surfaces from the SDK (`3.1.67-dev.2`+) so hosts
   *  can correlate child progress to the parent tool call deterministically. */
  parentToolCallId?: string;
  subagentType: string;
  subagentKind?: 'agent' | 'graph';
  /** Execution subject ID; synthetic for graph subagents. */
  subagentAgentId: string;
  memberAgentId?: string;
  depth?: number;
  ancestry?: readonly SubagentAncestryEntry[];
  parentAgentId?: string;
  phase: SubagentUpdatePhase;
  data?: unknown;
  label?: string;
  timestamp: string;
}
