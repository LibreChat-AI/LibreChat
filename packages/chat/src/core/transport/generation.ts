import { apiBaseUrl, generationServer, removeNullishValues } from 'librechat-data-provider';
import type {
  TPayload,
  ChatEvent,
  ChatTransportRequest,
  ChatTransport as WireTransport,
} from 'librechat-data-provider';
import type {
  ChatStream,
  ChatTransport,
  ChatSendResult,
  ChatAbortResult,
  ChatSendRequest,
  ChatAbortRequest,
  ChatStreamStatus,
  ChatTransportError,
  ChatReconnectRequest,
} from '../types';
import {
  getRetryAfterDelay,
  waitForRetryDelay,
  isServerNotReadyError,
  isResumedStartResponse,
  isSettledStartResponse,
  isRetryableNetworkError,
  isReplacedStartResponse,
  getStartGenerationStreamId,
  getStartGenerationCreatedAt,
  isUnnegotiatedV2StartControl,
  START_GENERATION_NETWORK_RETRIES,
  getStartGenerationConversationId,
  START_GENERATION_READINESS_TIMEOUT_MS,
} from '../resumable/start';
import {
  generationStreamUrl,
  generationProtocolHeaders,
  GENERATION_PROTOCOL_VERSION,
  getGenerationProtocolVersion,
} from '../protocol';

/** What the generation routes need from the app that calls them. */
export type GenerationTransportInit = {
  /**
   * The wire that opens a stream, bound to the signed-in user. Read on every attachment, so a
   * refreshed token is the one the next attachment sends.
   */
  wire: () => WireTransport;
  /** Reads a conversation's generation state from the status route. */
  getStatus: (conversationId: string) => Promise<ChatStreamStatus>;
  /**
   * POSTs a turn to the generation route and resolves to the server's start response, the way
   * the app's transport does for main chat (auth refresh included). With it the transport starts
   * turns; without it, it only follows generations something else started.
   */
  start?: (request: ChatTransportRequest, options?: { signal?: AbortSignal }) => Promise<unknown>;
  /** Starts a turn some other way than `start`; takes precedence over it. */
  sendMessages?: (request: ChatSendRequest) => Promise<ChatSendResult>;
  /** Stops a generation. Without it a stop is refused. */
  abort?: (request: ChatAbortRequest) => Promise<ChatAbortResult>;
};

const transportError = (
  message: string,
  code: string,
  response?: { status: number; data: unknown },
): ChatTransportError =>
  Object.assign(new Error(message), {
    code,
    ...(response == null ? {} : { response: { ...response, headers: {} } }),
  });

/** The server no longer has the generation: it ended, or a newer one replaced it. */
const isGone = (status: number | undefined): boolean => status === 404 || status === 409;

const isTerminal = (event: ChatEvent): boolean =>
  event.type === 'final' || event.type === 'abort' || event.type === 'error';

/**
 * One attachment as an async iterable. Events arrive through a callback, synchronously and in
 * wire order; they are held until the consumer asks, and the iteration ends with the terminal
 * event or once the connection is closed.
 */
function openStream(
  wire: WireTransport,
  target: {
    streamId: string;
    generationCreatedAt?: number;
    generationProtocolVersion?: number;
    signal?: AbortSignal;
    /** Replay the generation so far before live events; false for a turn this client started. */
    resume: boolean;
  },
): Promise<ChatStream | null> {
  const controller = new AbortController();
  const pending: ChatEvent[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  let abandon: (() => void) | undefined;
  const finish = (): void => {
    done = true;
    wake?.();
  };
  /**
   * Closing answers an attachment that has not opened yet: a wire whose connection is already
   * gone (one refreshing its token, say) reports nothing more, and the caller would wait forever.
   */
  const close = (): void => {
    controller.abort();
    finish();
    abandon?.();
  };
  if (target.signal?.aborted === true) {
    return Promise.resolve(null);
  }
  target.signal?.addEventListener('abort', close, { once: true });

  const stream: ChatStream = {
    streamId: target.streamId,
    generationCreatedAt: target.generationCreatedAt,
    generationProtocolVersion: target.generationProtocolVersion,
    resumed: target.resume,
    close,
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (pending.length > 0) {
          yield pending.shift() as ChatEvent;
        }
        if (done) {
          return;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    },
  };

  return new Promise<ChatStream | null>((resolve, reject) => {
    let opened = false;
    abandon = () => resolve(null);
    const onEvent = (event: ChatEvent): void => {
      if (event.type === 'open') {
        opened = true;
        resolve(stream);
        return;
      }
      /** Nothing was attached, so an abort or an error here answers the reattachment itself. */
      if (!opened && event.type === 'abort') {
        finish();
        resolve(null);
        return;
      }
      if (!opened && event.type === 'error') {
        finish();
        if (isGone(event.status)) {
          resolve(null);
          return;
        }
        reject(
          transportError(
            'The generation stream could not be opened',
            event.status === 0 || event.status == null ? 'ERR_NETWORK' : 'ERR_BAD_RESPONSE',
            event.status == null ? undefined : { status: event.status, data: event.data },
          ),
        );
        return;
      }
      /** A wire that reports no `open` still attached once it delivers a frame. */
      opened = true;
      resolve(stream);
      pending.push(event);
      if (isTerminal(event)) {
        done = true;
      }
      wake?.();
    };
    const connection = wire.reconnectToStream(
      {
        url: generationStreamUrl(apiBaseUrl(), {
          streamId: target.streamId,
          resume: target.resume,
          generationCreatedAt: target.generationCreatedAt,
        }),
        headers: generationProtocolHeaders(),
      },
      { signal: controller.signal, onEvent },
    );
    if (connection.closed && !opened) {
      finish();
      resolve(null);
    }
  });
}

/**
 * POSTs the turn until the server answers it, retrying what main chat's own start retries: a
 * dropped connection a few times, and a server that is still starting for as long as it says
 * to wait, within the readiness window.
 */
async function requestStart(
  start: NonNullable<GenerationTransportInit['start']>,
  request: ChatTransportRequest,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const deadline = Date.now() + START_GENERATION_READINESS_TIMEOUT_MS;
  for (let attempt = 1, dropped = 0; ; attempt++) {
    try {
      return await start(request, { signal });
    } catch (error) {
      const remaining = deadline - Date.now();
      const networkRetry =
        isRetryableNetworkError(error) && dropped < START_GENERATION_NETWORK_RETRIES - 1;
      const notReady = isServerNotReadyError(error) && remaining > 0;
      if (signal?.aborted === true || !(networkRetry || notReady)) {
        throw error;
      }
      dropped += networkRetry ? 1 : 0;
      const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
      const delay = notReady ? Math.min(getRetryAfterDelay(error, backoff), remaining) : backoff;
      if (!(await waitForRetryDelay(delay, signal))) {
        throw error;
      }
    }
  }
}

/**
 * A generation the server started whose stream did not open: it was over already, a newer one
 * took its place, the wire closed, the caller cancelled, or the request for it failed (a
 * gateway that answered in the server's place, a connection that dropped). None of those says
 * how the turn ended, so it is reported as what it is, a stream that dropped before its first
 * frame. It names its generation, which is what a caller needs to stop it or to ask what
 * became of it.
 */
const unopened = (target: {
  streamId: string;
  generationCreatedAt?: number;
  generationProtocolVersion?: number;
  resume: boolean;
}): ChatStream => ({
  streamId: target.streamId,
  generationCreatedAt: target.generationCreatedAt,
  generationProtocolVersion: target.generationProtocolVersion,
  resumed: target.resume,
  close: () => undefined,
  async *[Symbol.asyncIterator]() {},
});

/**
 * Starts a turn: posts it, reads what the server did with it, and opens the stream of the
 * generation it started. The server may instead say the turn had already run (`settled`) or
 * that a newer generation took its place (`replaced`), which the caller is told as they are.
 * Only the server says either: a stream that will not open is not an answer about the turn.
 */
async function startTurn(
  start: NonNullable<GenerationTransportInit['start']>,
  wire: () => WireTransport,
  request: ChatSendRequest,
): Promise<ChatSendResult> {
  const { payload, abortSignal } = request;
  if (payload.endpoint == null) {
    throw transportError('A turn needs an endpoint to be sent to', 'ERR_BAD_REQUEST');
  }
  const data = await requestStart(
    start,
    {
      server: generationServer(payload.endpoint),
      /** Stripped as main chat's start strips it, so the server reads the same body. */
      payload: removeNullishValues(payload) as TPayload,
    },
    abortSignal,
  );
  const conversationId = getStartGenerationConversationId(data);
  const streamId = getStartGenerationStreamId(data);
  const generationCreatedAt = getStartGenerationCreatedAt(data) ?? undefined;
  const refused = (): ChatTransportError =>
    transportError('The generation could not be started', 'ERR_BAD_RESPONSE', {
      status: 200,
      data,
    });
  if (isSettledStartResponse(data)) {
    if (conversationId == null) {
      throw refused();
    }
    return {
      status: 'settled',
      conversationId,
      generationProtocolVersion: GENERATION_PROTOCOL_VERSION,
    };
  }
  if (isReplacedStartResponse(data)) {
    if (conversationId == null || streamId == null || generationCreatedAt == null) {
      throw refused();
    }
    return {
      status: 'replaced',
      conversationId,
      streamId,
      generationCreatedAt,
      generationProtocolVersion: GENERATION_PROTOCOL_VERSION,
    };
  }
  /** A v2-only control word is never read as a stream because it also carries a stream id. */
  if (isUnnegotiatedV2StartControl(data) || streamId == null) {
    throw refused();
  }
  const target = {
    streamId,
    generationCreatedAt,
    generationProtocolVersion: getGenerationProtocolVersion(data),
    /** A start the server folded into a generation already running is replayed from its start. */
    resume: isResumedStartResponse(data),
  };
  request.onGeneration?.({
    streamId: target.streamId,
    generationCreatedAt: target.generationCreatedAt,
    generationProtocolVersion: target.generationProtocolVersion,
  });
  /**
   * The server has taken the turn, so nothing its stream does on opening is a refusal of it:
   * reported as one, a running turn would be shown as failed, and put back in a queue it was
   * sent from to be sent twice.
   */
  const stream = await openStream(wire(), { ...target, signal: abortSignal }).catch(() => null);
  return { status: 'stream', stream: stream ?? unopened(target) };
}

/**
 * The `Chat` transport over LibreChat's generation routes. Reattaching asks the status route
 * what is running and then opens that generation's stream, replayed from its start, so a chat
 * that joins late holds what one that watched from the first frame holds.
 */
export function createGenerationTransport(init: GenerationTransportInit): ChatTransport {
  return {
    sendMessages(request) {
      if (init.sendMessages != null) {
        return init.sendMessages(request);
      }
      if (init.start == null) {
        return Promise.reject(
          transportError('This transport only follows running generations', 'ERR_VIEW_ONLY'),
        );
      }
      return startTurn(init.start, init.wire, request);
    },
    async reconnectToStream(request: ChatReconnectRequest) {
      const status = await init.getStatus(request.chatId);
      if (!status.active || request.abortSignal?.aborted === true) {
        return null;
      }
      /** The caller named a generation; a different one running is not the one it asked for. */
      if (
        request.generationCreatedAt != null &&
        status.createdAt != null &&
        status.createdAt !== request.generationCreatedAt
      ) {
        return null;
      }
      const target = {
        streamId: request.streamId ?? status.streamId ?? request.chatId,
        generationCreatedAt: request.generationCreatedAt ?? status.createdAt,
        generationProtocolVersion: status.generationProtocolVersion,
      };
      request.onGeneration?.(target);
      return openStream(init.wire(), { ...target, signal: request.abortSignal, resume: true });
    },
    abort(request) {
      if (init.abort == null) {
        return Promise.reject(
          transportError('This transport cannot stop a generation', 'ERR_VIEW_ONLY'),
        );
      }
      return init.abort(request);
    },
    getStatus: (conversationId) => init.getStatus(conversationId),
  };
}
