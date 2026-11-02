/**
 * LibreChat embed loader.
 *
 * Frames a LibreChat deployment inside a host page and signs the visitor in with a token the
 * host's own backend signs. Include it from the LibreChat deployment and mount it:
 *
 *   <div id="librechat" style="height: 600px"></div>
 *   <script src="https://chat.example.com/embed.js"></script>
 *   <script>
 *     LibreChatEmbed.mount({
 *       target: '#librechat',
 *       app: 'my-app',
 *       getToken: () =>
 *         fetch('/api/librechat-token', { method: 'POST' })
 *           .then((res) => res.json())
 *           .then((data) => data.token),
 *     });
 *   </script>
 *
 * `getToken` must call the host backend, which signs a short-lived HS256 JWT with the app's
 * secret; the secret never reaches the browser. The chat asks for a new token whenever its
 * session needs one. See docs/embed.md.
 */
(function () {
  'use strict';

  var MESSAGE = {
    ready: 'librechat:embed:ready',
    tokenRequest: 'librechat:embed:token-request',
    token: 'librechat:embed:token',
    tokenError: 'librechat:embed:token-error',
    authFailed: 'librechat:embed:auth-failed',
  };

  var script = document.currentScript;
  var scriptUrl = script && script.src ? new URL(script.src, window.location.href) : null;
  var defaultBaseUrl = scriptUrl ? scriptUrl.href.replace(/\/embed\.js(?:[?#].*)?$/, '') : '';

  function resolveTarget(target) {
    var element = typeof target === 'string' ? document.querySelector(target) : target;
    if (!element || typeof element.appendChild !== 'function') {
      throw new Error('LibreChatEmbed: `target` must be an element or a selector that matches one');
    }
    return element;
  }

  /**
   * Mounts the chat into `options.target`.
   *
   * @param {object} options
   * @param {string | Element} options.target - Element, or selector, to render the chat into.
   * @param {string} options.app - Embed app id configured in librechat.yaml.
   * @param {() => Promise<string>} options.getToken - Resolves a token signed by the host backend.
   * @param {string} [options.baseUrl] - LibreChat URL; defaults to where this script was loaded.
   * @param {string} [options.title] - Accessible title for the frame.
   * @param {() => void} [options.onReady] - Called when the chat has loaded.
   * @param {() => void} [options.onAuthFailed] - Called when the chat could not sign in.
   * @returns {{ destroy: () => void, iframe: HTMLIFrameElement }}
   */
  function mount(options) {
    if (!options || typeof options.getToken !== 'function') {
      throw new Error('LibreChatEmbed: `getToken` is required');
    }
    if (typeof options.app !== 'string' || !options.app) {
      throw new Error('LibreChatEmbed: `app` is required');
    }
    var baseUrl = (options.baseUrl || defaultBaseUrl).replace(/\/+$/, '');
    if (!baseUrl) {
      throw new Error('LibreChatEmbed: `baseUrl` is required when the script URL is unknown');
    }
    var chatOrigin = new URL(baseUrl).origin;
    var container = resolveTarget(options.target);

    var src =
      baseUrl +
      '/embed?app=' +
      encodeURIComponent(options.app) +
      '&origin=' +
      encodeURIComponent(window.location.origin);

    var iframe = document.createElement('iframe');
    iframe.src = src;
    iframe.title = options.title || 'Chat';
    iframe.allow = 'clipboard-write';
    iframe.referrerPolicy = 'origin';
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.style.border = '0';
    iframe.style.display = 'block';

    function reply(message) {
      if (iframe.contentWindow) {
        iframe.contentWindow.postMessage(message, chatOrigin);
      }
    }

    function onMessage(event) {
      if (event.source !== iframe.contentWindow || event.origin !== chatOrigin) {
        return;
      }
      var data = event.data;
      if (!data || typeof data !== 'object') {
        return;
      }
      if (data.type === MESSAGE.tokenRequest) {
        var requestId = data.requestId;
        Promise.resolve()
          .then(function () {
            return options.getToken();
          })
          .then(function (token) {
            if (typeof token !== 'string' || !token) {
              throw new Error('getToken resolved without a token');
            }
            reply({ type: MESSAGE.token, requestId: requestId, token: token });
          })
          .catch(function (error) {
            console.error('LibreChatEmbed: could not get a token for the chat', error);
            reply({ type: MESSAGE.tokenError, requestId: requestId });
          });
        return;
      }
      if (data.type === MESSAGE.ready && typeof options.onReady === 'function') {
        options.onReady();
        return;
      }
      if (data.type === MESSAGE.authFailed && typeof options.onAuthFailed === 'function') {
        options.onAuthFailed();
      }
    }

    window.addEventListener('message', onMessage);
    container.appendChild(iframe);

    return {
      iframe: iframe,
      destroy: function () {
        window.removeEventListener('message', onMessage);
        if (iframe.parentNode) {
          iframe.parentNode.removeChild(iframe);
        }
      },
    };
  }

  window.LibreChatEmbed = { mount: mount, version: 1 };
})();
