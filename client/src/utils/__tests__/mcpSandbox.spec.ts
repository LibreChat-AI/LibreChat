import fs from 'fs';
import path from 'path';

/**
 * `client/public/mcp-sandbox.html` is a static asset outside the module graph, so it is exercised by
 * evaluating its inline script against a fake `window` (listener isolation per test, a stubbed
 * parent, and the query string the route is called with). The navigation cases it exists for cannot
 * run here: jsdom has no policy containers and no real frame navigation, so the heartbeat's
 * navigation invalidation window remains browser-only.
 */
const SANDBOX_PATH = path.join(__dirname, '../../../public/mcp-sandbox.html');
const SANDBOX_HTML = fs.readFileSync(SANDBOX_PATH, 'utf8');
const PARENT_ORIGIN = 'http://localhost:3080';
const RESOURCE_READY = 'ui/notifications/sandbox-resource-ready';
const PROXY_READY = 'ui/notifications/sandbox-proxy-ready';
const ATTEST = 'ui/notifications/sandbox-frame-attest';
const DETACH = 'ui/notifications/sandbox-frame-detach';

type JsonRpcMessage = {
  jsonrpc: string;
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
};

type FakeEvent = { data: unknown; origin: string; source: unknown };

type Harness = {
  parentPosts: Array<{ msg: JsonRpcMessage; targetOrigin: string }>;
  errors: unknown[][];
  fromParent: (msg: JsonRpcMessage, origin?: string) => void;
  fromInner: (msg: JsonRpcMessage, source?: unknown) => void;
  frame: () => HTMLIFrameElement | null;
  innerPosts: () => JsonRpcMessage[];
  blobs: string[];
  revoked: string[];
  bootstrapNonce: (index?: number) => string;
  attest: () => void;
  deliverResource: (params?: Record<string, unknown>) => void;
  loadFrame: (frame?: HTMLIFrameElement | null) => void;
};

function extractScript(html: string): string {
  const start = html.indexOf('<script>') + '<script>'.length;
  const end = html.lastIndexOf('</script>');
  return html.slice(start, end);
}

const blobs: string[] = [];
const revoked: string[] = [];
const errors: unknown[][] = [];

function installStubs(): () => void {
  const errorSpy = jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args);
  });
  return () => {
    errorSpy.mockRestore();
  };
}

function loadSandbox(
  options: {
    parentOrigin?: string | null;
    cspApplied?: boolean;
    viewCspApplied?: boolean;
  } = {},
): Harness {
  const { parentOrigin = PARENT_ORIGIN, cspApplied = true, viewCspApplied = true } = options;
  let source = extractScript(SANDBOX_HTML);
  if (cspApplied) {
    source = source.replace('/*__CSP_APPLIED__*/', 'window.__MCP_SANDBOX_CSP_APPLIED = true;');
  }
  if (viewCspApplied) {
    source = source.replace(
      '/*__VIEW_CSP__*/',
      "window.__MCP_VIEW_CSP = \"default-src 'none'; frame-src 'none'\";",
    );
  }

  const listeners = new Map<string, Array<(event: FakeEvent) => void>>();
  const parentPosts: Harness['parentPosts'] = [];
  const innerPosts: JsonRpcMessage[] = [];

  const parentWindow = {
    postMessage: (msg: JsonRpcMessage, targetOrigin: string) => {
      parentPosts.push({ msg, targetOrigin });
    },
  };

  const fakeWindow: Record<string, unknown> = {
    parent: parentWindow,
    location: {
      search: parentOrigin ? `?parentOrigin=${encodeURIComponent(parentOrigin)}` : '',
      origin: 'null',
    },
    addEventListener: (type: string, handler: (event: FakeEvent) => void) => {
      const bucket = listeners.get(type) ?? [];
      bucket.push(handler);
      listeners.set(type, bucket);
    },
    removeEventListener: () => {},
  };

  const run = new Function('window', source) as (win: unknown) => void;
  run(fakeWindow);

  const dispatch = (event: FakeEvent) => {
    for (const handler of listeners.get('message') ?? []) {
      handler(event);
    }
  };

  const frame = () => document.body.querySelector('iframe');

  const patchInnerPost = () => {
    const current = frame();
    if (!current || !current.contentWindow) {
      return;
    }
    const win = current.contentWindow as unknown as { postMessage: unknown; __patched?: boolean };
    if (win.__patched) {
      return;
    }
    win.postMessage = (msg: JsonRpcMessage) => innerPosts.push(msg);
    win.__patched = true;
  };

  const bootstrapNonce = (index?: number) => {
    const blob = blobs[index ?? blobs.length - 1];
    const match = blob?.match(/var N="([0-9a-f]+)"/);
    return match ? match[1] : '';
  };

  const fromInner = (msg: JsonRpcMessage, source?: unknown) =>
    dispatch({ data: msg, origin: 'null', source: source ?? frame()?.contentWindow });

  return {
    parentPosts,
    errors,
    blobs,
    revoked,
    fromParent: (msg, origin = PARENT_ORIGIN) =>
      dispatch({ data: msg, origin, source: parentWindow }),
    fromInner,
    frame,
    innerPosts: () => innerPosts,
    bootstrapNonce,
    attest: () =>
      fromInner({ jsonrpc: '2.0', method: ATTEST, params: { nonce: bootstrapNonce() } }),
    deliverResource: (params = {}) => {
      dispatch({
        data: {
          jsonrpc: '2.0',
          method: RESOURCE_READY,
          params: { html: '<html><head></head><body>app</body></html>', ...params },
        },
        origin: PARENT_ORIGIN,
        source: parentWindow,
      });
      const document = frame()?.srcdoc;
      if (document && blobs[blobs.length - 1] !== document) {
        blobs.push(document);
      }
      patchInnerPost();
    },
    loadFrame: (target) => {
      const element = target ?? frame();
      element?.dispatchEvent(new Event('load'));
    },
  };
}

const HOST_REQUEST: JsonRpcMessage = { jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: {} };
const APP_NOTIFICATION: JsonRpcMessage = {
  jsonrpc: '2.0',
  method: 'ui/notifications/size-changed',
  params: { height: 200 },
};

describe('mcp-sandbox.html source', () => {
  it('no longer builds a policy of its own', () => {
    for (const removed of [
      'http-equiv',
      'buildCspMeta',
      'buildCspPolicy',
      'escapeAttr',
      'SAFE_HOST_RE',
      'toDomainList',
      'applyNavigationPolicy',
      'beforeunload',
    ]) {
      expect(SANDBOX_HTML).not.toContain(removed);
    }
  });

  it('carries the fail-closed marker the sandbox route substitutes', () => {
    expect(SANDBOX_HTML).toContain('/*__CSP_APPLIED__*/');
    expect(SANDBOX_HTML).toContain('/*__VIEW_CSP__*/');
    expect(SANDBOX_HTML).toContain('window.__MCP_SANDBOX_CSP_APPLIED !== true');
    expect(SANDBOX_HTML).toContain("typeof window.__MCP_VIEW_CSP !== 'string'");
  });
});

describe('mcp-sandbox proxy', () => {
  let restoreStubs: () => void;

  beforeEach(() => {
    jest.useFakeTimers();
    document.body.innerHTML = '';
    blobs.length = 0;
    revoked.length = 0;
    errors.length = 0;
    restoreStubs = installStubs();
  });

  afterEach(() => {
    restoreStubs();
    jest.useRealTimers();
  });

  describe('handshake', () => {
    it('announces itself to the declared parent origin', () => {
      const sandbox = loadSandbox();
      expect(sandbox.parentPosts).toHaveLength(1);
      expect(sandbox.parentPosts[0]).toEqual({
        msg: { jsonrpc: '2.0', method: PROXY_READY, params: {} },
        targetOrigin: PARENT_ORIGIN,
      });
    });

    it('refuses to bridge without a parent origin', () => {
      const sandbox = loadSandbox({ parentOrigin: null });
      expect(sandbox.parentPosts).toHaveLength(0);
      expect(sandbox.errors).toHaveLength(1);
      sandbox.deliverResource();
      expect(sandbox.frame()).toBeNull();
    });

    it('bounds the re-announcement and stops once a frame exists', () => {
      const sandbox = loadSandbox();
      jest.advanceTimersByTime(500 * 40);
      expect(sandbox.parentPosts).toHaveLength(21);

      sandbox.deliverResource();
      const before = sandbox.parentPosts.length;
      jest.advanceTimersByTime(500 * 10);
      expect(sandbox.parentPosts).toHaveLength(before);
    });

    it('ignores a resource delivered from an untrusted origin', () => {
      const sandbox = loadSandbox();
      sandbox.fromParent(
        { jsonrpc: '2.0', method: RESOURCE_READY, params: { html: '<p>x</p>' } },
        'https://evil.example',
      );
      expect(sandbox.frame()).toBeNull();
    });
  });

  describe('fail-closed csp marker', () => {
    it('builds no frame when the document was served without a per-resource policy', () => {
      const sandbox = loadSandbox({ cspApplied: false });
      sandbox.deliverResource();
      expect(sandbox.frame()).toBeNull();
      expect(sandbox.errors).toHaveLength(1);
    });

    it('builds no frame when the route did not embed the View policy', () => {
      const sandbox = loadSandbox({ viewCspApplied: false });
      sandbox.deliverResource();
      expect(sandbox.frame()).toBeNull();
      expect(sandbox.errors).toHaveLength(1);
    });

    it('builds the frame when the route applied the policy', () => {
      const sandbox = loadSandbox();
      sandbox.deliverResource();
      expect(sandbox.frame()).not.toBeNull();
      expect(sandbox.errors).toHaveLength(0);
    });
  });

  describe('inner document', () => {
    it('is one resource per document', () => {
      const sandbox = loadSandbox();
      sandbox.deliverResource({ html: '<p>first</p>' });
      const first = sandbox.frame();
      sandbox.deliverResource({ html: '<p>second</p>' });
      expect(sandbox.frame()).toBe(first);
      expect(sandbox.blobs).toHaveLength(1);
      expect(sandbox.revoked).toHaveLength(0);
    });

    it('grants only allowlisted sandbox tokens', () => {
      const sandbox = loadSandbox();
      sandbox.deliverResource({
        sandbox:
          'allow-same-origin allow-top-navigation allow-popups-to-escape-sandbox allow-modals',
      });
      expect(sandbox.frame()?.getAttribute('sandbox')).toBe('allow-scripts allow-forms');
    });

    it('keeps a requested subset of the allowlist', () => {
      const sandbox = loadSandbox();
      sandbox.deliverResource({ sandbox: 'allow-scripts allow-same-origin allow-pointer-lock' });
      expect(sandbox.frame()?.getAttribute('sandbox')).toBe('allow-scripts allow-pointer-lock');
    });

    it('withholds media permissions that an opaque inner frame cannot use', () => {
      const sandbox = loadSandbox();
      sandbox.deliverResource({
        permissions: { camera: {}, microphone: {}, clipboardWrite: {}, geolocation: {} },
      });
      expect(sandbox.frame()?.getAttribute('allow')).toBe('geolocation; clipboard-write');
    });

    it.each([
      ['<html><head><title>t</title></head><body>a</body></html>', '<head>'],
      ['<!doctype html><body>a</body>', '<!doctype html>'],
      ['<!doctype html><!-- lead --><html><head></head><body>a</body></html>', '<head>'],
      ['<p>bare</p>', ''],
    ])('injects the bootstrap without rewriting the app document (%s)', (html) => {
      const sandbox = loadSandbox();
      sandbox.deliverResource({ html });
      const blob = sandbox.blobs[0];
      const injection =
        blob.match(
          /<meta http-equiv="Content-Security-Policy"[^>]*><script>\(function\(\)\{var N=[\s\S]*?<\/script>/,
        )?.[0] ?? '';
      expect(injection).not.toBe('');
      expect(injection).toContain("frame-src 'none'");
      expect(blob.replace(injection, '')).toBe(html);
      if (/<head/i.test(html)) {
        expect(blob).toMatch(
          /<head[^>]*><meta http-equiv="Content-Security-Policy"[^>]*><script>\(function\(\)\{var N=/,
        );
      }
      if (/^\s*<!doctype/i.test(html)) {
        expect(blob.toLowerCase().indexOf('<!doctype')).toBe(0);
      }
    });

    it.each([
      [
        '<!-- template includes <head> --><html><head></head><body>app</body></html>',
        '<html><head>',
      ],
      ['<!doctype html><!-- <head> --><body>app</body>', '<!-- <head> -->'],
      ['<!doctype html><!-- <head>', '<!doctype html>'],
      [
        '<!doctype html><html><head></head><body><script>var s="<head>";</script></body></html>',
        '<head>',
      ],
      ['<!doctype html><html><body><script>var s="<head>";</script></body></html>', '<html>'],
      ['<!doctype html><HTML><HEAD></HEAD><body>a</body></HTML>', '<HEAD>'],
      ['<!doctype html><html><head data-x="1"></head><body>a</body></html>', '<head data-x="1">'],
      ['<!doctype html><html><body><div title="<head>"></div></body></html>', '<html>'],
      ['<template><head></head></template><p>app</p>', ''],
      ['<!doctype html><!-- lead --><template><head></head></template><p>app</p>', '<!-- lead -->'],
      ['<!doctype html><html><template><template><head></head></template></template>', '<html>'],
      ['<p>bare</p>', ''],
    ])('injects into the document head or active prolog (%s)', (html, marker) => {
      const sandbox = loadSandbox();
      sandbox.deliverResource({ html });
      const blob = sandbox.blobs[0];
      const injection =
        blob.match(
          /<meta http-equiv="Content-Security-Policy"[^>]*><script>\(function\(\)\{var N=[\s\S]*?<\/script>/,
        )?.[0] ?? '';
      expect(injection).not.toBe('');
      const at = marker === '' ? 0 : html.indexOf(marker) + marker.length;
      expect(blob).toBe(html.slice(0, at) + injection + html.slice(at));
    });

    it('keeps a quoted doctype and leading comment ahead of the bootstrap', () => {
      const sandbox = loadSandbox();
      const prefix = '<!-- lead --><!doctype html PUBLIC "example>public" "example>system">';
      const html = `${prefix}<template><head></head></template>`;
      sandbox.deliverResource({ html });
      expect(sandbox.blobs[0]).toMatch(
        /^<!-- lead --><!doctype html PUBLIC "example>public" "example>system"><meta /,
      );
    });

    it('mints a distinct nonce per document', () => {
      const first = loadSandbox();
      first.deliverResource();
      document.body.innerHTML = '';
      const second = loadSandbox();
      second.deliverResource();
      expect(first.bootstrapNonce(0)).toMatch(/^[0-9a-f]{32}$/);
      expect(second.bootstrapNonce(1)).not.toBe(first.bootstrapNonce(0));
    });
  });

  describe('bridge invalidation', () => {
    it('forwards nothing until the injected bootstrap attests', () => {
      const sandbox = loadSandbox();
      sandbox.deliverResource();
      sandbox.fromParent(HOST_REQUEST);
      expect(sandbox.innerPosts()).toHaveLength(0);

      sandbox.attest();
      expect(sandbox.innerPosts()).toEqual([HOST_REQUEST]);
    });

    it('ignores an attestation that cannot produce the nonce', () => {
      const sandbox = loadSandbox();
      sandbox.deliverResource();
      sandbox.fromInner({ jsonrpc: '2.0', method: ATTEST, params: { nonce: 'forged' } });
      sandbox.fromParent(HOST_REQUEST);
      expect(sandbox.innerPosts()).toHaveLength(0);
    });

    it('holds traffic while the heartbeat is throttled and releases it on the next attestation', () => {
      const sandbox = loadSandbox();
      sandbox.deliverResource();
      sandbox.attest();

      jest.advanceTimersByTime(1200);
      sandbox.fromParent(HOST_REQUEST);
      sandbox.fromInner(APP_NOTIFICATION);
      expect(sandbox.innerPosts()).toHaveLength(0);
      expect(
        sandbox.parentPosts.filter((post) => post.msg.method === APP_NOTIFICATION.method),
      ).toHaveLength(0);

      sandbox.attest();
      expect(sandbox.innerPosts()).toEqual([HOST_REQUEST]);
      expect(
        sandbox.parentPosts.filter((post) => post.msg.method === APP_NOTIFICATION.method),
      ).toHaveLength(1);

      sandbox.fromParent(HOST_REQUEST);
      expect(sandbox.innerPosts()).toHaveLength(2);
    });

    it('bounds the hold queue', () => {
      const sandbox = loadSandbox();
      sandbox.deliverResource();
      sandbox.attest();
      jest.advanceTimersByTime(1200);
      for (let i = 0; i < 60; i += 1) {
        sandbox.fromParent({ ...HOST_REQUEST, id: i });
      }

      sandbox.attest();
      const released = sandbox.innerPosts();
      expect(released).toHaveLength(50);
      expect(released[0].id).toBe(10);
    });

    it('discards held traffic on detach', () => {
      const sandbox = loadSandbox();
      sandbox.deliverResource();
      sandbox.attest();
      jest.advanceTimersByTime(1200);
      sandbox.fromParent(HOST_REQUEST);
      sandbox.fromInner({
        jsonrpc: '2.0',
        method: DETACH,
        params: { nonce: sandbox.bootstrapNonce() },
      });

      sandbox.attest();
      expect(sandbox.innerPosts()).toHaveLength(0);
    });

    it('tears down on detach and relays nothing the replacement document posts', () => {
      const sandbox = loadSandbox();
      sandbox.deliverResource();
      sandbox.attest();
      const inner = sandbox.frame()?.contentWindow;

      sandbox.fromInner({
        jsonrpc: '2.0',
        method: DETACH,
        params: { nonce: sandbox.bootstrapNonce() },
      });
      expect(sandbox.frame()).toBeNull();
      expect(sandbox.revoked).toHaveLength(0);

      sandbox.fromInner(APP_NOTIFICATION, inner);
      sandbox.fromParent(HOST_REQUEST);
      expect(sandbox.innerPosts()).toHaveLength(0);
      expect(
        sandbox.parentPosts.filter((post) => post.msg.method === APP_NOTIFICATION.method),
      ).toHaveLength(0);
    });

    it('does not mistake duplicate load events for an app navigation', () => {
      const sandbox = loadSandbox();
      sandbox.deliverResource();
      sandbox.attest();
      sandbox.loadFrame();
      sandbox.fromParent(HOST_REQUEST);
      expect(sandbox.innerPosts()).toHaveLength(1);

      sandbox.loadFrame();
      expect(sandbox.frame()).not.toBeNull();
      sandbox.fromParent(HOST_REQUEST);
      expect(sandbox.innerPosts()).toHaveLength(2);
    });

    it('does not let stale load events restore a detached frame', () => {
      const sandbox = loadSandbox();
      sandbox.deliverResource();
      sandbox.attest();
      const stale = sandbox.frame() as HTMLIFrameElement;
      sandbox.fromInner({
        jsonrpc: '2.0',
        method: DETACH,
        params: { nonce: sandbox.bootstrapNonce() },
      });
      expect(sandbox.frame()).toBeNull();

      sandbox.loadFrame(stale);
      sandbox.loadFrame(stale);
      expect(sandbox.frame()).toBeNull();
    });
  });

  describe('relay', () => {
    it('relays app traffic up to the declared parent origin', () => {
      const sandbox = loadSandbox();
      sandbox.deliverResource();
      sandbox.attest();
      sandbox.fromInner(APP_NOTIFICATION);
      const relayed = sandbox.parentPosts.filter(
        (post) => post.msg.method === APP_NOTIFICATION.method,
      );
      expect(relayed).toHaveLength(1);
      expect(relayed[0].targetOrigin).toBe(PARENT_ORIGIN);
    });

    it('relays a response that carries no method', () => {
      const sandbox = loadSandbox();
      sandbox.deliverResource();
      sandbox.attest();
      sandbox.fromInner({ jsonrpc: '2.0', id: 7, result: {} });
      expect(sandbox.parentPosts.some((post) => post.msg.id === 7)).toBe(true);
    });

    it('never relays the sandbox control namespace up', () => {
      const sandbox = loadSandbox();
      sandbox.deliverResource();
      sandbox.attest();
      sandbox.fromInner({ jsonrpc: '2.0', method: PROXY_READY, params: {} });
      sandbox.fromInner({ jsonrpc: '2.0', method: RESOURCE_READY, params: { html: '<p>x</p>' } });
      expect(sandbox.parentPosts.filter((post) => post.msg.method === RESOURCE_READY)).toHaveLength(
        0,
      );
      expect(sandbox.parentPosts.filter((post) => post.msg.method === PROXY_READY)).toHaveLength(1);
    });

    it('drops messages from an unrelated window in both directions', () => {
      const sandbox = loadSandbox();
      sandbox.deliverResource();
      sandbox.attest();
      const grandchild = { name: 'grandchild' };
      sandbox.fromInner(APP_NOTIFICATION, grandchild);
      expect(
        sandbox.parentPosts.filter((post) => post.msg.method === APP_NOTIFICATION.method),
      ).toHaveLength(0);

      sandbox.fromParent(HOST_REQUEST, 'https://evil.example');
      expect(sandbox.innerPosts()).toHaveLength(0);
    });

    it('ignores non-JSON-RPC traffic', () => {
      const sandbox = loadSandbox();
      sandbox.deliverResource();
      sandbox.attest();
      sandbox.fromInner({ jsonrpc: '1.0', method: 'x' } as JsonRpcMessage);
      sandbox.fromInner('not json' as unknown as JsonRpcMessage);
      expect(sandbox.parentPosts.filter((post) => post.msg.method === 'x')).toHaveLength(0);
    });
  });
});
