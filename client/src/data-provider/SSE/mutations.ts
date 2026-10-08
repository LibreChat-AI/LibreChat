import { useMutation } from '@tanstack/react-query';
import { apiBaseUrl, EModelEndpoint } from 'librechat-data-provider';
import type { Agents, TMessage, TEphemeralAgent, TPendingSteer } from 'librechat-data-provider';
import { useChatTransport } from '~/Providers/ChatTransportContext';
import { postGenerationRequest } from './protocol';

export interface AbortStreamParams {
  /** The stream ID to abort (if known) */
  streamId?: string;
  /** The conversation ID to abort (backend will look up the job) */
  conversationId?: string;
  /** Exact generation epoch returned by start/status. Prevents a stale tab
   * from aborting a newer turn that reused the conversation-scoped stream id. */
  generationCreatedAt?: number;
}

export interface AbortStreamResponse {
  generationProtocolVersion?: number;
  success: boolean;
  aborted?: string;
  /** Stop lost to an ordinary terminal transition; no abort FINAL was emitted. */
  settled?: boolean;
  code?: 'RUN_ALREADY_SETTLED' | string;
  streamId?: string;
  terminalStatus?: 'complete' | 'error' | 'aborted';
  error?: string;
  /** The worker stopped, but its terminal state could not be made durable.
   * The client must not infer a safe queue-drain boundary from this ACK. */
  persistenceFailed?: boolean;
  /** Steers that never reached an injection boundary; restored as queued chips. */
  pendingSteers?: TPendingSteer[];
}

/**
 * Abort an ongoing generation stream.
 * The backend will emit a `done` event with `aborted: true` to the SSE stream,
 * allowing the client to handle cleanup via the normal event flow.
 *
 * Can pass either streamId or conversationId - backend will find the job.
 */
export const abortStream = async (params: AbortStreamParams): Promise<AbortStreamResponse> => {
  console.log('[abortStream] Calling abort endpoint with params:', params);
  const result = await postGenerationRequest<AbortStreamResponse>(
    `${apiBaseUrl()}/api/agents/chat/abort`,
    params,
  );
  console.log('[abortStream] Abort response:', result);
  return result;
};

/**
 * React Query mutation hook for aborting a generation stream, through the host's transport.
 * Use this when the user explicitly clicks the stop button.
 */
export function useAbortStreamMutation() {
  const transport = useChatTransport();
  return useMutation({
    mutationFn: transport.abort,
  });
}

/**
 * Agent/endpoint selection fields the resume route needs so its shared
 * `buildEndpointOption` middleware can reconstruct the same agent that paused.
 * Mirrors the fields a normal `POST /api/agents/chat` message carries; sourced
 * from the active conversation (and the conversation's ephemeral-agent state).
 */
export interface ResumeAgentFields {
  conversationId: string;
  /** Exact paused generation being resumed. */
  generationCreatedAt: number;
  endpoint?: EModelEndpoint | string | null;
  endpointType?: EModelEndpoint | string | null;
  agent_id?: string | null;
  model?: string | null;
  spec?: string | null;
  /** Ephemeral agents derive instructions from this; re-sent so resume rebuilds the
   *  same graph (and matches the server's request fingerprint). */
  promptPrefix?: string | null;
  ephemeralAgent?: TEphemeralAgent | null;
  isTemporary?: boolean;
}

/** Successful resume ACK. The continuation streams over the existing SSE. */
export interface ResumeResponse {
  generationProtocolVersion?: number;
  streamId: string;
  conversationId: string;
  status: 'resuming';
}

/**
 * Shared base for both resume payloads: the agent selection fields, plus the
 * `endpoint` defaulted to `agents` (the resume route lives under the agents
 * router and `buildEndpointOption` keys off it).
 */
const buildResumeBase = (fields: ResumeAgentFields) => ({
  ...fields,
  endpoint: fields.endpoint ?? EModelEndpoint.agents,
});

export interface SubmitToolApprovalParams extends ResumeAgentFields {
  /** Identifies the paused action; the server 409s a stale/mismatched id. */
  actionId: string;
  /** One entry per paused tool_call_id — the server 400s a partial batch. */
  decisions: Agents.ToolApprovalResolution[];
}

/**
 * Submit a batch of tool-approval decisions to resume a paused generation.
 * POSTs to the shared resume route; the continuation streams over the existing
 * SSE connection (this only fires the POST — it does not open a new stream).
 */
export const submitToolApproval = async (
  params: SubmitToolApprovalParams,
): Promise<ResumeResponse> => {
  const { actionId, decisions, ...fields } = params;
  return postGenerationRequest<ResumeResponse>(`${apiBaseUrl()}/api/agents/chat/resume`, {
    ...buildResumeBase(fields),
    actionId,
    decisions,
  });
};

/**
 * React Query mutation hook for submitting tool-approval decisions.
 * Mirrors {@link useAbortStreamMutation}; the resumed stream arrives on the SSE.
 */
export function useSubmitToolApprovalMutation() {
  return useMutation({
    mutationFn: submitToolApproval,
  });
}

export interface SubmitAskAnswerParams extends ResumeAgentFields {
  actionId: string;
  /** Free-form answer for a legacy single-question pause. */
  answer?: string;
  /** Answers keyed by question id for a batched pause. */
  answers?: Record<string, string>;
}

/**
 * Submit an ask-user-question answer to resume a paused generation.
 * POSTs to the shared resume route; the continuation streams over the existing SSE.
 */
export const submitAskAnswer = async (params: SubmitAskAnswerParams): Promise<ResumeResponse> => {
  const { actionId, answer, answers, ...fields } = params;
  return postGenerationRequest<ResumeResponse>(`${apiBaseUrl()}/api/agents/chat/resume`, {
    ...buildResumeBase(fields),
    actionId,
    ...(answer != null && { answer }),
    ...(answers != null && { answers }),
  });
};

/**
 * React Query mutation hook for submitting an ask-user answer.
 * Mirrors {@link useAbortStreamMutation}; the resumed stream arrives on the SSE.
 */
export function useSubmitAskAnswerMutation() {
  return useMutation({
    mutationFn: submitAskAnswer,
  });
}

export interface SteerMessageParams {
  conversationId: string;
  /** Exact live generation being steered. */
  generationCreatedAt?: number;
  /** Correlates terminal events that can arrive before this POST's response. */
  clientSteerId?: string;
  text: string;
  /** Attachment refs steered with the message (already uploaded). */
  files?: TMessage['files'];
  /** Quoted excerpts steered with the message ("Add to chat" selections). The
   *  server normalizes them like a normal send's quotes and merges them into
   *  the model-bound turn at the injection boundary. */
  quotes?: string[];
  /**
   * Ask the server to seal the live model stream at the next provider-safe
   * boundary rather than waiting for a tool step. Never a rejection reason:
   * a server or SDK without the capability still queues the steer and echoes
   * `preempt: false`, which relabels the chip instead of erroring.
   */
  preempt?: boolean;
}

/** Successful steer ACK: the server queued the message for mid-run injection. */
export interface SteerMessageResponse {
  generationProtocolVersion?: number;
  status: 'queued';
  steerId: string;
  position: number;
  conversationId: string;
  /** Whether the seal request was actually armed; see {@link SteerMessageParams.preempt}. */
  preempt?: boolean;
  preemptRevision?: number;
  /** Echoed when the durable item carries the sent quotes. Absent on a
   *  pre-quotes server (which 202s while dropping them) — the client then
   *  re-stages the excerpts as composer chips instead of losing them. */
  quotesAccepted?: boolean;
  /** Receipt replay after this item already left the durable queue. */
  settled?: boolean;
  /** Settled specifically by terminal drain; restore as a queued follow-up. */
  leftover?: boolean;
  replayed?: boolean;
}

/**
 * Queue a mid-run steering message against the conversation's active run.
 * The server injects it at the next tool-batch boundary — or, when `preempt`
 * is armed, at the next provider-safe token boundary — and streams an
 * `on_steer_applied` event over the existing SSE; this only fires the POST.
 * Rejections carry a `code` the caller degrades on (NO_ACTIVE_RUN → normal
 * send, RUN_PAUSED / STEER_UNSUPPORTED → client-side queue).
 */
export const steerMessage = async (params: SteerMessageParams): Promise<SteerMessageResponse> => {
  return postGenerationRequest<SteerMessageResponse>(
    `${apiBaseUrl()}/api/agents/chat/steer`,
    params,
  );
};

/** React Query mutation hook for steering, through the host's transport; the injection
 *  arrives on the SSE. */
export function useSteerMessageMutation() {
  const transport = useChatTransport();
  return useMutation({
    mutationFn: transport.steer,
  });
}

export interface CancelSteerParams {
  conversationId: string;
  steerId: string;
  clientSteerId?: string;
  /** Exact generation that owns this steer receipt. */
  generationCreatedAt?: number;
}

export interface CancelSteerResponse {
  generationProtocolVersion?: number;
  removed?: boolean;
}

/**
 * Cancels a still-queued steer before injection. `removed: false` means the
 * cancel lost its race (already injected, or the run ended) — not an error;
 * the client defers to the events it will receive.
 */
export const cancelSteerMessage = async (
  params: CancelSteerParams,
): Promise<CancelSteerResponse> => {
  return postGenerationRequest<CancelSteerResponse>(
    `${apiBaseUrl()}/api/agents/chat/steer/cancel`,
    params,
  );
};

export function useCancelSteerMutation() {
  const transport = useChatTransport();
  return useMutation({
    mutationFn: transport.cancelSteer,
  });
}

export interface ArmSteerParams {
  conversationId: string;
  steerId: string;
  /** Exact generation that owns this steer receipt. */
  generationCreatedAt?: number;
}

export interface ArmSteerResponse {
  generationProtocolVersion?: number;
  armed?: boolean;
  code?: string;
  preemptRevision?: number;
}

/**
 * Escalates a still-queued steer to an interrupt IN PLACE: the server flips
 * `preempt` on the existing item, so its FIFO position, id, and timestamp all
 * survive. `armed: false` is not an error — the steer already injected, was
 * cancelled, or the deployment cannot seal mid-stream (`PREEMPT_UNSUPPORTED`).
 */
export const armSteerMessage = async (params: ArmSteerParams): Promise<ArmSteerResponse> => {
  return postGenerationRequest<ArmSteerResponse>(
    `${apiBaseUrl()}/api/agents/chat/steer/arm`,
    params,
  );
};

export function useArmSteerMutation() {
  const transport = useChatTransport();
  return useMutation({
    mutationFn: transport.armSteer,
  });
}
