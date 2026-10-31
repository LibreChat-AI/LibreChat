import { JSDOM } from 'jsdom';
import type { DOMWindow } from 'jsdom';
import { _internal } from './html';

/**
 * Options `pptxPreview.init` is called with, captured by the fake below so
 * tests can assert what the bootstrap script actually passed at runtime.
 */
interface FakePptxPreviewInitOptions {
  width: number;
  height?: number;
}

/** How the fake previewer's `preview()` call resolves/rejects. */
type PreviewBehavior =
  | 'resolve'
  | 'reject'
  | 'resolveNoSlides'
  | 'resolveEmptyWrappers'
  | 'neverResolve';

interface RenderPptxLayoutOptions {
  /** height = width * ratio for every rendered slide; default 0.5625 (16:9). */
  slideAspectRatio?: number;
  /** Whether the fake `pptxPreview` global is installed at all; default true. */
  installRenderer?: boolean;
  /** How the fake previewer's `preview()` call behaves; default 'resolve'. */
  preview?: PreviewBehavior;
  /** Intercept the bootstrap's 8s safety-net timer instead of letting it
   *  schedule on the real clock; default false. */
  captureSafetyNet?: boolean;
}

interface RenderPptxLayoutResult {
  window: DOMWindow;
  document: Document;
  initializationOptions?: FakePptxPreviewInitOptions;
  /** Changes what `#lc-render`'s stubbed `clientWidth` reports on the next read. */
  setRenderSlotWidth: (width: number) => void;
  /** Fires the captured 8s safety-net timer (only valid when `captureSafetyNet: true`). */
  fireSafetyNet: () => void;
}

/**
 * Runs the actual `<script>` `pptxToHtmlViaCdn` emits inside JSDOM, against
 * a fake `pptxPreview` global that mirrors the pinned librarys DOM shape:
 * `init` creates one `.pptx-preview-wrapper` box (with the librarys own
 * inline width/background, and — only when a `height` option is passed —
 * a fixed inline height with `overflow-y: auto`), and `preview` populates
 * it with `.pptx-preview-slide-wrapper` children at their native size.
 * Exercises the real wrapping logic end to end rather than pattern-matching
 * the source text.
 */
async function renderPptxLayout(
  slideCount: number,
  renderSlotWidth: number,
  options: RenderPptxLayoutOptions = {},
): Promise<RenderPptxLayoutResult> {
  const {
    slideAspectRatio = 0.5625,
    installRenderer = true,
    preview = 'resolve',
    captureSafetyNet = false,
  } = options;

  const html = await _internal.pptxToHtmlViaCdn(
    Buffer.from('fixture'),
    '<ol class="lc-pptx-list"><li>fallback</li></ol>',
  );

  let initializationOptions: FakePptxPreviewInitOptions | undefined;
  let currentRenderSlotWidth = renderSlotWidth;
  let safetyNetCallback: (() => void) | undefined;

  const { window } = new JSDOM(html, {
    runScripts: 'dangerously',
    beforeParse(parsedWindow) {
      // JSDOM never computes real layout, so `clientWidth` is stubbed
      // directly on the render slot the bootstrap reads panel width from.
      Object.defineProperty(parsedWindow.HTMLElement.prototype, 'clientWidth', {
        configurable: true,
        get(this: HTMLElement) {
          return this.id === 'lc-render' ? currentRenderSlotWidth : 0;
        },
      });
      // JSDOM has no layout engine either, so `offsetWidth`/`offsetHeight`
      // are always 0 — stub them to reflect the inline size the fake
      // `preview()` sets on each slide, which is what `wrapSlides()` reads
      // to cache a slide's native (pre-scale) dimensions.
      Object.defineProperty(parsedWindow.HTMLElement.prototype, 'offsetWidth', {
        configurable: true,
        get(this: HTMLElement) {
          return Number.parseFloat(this.style.width) || 0;
        },
      });
      Object.defineProperty(parsedWindow.HTMLElement.prototype, 'offsetHeight', {
        configurable: true,
        get(this: HTMLElement) {
          return Number.parseFloat(this.style.height) || 0;
        },
      });
      if (captureSafetyNet) {
        // Capture the 8s safety-net timer instead of letting it run on the
        // real clock, so the test can fire it deterministically.
        Object.defineProperty(parsedWindow, 'setTimeout', {
          configurable: true,
          writable: true,
          value: (handler: () => void, timeout?: number) => {
            if (timeout === 8000) {
              safetyNetCallback = handler;
            }
            return 0;
          },
        });
      }
      if (!installRenderer) {
        return;
      }
      Object.assign(parsedWindow, {
        pptxPreview: {
          init(container: HTMLElement, initOptions: FakePptxPreviewInitOptions) {
            initializationOptions = initOptions;
            const wrapper = parsedWindow.document.createElement('div');
            wrapper.className = 'pptx-preview-wrapper';
            wrapper.style.width = `${initOptions.width}px`;
            wrapper.style.background = '#000';
            wrapper.style.margin = '0 auto';
            if (initOptions.height != null) {
              wrapper.style.height = `${initOptions.height}px`;
              wrapper.style.overflowY = 'auto';
            }
            container.appendChild(wrapper);
            return {
              preview(): Promise<{ slides: unknown[] }> {
                if (preview === 'reject') {
                  return Promise.reject(new Error('fake-render-error'));
                }
                if (preview === 'resolveNoSlides') {
                  return Promise.resolve({ slides: [] });
                }
                if (preview === 'neverResolve') {
                  return new Promise<{ slides: unknown[] }>(() => {});
                }
                const emptyWrappers = preview === 'resolveEmptyWrappers';
                for (let index = 0; index < slideCount; index += 1) {
                  const slide = parsedWindow.document.createElement('div');
                  slide.className = 'pptx-preview-slide-wrapper';
                  slide.style.width = `${initOptions.width}px`;
                  slide.style.height = `${initOptions.width * slideAspectRatio}px`;
                  slide.style.position = 'relative';
                  slide.style.margin = '0px auto 10px';
                  if (!emptyWrappers) {
                    slide.textContent = `Slide ${index + 1}`;
                  }
                  wrapper.appendChild(slide);
                }
                return Promise.resolve({ slides: new Array(slideCount).fill({}) });
              },
            };
          },
        },
      });
    },
  });

  // Flushes the `previewer.preview(...).then(finalize)` microtask queued
  // by the synchronous script execution above.
  await new Promise((resolve) => setTimeout(resolve, 0));

  if (installRenderer && !initializationOptions) {
    throw new Error('pptxPreview.init was not called');
  }

  return {
    window,
    document: window.document,
    initializationOptions,
    setRenderSlotWidth: (width: number) => {
      currentRenderSlotWidth = width;
    },
    fireSafetyNet: () => {
      if (!safetyNetCallback) {
        throw new Error('safety-net setTimeout was not captured');
      }
      safetyNetCallback();
    },
  };
}

describe('pptx CDN bootstrap — slide layout', () => {
  it.each([
    [3, 500],
    [2, 1200],
  ])(
    'wraps every one of %i slides as its own panel-width block (panel %ipx)',
    async (slideCount, renderSlotWidth) => {
      const { document } = await renderPptxLayout(slideCount, renderSlotWidth);
      const wraps = Array.from(document.querySelectorAll('.lc-slide-wrap'));
      expect(wraps).toHaveLength(slideCount);
      const expectedWidth = `${renderSlotWidth - 32}px`;
      wraps.forEach((wrap) => {
        expect(wrap.querySelectorAll('.pptx-preview-slide-wrapper')).toHaveLength(1);
        expect((wrap as HTMLElement).style.width).toBe(expectedWidth);
      });
    },
  );

  test('each slide wrap sits directly under the library box, not nested inside one shared wrap', async () => {
    const { document } = await renderPptxLayout(4, 640);
    const libraryBox = document.querySelector('.pptx-preview-wrapper');
    expect(libraryBox).not.toBeNull();
    const directChildren = Array.from(libraryBox!.children);
    expect(directChildren).toHaveLength(4);
    directChildren.forEach((child) => {
      expect(child.classList.contains('lc-slide-wrap')).toBe(true);
    });
  });

  test('initializes pptx-preview with only a width, never a fixed height', async () => {
    const { initializationOptions } = await renderPptxLayout(1, 800);
    expect(initializationOptions).toEqual({ width: 960 });
  });

  test('does not re-wrap an already-wrapped slide when the 8s safety net fires before preview() resolves', async () => {
    /* previewer.preview() can still be pending when the safety-net timer
     * fires (its bundled deps can take a while after appending slide
     * nodes). If both paths call finalize() unguarded, the slide gets
     * wrapped twice, nesting .lc-slide-wrap inside .lc-slide-wrap. */
    const html = await _internal.pptxToHtmlViaCdn(
      Buffer.from('fixture'),
      '<ol class="lc-pptx-list"><li>fallback</li></ol>',
    );

    let safetyNetCallback: (() => void) | undefined;
    let resolvePreview: ((value: { slides: unknown[] }) => void) | undefined;
    const { window } = new JSDOM(html, {
      runScripts: 'dangerously',
      beforeParse(parsedWindow) {
        Object.defineProperty(parsedWindow.HTMLElement.prototype, 'clientWidth', {
          configurable: true,
          get(this: HTMLElement) {
            return this.id === 'lc-render' ? 800 : 0;
          },
        });
        // Capture the 8s safety-net timer instead of letting it run on the
        // real clock, so the test can fire it deterministically.
        Object.defineProperty(parsedWindow, 'setTimeout', {
          configurable: true,
          writable: true,
          value: (handler: () => void, timeout?: number) => {
            if (timeout === 8000) {
              safetyNetCallback = handler;
              return 0;
            }
            return 0;
          },
        });
        Object.assign(parsedWindow, {
          pptxPreview: {
            init(container: HTMLElement, options: FakePptxPreviewInitOptions) {
              const wrapper = parsedWindow.document.createElement('div');
              wrapper.className = 'pptx-preview-wrapper';
              container.appendChild(wrapper);
              return {
                preview() {
                  // Slide DOM lands synchronously, mirroring the pinned
                  // library appending nodes as it renders — but the
                  // outer promise is held open so the test can fire the
                  // safety net BEFORE it resolves.
                  const slide = parsedWindow.document.createElement('div');
                  slide.className = 'pptx-preview-slide-wrapper';
                  slide.style.width = `${options.width}px`;
                  slide.style.height = `${options.width * 0.5625}px`;
                  slide.textContent = 'Slide 1';
                  wrapper.appendChild(slide);
                  return new Promise((resolve) => {
                    resolvePreview = resolve;
                  });
                },
              };
            },
          },
        });
      },
    });

    if (!safetyNetCallback) {
      throw new Error('safety-net setTimeout was not captured');
    }
    // Safety net fires first: a slide is already in the DOM, so it calls
    // finalize() and wraps it.
    safetyNetCallback();

    // The slow preview() promise resolves after the safety net already
    // finalized — its own .then() must not wrap the same slide again.
    if (!resolvePreview) {
      throw new Error('preview() was not called');
    }
    resolvePreview({ slides: [{}] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const wraps = Array.from(window.document.querySelectorAll('.lc-slide-wrap'));
    expect(wraps).toHaveLength(1);
    expect(window.document.querySelectorAll('.lc-slide-wrap .lc-slide-wrap')).toHaveLength(0);
  });
});

describe('pptx CDN bootstrap — fits every panel width', () => {
  it.each([360, 768, 1480])(
    'fits a %ipx panel and lets the library box hug the content instead of clipping it',
    async (renderSlotWidth) => {
      const { document } = await renderPptxLayout(3, renderSlotWidth);
      const expectedWidth = `${renderSlotWidth - 32}px`;
      const wraps = Array.from(document.querySelectorAll('.lc-slide-wrap')) as HTMLElement[];
      expect(wraps).toHaveLength(3);
      wraps.forEach((wrap) => {
        expect(wrap.style.width).toBe(expectedWidth);
      });

      const libraryBox = document.querySelector('.pptx-preview-wrapper') as HTMLElement;
      expect(libraryBox).not.toBeNull();
      // The librarys own init() sets a fixed inline width + opaque
      // background; JSDOMs getComputedStyle doesnt apply the stylesheets
      // `!important` override over that inline style (unlike a real
      // browser), so this asserts directly on what the bootstrap script
      // must clear once slides are wrapped. A library box still carrying
      // a fixed px width here would be wider than a narrow panels content
      // box (360-32=328px and 768-32=736px are both under the librarys
      // 960px default), clipping the stacked slides.
      expect(libraryBox.style.width).toBe('auto');
      expect(libraryBox.style.background).toBe('transparent');
    },
  );
});

describe('pptx CDN bootstrap — no inner scroll box for a long deck', () => {
  test('30 slides stack in order with no nested scroll region', async () => {
    const { document, window } = await renderPptxLayout(30, 768);
    const wraps = Array.from(document.querySelectorAll('.lc-slide-wrap')) as HTMLElement[];
    expect(wraps).toHaveLength(30);
    wraps.forEach((wrap, index) => {
      const slide = wrap.querySelector('.pptx-preview-slide-wrapper');
      expect(slide?.textContent).toBe(`Slide ${index + 1}`);
    });

    const renderRoot = document.getElementById('lc-render') as HTMLElement;
    const descendants = Array.from(renderRoot.querySelectorAll('*')) as HTMLElement[];
    descendants.forEach((element) => {
      const computed = window.getComputedStyle(element);
      const hasFixedPxHeight = /^\d/.test(element.style.height) || /^\d/.test(computed.height);
      const hasScrollOverflowY =
        ['auto', 'scroll'].includes(element.style.overflowY) ||
        ['auto', 'scroll'].includes(computed.overflowY);
      expect(hasFixedPxHeight && hasScrollOverflowY).toBe(false);
    });

    const libraryBox = document.querySelector('.pptx-preview-wrapper') as HTMLElement;
    expect(libraryBox.style.height).toBe('');
  });
});

describe('pptx CDN bootstrap — refits on panel resize', () => {
  test('every slide block refits when the render slot is resized', async () => {
    const { document, window, setRenderSlotWidth } = await renderPptxLayout(2, 1480);
    let wraps = Array.from(document.querySelectorAll('.lc-slide-wrap')) as HTMLElement[];
    wraps.forEach((wrap) => {
      expect(wrap.style.width).toBe('1448px');
    });

    setRenderSlotWidth(360);
    window.dispatchEvent(new window.Event('resize'));
    wraps = Array.from(document.querySelectorAll('.lc-slide-wrap')) as HTMLElement[];
    wraps.forEach((wrap) => {
      expect(wrap.style.width).toBe('328px');
      const height = Number.parseFloat(wrap.style.height);
      expect(Math.abs(height - 328 * 0.5625)).toBeLessThanOrEqual(0.5);
    });

    setRenderSlotWidth(768);
    window.dispatchEvent(new window.Event('resize'));
    wraps = Array.from(document.querySelectorAll('.lc-slide-wrap')) as HTMLElement[];
    wraps.forEach((wrap) => {
      expect(wrap.style.width).toBe('736px');
    });
  });
});

describe('pptx CDN bootstrap — keeps each slides native aspect ratio', () => {
  it.each([
    [0.75, '4:3'],
    [0.5625, '16:9'],
  ])('scales a %s deck without distorting it', async (ratio) => {
    const { document } = await renderPptxLayout(2, 768, { slideAspectRatio: ratio });
    const wraps = Array.from(document.querySelectorAll('.lc-slide-wrap')) as HTMLElement[];
    expect(wraps).toHaveLength(2);
    wraps.forEach((wrap) => {
      const width = Number.parseFloat(wrap.style.width);
      const height = Number.parseFloat(wrap.style.height);
      expect(height / width).toBeCloseTo(ratio, 2);
    });
  });
});

describe('pptx CDN bootstrap — falls back to the slide list', () => {
  test('the pptxPreview global is missing', async () => {
    const { document } = await renderPptxLayout(2, 768, { installRenderer: false });
    const fallback = document.getElementById('lc-fallback') as HTMLElement;
    const render = document.getElementById('lc-render') as HTMLElement;
    expect(fallback.hidden).toBe(false);
    expect(render.hidden).toBe(true);
  });

  test('the renderer throws (preview() rejects)', async () => {
    const { document } = await renderPptxLayout(2, 768, { preview: 'reject' });
    const fallback = document.getElementById('lc-fallback') as HTMLElement;
    const render = document.getElementById('lc-render') as HTMLElement;
    expect(fallback.hidden).toBe(false);
    expect(render.hidden).toBe(true);
  });

  test('the renderer resolves with no slides', async () => {
    const { document } = await renderPptxLayout(0, 768, { preview: 'resolveNoSlides' });
    const fallback = document.getElementById('lc-fallback') as HTMLElement;
    const render = document.getElementById('lc-render') as HTMLElement;
    expect(fallback.hidden).toBe(false);
    expect(render.hidden).toBe(true);
  });

  test('the renderer resolves slides but every slide wrapper is empty', async () => {
    const { document } = await renderPptxLayout(2, 768, { preview: 'resolveEmptyWrappers' });
    const fallback = document.getElementById('lc-fallback') as HTMLElement;
    const render = document.getElementById('lc-render') as HTMLElement;
    expect(fallback.hidden).toBe(false);
    expect(render.hidden).toBe(true);
  });

  test('the 8s safety net fires with nothing rendered', async () => {
    const { document, fireSafetyNet } = await renderPptxLayout(2, 768, {
      preview: 'neverResolve',
      captureSafetyNet: true,
    });
    fireSafetyNet();
    const fallback = document.getElementById('lc-fallback') as HTMLElement;
    const render = document.getElementById('lc-render') as HTMLElement;
    expect(fallback.hidden).toBe(false);
    expect(render.hidden).toBe(true);
  });
});

describe('pptx CDN bootstrap — spacing between stacked slide blocks', () => {
  test('restores the 16px rhythm that #lc-render gap no longer provides once slides live inside the library box', async () => {
    const { document, window } = await renderPptxLayout(3, 768);
    const wraps = Array.from(document.querySelectorAll('.lc-slide-wrap')) as HTMLElement[];
    expect(wraps).toHaveLength(3);
    expect(window.getComputedStyle(wraps[1]).marginTop).toBe('16px');
    expect(window.getComputedStyle(wraps[2]).marginTop).toBe('16px');
  });
});

describe('pptx CDN bootstrap — pins each slide to its blocks left edge', () => {
  it.each([1480, 1200])(
    'clears the librarys auto-centering margin on a %ipx panel',
    async (renderSlotWidth) => {
      const { document } = await renderPptxLayout(2, renderSlotWidth);
      const wraps = Array.from(document.querySelectorAll('.lc-slide-wrap')) as HTMLElement[];
      expect(wraps).toHaveLength(2);
      wraps.forEach((wrap) => {
        const slide = wrap.querySelector('.pptx-preview-slide-wrapper') as HTMLElement;
        expect(slide.style.marginLeft).toBe('0px');
      });
    },
  );

  test('stays pinned after a live resize from 768 to 1480', async () => {
    const { document, window, setRenderSlotWidth } = await renderPptxLayout(2, 768);
    setRenderSlotWidth(1480);
    window.dispatchEvent(new window.Event('resize'));
    const wraps = Array.from(document.querySelectorAll('.lc-slide-wrap')) as HTMLElement[];
    expect(wraps).toHaveLength(2);
    wraps.forEach((wrap) => {
      const slide = wrap.querySelector('.pptx-preview-slide-wrapper') as HTMLElement;
      expect(slide.style.marginLeft).toBe('0px');
    });
  });
});

describe('pptx CDN bootstrap — reserves the scrollbar gutter', () => {
  test('the root element reserves scrollbar space so its appearance never changes the content width', async () => {
    const html = await _internal.pptxToHtmlViaCdn(
      Buffer.from('fixture'),
      '<ol class="lc-pptx-list"><li>fallback</li></ol>',
    );
    const { window } = new JSDOM(html);
    const gutter = window
      .getComputedStyle(window.document.documentElement)
      .getPropertyValue('scrollbar-gutter');
    expect(gutter).toBe('stable');
  });
});
