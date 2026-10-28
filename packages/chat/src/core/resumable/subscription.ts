import { apiBaseUrl } from 'librechat-data-provider';
import type {
  TMessage,
  ChatEvent,
  TSubmission,
  ChatTransport,
  ChatStreamConnection,
} from 'librechat-data-provider';
import type { SubscriptionHost, SubscriptionTarget } from './host';
import type { GenerationProtocolVersion } from '../protocol';
import type { StepEvent } from '../reducer';
import type { ResumableRun } from './run';
import { GENERATION_PROTOCOL_VERSION, generationProtocolHeaders } from '../protocol';

/** What a subscription does with the events its connection reports. */
export interface SubscriptionHandlers {
  onOpen: () => void;
  onFrame: (event: ChatEvent) => void;
  onFailure: (event: Extract<ChatEvent, { type: 'error' }>) => void;
  onClose: () => void;
}

/**
 * One attachment of a pane to a running generation: the connection, the submission as the
 * stream has revised it so far, and the fences that make every late callback a no-op once a
 * newer attachment, submission or pane lifecycle has taken over.
 */
export class ResumableSubscription {
  readonly streamId: string;
  readonly isResume: boolean;
  readonly generationCreatedAt?: number;
  readonly generationProtocolVersion: GenerationProtocolVersion;
  readonly signal?: AbortSignal;
  /** Whether the pane created this stream's conversation optimistically, from `/c/new`. */
  readonly startedAsNewConversation: boolean;
  /** Closing is per connection: the transport tells this subscription's own close (`abort`)
   *  apart from a cancel by the user agent (`error` with status 0). */
  readonly controller: AbortController = new AbortController();
  submission: TSubmission;
  userMessage: TMessage;
  textIndex: number | null = null;
  finalReceived = false;
  /**
   * This subscription must never be revived. Set by the terminal recoveries that do not ride a
   * FINAL or served-error frame (the 404 and retry-ceiling reconciles both leave the attachment
   * pointing at a stream the server no longer has) and by the dev-only navigation simulator.
   * `finalReceived` covers the frame-carried terminals.
   */
  retired = false;
  /** Step events that arrived before `created` named the turn, replayed once it does. */
  readonly preCreatedStepEvents: StepEvent[] = [];
  connection: ChatStreamConnection | null = null;
  private foregroundStatusCheckInFlight = false;

  constructor(
    readonly run: ResumableRun,
    readonly host: SubscriptionHost,
    target: SubscriptionTarget,
  ) {
    this.streamId = target.streamId;
    this.isResume = target.isResume;
    this.generationCreatedAt = target.generationCreatedAt;
    this.generationProtocolVersion = target.generationProtocolVersion;
    this.signal = target.signal;
    this.submission = target.submission;
    this.userMessage = target.submission.userMessage;
    this.startedAsNewConversation = run.optimisticStreamIds.has(target.streamId);
  }

  /**
   * Every pane lifecycle owns one AbortSignal, while every reconnect owns one connection. Both
   * identities matter: cleanup can close an attachment after its async listener has already
   * crossed an `await`, and a reconnect can supersede an older attachment without changing the
   * submission object. The submission check is the final fence against a later conversation
   * installing its own submission in this pane.
   */
  isCurrent(): boolean {
    return (
      this.signal?.aborted !== true &&
      this.run.stream === this.controller &&
      this.run.submission === this.submission
    );
  }

  /** The submission with the user message as the stream has named it so far. */
  liveSubmission(): TSubmission {
    return { ...this.submission, userMessage: this.userMessage };
  }

  /** Adopts a revised submission as the one this subscription and its pane serve. */
  replaceSubmission(next: TSubmission): void {
    this.submission = next;
    this.run.submission = next;
  }

  close(): void {
    this.controller.abort();
  }

  /** The conversation this subscription's run belongs to, as far as it is known. */
  conversationId(): string {
    return this.submission.conversation?.conversationId ?? this.streamId;
  }

  /** Re-attaches now, with the run's state replayed. */
  reattach(): void {
    this.host.subscribe(this.resumeTarget(this.submission));
  }

  /**
   * Re-attaches after `delay` with the run's state replayed, unless a newer attachment or
   * submission takes over first. A different stream or epoch is passed when the status read
   * that scheduled it named one.
   */
  scheduleReattach(
    delay: number,
    streamId: string = this.streamId,
    generationCreatedAt: number | undefined = this.generationCreatedAt,
  ): void {
    this.run.reconnectTimeout = this.run.scheduler.setTimeout(() => {
      if (this.isCurrent() && this.run.submission) {
        this.host.subscribe({
          ...this.resumeTarget(this.run.submission),
          streamId,
          generationCreatedAt,
        });
      }
    }, delay);
  }

  private resumeTarget(submission: TSubmission): SubscriptionTarget {
    return {
      streamId: this.streamId,
      submission,
      isResume: true,
      generationCreatedAt: this.generationCreatedAt,
      generationProtocolVersion: this.generationProtocolVersion,
      signal: this.signal,
    };
  }

  /** The stream route, with the resume cursor and generation fence in its query. */
  url(): string {
    const baseUrl = `${apiBaseUrl()}/api/agents/chat/stream/${encodeURIComponent(this.streamId)}`;
    const query = new URLSearchParams();
    if (this.isResume) {
      query.set('resume', 'true');
    }
    if (this.generationCreatedAt != null) {
      query.set('generationCreatedAt', String(this.generationCreatedAt));
    }
    query.set('generationProtocolVersion', String(GENERATION_PROTOCOL_VERSION));
    const queryString = query.toString();
    return queryString ? `${baseUrl}?${queryString}` : baseUrl;
  }

  /** Makes this the pane's live attachment, superseding any earlier one. */
  claim(): void {
    this.run.stream = this.controller;
  }

  /** Opens the connection and routes its events to `handlers`. */
  connect(transport: ChatTransport, handlers: SubscriptionHandlers): void {
    this.connection = transport.reconnectToStream(
      { url: this.url(), headers: generationProtocolHeaders() },
      {
        signal: this.controller.signal,
        onEvent: (event) => {
          switch (event.type) {
            case 'open':
              handlers.onOpen();
              return;
            case 'error':
              handlers.onFailure(event);
              return;
            case 'abort':
              handlers.onClose();
              return;
            default:
              handlers.onFrame(event);
          }
        },
      },
    );
  }

  private reattachOnForeground(): void {
    this.host.logger.log('ResumableSSE', 'Re-attaching stream on foreground');
    /** Any backoff still pending targets this same attachment, so returning to the app
     *  supersedes it rather than waiting the delay out; its callback finds a superseded
     *  subscription and does nothing. */
    this.run.clearReconnectTimeout();
    this.run.reconnectAttempt = Math.max(this.run.reconnectAttempt, 1);
    this.close();
    this.reattach();
  }

  private isSettled(): boolean {
    return this.finalReceived || this.retired || this.run.replacementHandoff;
  }

  /**
   * A suspended page can lose its stream without the transport ever reporting it. When a
   * mobile browser freezes the tab, an intermediary closes the response body underneath it,
   * and XHR surfaces that as an ordinary load: sse.js dispatches nothing for a body that simply
   * ends, so neither the error nor the abort recovery ever runs. Nothing else re-reads the
   * conversation while the pane stays mounted, which is why the response the run finished
   * writing only appears after a reload.
   *
   * Some mobile WebViews leave the XHR marked OPEN even after the suspended request stopped
   * delivering events. In that case the durable run status is the only authority that
   * distinguishes a healthy live attachment from a terminal one holding stale partial content.
   * A terminal status forces the same resume path as a closed transport; it returns the
   * synthesized terminal frame or 404 that reconciles persisted messages.
   */
  private handleForegroundReattach(): void {
    const { visibility, fetchStatus, logger } = this.host;
    if (!visibility.isVisible() || this.isSettled() || !this.isCurrent() || !this.run.submission) {
      return;
    }

    if (this.connection?.closed === true) {
      this.reattachOnForeground();
      return;
    }

    if (this.foregroundStatusCheckInFlight) {
      return;
    }
    this.foregroundStatusCheckInFlight = true;
    const foregroundConvoId = this.conversationId();
    const { generationCreatedAt } = this;
    void fetchStatus(foregroundConvoId)
      .then((status) => {
        if (
          status.active !== false ||
          (status.createdAt != null &&
            generationCreatedAt != null &&
            status.createdAt !== generationCreatedAt) ||
          !this.isCurrent() ||
          this.isSettled() ||
          !visibility.isVisible()
        ) {
          return;
        }
        logger.log(
          'ResumableSSE',
          'Apparently open stream is terminal - reconciling on foreground',
          { conversationId: foregroundConvoId, generationCreatedAt },
        );
        this.reattachOnForeground();
      })
      .catch((error) => {
        if (!this.isCurrent()) {
          return;
        }
        logger.warn('ResumableSSE', 'Could not verify stream on foreground', {
          conversationId: foregroundConvoId,
          generationCreatedAt,
          error,
        });
      })
      .finally(() => {
        this.foregroundStatusCheckInFlight = false;
      });
  }

  /** Replaces the pane's foreground listener with this subscription's. */
  watchForeground(): void {
    this.run.stopForegroundReattach?.();
    this.run.stopForegroundReattach = this.host.visibility.subscribe(() =>
      this.handleForegroundReattach(),
    );
  }
}
