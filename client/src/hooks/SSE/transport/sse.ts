import { SSE } from 'sse.js';
import { request } from 'librechat-data-provider';
import type {
  ChatFrame,
  ChatEvent,
  ChatTransport,
  ChatErrorData,
  ChatStreamConnection,
} from 'librechat-data-provider';
import { normalizeFrame } from './frames';

type StreamErrorEvent = MessageEvent & { responseCode?: number };
type ReadyStateChangeEvent = Event & { readyState?: number };
type EventCallback = (event: ChatEvent) => void;

const jsonHeaders = (token?: string) => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${token}`,
});

/** Parses one `message` event and emits it normalized; a frame that is not JSON is skipped. */
const emitFrame = (onEvent: EventCallback) => (e: MessageEvent) => {
  let frame: ChatFrame;
  try {
    frame = JSON.parse(e.data);
  } catch (error) {
    console.error('Skipping malformed stream frame:', error);
    return;
  }
  const event = normalizeFrame(frame);
  if (event) {
    onEvent(event);
  }
};

/** Resolves to the refreshed token, or `null` when the refresh failed. */
async function refreshToken(): Promise<string | null> {
  try {
    const refreshResponse = await request.refreshToken();
    const refreshedToken = refreshResponse?.token ?? '';
    if (!refreshedToken) {
      throw new Error('Token refresh failed.');
    }
    return refreshedToken;
  } catch (error) {
    /* token refresh failed, continue handling the original 401 */
    console.log(error);
    return null;
  }
}

/**
 * An HTTP failure body is often empty or HTML, so one that is not JSON is
 * `undefined`. An error event the server wrote keeps its raw text instead.
 */
function parseErrorBody(body: unknown, status?: number): ChatErrorData | undefined {
  if (typeof body !== 'string' || body === '') {
    return undefined;
  }
  try {
    return JSON.parse(body);
  } catch {
    return status == null ? body : undefined;
  }
}

/**
 * POSTs the turn with `sse.js` and normalizes what comes back. Owns the wire:
 * frame parsing, named `attachment`/`error` events, and one token refresh and
 * retry on a 401. A frame that is not JSON is logged and skipped, so the
 * frames behind it in the same chunk still dispatch.
 */
export function createSSETransport({ token }: { token?: string }): ChatTransport {
  return {
    send({ server, payload }, { signal, onEvent }) {
      if (signal.aborted) {
        return;
      }

      const sse = new SSE(server, {
        payload: JSON.stringify(payload),
        headers: jsonHeaders(token),
      });

      sse.addEventListener('open', () => {
        onEvent({ type: 'open' });
      });

      sse.addEventListener('attachment', (e: MessageEvent) => {
        try {
          onEvent({ type: 'attachment', data: JSON.parse(e.data) });
        } catch (error) {
          console.error(error);
        }
      });

      sse.addEventListener('message', emitFrame(onEvent));

      let refreshed = false;
      /** sse.js marks the connection closed on a 401, but the turn is still
       * live until the retry settles, so an abort meanwhile must still cancel. */
      let refreshing = false;
      sse.addEventListener('error', async (e: StreamErrorEvent) => {
        if (e.responseCode === 401 && !refreshed) {
          refreshed = true;
          refreshing = true;
          const refreshedToken = await refreshToken();
          refreshing = false;
          if (signal.aborted) {
            return;
          }
          if (refreshedToken) {
            sse.headers = jsonHeaders(refreshedToken);
            request.dispatchTokenUpdatedEvent(refreshedToken);
            sse.stream();
            return;
          }
        }

        let data: ChatErrorData | null | undefined;
        try {
          data = JSON.parse(e.data);
        } catch (error) {
          console.error(error);
          console.log(e);
        }
        onEvent({ type: 'error', data });
      });

      sse.addEventListener('cancel', () => {
        onEvent({ type: 'abort' });
      });

      signal.addEventListener(
        'abort',
        () => {
          const wasOpen = sse.readyState <= 1 || refreshing;
          sse.close();
          if (wasOpen) {
            // @ts-expect-error sse.js declares dispatchEvent as (type, listener); it takes an event
            sse.dispatchEvent(new Event('cancel'));
          }
        },
        { once: true },
      );

      sse.stream();
    },

    reconnectToStream({ url, headers }, { signal, onEvent }): ChatStreamConnection {
      if (signal.aborted) {
        return { closed: true };
      }

      const sse = new SSE(url, {
        headers: { Authorization: `Bearer ${token}`, ...headers },
        method: 'GET',
      });

      /**
       * sse.js closes a 2xx body that simply ends without dispatching
       * anything, so the frames decide what that means: after `final` it is
       * the ordinary end of the stream, before it an intermediary dropped the
       * connection underneath the attachment. `failureSeen` is set by every
       * `error` and `abort` (including a 401 whose refresh restreams), so the
       * silent close below does not add a second verdict to one they already
       * accounted for; `open` clears it for the refreshed reattachment.
       */
      let final = false;
      let failureSeen = false;
      const dispatch = (event: ChatEvent) => {
        final ||= event.type === 'final';
        onEvent(event);
      };

      sse.addEventListener('open', () => {
        failureSeen = false;
        dispatch({ type: 'open' });
      });

      sse.addEventListener('message', emitFrame(dispatch));

      let refreshed = false;
      sse.addEventListener('error', async (e: StreamErrorEvent) => {
        failureSeen = true;
        if (e.responseCode === 401 && !refreshed) {
          refreshed = true;
          const refreshedToken = await refreshToken();
          if (signal.aborted) {
            return;
          }
          if (refreshedToken) {
            sse.headers = { ...sse.headers, Authorization: `Bearer ${refreshedToken}` };
            request.dispatchTokenUpdatedEvent(refreshedToken);
            sse.stream();
            return;
          }
        }
        dispatch({
          type: 'error',
          status: e.responseCode,
          data: parseErrorBody(e.data, e.responseCode),
        });
      });

      /** sse.js dispatches `abort` when the XHR is cancelled, by our close or by the user agent. */
      sse.addEventListener('abort', () => {
        failureSeen = true;
        dispatch(signal.aborted ? { type: 'abort' } : { type: 'error', status: 0 });
      });

      sse.addEventListener('readystatechange', (e: ReadyStateChangeEvent) => {
        if (e.readyState !== SSE.CLOSED || final || failureSeen) {
          return;
        }
        dispatch({ type: 'error', status: 0 });
      });

      signal.addEventListener('abort', () => sse.close(), { once: true });

      sse.stream();

      return {
        get closed() {
          return sse.readyState === SSE.CLOSED;
        },
      };
    },
  };
}
