import { apiBaseUrl } from 'librechat-data-provider';
import type { ChatEvent, ChatTransport as WireTransport } from 'librechat-data-provider';
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
import { generationProtocolHeaders, generationStreamUrl } from '../protocol';

/** What the generation routes need from the app that calls them. */
export type GenerationTransportInit = {
  /**
   * The wire that opens a stream, bound to the signed-in user. Read on every attachment, so a
   * refreshed token is the one the next attachment sends.
   */
  wire: () => WireTransport;
  /** Reads a conversation's generation state from the status route. */
  getStatus: (conversationId: string) => Promise<ChatStreamStatus>;
  /** Starts a turn. Without it the transport only follows generations something else started. */
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
  },
): Promise<ChatStream | null> {
  const controller = new AbortController();
  const pending: ChatEvent[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  const finish = (): void => {
    done = true;
    wake?.();
  };
  const close = (): void => {
    controller.abort();
    finish();
  };
  if (target.signal?.aborted === true) {
    return Promise.resolve(null);
  }
  target.signal?.addEventListener('abort', close, { once: true });

  const stream: ChatStream = {
    streamId: target.streamId,
    generationCreatedAt: target.generationCreatedAt,
    generationProtocolVersion: target.generationProtocolVersion,
    resumed: true,
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
          resume: true,
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
 * The `Chat` transport over LibreChat's generation routes. Reattaching asks the status route
 * what is running and then opens that generation's stream, replayed from its start, so a chat
 * that joins late holds what one that watched from the first frame holds.
 */
export function createGenerationTransport(init: GenerationTransportInit): ChatTransport {
  return {
    sendMessages(request) {
      if (init.sendMessages == null) {
        return Promise.reject(
          transportError('This transport only follows running generations', 'ERR_VIEW_ONLY'),
        );
      }
      return init.sendMessages(request);
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
      return openStream(init.wire(), {
        streamId: request.streamId ?? status.streamId ?? request.chatId,
        generationCreatedAt: request.generationCreatedAt ?? status.createdAt,
        generationProtocolVersion: status.generationProtocolVersion,
        signal: request.abortSignal,
      });
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
