import {
  defaultBounds,
  mirrorDocumentStyles,
  mirrorDocumentTheme,
  openUndockedWindow,
  parseBounds,
  persistBounds,
  prepareUndockedDocument,
  relayFrameMessages,
  UNDOCKED_ARTIFACTS_BOUNDS_KEY,
} from '../undockedWindow';

const detachedDocument = () => document.implementation.createHTMLDocument('detached');

/**
 * A browser that denies Web Storage throws from the `localStorage` getter
 * itself, not from `getItem`. Undocking has to fall back to default bounds,
 * and docking back — which runs through the same persistence — has to finish,
 * or the pane is stranded in a window with no way home.
 */
const windowWithDeniedStorage = (overrides: Partial<Window> = {}) => {
  const denied = {
    screen: { availWidth: 1600, availHeight: 1000 },
    outerWidth: 1200,
    outerHeight: 900,
    screenX: 0,
    screenY: 0,
    open: jest.fn(() => ({ focus: jest.fn() })),
    ...overrides,
  };
  Object.defineProperty(denied, 'localStorage', {
    get() {
      throw new DOMException('denied', 'SecurityError');
    },
  });
  return denied as unknown as Window;
};

describe('undocking when the browser denies storage', () => {
  it('opens the window at the default bounds instead of throwing', () => {
    const source = windowWithDeniedStorage();

    const opened = openUndockedWindow(source);

    expect(opened).not.toBeNull();
    const features = (source.open as jest.Mock).mock.calls[0][2] as string;
    const { width, height } = defaultBounds(source);
    expect(features).toContain(`width=${width}`);
    expect(features).toContain(`height=${height}`);
  });

  it('lets the redock and teardown path finish without remembering bounds', () => {
    const detached = {
      outerWidth: 900,
      outerHeight: 700,
      screenX: 120,
      screenY: 40,
    } as unknown as Window;

    expect(() => persistBounds(detached, windowWithDeniedStorage())).not.toThrow();
  });

  it('still remembers the bounds when storage is available', () => {
    const detached = {
      outerWidth: 900,
      outerHeight: 700,
      screenX: 120,
      screenY: 40,
    } as unknown as Window;

    persistBounds(detached, window);

    expect(window.localStorage.getItem(UNDOCKED_ARTIFACTS_BOUNDS_KEY)).toBe(
      JSON.stringify({ width: 900, height: 700, left: 120, top: 40 }),
    );
  });
});

describe('parseBounds', () => {
  it('keeps a window that was left on a monitor at negative coordinates', () => {
    expect(parseBounds(JSON.stringify({ width: 900, height: 700, left: -1720, top: -80 }))).toEqual(
      {
        width: 900,
        height: 700,
        left: -1720,
        top: -80,
      },
    );
  });

  it('refuses to reopen a window too small to use', () => {
    expect(parseBounds(JSON.stringify({ width: 10, height: 10, left: 0, top: 0 }))).toEqual({
      width: 520,
      height: 480,
      left: 0,
      top: 0,
    });
  });

  it.each([
    ['nothing stored', null],
    ['not json', '{oops'],
    ['a partial record', JSON.stringify({ width: 900, height: 700 })],
    ['a non-numeric field', JSON.stringify({ width: '900', height: 700, left: 0, top: 0 })],
  ])('falls back when storage holds %s', (_label, raw) => {
    expect(parseBounds(raw)).toBeNull();
  });
});

/**
 * Remembered coordinates outlive the monitor arrangement that produced them,
 * and undocking takes the pane — and the only Dock control — out of this page.
 * A window put where nothing can reach it is the one failure the remembered
 * bounds must never cause.
 */
describe('reopening at remembered bounds', () => {
  const sourceOn = (screen: Record<string, unknown>) =>
    ({
      screen,
      outerWidth: 1200,
      outerHeight: 900,
      screenX: 0,
      screenY: 0,
      localStorage: {
        getItem: () => JSON.stringify({ width: 900, height: 700, left: -1720, top: -80 }),
      },
      open: jest.fn(() => ({ focus: jest.fn() })),
    }) as unknown as Window;

  const openedFeatures = (source: Window) => {
    openUndockedWindow(source);
    return (source.open as jest.Mock).mock.calls[0][2] as string;
  };

  it('ignores a monitor that is no longer attached', () => {
    const source = sourceOn({
      availWidth: 1600,
      availHeight: 1000,
      availLeft: 0,
      availTop: 0,
      isExtended: false,
    });

    const features = openedFeatures(source);

    const fallback = defaultBounds(source);
    expect(features).toContain(`left=${fallback.left}`);
    expect(features).toContain(`top=${fallback.top}`);
  });

  it('keeps the placement while a second display is attached', () => {
    const features = openedFeatures(
      sourceOn({
        availWidth: 1600,
        availHeight: 1000,
        availLeft: 0,
        availTop: 0,
        isExtended: true,
      }),
    );

    expect(features).toContain('left=-1720');
    expect(features).toContain('top=-80');
  });

  it('keeps the placement when the browser does not report other displays', () => {
    const features = openedFeatures({
      screen: { availWidth: 1600, availHeight: 1000 },
      outerWidth: 1200,
      outerHeight: 900,
      screenX: 0,
      screenY: 0,
      localStorage: {
        getItem: () => JSON.stringify({ width: 900, height: 700, left: -1720, top: -80 }),
      },
      open: jest.fn(() => ({ focus: jest.fn() })),
    } as unknown as Window);

    expect(features).toContain('left=-1720');
  });

  it('keeps a placement that still overlaps this display', () => {
    const source = {
      screen: {
        availWidth: 1600,
        availHeight: 1000,
        availLeft: 0,
        availTop: 0,
        isExtended: false,
      },
      outerWidth: 1200,
      outerHeight: 900,
      screenX: 0,
      screenY: 0,
      localStorage: {
        getItem: () => JSON.stringify({ width: 900, height: 700, left: 640, top: 120 }),
      },
      open: jest.fn(() => ({ focus: jest.fn() })),
    } as unknown as Window;

    const features = openedFeatures(source);

    expect(features).toContain('left=640');
    expect(features).toContain('top=120');
  });
});

describe('mirrorDocumentStyles', () => {
  let host: HTMLStyleElement;
  let link: HTMLLinkElement;

  beforeEach(() => {
    jest.useFakeTimers();
    host = document.createElement('style');
    host.textContent = '.mirrored { color: red; }';
    link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/assets/app.css';
    document.head.append(host, link);
  });

  afterEach(() => {
    jest.useRealTimers();
    document.head.querySelectorAll('style, link').forEach((node) => node.remove());
  });

  it('mirrors the host stylesheets into the detached document', () => {
    const target = detachedDocument();

    const stop = mirrorDocumentStyles(document, target);

    expect(target.head.querySelector('style')?.textContent).toContain('.mirrored');
    expect(target.head.querySelector('style')?.textContent).toContain('color: red');
    expect(target.head.querySelector('link')?.href).toContain('/assets/app.css');

    stop();
    expect(target.head.querySelector('style')).toBeNull();
    expect(target.head.querySelector('link')).toBeNull();
  });

  it('picks up a stylesheet added after the window opened', async () => {
    const target = detachedDocument();
    const stop = mirrorDocumentStyles(document, target);

    const lazyChunkStyle = document.createElement('style');
    lazyChunkStyle.textContent = '.lazy { color: blue; }';
    document.head.appendChild(lazyChunkStyle);
    await Promise.resolve();

    expect(target.head.textContent).toContain('.lazy');
    expect(target.head.textContent).toContain('color: blue');
    stop();
  });

  /* A rewrite that keeps the text length and the rule count is invisible to
   * any cheap signature, so the mutation record has to drive the refresh. */
  it('mirrors a rewrite that changes no measurable shape', async () => {
    const target = detachedDocument();
    const stop = mirrorDocumentStyles(document, target);

    host.textContent = '.mirrored { color: RED; }'.replace('RED', 'tan');
    await Promise.resolve();

    expect(target.head.textContent).toContain('color: tan');
    expect(target.head.textContent).not.toContain('color: red');
    stop();
  });

  /* Monaco writes its dynamic rules straight into the CSSOM, which mutates no
   * node: only the periodic re-check can notice them. */
  it('mirrors rules inserted through the CSSOM', () => {
    const target = detachedDocument();
    const dynamic = document.createElement('style');
    document.head.appendChild(dynamic);
    const stop = mirrorDocumentStyles(document, target);

    dynamic.sheet?.insertRule('.inserted { color: green; }', 0);
    jest.advanceTimersByTime(1000);

    expect(target.head.textContent).toContain('.inserted');
    stop();
  });
});

describe('mirrorDocumentTheme', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.className = '';
    document.documentElement.removeAttribute('style');
  });

  it('follows the host theme while the window is open', () => {
    document.documentElement.className = 'dark';
    document.documentElement.dataset.theme = 'midnight';
    document.documentElement.style.setProperty('--surface-primary', '13 13 13');
    const target = detachedDocument();

    const stop = mirrorDocumentTheme(document, target);
    expect(target.documentElement.className).toBe('dark');
    expect(target.documentElement.dataset.theme).toBe('midnight');
    expect(target.documentElement.style.getPropertyValue('--surface-primary')).toBe('13 13 13');

    document.documentElement.className = 'light high-contrast';
    document.documentElement.removeAttribute('data-theme');

    return Promise.resolve().then(() => {
      expect(target.documentElement.className).toBe('light high-contrast');
      expect(target.documentElement.hasAttribute('data-theme')).toBe(false);
      stop();
    });
  });
});

describe('relayFrameMessages', () => {
  it('re-dispatches frame messages on the host window with their source intact', () => {
    const detached = { addEventListener: jest.fn(), removeEventListener: jest.fn() };
    const stop = relayFrameMessages(window, detached as unknown as Window);
    const relay = detached.addEventListener.mock.calls[0][1] as (event: MessageEvent) => void;

    const received: MessageEvent[] = [];
    const listener = (event: Event) => received.push(event as MessageEvent);
    window.addEventListener('message', listener);

    const frameWindow = {} as Window;
    relay(
      new MessageEvent('message', {
        data: { codesandbox: true, type: 'initialize' },
        source: frameWindow,
        origin: 'https://bundler.example',
      }),
    );

    expect(received).toHaveLength(1);
    expect(received[0].data).toEqual({ codesandbox: true, type: 'initialize' });
    expect(received[0].source).toBe(frameWindow);
    expect(received[0].origin).toBe('https://bundler.example');

    /* The popup's own messages must not bounce back into the host. */
    relay(new MessageEvent('message', { data: 'noise', source: detached as unknown as Window }));
    expect(received).toHaveLength(1);

    window.removeEventListener('message', listener);
    stop();
    expect(detached.removeEventListener).toHaveBeenCalled();
  });
});

describe('prepareUndockedDocument', () => {
  it('gives the popup a portal root and a base URL to resolve assets against', () => {
    const target = detachedDocument();

    const root = prepareUndockedDocument(document, target);

    expect(root.parentElement).toBe(target.body);
    expect(target.body.children).toHaveLength(1);
    expect(target.head.querySelector('base')?.href).toBe(document.baseURI);
  });
});
