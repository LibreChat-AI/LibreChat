import {
  mirrorDocumentStyles,
  mirrorDocumentTheme,
  parseBounds,
  prepareUndockedDocument,
  relayFrameMessages,
} from '../undockedWindow';

const detachedDocument = () => document.implementation.createHTMLDocument('detached');

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

    expect(target.head.querySelector('style')?.textContent).toBe('.mirrored { color: red; }');
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

    expect(target.head.textContent).toContain('.lazy { color: blue; }');
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
