import { StepTypes, StepEvents, ContentTypes, ToolCallTypes } from 'librechat-data-provider';
import type {
  Agents,
  TMessage,
  EventSubmission,
  TSteerAppliedEvent,
  TActivityLabelEvent,
  TReasoningLabelEvent,
} from 'librechat-data-provider';
import type { ResumableSubscription } from './subscription';
import type { ResumableHost } from './host';
import {
  applyPendingAction,
  countTaggedApprovalParts,
  findPendingActionMessageIndex,
} from '../pending';

/**
 * Keep retrying across frames (not just once): message updates from the preceding created/step
 * events are async and can take several frames under load, so a single retry would drop a
 * valid pause and leave the run with no approval controls. Bounded so a genuinely-absent target
 * can't spin forever.
 */
const PENDING_ACTION_MAX_RETRY_FRAMES = 120;

type PhaseLabelPart = TActivityLabelEvent['part'] & {
  activity_label_type?: 'phase';
  activity_start_index?: number;
  activity_end_index?: number;
};

/**
 * Places what the stream reports beside its deltas (pending actions, injected steers, activity
 * and reasoning labels, OAuth prompts) onto the in-flight response, retrying on later frames
 * while the response placeholder has not rendered yet.
 */
export class ResponsePatcher {
  constructor(
    private readonly sub: ResumableSubscription,
    private readonly host: ResumableHost,
  ) {}

  /** Replays the step events that arrived before `created` named the turn. */
  replayPreCreatedStepEvents(): void {
    const { sub } = this;
    if (!sub.isCurrent() || sub.preCreatedStepEvents.length === 0) {
      return;
    }

    const submission = sub.liveSubmission() as EventSubmission;
    for (const event of sub.preCreatedStepEvents.splice(0)) {
      this.host.events.stepHandler(event, submission);
    }
  }

  /** Renders a pending MCP OAuth prompt as the tool call it pauses. */
  applyPendingOAuthPrompt(prompt: Agents.PendingMCPOAuthPrompt, submission: EventSubmission): void {
    const { stepHandler } = this.host.events;
    const toolCall: Agents.ToolCall = {
      id: prompt.toolCallId,
      name: prompt.toolName,
      args: '',
      type: ToolCallTypes.TOOL_CALL,
    };
    const toolCallDelta: Agents.ToolCallChunk = {
      id: prompt.toolCallId,
      name: prompt.toolName,
      args: '',
    };
    stepHandler(
      {
        event: StepEvents.ON_RUN_STEP,
        data: {
          id: prompt.stepId,
          runId: prompt.runId,
          index: prompt.index,
          type: StepTypes.TOOL_CALLS,
          stepDetails: {
            type: StepTypes.TOOL_CALLS,
            tool_calls: [toolCall],
          },
        },
      },
      submission,
    );
    stepHandler(
      {
        event: StepEvents.ON_RUN_STEP_DELTA,
        data: {
          id: prompt.stepId,
          delta: {
            type: StepTypes.TOOL_CALLS,
            tool_calls: [toolCallDelta],
            auth: prompt.authURL,
            expires_at: prompt.expiresAt,
          },
        },
      },
      submission,
    );
  }

  /**
   * Maps a pending action onto the in-flight response message so the approval / ask-user UI
   * renders. Syncs the result back into the step handler's map so subsequent deltas build on
   * the approval-tagged content rather than clobbering it.
   *
   * If the mapping is a no-op (the paused tool-call content part hasn't rendered yet, a
   * pause-before-render race), retry on subsequent frames so the approval still attaches.
   * `ask_user_question` always applies (it appends a synthetic part), so only `tool_approval`
   * ever retries.
   */
  applyPendingAction(pendingAction: Agents.PendingAction, attempt = 0): void {
    const { sub, host } = this;
    const { run } = sub;
    if (!sub.isCurrent()) {
      return;
    }
    const pendingConversationId = pendingAction.conversationId ?? sub.conversationId();
    host.pane.setPendingAction(pendingConversationId, pendingAction);
    const retryNextFrame = () => {
      if (attempt < PENDING_ACTION_MAX_RETRY_FRAMES) {
        run.pendingActionRetry = run.scheduler.requestFrame(() => {
          if (sub.isCurrent()) {
            this.applyPendingAction(pendingAction, attempt + 1);
          }
        });
      }
    };
    /** The pause card must attach to the same message state the stream
     * produced: apply any queued delta before reading the cache, or the
     * later flush would clobber the card (and `syncStepMessage` below
     * would sync a pre-delta copy). */
    host.events.flushPendingDeltas();
    const messages = host.messages.get() ?? [];
    const index = findPendingActionMessageIndex(messages, pendingAction);
    if (index < 0) {
      retryNextFrame();
      return;
    }
    const updated = applyPendingAction(messages[index], pendingAction);
    const changed = updated !== messages[index];
    if (changed) {
      const nextMessages = [...messages];
      nextMessages[index] = updated;
      host.messages.set(nextMessages);
      host.events.syncStepMessage(updated);
    }
    // A `tool_approval` pause can carry several `action_requests` whose tool-call
    // parts render on different frames; tagging only the first to arrive would leave
    // late siblings with no approval card, and the resume route then 400s the partial
    // batch ("every paused tool call must be decided"). Keep retrying (bounded) until
    // EVERY paused call is tagged. `ask_user_question` applies its single synthetic
    // part in one shot, so it only needs the original "did anything change" retry.
    if (pendingAction.payload.type === 'tool_approval') {
      const expected = pendingAction.payload.action_requests.length;
      if (countTaggedApprovalParts(updated, pendingAction.actionId) < expected) {
        retryNextFrame();
      }
    } else if (!changed) {
      retryNextFrame();
    }
  }

  /**
   * The identities this pane may be rendering the in-flight response under before the first
   * run step renames it to the server's pre-allocated id: the submission's placeholder (updated
   * on `created`) and the padded form of the live user message. Read at call time, since
   * `created` reassigns both.
   */
  private livePlaceholderIds(): (string | undefined)[] {
    const { sub } = this;
    return [
      sub.submission.initialResponse?.messageId,
      sub.userMessage?.messageId ? `${sub.userMessage.messageId}_` : undefined,
    ];
  }

  /**
   * A regenerate seeds the renamed response from `submission.initialResponse` rather than the
   * store tail (an edited resubmission seeds from its content), so a part committed to the
   * placeholder only in the store would be dropped by the first run step's rename. Keep the
   * submission the step handler receives in step with the placeholder this pane mutated.
   */
  private syncSubmissionPlaceholder(updated: TMessage): void {
    const { sub } = this;
    if (updated.messageId !== sub.submission.initialResponse?.messageId) {
      return;
    }
    sub.replaceSubmission({ ...sub.submission, initialResponse: updated });
  }

  /**
   * Edit-and-resubmit keeps the retained prefix on the client while the server indexes only
   * the NEW content, so every server-claimed index (run steps, labels and steers) shifts past
   * it or lands inside the prefix and overwrites kept content. The captured length is used
   * over the live array because a resume sync replaces `initialResponse.content` with the
   * server's completion-local snapshot.
   */
  private editPrefixLength(): number {
    const { sub } = this;
    return sub.submission.editedContent != null && !sub.run.editPrefixCleared
      ? (sub.submission.editPrefixLength ?? sub.submission.initialResponse?.content?.length ?? 0)
      : 0;
  }

  /** Writes `updated` over the message at `index`, in the cache and the step handler's map. */
  private commit(messages: TMessage[], index: number, updated: TMessage): void {
    const nextMessages = [...messages];
    nextMessages[index] = updated;
    this.host.messages.set(nextMessages);
    this.host.events.syncStepMessage(updated);
  }

  /**
   * Places an injected steer part on the in-flight response message and resolves its pending
   * chip. Same bounded next-frame retry as pending actions for the inject-before-render race
   * (the assistant placeholder can land a few frames after the created event under load).
   */
  applySteer(event: TSteerAppliedEvent, attempt = 0, liveSteerIds: string[] = []): void {
    const { sub, host } = this;
    const { run } = sub;
    if (!sub.isCurrent()) {
      return;
    }
    const chipConvoId = event.conversationId ?? sub.conversationId();
    /** The server's applied event settles ownership immediately. Rendering
     *  the inline part can wait for the target to mount, but leaving
     *  the chip pending during that wait lets an intervening error/final
     *  convert already-applied words into a duplicate queued message. */
    const firstApplicationIds =
      attempt === 0
        ? (host.steers.resolve(
            chipConvoId,
            event.steerId,
            event.clientSteerId,
            event.part?.quotes,
          ) ?? [])
        : liveSteerIds;
    const retryNextFrame = () => {
      if (attempt < PENDING_ACTION_MAX_RETRY_FRAMES) {
        const frameId = run.scheduler.requestFrame(() => {
          run.steerRetryFrames.delete(frameId);
          if (sub.isCurrent()) {
            this.applySteer(event, attempt + 1, firstApplicationIds);
          }
        });
        run.steerRetryFrames.add(frameId);
      }
    };
    /** Same boundary as pending actions: land queued deltas before the
     * steer part is placed and synced. */
    host.events.flushPendingDeltas();
    const messages = host.messages.get() ?? [];
    const index = host.parts.findSteerTarget(messages, event, this.livePlaceholderIds());
    if (index < 0) {
      retryNextFrame();
      return;
    }
    const prefixLength = this.editPrefixLength();
    const updated = host.parts.applySteer(
      messages[index],
      typeof event.index === 'number' && prefixLength > 0
        ? { ...event, index: event.index + prefixLength }
        : event,
    );
    if (updated !== messages[index]) {
      /** Stamped only when the inline part is actually committed, in the
       *  same batch, so its first render sees the flag and plays the
       *  one-shot draw-in (`SteerPart` consumes the id on mount). A
       *  replayed event is referentially stable here and an abandoned
       *  placement never reaches this branch, so neither can strand a
       *  stale id that would animate a historical part on a later visit.
       *  Only the id the part RENDERS with (`part.steerId`) is stamped:
       *  the part consumes exactly that id, so a client alias would sit
       *  in the set forever as dead weight. */
      const renderedSteerId = event.part?.steerId ?? event.steerId;
      if (firstApplicationIds.includes(renderedSteerId)) {
        host.steers.markLiveApplied(renderedSteerId);
      }
      this.commit(messages, index, updated);
      this.syncSubmissionPlaceholder(updated);
    }
  }

  /**
   * Places an activity-label part at its claimed content index on the in-flight response
   * message. Fires twice per block (the empty reservation at batch end, the generated label on
   * resolve); the applier is referentially stable on duplicate replays and refuses to
   * overwrite filled text with a stale placeholder. Same bounded next-frame retry as steers
   * for the inject-before-render race.
   */
  applyActivityLabel(event: TActivityLabelEvent, attempt = 0): void {
    const { sub, host } = this;
    const { run } = sub;
    if (!sub.isCurrent()) {
      return;
    }
    const retryNextFrame = () => {
      if (attempt < PENDING_ACTION_MAX_RETRY_FRAMES) {
        const frameId = run.scheduler.requestFrame(() => {
          run.activityLabelRetryFrames.delete(frameId);
          if (sub.isCurrent()) {
            this.applyActivityLabel(event, attempt + 1);
          }
        });
        run.activityLabelRetryFrames.add(frameId);
      }
    };
    /** Same boundary as pending actions and steers: land queued deltas
     * before the label part is placed and synced, or the later flush
     * would clobber it (and `syncStepMessage` would sync a pre-delta
     * copy back into the step handler's authoritative map). */
    host.events.flushPendingDeltas();
    const messages = host.messages.get() ?? [];
    const index = host.parts.findActivityLabelTarget(messages, event, this.livePlaceholderIds());
    if (index < 0) {
      retryNextFrame();
      return;
    }
    /** Edit-and-resubmit replays the kept prefix into the response before
     *  the run starts, and the server indexes only the NEW content, so
     *  run steps offset by that prefix (`useStepHandler`). The label index
     *  is claimed in the same server-side space and needs the identical
     *  shift, or it lands inside the prefix and overwrites kept content.
     *
     *  Uses `editPrefixLength`, captured when the submission was built,
     *  for the same reason `useStepHandler` does: a resume sync replaces
     *  `initialResponse.content` with the server's completion-local
     *  snapshot, so its length no longer describes the retained prefix.
     *  Tool cards and the label heading them must land in one index
     *  space: a label shifting differently from its tools would overwrite
     *  another part, and a gap fill would miss its own reservation and
     *  leave the placeholder pending forever. */
    const prefixLength = this.editPrefixLength();
    const phasePart = event.part as PhaseLabelPart;
    let offsetEvent = event;
    if (prefixLength > 0) {
      let offsetPart: PhaseLabelPart = phasePart;
      if (
        phasePart.activity_label_type === 'phase' &&
        typeof phasePart.activity_start_index === 'number'
      ) {
        let activityStartIndex = phasePart.activity_start_index + prefixLength;
        const foldedFirstPart = run.editPrefixFirstPartFolded;
        const targetContent = messages[index]?.content;
        /** The step handler records an actual server-index-zero text/think
         *  merge. An empty +prefix slot is insufficient evidence because
         *  a delayed tool may not have materialized there yet. */
        if (
          phasePart.activity_start_index === 0 &&
          activityStartIndex > 0 &&
          foldedFirstPart &&
          targetContent?.[activityStartIndex - 1] != null
        ) {
          activityStartIndex -= 1;
        }
        offsetPart = {
          ...phasePart,
          activity_start_index: activityStartIndex,
          ...(typeof phasePart.activity_end_index === 'number' && {
            activity_end_index: host.parts.offsetActivityPhaseBoundary(
              phasePart.activity_end_index,
              prefixLength,
              foldedFirstPart,
            ),
          }),
        };
      }
      offsetEvent = {
        ...event,
        index: event.index + prefixLength,
        part: offsetPart,
      };
    }
    const updated = host.parts.applyActivityLabel(messages[index], offsetEvent);
    if (updated !== messages[index]) {
      this.commit(messages, index, updated);
      this.syncSubmissionPlaceholder(updated);
    }
  }

  /** Patches a generated title onto its existing reasoning part. */
  applyReasoningLabel(event: TReasoningLabelEvent, attempt = 0): void {
    const { sub, host } = this;
    const { run } = sub;
    if (!sub.isCurrent()) {
      return;
    }
    const retryNextFrame = () => {
      if (attempt < PENDING_ACTION_MAX_RETRY_FRAMES) {
        const frameId = run.scheduler.requestFrame(() => {
          run.activityLabelRetryFrames.delete(frameId);
          if (sub.isCurrent()) {
            this.applyReasoningLabel(event, attempt + 1);
          }
        });
        run.activityLabelRetryFrames.add(frameId);
      }
    };
    host.events.flushPendingDeltas();
    const messages = host.messages.get() ?? [];
    const messageIndex = host.parts.findReasoningLabelTarget(messages, event);
    if (messageIndex < 0) {
      retryNextFrame();
      return;
    }
    const prefixLength = this.editPrefixLength();
    let contentIndex = event.index + prefixLength;
    if (
      prefixLength > 0 &&
      event.index === 0 &&
      run.editPrefixFirstPartFolded &&
      messages[messageIndex]?.content?.[contentIndex - 1]?.type === ContentTypes.THINK
    ) {
      contentIndex -= 1;
    }
    const updated = host.parts.applyReasoningLabel(messages[messageIndex], {
      ...event,
      index: contentIndex,
    });
    if (updated === messages[messageIndex]) {
      const part = messages[messageIndex]?.content?.[contentIndex];
      if (part?.type !== ContentTypes.THINK && attempt < PENDING_ACTION_MAX_RETRY_FRAMES) {
        retryNextFrame();
      }
      return;
    }
    this.commit(messages, messageIndex, updated);
  }
}
