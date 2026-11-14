const ORIGIN = window.location.origin;
const REFRESH_ENDPOINT = `${ORIGIN}/api/auth/refresh`;

function safeSendResponse(sendResponse, payload) {
  if (typeof sendResponse !== 'function') {
    return;
  }
  if (!isRuntimeAvailable()) {
    console.debug('Skipping token response because the extension runtime is unavailable');
    return;
  }
  try {
    sendResponse(payload);
  } catch (error) {
    if (error && error.message && error.message.includes('Extension context invalidated')) {
      console.debug('Token response skipped due to invalidated context');
    } else {
      console.warn('Failed to deliver token response', error);
    }
  }
}

function isRuntimeAvailable() {
  return Boolean(chrome.runtime && chrome.runtime.id);
}

let tokenListenerCleanup = null;
let runtimeWatcherInstalled = false;

function registerTokenListener() {
  if (window.__librechatTokenListenerRegistered || !isRuntimeAvailable()) {
    return;
  }

  const handler = (message, sender, sendResponse) => {
    if (!isRuntimeAvailable()) {
      safeSendResponse(sendResponse, { success: false, error: 'Extension runtime unavailable' });
      return false;
    }
    if (!message || message.type !== 'requestAccessToken') {
      return;
    }

    (async () => {
      try {
        const response = await fetch(REFRESH_ENDPOINT, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json'
          }
        });

        if (!response.ok) {
          const body = await response.text();
          throw new Error(`Refresh failed: ${response.status} ${body}`);
        }

        const data = await response.json();
        if (!data || !data.token) {
          throw new Error('Refresh response missing access token');
        }

        safeSendResponse(sendResponse, { success: true, token: data.token, expires: data.expires ?? data.expiresAt ?? null, expiresIn: data.expiresIn ?? null });
      } catch (error) {
        safeSendResponse(sendResponse, { success: false, error: error.message });
      }
    })();

    return true;
  };

  try {
    chrome.runtime.onMessage.addListener(handler);
  } catch (error) {
    if (error && error.message && error.message.includes('Extension context invalidated')) {
      console.debug('Skipping token listener registration due to invalidated context');
    } else {
      console.warn('Failed to register token listener', error);
    }
    return;
  }

  window.__librechatTokenListenerRegistered = true;

  tokenListenerCleanup = () => {
    if (!window.__librechatTokenListenerRegistered) {
      return;
    }
    if (chrome.runtime?.onMessage?.removeListener) {
      try {
        chrome.runtime.onMessage.removeListener(handler);
      } catch (error) {
        console.debug('Failed to remove token listener', error);
      }
    }
    window.__librechatTokenListenerRegistered = false;
    tokenListenerCleanup = null;
  };

  const teardownOptions = { once: true };
  window.addEventListener('pagehide', tokenListenerCleanup, teardownOptions);
  window.addEventListener('unload', tokenListenerCleanup, teardownOptions);
}

registerTokenListener();

if (!runtimeWatcherInstalled) {
  runtimeWatcherInstalled = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !window.__librechatTokenListenerRegistered) {
      registerTokenListener();
    }
  });
}
