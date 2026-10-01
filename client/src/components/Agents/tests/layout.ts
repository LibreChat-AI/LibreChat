import type t from 'librechat-data-provider';

export const makeAgents = (count: number, start = 0): t.Agent[] =>
  Array.from({ length: count }, (_, offset) => ({
    id: `agent-${start + offset}`,
    name: `Agent ${start + offset}`,
    description: 'A useful agent summary.',
    category: 'general',
    avatar: null,
    created_at: 0,
    provider: 'openai',
    model: 'gpt-4',
    model_parameters: {
      temperature: null,
      maxContextTokens: null,
      max_context_tokens: null,
      max_output_tokens: null,
      top_p: null,
      frequency_penalty: null,
      presence_penalty: null,
    },
  }));

export interface VirtualLayout {
  resize(width: number, height?: number): void;
  cleanup(): void;
}

/** Supply jsdom geometry and ResizeObserver delivery without mocking the virtualizer. */
export function installVirtualLayout(initialWidth = 1400, initialHeight = 600): VirtualLayout {
  let width = initialWidth;
  let height = initialHeight;
  const observers = new Set<TestResizeObserver>();
  const originalStyle = window.getComputedStyle.bind(window);
  const rect = (top: number, w: number, h: number): DOMRect => ({
    x: 0,
    y: top,
    width: w,
    height: h,
    top,
    left: 0,
    right: w,
    bottom: top + h,
    toJSON: () => ({ top, width: w, height: h }),
  });
  const isFrame = (element: Element) => element.getAttribute('data-testid') === 'viewport';
  /** The responsive card track shared by the virtualized list and the loading skeleton. */
  const isCardGrid = (element: Element) =>
    element.classList.contains('grid') &&
    element.classList.value.includes('grid-cols-[repeat(auto-fill');
  const listHeight = (element: Element) => {
    const list = element.querySelector<HTMLElement>('[role="list"]');
    return list ? parseFloat(list.style.height) || list.children.length * 320 - 20 : 0;
  };
  const bounds = jest
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: HTMLElement) {
      const frame = this.closest<HTMLElement>('[data-testid="viewport"]');
      if (!frame) return rect(0, 100, 30);
      if (isFrame(this)) return rect(0, width, height);
      if (isCardGrid(this)) return rect(-frame.scrollTop, width, listHeight(frame));
      if (this.matches('[data-index]')) {
        const translate = /translateY\(([-\d.]+)px\)/.exec(this.style.transform);
        const top = translate ? Number(translate[1]) : Number(this.dataset.index) * 320;
        return rect(top - frame.scrollTop, width, 300);
      }
      return rect(0, 100, 30);
    });
  const savedDescriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const property of [
    'clientHeight',
    'clientWidth',
    'offsetHeight',
    'offsetWidth',
    'scrollHeight',
    'scrollTo',
  ]) {
    savedDescriptors.set(
      property,
      Object.getOwnPropertyDescriptor(HTMLElement.prototype, property),
    );
  }
  Object.defineProperties(HTMLElement.prototype, {
    offsetHeight: {
      configurable: true,
      get(this: HTMLElement) {
        return this.getBoundingClientRect().height;
      },
    },
    offsetWidth: {
      configurable: true,
      get(this: HTMLElement) {
        return this.getBoundingClientRect().width;
      },
    },
    clientHeight: {
      configurable: true,
      get(this: HTMLElement) {
        return isFrame(this) ? height : 0;
      },
    },
    clientWidth: {
      configurable: true,
      get(this: HTMLElement) {
        return isFrame(this) ? width : 0;
      },
    },
    scrollHeight: {
      configurable: true,
      get(this: HTMLElement) {
        return isFrame(this) ? Math.max(height, listHeight(this)) : 0;
      },
    },
    scrollTo: {
      configurable: true,
      value(this: HTMLElement, options: ScrollToOptions) {
        const next = options.top ?? this.scrollTop;
        if (next === this.scrollTop) return;
        this.scrollTop = next;
        queueMicrotask(() => this.isConnected && this.dispatchEvent(new Event('scroll')));
      },
    },
  });
  const styles = jest.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
    const style = originalStyle(element, pseudo);
    return new Proxy(style, {
      get(target, property) {
        if (element === document.documentElement && property === 'fontSize') return '16px';
        if (isCardGrid(element) && element.closest('[data-testid="viewport"]')) {
          const columns = Math.max(1, Math.min(4, Math.floor((width + 20) / 340)));
          if (property === 'gridTemplateColumns')
            return Array(columns)
              .fill(`${width / columns}px`)
              .join(' ');
          if (property === 'rowGap') return '20px';
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });

  class TestResizeObserver implements ResizeObserver {
    private targets = new Set<Element>();
    constructor(private callback: ResizeObserverCallback) {
      observers.add(this);
    }

    observe(target: Element) {
      if (this.targets.has(target)) return;
      this.targets.add(target);
      queueMicrotask(() => this.flush());
    }

    unobserve(target: Element) {
      this.targets.delete(target);
    }

    disconnect() {
      this.targets.clear();
      observers.delete(this);
    }

    flush() {
      const entries: ResizeObserverEntry[] = [];
      for (const target of this.targets) {
        if (!target.isConnected) continue;
        const box = target.getBoundingClientRect();
        entries.push({
          target,
          contentRect: box,
          borderBoxSize: [{ blockSize: box.height, inlineSize: box.width }],
          contentBoxSize: [{ blockSize: box.height, inlineSize: box.width }],
          devicePixelContentBoxSize: [],
        });
      }
      if (entries.length) this.callback(entries, this);
    }
  }
  const originalObserver = global.ResizeObserver;
  global.ResizeObserver = TestResizeObserver;
  return {
    resize(nextWidth: number, nextHeight = height) {
      width = nextWidth;
      height = nextHeight;
      for (const observer of observers) observer.flush();
    },
    cleanup() {
      for (const observer of observers) observer.disconnect();
      global.ResizeObserver = originalObserver;
      bounds.mockRestore();
      styles.mockRestore();
      for (const [property, descriptor] of savedDescriptors) {
        if (descriptor) Object.defineProperty(HTMLElement.prototype, property, descriptor);
        else Reflect.deleteProperty(HTMLElement.prototype, property);
      }
    },
  };
}
