import type {
  Agents,
  TMessage,
  EventSubmission,
  TSteerAppliedEvent,
  TActivityLabelEvent,
  TReasoningLabelEvent,
} from 'librechat-data-provider';
import type { ResumableSubscription } from './subscription';
import type { PlacementContext } from '../parts/place';
import type { ResumableHost } from './host';
import {
  placeSteer,
  oauthPromptSteps,
  placeActivityLabel,
  placePendingAction,
  placeReasoningLabel,
} from '../parts/place';

/**
 * Keep retrying across frames (not just once): message updates from the preceding created/step
 * events are async and can take several frames under load, so a single retry would drop a
 * valid pause and leave the run with no approval controls. Bounded so a genuinely-absent target
 * can't spin forever.
 */
const PENDING_ACTION_MAX_RETRY_FRAMES = 120;

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
    for (const step of oauthPromptSteps(prompt)) {
      this.host.events.stepHandler(step, submission);
    }
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
    const placement = placePendingAction(messages, pendingAction);
    if (placement == null) {
      retryNextFrame();
      return;
    }
    if (placement.changed) {
      this.commit(messages, placement.index, placement.message);
    }
    /** A `tool_approval` pause can carry several calls whose parts render on different frames,
     *  and the resume route refuses a partial batch, so the retry runs until every paused call
     *  is tagged; an `ask_user_question` only until its part is written. */
    if (!placement.settled) {
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
   * Where this run's side frames land. Edit-and-resubmit keeps the retained prefix on the client
   * while the server indexes only the NEW content, so every server-claimed index (run steps,
   * labels and steers) shifts past it. The captured length is used over the live array because
   * a resume sync replaces `initialResponse.content` with the server's completion-local
   * snapshot.
   */
  private placement(): PlacementContext {
    const { sub } = this;
    const prefixLength =
      sub.submission.editedContent != null && !sub.run.editPrefixCleared
        ? (sub.submission.editPrefixLength ?? sub.submission.initialResponse?.content?.length ?? 0)
        : 0;
    return {
      placeholderIds: this.livePlaceholderIds(),
      prefixLength,
      foldedFirstPart: sub.run.editPrefixFirstPartFolded,
    };
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
    const placement = placeSteer(messages, event, this.placement());
    if (placement == null) {
      retryNextFrame();
      return;
    }
    if (placement.changed) {
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
      this.commit(messages, placement.index, placement.message);
      this.syncSubmissionPlaceholder(placement.message);
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
    const placement = placeActivityLabel(messages, event, this.placement());
    if (placement == null) {
      retryNextFrame();
      return;
    }
    if (placement.changed) {
      this.commit(messages, placement.index, placement.message);
      this.syncSubmissionPlaceholder(placement.message);
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
    const placement = placeReasoningLabel(messages, event, this.placement());
    if (placement == null) {
      retryNextFrame();
      return;
    }
    if (!placement.changed) {
      if (!placement.settled) {
        retryNextFrame();
      }
      return;
    }
    this.commit(messages, placement.index, placement.message);
  }
}
