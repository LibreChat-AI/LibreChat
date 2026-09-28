import { JSDOM } from 'jsdom';
import { _internal } from './html';

/**
 * Options `pptxPreview.init` is called with, captured by the fake below so
 * tests can assert what the bootstrap script actually passed at runtime.
 */
interface FakePptxPreviewInitOptions {
  width: number;
  height?: number;
}

/**
 * Runs the actual `<script>` `pptxToHtmlViaCdn` emits inside JSDOM, against
 * a fake `pptxPreview` global that mirrors the pinned librarys DOM shape:
 * `init` creates one `.pptx-preview-wrapper` box, and `preview` populates it
 * with `.pptx-preview-slide-wrapper` children. Exercises the real wrapping
 * logic end to end rather than pattern-matching the source text.
 */
async function renderPptxLayout(
  slideCount: number,
  renderSlotWidth: number,
): Promise<{ document: Document; initializationOptions: FakePptxPreviewInitOptions }> {
  const html = await _internal.pptxToHtmlViaCdn(
    Buffer.from('fixture'),
    '<ol class="lc-pptx-list"><li>fallback</li></ol>',
  );

  let initializationOptions: FakePptxPreviewInitOptions | undefined;
  const { window } = new JSDOM(html, {
    runScripts: 'dangerously',
    beforeParse(parsedWindow) {
      // JSDOM never computes real layout, so `clientWidth` is stubbed
      // directly on the render slot the bootstrap reads panel width from.
      Object.defineProperty(parsedWindow.HTMLElement.prototype, 'clientWidth', {
        configurable: true,
        get(this: HTMLElement) {
          return this.id === 'lc-render' ? renderSlotWidth : 0;
        },
      });
      Object.assign(parsedWindow, {
        pptxPreview: {
          init(container: HTMLElement, options: FakePptxPreviewInitOptions) {
            initializationOptions = options;
            const wrapper = parsedWindow.document.createElement('div');
            wrapper.className = 'pptx-preview-wrapper';
            container.appendChild(wrapper);
            return {
              preview() {
                for (let index = 0; index < slideCount; index += 1) {
                  const slide = parsedWindow.document.createElement('div');
                  slide.className = 'pptx-preview-slide-wrapper';
                  slide.style.width = `${options.width}px`;
                  slide.style.height = `${options.width * 0.5625}px`;
                  slide.textContent = `Slide ${index + 1}`;
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

  if (!initializationOptions) {
    throw new Error('pptxPreview.init was not called');
  }
  return { document: window.document, initializationOptions };
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
