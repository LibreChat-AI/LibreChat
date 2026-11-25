import type { TSubmission } from 'librechat-data-provider';
import type { GenerationProtocolVersion } from '../protocol';
import { GENERATION_PROTOCOL_VERSION, supportsGenerationProtocolV2 } from '../protocol';

export const MAX_RETRIES = 5;
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;
export const getReconnectDelay = (attempt: number): number =>
  Math.min(RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt - 1), RECONNECT_MAX_DELAY_MS);
export const START_GENERATION_NETWORK_RETRIES = 3;
export const START_GENERATION_READINESS_TIMEOUT_MS = 120000;
const SERVER_NOT_READY_CODE = 'SERVER_NOT_READY';
const PREDECESSOR_MISMATCH_CODE = 'GENERATION_PREDECESSOR_MISMATCH';
const STEER_RECOVERY_REQUEST_PREFIX = 'steer-recovery:';

export type StartGenerationError = {
  code?: string;
  response?: {
    status?: number;
    data?: unknown;
    headers?: Record<string, string | number | string[] | undefined>;
  };
};

export const toStartGenerationError = (error: unknown): StartGenerationError | undefined =>
  error != null && typeof error === 'object' ? (error as StartGenerationError) : undefined;

export const getStartGenerationStreamId = (data: unknown): string | null => {
  if (data == null || typeof data !== 'object' || !('streamId' in data)) {
    return null;
  }

  const streamId = (data as { streamId?: unknown }).streamId;
  return typeof streamId === 'string' && streamId.length > 0 ? streamId : null;
};

/** The server returns `status: 'resumed'` when a duplicate start request was deduped to an
 *  already-running stream: the client must subscribe with resume=true to replay its state
 *  (prior content and any pending-action) rather than only receiving live events. */
export const isResumedStartResponse = (data: unknown): boolean =>
  data != null && typeof data === 'object' && (data as { status?: unknown }).status === 'resumed';

export const isSettledStartResponse = (data: unknown): boolean =>
  supportsGenerationProtocolV2(data) &&
  data != null &&
  typeof data === 'object' &&
  (data as { status?: unknown }).status === 'settled';

export const isReplacedStartResponse = (data: unknown): boolean =>
  supportsGenerationProtocolV2(data) &&
  data != null &&
  typeof data === 'object' &&
  (data as { status?: unknown }).status === 'replaced';

export const isUnnegotiatedV2StartControl = (data: unknown): boolean => {
  if (supportsGenerationProtocolV2(data) || data == null || typeof data !== 'object') {
    return false;
  }
  const status = (data as { status?: unknown }).status;
  return status === 'settled' || status === 'replaced';
};

export const getStartGenerationConversationId = (data: unknown): string | null => {
  if (data == null || typeof data !== 'object' || !('conversationId' in data)) {
    return null;
  }
  const conversationId = (data as { conversationId?: unknown }).conversationId;
  return typeof conversationId === 'string' && conversationId.length > 0 ? conversationId : null;
};

export const getStartGenerationCreatedAt = (data: unknown): number | null => {
  if (data == null || typeof data !== 'object' || !('generationCreatedAt' in data)) {
    return null;
  }
  const createdAt = (data as { generationCreatedAt?: unknown }).generationCreatedAt;
  return typeof createdAt === 'number' && Number.isSafeInteger(createdAt) && createdAt >= 0
    ? createdAt
    : null;
};

export type PredecessorMismatchStartResponse = {
  streamId: string;
  conversationId: string;
  generationCreatedAt: number;
  active: boolean;
};

export const getPredecessorMismatchStartResponse = (
  error: unknown,
): PredecessorMismatchStartResponse | null => {
  const startError = toStartGenerationError(error);
  const data = startError?.response?.data;
  if (
    startError?.response?.status !== 409 ||
    data == null ||
    typeof data !== 'object' ||
    (data as { status?: unknown }).status !== 'predecessor_mismatch' ||
    (data as { code?: unknown }).code !== PREDECESSOR_MISMATCH_CODE
  ) {
    return null;
  }

  const streamId = getStartGenerationStreamId(data);
  const conversationId = getStartGenerationConversationId(data);
  if (!streamId || !conversationId) {
    return null;
  }

  const generationCreatedAt = getStartGenerationCreatedAt(data);
  const active = (data as { active?: unknown }).active;
  if (generationCreatedAt == null || typeof active !== 'boolean') {
    return null;
  }
  return {
    streamId,
    conversationId,
    generationCreatedAt,
    active,
  };
};

/** Recovery submissions use a deterministic request id tied to the parked
 * source. A status read performed only after this exact submission is proven
 * terminal may authorize that source past the client-side live-event
 * tombstone; unrelated status snapshots must remain deduped. */
export const getRecoverySteerId = (submission: TSubmission): string | null => {
  if (typeof submission.recoverySteerId === 'string' && submission.recoverySteerId.length > 0) {
    return submission.recoverySteerId;
  }
  const clientRequestId = submission.clientRequestId;
  if (
    typeof clientRequestId !== 'string' ||
    !clientRequestId.startsWith(STEER_RECOVERY_REQUEST_PREFIX)
  ) {
    return null;
  }
  const steerId = clientRequestId.slice(STEER_RECOVERY_REQUEST_PREFIX.length);
  return steerId.length > 0 ? steerId : null;
};

export type StartGenerationResult =
  | {
      status: 'stream';
      streamId: string;
      resumed: boolean;
      generationCreatedAt?: number;
      generationProtocolVersion: GenerationProtocolVersion;
    }
  | {
      status: 'settled';
      conversationId: string;
      generationProtocolVersion: typeof GENERATION_PROTOCOL_VERSION;
    }
  | {
      status: 'replaced';
      streamId: string;
      conversationId: string;
      generationCreatedAt: number;
      generationProtocolVersion: typeof GENERATION_PROTOCOL_VERSION;
    }
  | {
      status: 'predecessor_mismatch';
      streamId: string;
      conversationId: string;
      generationCreatedAt: number;
      active: boolean;
      generationProtocolVersion: typeof GENERATION_PROTOCOL_VERSION;
    };

export const isRetryableNetworkError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }

  const { code } = toStartGenerationError(error) ?? {};
  return code === 'ERR_NETWORK' || code === 'ERR_INTERNET_DISCONNECTED';
};

export const isServerNotReadyError = (error: unknown): boolean => {
  const candidate = toStartGenerationError(error);
  const data = candidate?.response?.data;
  const code =
    data != null && typeof data === 'object' && 'code' in data
      ? (data as { code?: unknown }).code
      : undefined;
  return candidate?.response?.status === 503 && code === SERVER_NOT_READY_CODE;
};

export const getRetryAfterDelay = (error: unknown, fallbackDelay: number): number => {
  const headers = toStartGenerationError(error)?.response?.headers;
  const rawValue = headers?.['retry-after'] ?? headers?.['Retry-After'];
  const retryAfter = Array.isArray(rawValue) ? rawValue[0] : rawValue;
  const seconds = typeof retryAfter === 'number' ? retryAfter : Number(retryAfter);

  if (!Number.isFinite(seconds) || seconds < 0) {
    return fallbackDelay;
  }

  return Math.min(seconds * 1000, 30000);
};

export const waitForRetryDelay = (delay: number, signal?: AbortSignal): Promise<boolean> =>
  new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }

    function cleanup() {
      signal?.removeEventListener('abort', onAbort);
    }
    function onAbort() {
      clearTimeout(timeout);
      cleanup();
      resolve(false);
    }
    const timeout = setTimeout(() => {
      cleanup();
      resolve(true);
    }, delay);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
