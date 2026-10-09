import { GraphEvents } from '@librechat/agents';
import { ContentTypes, StepTypes } from 'librechat-data-provider';
import type { EventHandler } from '@librechat/agents';
import type { LooseContentPart } from '~/agents/activityLabels/wiring';

export type ReasoningLabelStatus = 'streaming' | 'complete';

export interface GenerateReasoningLabelPayload {
  visibleReasoning: string;
  reasoningStepId: string;
  revision: number;
  status: ReasoningLabelStatus;
  previousLabel?: string;
  agentId?: string;
  prompt?: string;
  charLimit: number;
  signal: AbortSignal;
}

export interface GeneratedReasoningLabel {
  label?: string;
  /** Bills this provider call; receives the least-normalized completion text
   * available when metadata-based token counts are absent. */
  collectUsage?: (completionText?: string) => void | Promise<void>;
}

export interface ReasoningLabelEvent {
  index: number;
  stepId: string;
  revision: number;
  label: string;
  status: ReasoningLabelStatus;
}

export interface ReasoningLabelAttemptEvent {
  index: number;
  stepId: string;
  attempts: number;
  submittedChars: number;
}

export interface ReasoningLabelHostDeps {
  minChars?: number;
  updateChars?: number;
  updateIntervalMs?: number;
  maxPerRun?: number;
  /** Explicit call-budget seed. Omit on HITL resume to derive it from content;
   *  pass zero for a new generation whose retained edit prefix is historical. */
  initialAttempts?: number;
  prompt?: string;
  abortSignal?: AbortSignal;
  getContentParts: () => Array<LooseContentPart | null | undefined>;
  getStepIndex: (stepId: string) => number | undefined;
  emitAttemptEvent: (event: ReasoningLabelAttemptEvent) => Promise<unknown>;
  emitLabelEvent: (event: ReasoningLabelEvent) => Promise<unknown>;
  trackPendingFill: (fillDone: Promise<void>) => void;
  isClosed?: () => boolean;
  generateLabel: (payload: GenerateReasoningLabelPayload) => Promise<GeneratedReasoningLabel>;
  now?: () => number;
}

export interface ReasoningLabelWiring {
  handlers: (
    handlers: Record<string, EventHandler> | undefined,
  ) => Record<string, EventHandler> | undefined;
  /** Closes every reasoning step and schedules any meaningful trailing revision. */
  complete: () => void;
}

interface ReasoningLabelGapEvent {
  event: string;
  data: Record<string, unknown>;
}

interface ReasoningStepState {
  stepId: string;
  agentId?: string;
  index?: number;
  text: string;
  totalChars: number;
  label?: string;
  labelStatus?: ReasoningLabelStatus;
  revision: number;
  attempts: number;
  submittedChars: number;
  lastSubmittedAt: number;
  closed: boolean;
  pendingFinal: boolean;
  timer?: ReturnType<typeof setTimeout>;
  inFlight?: Promise<void>;
  completionTask?: Promise<void>;
}

const DEFAULT_MIN_CHARS = 500;
const DEFAULT_UPDATE_CHARS = 400;
const DEFAULT_UPDATE_INTERVAL_MS = 3_000;
const DEFAULT_MAX_PER_RUN = 8;
const REASONING_PROMPT_CHAR_LIMIT = 4_000;
const MAX_TRACKED_REASONING_CHARS = 8_000;
/** Terminal exception to the streaming gates: enough new evidence merits a
 * completion rewrite; a smaller tail only upgrades the current status. */
const FINAL_UPDATE_CHAR_LIMIT = 120;
const OUTPUT_CHAR_LIMIT = 120;
const REQUEST_TIMEOUT_MS = 12_000;

function textValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  const nested = (value as { value?: unknown } | null | undefined)?.value;
  return typeof nested === 'string' ? nested : '';
}

function deltaText(data: unknown): string {
  const raw = (data as { delta?: { content?: unknown } } | null)?.delta?.content;
  let parts: unknown[] = [];
  if (Array.isArray(raw)) {
    parts = raw;
  } else if (raw != null) {
    parts = [raw];
  }
  return parts
    .filter((part) => (part as { type?: unknown } | null)?.type === ContentTypes.THINK)
    .map((part) => textValue((part as { think?: unknown }).think))
    .join('');
}

function normalizeLabel(value: string | undefined): string {
  const firstLine = value?.split(/\r?\n/).find((line) => line.trim().length > 0) ?? '';
  const normalized = firstLine
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/, '')
    .trim();
  return normalized.length > OUTPUT_CHAR_LIMIT
    ? `${normalized.slice(0, OUTPUT_CHAR_LIMIT - 1)}…`
    : normalized;
}

function appendBoundedReasoning(current: string, delta: string): string {
  const combined = `${current}${delta}`;
  if (combined.length <= MAX_TRACKED_REASONING_CHARS) {
    return combined;
  }
  const headChars = Math.floor(MAX_TRACKED_REASONING_CHARS / 4);
  const tailChars = MAX_TRACKED_REASONING_CHARS - headChars;
  return `${combined.slice(0, headChars)}\n…\n${combined.slice(-tailChars)}`;
}

function buildSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal != null && typeof AbortSignal.any === 'function'
    ? AbortSignal.any([signal, timeout])
    : timeout;
}

function getReasoningPart(
  deps: ReasoningLabelHostDeps,
  state: ReasoningStepState,
): LooseContentPart | null | undefined {
  const index = deps.getStepIndex(state.stepId) ?? state.index;
  if (index != null) {
    state.index = index;
  }
  const part = index != null ? deps.getContentParts()[index] : undefined;
  return part?.type === ContentTypes.THINK ? part : undefined;
}

/** Re-emits reasoning-title revisions or resets committed in the resume snapshot gap. */
export function synthesizeReasoningLabelGapEvents(
  snapshotContent: ReadonlyArray<LooseContentPart | null | undefined>,
  freshContent: ReadonlyArray<LooseContentPart | null | undefined>,
  meta: { conversationId: string; responseMessageId?: string },
): ReasoningLabelGapEvent[] {
  const events: ReasoningLabelGapEvent[] = [];
  for (let i = 0; i < freshContent.length; i += 1) {
    const part = freshContent[i];
    if (part?.type !== ContentTypes.THINK) {
      continue;
    }
    const snapshot = snapshotContent[i];
    const snapshotStepId =
      snapshot?.type === ContentTypes.THINK && typeof snapshot.reasoning_label_step_id === 'string'
        ? snapshot.reasoning_label_step_id
        : undefined;
    const freshStepId =
      typeof part.reasoning_label_step_id === 'string' ? part.reasoning_label_step_id : undefined;
    const freshHasLabel =
      typeof part.reasoning_label === 'string' &&
      part.reasoning_label.trim().length > 0 &&
      typeof part.reasoning_label_revision === 'number' &&
      freshStepId != null;
    if (snapshotStepId != null && freshStepId != null && snapshotStepId !== freshStepId) {
      events.push({
        event: 'on_reasoning_label',
        data: {
          index: i,
          stepId: freshStepId,
          reset: true,
          previousStepId: snapshotStepId,
          ...(typeof part.reasoning_label_attempts === 'number' && {
            attempts: part.reasoning_label_attempts,
          }),
          conversationId: meta.conversationId,
          ...(meta.responseMessageId != null && { responseMessageId: meta.responseMessageId }),
        },
      });
    }
    if (!freshHasLabel) {
      continue;
    }
    if (
      snapshot?.type === ContentTypes.THINK &&
      snapshot.reasoning_label_step_id === part.reasoning_label_step_id &&
      snapshot.reasoning_label === part.reasoning_label &&
      snapshot.reasoning_label_revision === part.reasoning_label_revision &&
      snapshot.reasoning_label_status === part.reasoning_label_status
    ) {
      continue;
    }
    events.push({
      event: 'on_reasoning_label',
      data: {
        index: i,
        stepId: part.reasoning_label_step_id,
        revision: part.reasoning_label_revision,
        label: part.reasoning_label,
        status: part.reasoning_label_status === 'complete' ? 'complete' : 'streaming',
        conversationId: meta.conversationId,
        ...(meta.responseMessageId != null && { responseMessageId: meta.responseMessageId }),
      },
    });
  }
  return events;
}

/**
 * Adds a throttled, revision-safe title lifecycle to top-level reasoning run
 * steps. Nested subagent-content envelopes have a separate persistence and UI
 * lifecycle and are intentionally outside this wiring. The title lives on the
 * THINK part itself, so updates never reserve or shift content indices.
 */
export function createReasoningLabelWiring(deps: ReasoningLabelHostDeps): ReasoningLabelWiring {
  const minChars = deps.minChars ?? DEFAULT_MIN_CHARS;
  const updateChars = deps.updateChars ?? DEFAULT_UPDATE_CHARS;
  const updateIntervalMs = deps.updateIntervalMs ?? DEFAULT_UPDATE_INTERVAL_MS;
  const maxPerRun = deps.maxPerRun ?? DEFAULT_MAX_PER_RUN;
  const now = deps.now ?? Date.now;
  const steps = new Map<string, ReasoningStepState>();
  const activeStepByAgent = new Map<string, string>();
  const initialParts = deps.getContentParts();
  const durableAttempts = initialParts.reduce((highest, part) => {
    if (part?.type !== ContentTypes.THINK || typeof part.reasoning_label_attempts !== 'number') {
      return highest;
    }
    return Math.max(highest, part.reasoning_label_attempts);
  }, 0);
  const committedFallback = initialParts.reduce((highest, part) => {
    if (
      part?.type !== ContentTypes.THINK ||
      typeof part.reasoning_label_revision !== 'number' ||
      part.reasoning_label_revision <= 0
    ) {
      return highest;
    }
    return Math.max(highest, part.reasoning_label_revision);
  }, 0);
  /** `reasoning_label_attempts` is a run-cumulative high-water mark, not a
   *  per-step counter. Taking the max lets a new reasoning step reuse the same
   *  THINK slot without erasing provider calls already spent before HITL. */
  let generated = deps.initialAttempts ?? Math.max(durableAttempts, committedFallback);

  const emitCommitted = async (
    state: ReasoningStepState,
    revision: number,
    label: string,
    status: ReasoningLabelStatus,
  ): Promise<boolean> => {
    if (deps.isClosed?.() === true || deps.abortSignal?.aborted) {
      return false;
    }
    const part = getReasoningPart(deps, state);
    const index = state.index;
    if (part == null || index == null || part.reasoning_label_step_id !== state.stepId) {
      return false;
    }
    const currentRevision =
      part.reasoning_label_step_id === state.stepId &&
      typeof part.reasoning_label_revision === 'number'
        ? part.reasoning_label_revision
        : 0;
    if (revision < currentRevision) {
      return false;
    }
    await deps.emitLabelEvent({ index, stepId: state.stepId, revision, label, status });
    /** The durable emit can yield while another delta replaces the THINK
     *  object. Re-fetch the authoritative slot instead of mutating the
     *  pre-await reference, which may now be orphaned. */
    const committedPart = getReasoningPart(deps, state);
    if (
      committedPart == null ||
      state.index !== index ||
      committedPart.reasoning_label_step_id !== state.stepId
    ) {
      return false;
    }
    Object.assign(committedPart, {
      reasoning_label: label,
      reasoning_label_step_id: state.stepId,
      reasoning_label_revision: revision,
      reasoning_label_status: status,
    });
    state.label = label;
    state.labelStatus = status;
    state.revision = revision;
    return true;
  };

  const markComplete = (state: ReasoningStepState): void => {
    if (!state.label || state.completionTask != null) {
      return;
    }
    const part = getReasoningPart(deps, state);
    if (state.labelStatus === 'complete' || part?.reasoning_label_status === 'complete') {
      return;
    }
    const task = emitCommitted(state, state.revision, state.label, 'complete')
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        state.completionTask = undefined;
      });
    state.completionTask = task;
    deps.trackPendingFill(task);
  };

  const shouldGenerate = (state: ReasoningStepState, final: boolean): boolean => {
    const length = state.totalChars;
    if (!state.label) {
      if (length < minChars) {
        return false;
      }
      if (state.submittedChars === 0) {
        return true;
      }
      const changed = Math.max(0, length - state.submittedChars);
      return changed >= (final ? Math.min(updateChars, FINAL_UPDATE_CHAR_LIMIT) : updateChars);
    }
    const changed = Math.max(0, length - state.submittedChars);
    return changed >= (final ? Math.min(updateChars, FINAL_UPDATE_CHAR_LIMIT) : updateChars);
  };

  const clearTimer = (state: ReasoningStepState): void => {
    if (state.timer != null) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
  };

  const schedule = (state: ReasoningStepState, final = state.closed): void => {
    if (deps.isClosed?.() === true || deps.abortSignal?.aborted) {
      clearTimer(state);
      return;
    }
    state.pendingFinal ||= final;
    if (state.inFlight != null) {
      return;
    }
    if (!shouldGenerate(state, state.pendingFinal)) {
      clearTimer(state);
      if (state.pendingFinal) {
        markComplete(state);
      }
      return;
    }
    if (generated >= maxPerRun) {
      clearTimer(state);
      markComplete(state);
      return;
    }
    const waitMs =
      state.attempts > 0 ? Math.max(0, state.lastSubmittedAt + updateIntervalMs - now()) : 0;
    if (!state.pendingFinal && waitMs > 0) {
      if (state.timer == null) {
        state.timer = setTimeout(() => {
          state.timer = undefined;
          schedule(state);
        }, waitMs);
      }
      return;
    }

    clearTimer(state);
    const status: ReasoningLabelStatus = state.pendingFinal ? 'complete' : 'streaming';
    state.pendingFinal = false;
    const visibleReasoning = state.text.trim();
    state.submittedChars = state.totalChars;
    state.lastSubmittedAt = now();
    generated += 1;
    state.attempts += 1;
    const attempts = generated;
    /** Provider-call sequence doubles as the visible revision. Failed or
     *  suppressed attempts may leave gaps, but a later call never reuses the
     *  same SDK/Langfuse trace identity. */
    const revision = attempts;
    const task = (async () => {
      const part = getReasoningPart(deps, state);
      const index = state.index;
      if (part == null || index == null || part.reasoning_label_step_id !== state.stepId) {
        return;
      }
      try {
        await deps.emitAttemptEvent({
          index,
          stepId: state.stepId,
          attempts,
          submittedChars: state.submittedChars,
        });
      } catch {
        return;
      }
      const reservedPart = getReasoningPart(deps, state);
      if (
        reservedPart == null ||
        state.index !== index ||
        reservedPart.reasoning_label_step_id !== state.stepId
      ) {
        return;
      }
      Object.assign(reservedPart, {
        reasoning_label_step_id: state.stepId,
        reasoning_label_attempts: attempts,
        reasoning_label_submitted_chars: state.submittedChars,
      });
      let generatedLabel: GeneratedReasoningLabel = {};
      try {
        generatedLabel = await deps.generateLabel({
          visibleReasoning,
          reasoningStepId: state.stepId,
          revision,
          status,
          ...(state.label != null && { previousLabel: state.label }),
          ...(state.agentId != null && { agentId: state.agentId }),
          ...(deps.prompt != null && { prompt: deps.prompt }),
          charLimit: REASONING_PROMPT_CHAR_LIMIT,
          signal: buildSignal(deps.abortSignal),
        });
      } catch {
        generatedLabel = {};
      }
      const label = normalizeLabel(generatedLabel.label);
      /** Provider usage is billable even when output normalization rejects
       *  the title or a later durable UI patch loses ownership. Start it in
       *  parallel so balance persistence never delays the visible revision. */
      const usageTask = (async () => {
        try {
          await generatedLabel.collectUsage?.(generatedLabel.label || label || undefined);
        } catch {
          // Accounting failures must not suppress a valid visible title.
        }
      })();
      /** Billing remains part of final settlement, but not the per-step
       * generation lock. A slow balance write must not prevent a trailing
       * terminal revision from being generated and durably shown. */
      deps.trackPendingFill(usageTask);
      if (!label) {
        if (status === 'complete') {
          markComplete(state);
        }
        return;
      }
      let committed = false;
      try {
        committed = await emitCommitted(state, revision, label, status);
      } catch {
        return;
      }
      if (!committed) {
        return;
      }
    })().finally(() => {
      state.inFlight = undefined;
      if (state.closed || state.totalChars - state.submittedChars >= updateChars) {
        schedule(state, state.closed);
      }
    });
    state.inFlight = task;
    deps.trackPendingFill(task);
  };

  const closeStep = (stepId: string): void => {
    const state = steps.get(stepId);
    if (state == null || state.closed) {
      return;
    }
    state.closed = true;
    clearTimer(state);
    schedule(state, true);
  };

  const startStep = (data: unknown, metadata?: Record<string, unknown>): void => {
    const step = data as {
      id?: string;
      agentId?: string;
      stepDetails?: { type?: string; message_creation?: { content_type?: string } };
    };
    const hideSequentialOutputs = metadata?.hide_sequential_outputs === true;
    const lastAgentId = metadata?.last_agent_id;
    const graphNode = metadata?.langgraph_node;
    const isLastAgent =
      typeof lastAgentId === 'string' &&
      typeof graphNode === 'string' &&
      graphNode.endsWith(lastAgentId);
    if (
      (hideSequentialOutputs && !isLastAgent) ||
      !step.id ||
      step.stepDetails?.type !== StepTypes.MESSAGE_CREATION ||
      step.stepDetails.message_creation?.content_type !== ContentTypes.THINK
    ) {
      return;
    }
    const agentKey = step.agentId ?? 'root';
    const previousStepId = activeStepByAgent.get(agentKey);
    if (previousStepId != null && previousStepId !== step.id) {
      closeStep(previousStepId);
    }
    activeStepByAgent.set(agentKey, step.id);
    if (steps.has(step.id)) {
      return;
    }
    const index = deps.getStepIndex(step.id);
    const part = index != null ? deps.getContentParts()[index] : undefined;
    const ownsExistingStep =
      part?.type === ContentTypes.THINK && part.reasoning_label_step_id === step.id;
    const existingLabel =
      ownsExistingStep && typeof part.reasoning_label === 'string'
        ? part.reasoning_label
        : undefined;
    const existingText = ownsExistingStep ? textValue(part?.think) : '';
    const persistedSubmittedChars =
      ownsExistingStep && typeof part.reasoning_label_submitted_chars === 'number'
        ? Math.min(part.reasoning_label_submitted_chars, existingText.trim().length)
        : undefined;
    const hasSubmitted =
      ownsExistingStep &&
      (persistedSubmittedChars != null ||
        (typeof part.reasoning_label_revision === 'number' && part.reasoning_label_revision > 0));
    const revision =
      ownsExistingStep && typeof part.reasoning_label_revision === 'number'
        ? part.reasoning_label_revision
        : 0;
    const state: ReasoningStepState = {
      stepId: step.id,
      ...(step.agentId != null && { agentId: step.agentId }),
      ...(index != null && { index }),
      text: appendBoundedReasoning('', existingText),
      totalChars: existingText.trim().length,
      ...(existingLabel != null && { label: existingLabel }),
      ...(existingLabel != null && {
        labelStatus: part?.reasoning_label_status === 'complete' ? 'complete' : 'streaming',
      }),
      revision,
      attempts: hasSubmitted ? 1 : 0,
      submittedChars: persistedSubmittedChars ?? (hasSubmitted ? existingText.trim().length : 0),
      lastSubmittedAt: hasSubmitted ? now() : 0,
      closed: false,
      pendingFinal: false,
    };
    steps.set(step.id, state);
    if (part?.type === ContentTypes.THINK) {
      if (!ownsExistingStep) {
        delete part.reasoning_label;
        delete part.reasoning_label_revision;
        delete part.reasoning_label_status;
        delete part.reasoning_label_submitted_chars;
      }
      Object.assign(part, {
        reasoning_label_step_id: step.id,
        reasoning_label_attempts: generated,
      });
    }
    schedule(state);
  };

  const appendDelta = (data: unknown): void => {
    const event = data as { id?: string };
    const text = deltaText(data);
    if (!event.id || !text) {
      return;
    }
    const state = steps.get(event.id);
    if (state == null || state.closed) {
      return;
    }
    const part = getReasoningPart(deps, state);
    if (part != null) {
      Object.assign(part, {
        reasoning_label_step_id: state.stepId,
        reasoning_label_attempts: generated,
        ...(state.attempts > 0 && {
          reasoning_label_submitted_chars: state.submittedChars,
        }),
        ...(state.label != null && state.revision > 0
          ? {
              reasoning_label: state.label,
              reasoning_label_revision: state.revision,
              reasoning_label_status: state.labelStatus ?? 'streaming',
            }
          : {}),
      });
    }
    state.text = appendBoundedReasoning(state.text, text);
    state.totalChars += text.length;
    schedule(state);
  };

  const wrapHandlers = (
    handlers: Record<string, EventHandler> | undefined,
  ): Record<string, EventHandler> | undefined => {
    if (handlers == null) {
      return handlers;
    }
    const wrapped = { ...handlers };
    const runStepHandler = handlers[GraphEvents.ON_RUN_STEP];
    if (runStepHandler != null) {
      wrapped[GraphEvents.ON_RUN_STEP] = {
        handle: async (event, data, metadata, graph) => {
          const result = await runStepHandler.handle(event, data, metadata, graph);
          startStep(data, metadata);
          return result;
        },
      };
    }
    const reasoningHandler = handlers[GraphEvents.ON_REASONING_DELTA];
    if (reasoningHandler != null) {
      wrapped[GraphEvents.ON_REASONING_DELTA] = {
        handle: async (event, data, metadata, graph) => {
          const result = await reasoningHandler.handle(event, data, metadata, graph);
          appendDelta(data);
          return result;
        },
      };
    }
    const messageHandler = handlers[GraphEvents.ON_MESSAGE_DELTA];
    if (messageHandler != null) {
      wrapped[GraphEvents.ON_MESSAGE_DELTA] = {
        handle: async (event, data, metadata, graph) => {
          const result = await messageHandler.handle(event, data, metadata, graph);
          appendDelta(data);
          return result;
        },
      };
    }
    const closedHandler = handlers[GraphEvents.ON_RUN_STEP_CLOSED];
    if (closedHandler != null) {
      wrapped[GraphEvents.ON_RUN_STEP_CLOSED] = {
        handle: async (event, data, metadata, graph) => {
          const result = await closedHandler.handle(event, data, metadata, graph);
          const id = (data as { id?: string }).id;
          if (id != null) {
            closeStep(id);
          }
          return result;
        },
      };
    }
    return wrapped;
  };

  const complete = (): void => {
    for (const state of steps.values()) {
      closeStep(state.stepId);
    }
  };

  return { handlers: wrapHandlers, complete };
}
