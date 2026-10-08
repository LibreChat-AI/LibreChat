import { ContentTypes } from 'librechat-data-provider';
import type { HookCallback } from '@librechat/agents';
import type {
  ActivityLabelBlockContext,
  ActivityLabelInvokeCallbacks,
  ActivityLabelLLM,
  GenerateLabelPayload,
} from './runtime';
import { ACTIVITY_INSTRUCTION, createActivityLabelHook } from './runtime';

/** Structural view of a content part; hosts pass their live parts array. */
export interface LooseContentPart {
  type?: string;
  text?: unknown;
  think?: unknown;
  agentId?: unknown;
  groupId?: unknown;
  tool_call?: { id?: unknown };
  pending?: boolean;
  phase?: unknown;
  [key: string]: unknown;
}

const MAX_EXCERPTS = 4;
const EXCERPT_CHARS = 300;
const INTENT_CHARS = 200;

function textValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  const nested = (value as { value?: unknown } | null | undefined)?.value;
  return typeof nested === 'string' ? nested : '';
}

/**
 * Captures the current activity block's context for the label payload:
 * reasoning excerpts since the last text part, plus the assistant's last
 * text (~200 chars) as intent. Deliberately NO human messages. Reasoning
 * collection stops at the previous block's label part — labels delimit
 * blocks, so scanning past one would bleed another batch's reasoning into
 * this payload — and filters by executing agent in multi-agent runs.
 * Intent keeps scanning past labels: with consecutive batches and no
 * interleaved text, the assistant's last words remain the current intent.
 */
export function captureActivityBlockContext(
  parts: ReadonlyArray<LooseContentPart | null | undefined>,
  executingAgentId?: string,
): ActivityLabelBlockContext {
  const thinkingExcerpts: string[] = [];
  let lastAssistantText: string | undefined;
  let lastAssistantPhase: ActivityLabelBlockContext['lastAssistantPhase'];
  let collectThinking = true;
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (part == null) {
      continue;
    }
    if (part.type === ContentTypes.ACTIVITY_LABEL) {
      collectThinking = false;
      continue;
    }
    if (part.type === ContentTypes.TEXT) {
      /** Parallel/added-agent runs interleave text parts from several
       *  agents; another agent's text at the tail is not this batch's
       *  intent, so skip it rather than stopping the scan there. */
      if (executingAgentId != null && part.agentId != null && part.agentId !== executingAgentId) {
        continue;
      }
      const text = textValue(part.text).trim();
      if (text.length > 0) {
        lastAssistantText = text.slice(-INTENT_CHARS);
        if (part.phase === 'commentary' || part.phase === 'final_answer') {
          lastAssistantPhase = part.phase;
        }
        break;
      }
      continue;
    }
    if (
      collectThinking &&
      part.type === ContentTypes.THINK &&
      thinkingExcerpts.length < MAX_EXCERPTS &&
      (executingAgentId == null || part.agentId == null || part.agentId === executingAgentId)
    ) {
      const think = textValue(part.think).trim();
      if (think.length > 0) {
        thinkingExcerpts.unshift(think.slice(0, EXCERPT_CHARS));
      }
    }
  }
  return { thinkingExcerpts, lastAssistantText, lastAssistantPhase };
}

/**
 * Removes UI-only activity-label parts from a message payload before any
 * `formatAgentMessages` call. Published SDK versions without the formatter
 * skip would otherwise fold the label text into provider-facing content via
 * the formatter's catch-all. Non-mutating; returns the same reference when
 * nothing needed stripping.
 */
export function stripActivityLabelParts<T extends { content?: unknown }>(payload: T[]): T[] {
  if (!Array.isArray(payload)) {
    return payload;
  }
  let changed = false;
  const result = payload.map((message) => {
    const content = message?.content;
    if (!Array.isArray(content)) {
      return message;
    }
    const filtered = content.filter(
      (part) => (part as LooseContentPart | null | undefined)?.type !== ContentTypes.ACTIVITY_LABEL,
    );
    if (filtered.length === content.length) {
      return message;
    }
    changed = true;
    return { ...message, content: filtered };
  });
  return changed ? result : payload;
}

/** Minimal SSE shape for synthesized gap events. */
interface ActivityLabelGapEvent {
  event: string;
  data: Record<string, unknown>;
}

/**
 * Synthesizes `on_activity_label` events for labels that appeared OR were
 * filled between a resume snapshot and subscriber attach. In Redis mode the
 * label publish is fire-and-forget and the sync payload carries only the
 * snapshot, so a label claimed or resolved in that window would otherwise
 * never reach the reconnecting client. Compares by index: a fresh label part
 * whose text, pending state, or phase bounds differ from the snapshot's (or
 * that has no snapshot counterpart) is re-emitted. Idempotent - the client
 * applier ignores duplicates and refuses stale pending placeholders.
 */
export function synthesizeActivityLabelGapEvents(
  snapshotContent: ReadonlyArray<LooseContentPart | null | undefined>,
  freshContent: ReadonlyArray<LooseContentPart | null | undefined>,
  meta: { conversationId: string; responseMessageId?: string },
): ActivityLabelGapEvent[] {
  const events: ActivityLabelGapEvent[] = [];
  for (let i = 0; i < freshContent.length; i++) {
    const part = freshContent[i];
    if (part?.type !== ContentTypes.ACTIVITY_LABEL) {
      continue;
    }
    const snapshot = snapshotContent[i];
    const isSameLabel =
      snapshot?.type === ContentTypes.ACTIVITY_LABEL &&
      snapshot[ContentTypes.ACTIVITY_LABEL] === part[ContentTypes.ACTIVITY_LABEL] &&
      snapshot.activity_label_type === part.activity_label_type &&
      snapshot.activity_start_index === part.activity_start_index &&
      snapshot.activity_end_index === part.activity_end_index &&
      snapshot.activity_count === part.activity_count &&
      snapshot.pending === part.pending;
    if (isSameLabel) {
      continue;
    }
    events.push({
      event: 'on_activity_label',
      data: {
        index: i,
        part,
        conversationId: meta.conversationId,
        ...(meta.responseMessageId != null && { responseMessageId: meta.responseMessageId }),
      },
    });
  }
  return events;
}

/** Host closures the wiring needs; each is a thin bridge into the caller. */
export interface ActivityLabelHostDeps {
  /** Cost cap from `activityMaxPerRun`; falls back to the hook default. */
  maxPerRun?: number;
  /** Prompt truncation from `activityCharLimit`; falls back to the hook default. */
  charLimit?: number;
  /** `activityPrompt` override, applied on both generation paths. */
  prompt?: string;
  abortSignal?: AbortSignal;
  /** Returns the LIVE host content array (same instance the SDK writes into). */
  getContentParts: () => Array<LooseContentPart | null | undefined>;
  /** Bumps the shared index offset so subsequent SDK indices skip the slot. */
  bumpIndexOffset: () => void;
  /** Emits the on_activity_label SSE/chunk event for a slot state. */
  emitLabelEvent: (index: number, part: LooseContentPart) => Promise<unknown>;
  /** Registers a promise the bounded settle must await at finalization:
   *  per-slot fill completion AND the hook's whole detached task (fill plus
   *  the usage accounting deferred until after the commit). */
  trackPendingFill: (fillDone: Promise<void>) => void;
  /**
   * True once the response has finalized (settle timed out). A late fill
   * must then neither mutate persisted content nor emit chunks for a job
   * whose runtime is gone.
   */
  isClosed?: () => boolean;
  resolveLLM: () => Promise<ActivityLabelLLM>;
  /**
   * Resolve `undefined` to DECLINE — this bridge cannot serve the request, so
   * the hook falls back to the direct model call. `null` means it ran and
   * produced no label. The distinction is the contract the hook keys on, so it
   * belongs in the exported type.
   */
  generateLabel?: (payload: GenerateLabelPayload) => Promise<string | null | undefined>;
  getInvokeCallbacks?: () => ActivityLabelInvokeCallbacks;
}

/**
 * Builds the run wiring for activity labels: slot claiming at each batch
 * boundary (steering's index-offset pattern), fill-time label emit,
 * groupId/agentId lane stamping, and settle tracking. Implementation lives
 * here (TS) so the JS controller stays a thin wrapper.
 */
export function createActivityLabelWiring(deps: ActivityLabelHostDeps): {
  hook: HookCallback<'PostToolBatch'>;
} {
  /** One pass over resumed content for BOTH seeds: the quota counts every
   *  label part (filled or not, so a HITL resume cannot mint a fresh quota
   *  after every approval) while continuity keeps only committed text,
   *  keyed by content index so run order survives out-of-order fills. */
  const resumedParts = deps.getContentParts();
  let initialGeneratedCount = 0;
  const initialLabels: Array<{ index: number; text: string }> = [];
  for (let i = 0; i < resumedParts.length; i++) {
    const part = resumedParts[i];
    if (part?.type !== ContentTypes.ACTIVITY_LABEL || part.activity_label_type === 'phase') {
      continue;
    }
    initialGeneratedCount += 1;
    const text = part[ContentTypes.ACTIVITY_LABEL];
    if (typeof text === 'string' && text.length > 0 && part.pending !== true) {
      initialLabels.push({ index: i, text });
    }
  }
  return {
    hook: createActivityLabelHook({
      resolveLLM: deps.resolveLLM,
      ...(deps.maxPerRun != null && { maxPerRun: deps.maxPerRun }),
      ...(deps.charLimit != null && { charLimit: deps.charLimit }),
      /** Always send an instruction. With none, the SDK path falls back to
       *  the published package's own generic prompt, so the register this
       *  module defines would apply to the fallback path only. */
      prompt: deps.prompt ?? ACTIVITY_INSTRUCTION,
      initialGeneratedCount,
      initialLabels,
      /** The settle must cover the whole detached task: deferred usage runs
       *  AFTER the fill resolves, so tracking fills alone would let
       *  finalization flush the usage sink mid-billing. */
      trackTask: deps.trackPendingFill,
      signal: deps.abortSignal,
      getInvokeCallbacks: deps.getInvokeCallbacks,
      ...(deps.generateLabel && { generateLabel: deps.generateLabel }),
      claimSlot: (meta) => {
        const parts = deps.getContentParts();
        const index = parts.length;
        /** Parallel-column runs: carry the batch's groupId onto the label
         *  part so ParallelContentRenderer places it inside its group
         *  instead of filtering it out as an unplaced sequential part. */
        let groupId: unknown;
        for (let i = parts.length - 1; i >= 0 && groupId == null; i--) {
          const prior = parts[i];
          if (
            prior?.type === ContentTypes.TOOL_CALL &&
            prior.groupId != null &&
            typeof prior.tool_call?.id === 'string' &&
            meta.toolCallIds.includes(prior.tool_call.id)
          ) {
            groupId = prior.groupId;
          }
        }
        /** Context is captured BEFORE the label part is pushed — the scan
         *  stops at ACTIVITY_LABEL parts, so capturing after the push would
         *  hit the just-inserted label at the tail and collect nothing. */
        const context = captureActivityBlockContext(parts, meta.executingAgentId);
        const part: LooseContentPart = {
          type: ContentTypes.ACTIVITY_LABEL,
          [ContentTypes.ACTIVITY_LABEL]: '',
          tool_call_ids: meta.toolCallIds,
          status: meta.status,
          ...(meta.executingAgentId != null && { agentId: meta.executingAgentId }),
          ...(groupId != null && { groupId }),
          pending: true,
        };
        parts.push(part);
        deps.bumpIndexOffset();
        /**
         * Publish the reservation immediately, empty and pending.
         *
         * Reserving the index server-side is not enough on its own: with no
         * event for this slot, a cross-instance replay rebuilds content as
         * [tool, <hole>, laterText] and compacts the hole away, so the fill
         * that later arrives for this index lands on `laterText` and
         * overwrites it. Publishing the empty part keeps the slot real
         * everywhere the content is reconstructed.
         *
         * It stays invisible: `groupSequentialToolCalls` lets an empty label
         * delimit its batch without becoming the header, so the block renders
         * exactly as it does with the feature off until `fill` lands.
         */
        void Promise.resolve(deps.emitLabelEvent(index, part)).catch(() => {
          /** Best-effort: a dropped reservation degrades to the pre-fix
           *  behavior, and must never break the batch that triggered it. */
        });
        let resolveFill: () => void = () => undefined;
        const fillDone = new Promise<void>((resolve) => {
          resolveFill = resolve;
        });
        deps.trackPendingFill(fillDone);
        return {
          index,
          context,
          fill: async (text) => {
            try {
              /** Finalization already passed: drop the result rather than
               *  mutating a saved response or emitting into a closed job.
               *  `false` tells the hook the label never surfaced, so its
               *  usage must not be billed. A scope that closes AFTER this
               *  check — while the durable emit below is in flight — does
               *  NOT un-commit: the emit was already dispatched and the
               *  mutation lands with it, so the fill still resolves `true`
               *  and the committed label bills. */
              if (deps.isClosed?.() === true) {
                return false;
              }
              /** Staged on a COPY; the shared part mutates only AFTER the
               *  durable emit succeeds. Mutating first let a FAILED emit
               *  leave the text on `contentParts` anyway — persistence could
               *  then save and display a label that no client ever received
               *  and that billing (keyed on the commit flag) never charged.
               *  Emitted even when generation produced nothing: the claim
               *  already published a PENDING part, so staying silent would
               *  leave the client pinned at pending forever. */
              const next: LooseContentPart = { ...part, pending: false };
              if (text != null && text.length > 0) {
                next[ContentTypes.ACTIVITY_LABEL] = text;
              }
              await deps.emitLabelEvent(index, next);
              part.pending = false;
              if (text != null && text.length > 0) {
                part[ContentTypes.ACTIVITY_LABEL] = text;
              }
              return true;
            } finally {
              resolveFill();
            }
          },
        };
      },
    }),
  };
}
