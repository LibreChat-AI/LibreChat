import type { EmbedState } from './state';

/** Messages exchanged with the host page. The loader (`client/public/embed.js`) speaks the same. */
export const EmbedMessage = {
  ready: 'librechat:embed:ready',
  tokenRequest: 'librechat:embed:token-request',
  token: 'librechat:embed:token',
  tokenError: 'librechat:embed:token-error',
  authFailed: 'librechat:embed:auth-failed',
} as const;

/** Fixed rather than configured: the first token request runs before the startup config loads. */
const TOKEN_REQUEST_TIMEOUT_MS = 15_000;

interface HostMessage {
  type?: unknown;
  requestId?: unknown;
  token?: unknown;
}

/** Posts to the host page only, so nothing reaches a frame ancestor from another origin. */
export function postToHost(state: EmbedState, message: Record<string, unknown>) {
  window.parent.postMessage(message, state.origin);
}

/**
 * Asks the host page for a freshly signed token and resolves with it. Replies are accepted only
 * from the parent window at the recorded host origin and must echo the request id.
 */
export function requestHostToken(state: EmbedState): Promise<string> {
  const requestId =
    typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timer);
      window.removeEventListener('message', onMessage);
    };
    const onMessage = (event: MessageEvent<HostMessage>) => {
      if (event.source !== window.parent || event.origin !== state.origin) {
        return;
      }
      const data = event.data;
      if (data == null || typeof data !== 'object' || data.requestId !== requestId) {
        return;
      }
      if (data.type === EmbedMessage.token && typeof data.token === 'string' && data.token) {
        cleanup();
        resolve(data.token);
        return;
      }
      if (data.type === EmbedMessage.tokenError || data.type === EmbedMessage.token) {
        cleanup();
        reject(new Error('The host page did not provide an embed token'));
      }
    };
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for the host page to provide an embed token'));
    }, TOKEN_REQUEST_TIMEOUT_MS);

    window.addEventListener('message', onMessage);
    postToHost(state, { type: EmbedMessage.tokenRequest, requestId });
  });
}
