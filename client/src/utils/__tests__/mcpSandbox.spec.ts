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

/** What the proxy puts ahead of the App: the policy, the bootstrap, then the storage stand-ins. */
const VIEW_INJECTION =
  /<meta http-equiv="Content-Security-Policy"[^>]*><script>\(function\(\)\{var N=[\s\S]*?<\/script><script>[\s\S]*?<\/script>/;

/** The inline scripts the proxy adds to a View document, in order: bootstrap, then stand-ins. */
function injectedScripts(srcdoc: string): string[] {
  const parsed = new DOMParser().parseFromString(srcdoc, 'text/html');
  return Array.from(parsed.head.querySelectorAll('script'), (script) => script.textContent ?? '');
}

function securityError(property: string): DOMException {
  return new DOMException(
    `Failed to read the '${property}' property: The document is sandboxed and lacks the 'allow-same-origin' flag.`,
    'SecurityError',
  );
}

function errorName(read: () => unknown): string | null {
  try {
    read();
    return null;
  } catch (error) {
    return (error as Error).name;
  }
}

const ALL_BLOCKED = ['localStorage', 'sessionStorage', 'indexedDB', 'cookie'];

/**
 * A window and document as an opaque View sees them. Whatever is listed in `blocked` throws a
 * SecurityError on access, as it does without `allow-same-origin`. Everything else behaves like a
 * browser that grants it: a getter that returns the same native object, and a cookie accessor on
 * the document prototype.
 */
function createView(blocked: readonly string[] = ALL_BLOCKED) {
  const native: Record<string, object> = {
    localStorage: { native: 'localStorage' },
    sessionStorage: { native: 'sessionStorage' },
    indexedDB: { native: 'indexedDB' },
  };
  const cookieWrites: string[] = [];
  class FakeDocument {}
  const win: Record<string, unknown> = {};
  for (const name of Object.keys(native)) {
    Object.defineProperty(win, name, {
      configurable: true,
      get: () => {
        if (blocked.includes(name)) {
          throw securityError(name);
        }
        return native[name];
      },
    });
  }
  Object.defineProperty(FakeDocument.prototype, 'cookie', {
    configurable: true,
    get: () => {
      if (blocked.includes('cookie')) {
        throw securityError('cookie');
      }
      return 'native=1';
    },
    set: (value: string) => {
      if (blocked.includes('cookie')) {
        throw securityError('cookie');
      }
      cookieWrites.push(value);
    },
  });
  const doc = Object.create(FakeDocument.prototype) as { cookie: string };
  return {
    win,
    doc,
    native,
    cookieWrites,
    storage: (name: 'localStorage' | 'sessionStorage') => win[name] as Storage,
    cookieDescriptor: () => Object.getOwnPropertyDescriptor(FakeDocument.prototype, 'cookie'),
    run: (script: string): unknown =>
      new Function('window', 'document', 'Document', script)(win, doc, FakeDocument),
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
      const injection = blob.match(VIEW_INJECTION)?.[0] ?? '';
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
      const injection = blob.match(VIEW_INJECTION)?.[0] ?? '';
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

  describe('storage stand-ins', () => {
    const standInsFor = (html?: string): string => {
      const sandbox = loadSandbox();
      sandbox.deliverResource(html ? { html } : {});
      const scripts = injectedScripts(sandbox.blobs[0]);
      expect(scripts).toHaveLength(2);
      return scripts[1];
    };

    it('are injected as their own script, after the bootstrap and ahead of the app', () => {
      const html =
        '<!doctype html><html><head><title>t</title></head><body><p>app</p></body></html>';
      const sandbox = loadSandbox();
      sandbox.deliverResource({ html });
      const blob = sandbox.blobs[0];

      expect(blob).toMatch(
        /<head><meta http-equiv="Content-Security-Policy"[^>]*><script>\(function\(\)\{var N=[\s\S]*?<\/script><script>[\s\S]*?<\/script><title>t<\/title>/,
      );
      const [bootstrap, standIns] = injectedScripts(blob);
      expect(bootstrap).toContain('var N=');
      expect(standIns).not.toContain('var N=');
      expect(standIns).toContain('localStorage');
      expect(standIns).toContain('sessionStorage');
      expect(standIns).toContain('cookie');
      // The closing tag is escaped in the proxy, so no part of the script leaks into the document.
      const parsed = new DOMParser().parseFromString(blob, 'text/html');
      expect(parsed.querySelectorAll('script')).toHaveLength(2);
      expect(parsed.body.textContent).toBe('app');
      expect(blob.replace(blob.match(VIEW_INJECTION)?.[0] ?? '', '')).toBe(html);
    });

    it('keep the bootstrap attestation untouched', () => {
      const sandbox = loadSandbox();
      sandbox.deliverResource();
      sandbox.attest();
      sandbox.fromParent(HOST_REQUEST);
      expect(sandbox.innerPosts()).toEqual([HOST_REQUEST]);
      expect(sandbox.bootstrapNonce()).toMatch(/^[0-9a-f]{32}$/);
    });

    it('make localStorage a working in-memory store where access throws', () => {
      const standIns = standInsFor();
      const view = createView();
      expect(errorName(() => view.win.localStorage)).toBe('SecurityError');

      view.run(standIns);
      const local = view.storage('localStorage');
      expect(local.length).toBe(0);
      expect(local.getItem('missing')).toBeNull();

      local.setItem('a', '1');
      local.setItem('b', 'two');
      expect(local.getItem('a')).toBe('1');
      expect(local.length).toBe(2);
      expect(local.key(0)).toBe('a');
      expect(local.key(1)).toBe('b');
      expect(local.key(2)).toBeNull();
      expect(local.key(-1)).toBeNull();
      expect(view.storage('localStorage')).toBe(local);

      local.setItem('a', '3');
      expect(local.getItem('a')).toBe('3');
      expect(local.length).toBe(2);

      local.removeItem('a');
      expect(local.getItem('a')).toBeNull();
      expect(local.length).toBe(1);
      local.removeItem('a');
      expect(local.length).toBe(1);

      local.clear();
      expect(local.length).toBe(0);
      expect(local.key(0)).toBeNull();
    });

    it('store values as strings, and treat prototype names as plain keys', () => {
      const view = createView();
      view.run(standInsFor());
      const local = view.storage('localStorage');
      local.setItem('count', 5 as unknown as string);
      expect(local.getItem('count')).toBe('5');
      local.setItem('constructor', 'x');
      local.setItem('__proto__', 'y');
      expect(local.getItem('constructor')).toBe('x');
      expect(local.getItem('__proto__')).toBe('y');
      expect(local.getItem('toString')).toBeNull();
      expect(local.length).toBe(3);
    });

    it('keep sessionStorage separate from localStorage', () => {
      const view = createView();
      view.run(standInsFor());
      const local = view.storage('localStorage');
      const session = view.storage('sessionStorage');
      expect(session).not.toBe(local);

      local.setItem('k', 'local');
      session.setItem('k', 'session');
      session.setItem('only-session', '1');
      expect(local.getItem('k')).toBe('local');
      expect(session.getItem('k')).toBe('session');
      expect(local.getItem('only-session')).toBeNull();
      expect(local.length).toBe(1);
      expect(session.length).toBe(2);

      session.clear();
      expect(local.getItem('k')).toBe('local');
      expect(session.length).toBe(0);
    });

    it('make document.cookie an in-memory jar: set, read, overwrite and join with "; "', () => {
      const view = createView();
      expect(errorName(() => view.doc.cookie)).toBe('SecurityError');

      view.run(standInsFor());
      expect(view.doc.cookie).toBe('');
      view.doc.cookie = 'a=1; path=/; SameSite=Lax';
      expect(view.doc.cookie).toBe('a=1');
      view.doc.cookie = 'b=two=parts';
      expect(view.doc.cookie).toBe('a=1; b=two=parts');
      view.doc.cookie = 'a=changed';
      expect(view.doc.cookie).toBe('a=changed; b=two=parts');
      view.doc.cookie = '=nameless';
      view.doc.cookie = 'justtext';
      expect(view.doc.cookie).toBe('a=changed; b=two=parts');
    });

    it('delete a cookie on max-age of zero or less, or an expiry in the past', () => {
      const view = createView();
      view.run(standInsFor());
      view.doc.cookie = 'a=1';
      view.doc.cookie = 'b=2';
      view.doc.cookie = 'c=3';
      view.doc.cookie = 'd=4; max-age=3600';
      view.doc.cookie = 'e=5; expires=Fri, 01 Jan 2100 00:00:00 GMT';
      expect(view.doc.cookie).toBe('a=1; b=2; c=3; d=4; e=5');

      view.doc.cookie = 'a=; max-age=0';
      view.doc.cookie = 'b=; Max-Age=-1; path=/';
      view.doc.cookie = 'c=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
      expect(view.doc.cookie).toBe('d=4; e=5');

      view.doc.cookie = 'missing=; max-age=0';
      expect(view.doc.cookie).toBe('d=4; e=5');
    });

    it('let an App that reads cookies and storage without a guard run to the end', () => {
      const app = `
        var seen = [document.cookie, window.localStorage.getItem('theme'), window.sessionStorage.length];
        window.localStorage.setItem('theme', 'dark');
        seen.push(window.localStorage.getItem('theme'));
        return seen.join('|');
      `;
      const without = createView();
      expect(errorName(() => without.run(app))).toBe('SecurityError');

      const view = createView();
      view.run(standInsFor());
      expect(view.run(app)).toBe('||0|dark');
    });

    it('leave localStorage, sessionStorage and the cookie accessor alone where they work', () => {
      const view = createView([]);
      const before = {
        local: Object.getOwnPropertyDescriptor(view.win, 'localStorage'),
        session: Object.getOwnPropertyDescriptor(view.win, 'sessionStorage'),
        cookie: view.cookieDescriptor(),
      };

      view.run(standInsFor());

      expect(Object.getOwnPropertyDescriptor(view.win, 'localStorage')).toEqual(before.local);
      expect(Object.getOwnPropertyDescriptor(view.win, 'sessionStorage')).toEqual(before.session);
      expect(view.cookieDescriptor()).toEqual(before.cookie);
      expect(view.cookieDescriptor()?.get).toBe(before.cookie?.get);
      expect(view.cookieDescriptor()?.set).toBe(before.cookie?.set);
      expect(view.win.localStorage).toBe(view.native.localStorage);
      expect(view.win.sessionStorage).toBe(view.native.sessionStorage);
      expect(view.doc.cookie).toBe('native=1');
      view.doc.cookie = 'x=1';
      expect(view.cookieWrites).toEqual(['x=1']);
    });

    it('replace only what throws', () => {
      const view = createView(['localStorage']);
      view.run(standInsFor());

      view.storage('localStorage').setItem('k', 'v');
      expect(view.storage('localStorage').getItem('k')).toBe('v');
      expect(view.win.sessionStorage).toBe(view.native.sessionStorage);
      expect(view.doc.cookie).toBe('native=1');

      const cookieOnly = createView(['cookie']);
      cookieOnly.run(standInsFor());
      cookieOnly.doc.cookie = 'k=v';
      expect(cookieOnly.doc.cookie).toBe('k=v');
      expect(cookieOnly.win.localStorage).toBe(cookieOnly.native.localStorage);
      expect(cookieOnly.win.sessionStorage).toBe(cookieOnly.native.sessionStorage);
    });

    it('leave indexedDB alone', () => {
      const view = createView();
      view.run(standInsFor());
      expect(errorName(() => view.win.indexedDB)).toBe('SecurityError');
    });

    it('give every View stores of its own, and keep them when run again', () => {
      const standIns = standInsFor();
      const first = createView();
      const second = createView();
      first.run(standIns);
      second.run(standIns);

      first.storage('localStorage').setItem('k', 'v');
      first.doc.cookie = 'c=1';
      expect(second.storage('localStorage').getItem('k')).toBeNull();
      expect(second.doc.cookie).toBe('');

      // A second run finds working stores, so it keeps the ones already in place.
      first.run(standIns);
      expect(first.storage('localStorage').getItem('k')).toBe('v');
      expect(first.doc.cookie).toBe('c=1');
    });

    it('do not throw when a property cannot be redefined', () => {
      const view = createView();
      Object.defineProperty(view.win, 'localStorage', {
        configurable: false,
        get: () => {
          throw securityError('localStorage');
        },
      });
      expect(() => view.run(standInsFor())).not.toThrow();

      expect(errorName(() => view.win.localStorage)).toBe('SecurityError');
      view.storage('sessionStorage').setItem('k', 'v');
      expect(view.storage('sessionStorage').getItem('k')).toBe('v');
      view.doc.cookie = 'c=1';
      expect(view.doc.cookie).toBe('c=1');
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

    it('invalidates every load and requires a fresh bootstrap challenge response', () => {
      const sandbox = loadSandbox();
      sandbox.deliverResource();
      sandbox.attest();
      sandbox.loadFrame();
      const challenge = sandbox.innerPosts().at(-1)?.params?.challenge;
      const forwarded = () => sandbox.innerPosts().filter((msg) => msg.id === HOST_REQUEST.id);
      sandbox.fromParent(HOST_REQUEST);
      sandbox.attest(); // A queued heartbeat from the old realm cannot restore authority.
      expect(forwarded()).toHaveLength(0);
      sandbox.fromInner({
        jsonrpc: '2.0',
        method: ATTEST,
        params: { nonce: sandbox.bootstrapNonce(), challenge },
      });
      expect(forwarded()).toHaveLength(1);
      sandbox.loadFrame();
      sandbox.fromParent(HOST_REQUEST);
      sandbox.fromInner({
        jsonrpc: '2.0',
        method: ATTEST,
        params: { nonce: sandbox.bootstrapNonce(), challenge },
      });
      expect(forwarded()).toHaveLength(1);
      const nextChallenge = sandbox
        .innerPosts()
        .filter((msg) => msg.method === 'ui/notifications/sandbox-frame-challenge')
        .at(-1)?.params?.challenge;
      sandbox.fromInner({
        jsonrpc: '2.0',
        method: ATTEST,
        params: { nonce: sandbox.bootstrapNonce(), challenge: nextChallenge },
      });
      expect(forwarded()).toHaveLength(2);
      expect(sandbox.frame()).not.toBeNull();
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
