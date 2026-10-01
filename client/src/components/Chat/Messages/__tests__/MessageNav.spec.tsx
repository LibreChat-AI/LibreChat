import React from 'react';
import { render, act, fireEvent, screen } from '@testing-library/react';

type ReactNode = React.ReactNode;
type RefObject<T> = React.RefObject<T>;

type TestMessage = {
  messageId: string;
  conversationId?: string;
  text?: string;
  isCreatedByUser?: boolean;
  content?: Array<
    | {
        type?: string;
        text?: string | { value?: string };
      }
    | undefined
  >;
};

const mockUseGetMessagesByConvoId = jest.fn();
const mockUseMessagesConversation = jest.fn();
const mockUseMessagesSubmission = jest.fn();

jest.mock('~/data-provider', () => ({
  useGetMessagesByConvoId: (...args: unknown[]) => mockUseGetMessagesByConvoId(...args),
}));

jest.mock('~/Providers', () => ({
  useMessagesConversation: (...args: unknown[]) => mockUseMessagesConversation(...args),
  useMessagesSubmission: (...args: unknown[]) => mockUseMessagesSubmission(...args),
}));

jest.mock('~/hooks', () => ({
  useLocalize:
    () =>
    (key: string, opts?: Record<string, string | number>): string =>
      opts ? `${key}|${JSON.stringify(opts)}` : key,
}));

// The nav no longer renders HoverCard, but `~/utils` transitively imports the
// dual CJS/ESM @librechat/client whose dist pulls ESM-only @ariakit subpaths
// that jest cannot resolve. Stub the module so the unit under test stays isolated.
jest.mock('@librechat/client', () => ({
  HoverCard: ({ children }: { children: ReactNode }) => <>{children}</>,
  HoverCardTrigger: ({ children, asChild }: { children: ReactNode; asChild?: boolean }) =>
    asChild ? children : <div>{children}</div>,
  HoverCardPortal: ({ children }: { children: ReactNode }) => <>{children}</>,
  HoverCardContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

type IOEntry = Pick<IntersectionObserverEntry, 'target' | 'isIntersecting'>;

class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];
  static last(): MockIntersectionObserver | undefined {
    return MockIntersectionObserver.instances[MockIntersectionObserver.instances.length - 1];
  }

  static reset() {
    MockIntersectionObserver.instances = [];
  }

  root: Element | Document | null = null;
  rootMargin = '0px';
  thresholds: number[] = [0];
  callback: IntersectionObserverCallback;
  observed = new Set<Element>();
  observe = jest.fn((el: Element) => {
    this.observed.add(el);
  });

  unobserve = jest.fn((el: Element) => {
    this.observed.delete(el);
  });

  disconnect = jest.fn(() => {
    this.observed.clear();
  });

  takeRecords = jest.fn(() => []);
  constructor(cb: IntersectionObserverCallback, opts?: IntersectionObserverInit) {
    this.callback = cb;
    if (opts?.root instanceof Element || opts?.root instanceof Document) {
      this.root = opts.root;
    }
    MockIntersectionObserver.instances.push(this);
  }

  trigger(entries: IOEntry[]) {
    this.callback(entries as IntersectionObserverEntry[], this as unknown as IntersectionObserver);
  }
}

const originalIO = global.IntersectionObserver;

class PointerEventPolyfill extends MouseEvent {
  pointerId: number;
  constructor(type: string, params: MouseEventInit & { pointerId?: number } = {}) {
    super(type, params);
    this.pointerId = params.pointerId ?? 0;
  }
}

if (typeof (global as { PointerEvent?: unknown }).PointerEvent === 'undefined') {
  (global as unknown as { PointerEvent: typeof PointerEventPolyfill }).PointerEvent =
    PointerEventPolyfill;
  (window as unknown as { PointerEvent: typeof PointerEventPolyfill }).PointerEvent =
    PointerEventPolyfill;
}

import type { TMessage } from 'librechat-data-provider';
import MessageNav, {
  buildEntry,
  previewTextFor,
  buildSteerEntry,
  buildFallbackEntry,
  magnifyFalloff,
  ribDimsFor,
} from '../MessageNav';

function buildMessage(overrides: Partial<TestMessage> = {}): TestMessage {
  return {
    messageId: 'm',
    conversationId: 'test-convo',
    text: 'hello',
    isCreatedByUser: false,
    ...overrides,
  };
}

const asTMessage = (m: TestMessage): TMessage => m as unknown as TMessage;

function buildDom(messages: TestMessage[]): {
  scrollable: HTMLDivElement;
  content: HTMLDivElement;
} {
  const scrollable = document.createElement('div');
  scrollable.className = 'scrollbar-gutter-stable';
  Object.defineProperty(scrollable, 'clientHeight', { value: 600, configurable: true });
  Object.defineProperty(scrollable, 'scrollHeight', { value: 3000, configurable: true });
  Object.defineProperty(scrollable, 'scrollTop', { value: 0, writable: true, configurable: true });

  const content = document.createElement('div');
  content.className = 'flex flex-col';
  scrollable.appendChild(content);

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const div = document.createElement('div');
    div.id = m.messageId;
    div.className = 'message-render';
    if (m.isCreatedByUser) {
      const turn = document.createElement('div');
      turn.className = 'user-turn';
      turn.textContent = m.text ?? '';
      div.appendChild(turn);
    } else {
      div.textContent = m.text ?? '';
    }
    Object.defineProperty(div, 'offsetTop', { value: 100 + i * 200, configurable: true });
    Object.defineProperty(div, 'offsetHeight', { value: 150, configurable: true });
    content.appendChild(div);
  }

  document.body.appendChild(scrollable);
  return { scrollable, content };
}

function renderNav(messages: TestMessage[]) {
  mockUseGetMessagesByConvoId.mockReturnValue({ data: messages });
  const { scrollable, content } = buildDom(messages);
  const scrollableRef = { current: scrollable } as RefObject<HTMLDivElement>;
  const result = render(<MessageNav scrollableRef={scrollableRef} />);
  act(() => {
    jest.advanceTimersByTime(250);
  });
  return { ...result, scrollable, content, scrollableRef };
}

/** The rail pins an origin rib above the scrolling column and a terminus rib
 *  below it, so `nav > div` is no longer the column and a nav-wide
 *  `[data-msg-id]` sweep includes both pinned ribs. */
const NAV_COLUMN_SELECTOR = '[data-message-nav-column]';

function getColumn(container: HTMLElement): HTMLDivElement {
  return container.querySelector(NAV_COLUMN_SELECTOR) as HTMLDivElement;
}

function messageRibs(container: HTMLElement): HTMLElement[] {
  return Array.from(getColumn(container).querySelectorAll<HTMLElement>('[data-msg-id]'));
}

/**
 * Lay the ribs out on a fixed pitch.
 *
 * The rail hit-tests the pointer against the ribs' own `offsetTop`/`offsetHeight`
 * — content-space values, since the column is their offset parent — so the rib
 * under the pointer, the message named in the preview and the message a drag
 * lands on all come from one measurement. jsdom reports 0 for both, which would
 * collapse every rib onto the same point, so any test that drives pointer
 * geometry has to declare the layout. Rows keep their own `offsetTop` from
 * `buildDom`; own properties win over these prototype getters.
 */
function stubRibLayout(ids: string[], pitch = 12, height = 6): () => void {
  const indexById = new Map(ids.map((id, i) => [id, i]));
  const top = jest.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    const id = this.getAttribute('data-msg-id');
    const index = id != null ? indexById.get(id) : undefined;
    return index != null ? index * pitch : 0;
  });
  const size = jest
    .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
    .mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('data-msg-id') != null ? height : 0;
    });
  return () => {
    top.mockRestore();
    size.mockRestore();
  };
}

function clearDom() {
  while (document.body.firstChild) {
    document.body.removeChild(document.body.firstChild);
  }
}

beforeEach(() => {
  MockIntersectionObserver.reset();
  (
    global as unknown as { IntersectionObserver: typeof MockIntersectionObserver }
  ).IntersectionObserver = MockIntersectionObserver;
  jest.useFakeTimers();
  mockUseMessagesConversation.mockReturnValue({ conversationId: 'test-convo' });
  mockUseMessagesSubmission.mockReturnValue({ isSubmitting: false });
  mockUseGetMessagesByConvoId.mockReturnValue({ data: [] });
});

afterEach(() => {
  jest.useRealTimers();
  (
    global as unknown as { IntersectionObserver: typeof IntersectionObserver }
  ).IntersectionObserver = originalIO;
  clearDom();
});

describe('MessageNav', () => {
  describe('rendering threshold', () => {
    it('renders nothing when there are 0 messages', () => {
      const { container } = renderNav([]);
      expect(container.querySelector('nav')).toBeNull();
    });

    it('renders nothing with fewer than 3 messages', () => {
      const messages = [
        buildMessage({ messageId: 'a', text: 'hi', isCreatedByUser: true }),
        buildMessage({ messageId: 'b', text: 'hey' }),
      ];
      const { container } = renderNav(messages);
      expect(container.querySelector('nav')).toBeNull();
    });

    it('renders the nav with 3+ messages and an indicator for each', () => {
      const messages = [
        buildMessage({ messageId: 'a', text: 'alpha', isCreatedByUser: true }),
        buildMessage({ messageId: 'b', text: 'bravo' }),
        buildMessage({ messageId: 'c', text: 'charlie', isCreatedByUser: true }),
      ];
      const { container } = renderNav(messages);
      const nav = container.querySelector('nav');
      expect(nav).not.toBeNull();
      expect(nav).toHaveAttribute('aria-label', 'com_ui_message_nav');

      const indicators = messageRibs(container);
      expect(indicators).toHaveLength(3);
      expect(Array.from(indicators).map((el) => el.getAttribute('data-msg-id'))).toEqual([
        'a',
        'b',
        'c',
      ]);
    });

    it('renders one rib per message even when a message nests duplicate .message-render nodes', () => {
      mockUseGetMessagesByConvoId.mockReturnValue({ data: [] });
      const scrollable = document.createElement('div');
      scrollable.className = 'scrollbar-gutter-stable';
      const content = document.createElement('div');
      scrollable.appendChild(content);
      for (const [i, id] of ['a', 'b', 'c'].entries()) {
        const div = document.createElement('div');
        div.id = id;
        div.className = 'message-render';
        div.textContent = `msg-${id}`;
        if (id === 'b') {
          const part = document.createElement('div');
          part.id = id;
          part.className = 'message-render';
          part.textContent = 'msg-b-part';
          div.appendChild(part);
        }
        Object.defineProperty(div, 'offsetTop', { value: i * 200, configurable: true });
        Object.defineProperty(div, 'offsetHeight', { value: 150, configurable: true });
        content.appendChild(div);
      }
      document.body.appendChild(scrollable);
      const scrollableRef = { current: scrollable } as RefObject<HTMLDivElement>;
      const { container } = render(<MessageNav scrollableRef={scrollableRef} />);
      act(() => {
        jest.advanceTimersByTime(250);
      });

      const indicators = messageRibs(container);
      expect(Array.from(indicators).map((el) => el.getAttribute('data-msg-id'))).toEqual([
        'a',
        'b',
        'c',
      ]);
    });
  });

  describe('indicator styling', () => {
    it('gives every message rib the same short resting width regardless of role', () => {
      const messages = [
        buildMessage({ messageId: 'u', text: 'user msg', isCreatedByUser: true }),
        buildMessage({ messageId: 'a', text: 'assistant msg' }),
        buildMessage({ messageId: 'u2', text: 'more user', isCreatedByUser: true }),
      ];
      const { container } = renderNav(messages);
      const [, assistantInd, userInd] = messageRibs(container);
      const userLine = assistantInd.querySelector('span') as HTMLElement;
      const assistantLine = userInd.querySelector('span') as HTMLElement;
      expect(userLine.style.width).toBe('12px');
      expect(assistantLine.style.width).toBe('12px');
    });

    it('gives the current rib a longer resting width than its neighbours', () => {
      const messages = [
        buildMessage({ messageId: 'u', text: 'user msg', isCreatedByUser: true }),
        buildMessage({ messageId: 'a', text: 'assistant msg' }),
        buildMessage({ messageId: 'u2', text: 'more user', isCreatedByUser: true }),
      ];
      const { container } = renderNav(messages);
      const [current, next] = messageRibs(container);
      expect(current.getAttribute('aria-current')).toBe('true');
      const currentWidth = parseFloat((current.querySelector('span') as HTMLElement).style.width);
      const nextWidth = parseFloat((next.querySelector('span') as HTMLElement).style.width);
      expect(currentWidth).toBeGreaterThan(nextWidth);
    });

    it('holds every rib row at a fixed height so the column cannot compress them', () => {
      const messages = Array.from({ length: 6 }, (_, i) =>
        buildMessage({ messageId: `m-${i}`, text: `message ${i}` }),
      );
      const { container } = renderNav(messages);
      for (const rib of messageRibs(container)) {
        expect(rib.className).toContain('shrink-0');
        expect(rib.style.height).toBe('6px');
      }
    });

    it('lights up only the in-viewport ribs at rest (no hover)', () => {
      const messages = [
        buildMessage({ messageId: 'a', text: 'alpha', isCreatedByUser: true }),
        buildMessage({ messageId: 'b', text: 'bravo' }),
        buildMessage({ messageId: 'c', text: 'charlie', isCreatedByUser: true }),
      ];
      const { container } = renderNav(messages);
      const io = MockIntersectionObserver.last();
      act(() => {
        io!.trigger([{ target: document.getElementById('a')!, isIntersecting: true }]);
        jest.advanceTimersByTime(32);
      });

      const ribA = container.querySelector('[data-msg-id="a"]') as HTMLElement;
      const ribB = container.querySelector('[data-msg-id="b"]') as HTMLElement;
      expect(ribA.className).toContain('opacity-100');
      expect(ribA.className).not.toContain('opacity-40');
      expect(ribA.querySelector('span')).toHaveClass('bg-text-primary');
      expect(ribB.className).toContain('opacity-40');
      expect(ribB.className).toContain('high-contrast:opacity-50');
      expect(ribB.querySelector('span')).toHaveClass('bg-text-tertiary');
      expect(ribA.querySelector('span')?.className).not.toMatch(/bg-gray-|dark:bg-gray-/);
      expect(ribB.querySelector('span')?.className).not.toMatch(/bg-gray-|dark:bg-gray-/);

      const previous = screen.getByRole('button', { name: 'com_ui_message_nav_previous' });
      const next = screen.getByRole('button', { name: 'com_ui_message_nav_next' });
      expect(previous).toHaveClass('text-text-tertiary', 'high-contrast:opacity-50');
      expect(next).toHaveClass('text-text-tertiary', 'high-contrast:opacity-50');
    });
  });

  describe('preview text', () => {
    it('uses message text from React Query data when available', () => {
      const entry = buildEntry(
        'a',
        asTMessage(buildMessage({ messageId: 'a', text: 'alpha-preview' })),
      );
      expect(entry.preview).toBe('alpha-preview');
    });

    it('falls back to DOM text content for messages without React Query data', () => {
      const node = document.createElement('div');
      node.className = 'message-render';
      node.textContent = 'dom-text-x';
      const entry = buildFallbackEntry(node, 'x');
      expect(entry.preview).toBe('dom-text-x');
      expect(entry.isUser).toBe(false);
    });

    it('marks fallback entries containing a user turn as user messages', () => {
      const node = document.createElement('div');
      node.className = 'message-render';
      const turn = document.createElement('div');
      turn.className = 'user-turn';
      turn.textContent = 'hi';
      node.appendChild(turn);
      expect(buildFallbackEntry(node, 'u').isUser).toBe(true);
    });

    it('truncates previews longer than 80 chars with an ellipsis', () => {
      const entry = buildEntry(
        'a',
        asTMessage(buildMessage({ messageId: 'a', text: 'a'.repeat(120) })),
      );
      expect(entry.preview.endsWith('...')).toBe(true);
      expect(entry.preview.length).toBe(83);
    });

    it('skips sparse content entries when deriving preview text', () => {
      const entry = buildEntry(
        'a',
        asTMessage(
          buildMessage({
            messageId: 'a',
            text: '',
            content: [undefined, { type: 'text', text: 'content-preview' }],
          }),
        ),
      );
      expect(entry.preview).toBe('content-preview');
    });
  });

  describe('rib magnification', () => {
    it('peaks at the pointer and decays to zero at the influence radius', () => {
      expect(magnifyFalloff(0, 50)).toBeCloseTo(1);
      expect(magnifyFalloff(50, 50)).toBe(0);
      expect(magnifyFalloff(100, 50)).toBe(0);
    });

    it('decreases monotonically with distance within the radius', () => {
      const near = magnifyFalloff(10, 50);
      const mid = magnifyFalloff(25, 50);
      const far = magnifyFalloff(40, 50);
      expect(near).toBeGreaterThan(mid);
      expect(mid).toBeGreaterThan(far);
    });

    it('magnifies every message rib uniformly and keeps the end marker square', () => {
      const user = ribDimsFor({ id: 'u', isUser: true, preview: '' });
      const assistant = ribDimsFor({ id: 'a', isUser: false, preview: '' });
      const end = ribDimsFor({ id: 'e', isUser: false, preview: '', isEnd: true });
      expect(assistant.baseW).toBe(user.baseW);
      expect(assistant.peakW).toBe(user.peakW);
      expect(user.peakW).toBeGreaterThan(user.baseW);
      expect(end.baseW).toBe(end.baseH);
      expect(end.peakW).toBe(end.peakH);
    });
  });

  describe('steer ribs', () => {
    function appendSteerNode(
      parent: Element,
      steerId: string,
      text: string,
      offsetTop: number,
    ): HTMLDivElement {
      const steer = document.createElement('div');
      steer.id = `steer-${steerId}`;
      steer.className = 'steer-render group relative';
      const header = document.createElement('h2');
      header.textContent = 'Danny';
      const body = document.createElement('div');
      body.className = 'message-content';
      body.textContent = text;
      steer.appendChild(header);
      steer.appendChild(body);
      Object.defineProperty(steer, 'offsetTop', { value: offsetTop, configurable: true });
      Object.defineProperty(steer, 'offsetHeight', { value: 40, configurable: true });
      parent.appendChild(steer);
      return steer;
    }

    it('buildSteerEntry reads the text body, skipping the author header', () => {
      const node = document.createElement('div');
      appendSteerNode(node, 's', 'actually use bun instead', 0);
      const entry = buildSteerEntry(node.firstElementChild as HTMLElement, 'steer-s');
      expect(entry).toEqual({
        id: 'steer-s',
        isUser: true,
        preview: 'actually use bun instead',
      });
    });

    it('buildSteerEntry truncates long steers and falls back to full node text', () => {
      const node = document.createElement('div');
      node.textContent = 'x'.repeat(100);
      const entry = buildSteerEntry(node, 'steer-long');
      expect(entry.preview.endsWith('...')).toBe(true);
      expect(entry.preview).toHaveLength(83);
    });

    it('interleaves a steer rib inside its response, labeled as a user message', () => {
      const messages = [
        buildMessage({ messageId: 'u1', text: 'first ask', isCreatedByUser: true }),
        buildMessage({ messageId: 'a1', text: 'long tool run' }),
        buildMessage({ messageId: 'u2', text: 'follow-up', isCreatedByUser: true }),
        buildMessage({ messageId: 'a2', text: 'second reply' }),
      ];
      mockUseGetMessagesByConvoId.mockReturnValue({ data: messages });
      const { scrollable } = buildDom(messages);
      const response = scrollable.querySelector('#a1') as HTMLElement;
      appendSteerNode(response, 's1', 'steer mid-run words', 350);

      const scrollableRef = { current: scrollable } as RefObject<HTMLDivElement>;
      const { container } = render(<MessageNav scrollableRef={scrollableRef} />);
      act(() => {
        jest.advanceTimersByTime(250);
      });

      const ids = messageRibs(container).map((el) => el.getAttribute('data-msg-id'));
      expect(ids).toEqual(['u1', 'a1', 'steer-s1', 'u2', 'a2']);

      const steerRib = container.querySelector('[data-msg-id="steer-s1"]');
      expect(steerRib?.getAttribute('aria-label')).toMatch(/^com_ui_message_nav_go_to_user\|/);
      expect(steerRib?.getAttribute('aria-label')).toContain('steer mid-run words');
      expect(steerRib?.getAttribute('aria-label')).not.toContain('Danny');
    });

    it('places a nested steer at its content-space position, not its offset-parent-local offset', () => {
      // A steer renders inside the response's `relative` content column, so its
      // raw offsetTop is local to that column, not its true position in the
      // thread. The rail must sum the offsetParent chain — otherwise the steer's
      // small local offset reads as the topmost row and hijacks the current
      // indicator (and, with it, the up/down chevrons) whenever it is on screen.
      const messages = [
        buildMessage({ messageId: 'u1', text: 'first ask', isCreatedByUser: true }),
        buildMessage({ messageId: 'a1', text: 'long tool run' }),
        buildMessage({ messageId: 'u2', text: 'follow-up', isCreatedByUser: true }),
        buildMessage({ messageId: 'a2', text: 'second reply' }),
      ];
      mockUseGetMessagesByConvoId.mockReturnValue({ data: messages });
      const { scrollable } = buildDom(messages);
      const response = scrollable.querySelector('#a1') as HTMLElement;

      // Nest the steer in a positioned column of its own; the steer's offsetTop
      // (40) is local to that column (380), so its content-space top is 420 —
      // below a1 (300) and above u2 (500). jsdom leaves offsetParent null, so
      // the nesting has to be declared for the chain-walk to have anything to
      // sum.
      const column = document.createElement('div');
      column.className = 'relative';
      Object.defineProperty(column, 'offsetTop', { value: 380, configurable: true });
      response.appendChild(column);
      const steer = appendSteerNode(column, 's1', 'steer mid-run words', 40);
      Object.defineProperty(steer, 'offsetParent', { value: column, configurable: true });

      const scrollableRef = { current: scrollable } as RefObject<HTMLDivElement>;
      const { container } = render(<MessageNav scrollableRef={scrollableRef} />);
      act(() => {
        jest.advanceTimersByTime(250);
      });

      // Park the viewport between the response (300) and the steer's true
      // content-space top (420). Read in content space the reader is inside a1;
      // read with the steer's raw local offset (40) it is the last entry to have
      // passed the viewport top, and the steer hijacks the current indicator.
      (scrollable as HTMLElement).scrollTop = 350;
      act(() => {
        fireEvent.scroll(scrollable);
        jest.advanceTimersByTime(32);
      });

      const current = container.querySelectorAll('[aria-current="true"]');
      expect(current).toHaveLength(1);
      expect(current[0]).toHaveAttribute('data-msg-id', 'a1');
    });

    it('un-lights a steer rib when its DOM node is replaced (pending → applied swap)', async () => {
      const messages = [
        buildMessage({ messageId: 'u1', text: 'first ask', isCreatedByUser: true }),
        buildMessage({ messageId: 'a1', text: 'long tool run' }),
        buildMessage({ messageId: 'u2', text: 'follow-up', isCreatedByUser: true }),
      ];
      mockUseGetMessagesByConvoId.mockReturnValue({ data: messages });
      const { scrollable } = buildDom(messages);
      const response = scrollable.querySelector('#a1') as HTMLElement;
      const pendingNode = appendSteerNode(response, 's1', 'swap me', 350);

      const scrollableRef = { current: scrollable } as RefObject<HTMLDivElement>;
      const { container } = render(<MessageNav scrollableRef={scrollableRef} />);
      act(() => {
        jest.advanceTimersByTime(250);
      });

      const io = MockIntersectionObserver.last();
      act(() => {
        io!.trigger([{ target: pendingNode, isIntersecting: true }]);
        jest.advanceTimersByTime(32);
      });
      const rib = container.querySelector('[data-msg-id="steer-s1"]') as HTMLElement;
      expect(rib.className).toContain('opacity-100');

      // The applied part replaces the optimistic node under the SAME id —
      // same entry list (id + preview unchanged), no observer exit event.
      act(() => {
        pendingNode.remove();
        appendSteerNode(response, 's1', 'swap me', 350);
      });
      // Let the MutationObserver microtask deliver (it schedules the
      // debounced refresh), then advance the debounce.
      await act(async () => {});
      act(() => {
        jest.advanceTimersByTime(250);
      });

      // Without node-level reconciliation the dead node keeps the rib lit
      // forever; after it, visibility drops until the fresh node reports.
      const ribAfter = container.querySelector('[data-msg-id="steer-s1"]') as HTMLElement;
      expect(ribAfter.className).toContain('opacity-40');
    });
  });

  describe('accessibility', () => {
    it('labels the nav and chevron buttons via useLocalize', () => {
      const messages = [
        buildMessage({ messageId: 'a', text: 'one', isCreatedByUser: true }),
        buildMessage({ messageId: 'b', text: 'two' }),
        buildMessage({ messageId: 'c', text: 'three', isCreatedByUser: true }),
      ];
      const { container } = renderNav(messages);

      expect(container.querySelector('nav')).toHaveAttribute('aria-label', 'com_ui_message_nav');

      const prevBtn = container.querySelector('button[aria-label="com_ui_message_nav_previous"]');
      const nextBtn = container.querySelector('button[aria-label="com_ui_message_nav_next"]');
      expect(prevBtn).not.toBeNull();
      expect(nextBtn).not.toBeNull();
    });

    it('labels each indicator with its role-specific key and localized preview', () => {
      const messages = [
        buildMessage({ messageId: 'u', text: 'hi there', isCreatedByUser: true }),
        buildMessage({ messageId: 'a', text: 'assistant reply' }),
        buildMessage({ messageId: 'u2', text: 'follow-up', isCreatedByUser: true }),
      ];
      const { container } = renderNav(messages);
      const [userInd, assistantInd] = messageRibs(container);
      expect(userInd.getAttribute('aria-label')).toMatch(/^com_ui_message_nav_go_to_user\|/);
      expect(userInd.getAttribute('aria-label')).toContain('hi there');
      expect(assistantInd.getAttribute('aria-label')).toMatch(
        /^com_ui_message_nav_go_to_assistant\|/,
      );
    });

    it('sets aria-current on the entry the viewport has reached', () => {
      const messages = [
        buildMessage({ messageId: 'a', text: 'alpha', isCreatedByUser: true }),
        buildMessage({ messageId: 'b', text: 'bravo' }),
        buildMessage({ messageId: 'c', text: 'charlie', isCreatedByUser: true }),
      ];
      const { container, scrollable } = renderNav(messages);

      /** Rows sit at 100/300/500; parking at 350 puts the reader inside 'b'. */
      (scrollable as HTMLElement).scrollTop = 350;
      act(() => {
        fireEvent.scroll(scrollable);
        jest.advanceTimersByTime(32);
      });

      const active = container.querySelector('[aria-current="true"]');
      expect(active).not.toBeNull();
      expect(active).toHaveAttribute('data-msg-id', 'b');
    });

    it('marks exactly one entry current, and it is not every row on screen', () => {
      const messages = [
        buildMessage({ messageId: 'a', text: 'alpha', isCreatedByUser: true }),
        buildMessage({ messageId: 'b', text: 'bravo' }),
        buildMessage({ messageId: 'c', text: 'charlie', isCreatedByUser: true }),
      ];
      const { container } = renderNav(messages);
      const io = MockIntersectionObserver.last();
      expect(io).toBeDefined();

      act(() => {
        io!.trigger([
          { target: document.getElementById('c')!, isIntersecting: true },
          { target: document.getElementById('b')!, isIntersecting: true },
          { target: document.getElementById('a')!, isIntersecting: true },
        ]);
        jest.advanceTimersByTime(32);
      });

      const current = container.querySelectorAll('[aria-current="true"]');
      expect(current).toHaveLength(1);
      expect(current[0]).toHaveAttribute('data-msg-id', 'a');

      const activeLine = container.querySelector('[aria-current="true"] span');
      expect(activeLine?.className).toContain('bg-text-primary');

      /** The other two rows are on screen, so they read as the in-view band:
       *  lit, but plainly not the mark that says where the reader is. */
      const band = messageRibs(container)
        .slice(1)
        .map((rib) => rib.querySelector('span')?.className ?? '');
      expect(band.every((c) => c.includes('bg-text-secondary'))).toBe(true);
    });

    it('lands current on the terminus once the thread is scrolled to the bottom', () => {
      const messages = Array.from({ length: 4 }, (_, i) =>
        buildMessage({ messageId: `m-${i}`, text: `message ${i}` }),
      );
      mockUseGetMessagesByConvoId.mockReturnValue({ data: messages });
      const scrollable = document.createElement('div');
      scrollable.className = 'scrollbar-gutter-stable';
      Object.defineProperty(scrollable, 'clientHeight', { value: 600, configurable: true });
      Object.defineProperty(scrollable, 'scrollHeight', { value: 3000, configurable: true });
      Object.defineProperty(scrollable, 'scrollTop', {
        value: 0,
        writable: true,
        configurable: true,
      });
      const content = document.createElement('div');
      scrollable.appendChild(content);
      for (let i = 0; i < messages.length; i++) {
        const div = document.createElement('div');
        div.id = messages[i].messageId;
        div.className = 'message-render';
        div.textContent = messages[i].text ?? '';
        Object.defineProperty(div, 'offsetTop', { value: 100 + i * 200, configurable: true });
        Object.defineProperty(div, 'offsetHeight', { value: 150, configurable: true });
        content.appendChild(div);
      }
      /** A steer absorbed into the last response follows it in document order
       *  while sitting inside it, so before the scroll-spy the rail lit a rib
       *  two places short of the end while the reader sat at the very bottom. */
      const steer = document.createElement('div');
      steer.id = 'steer-s1';
      steer.className = 'steer-render';
      steer.textContent = 'mid-run steer';
      Object.defineProperty(steer, 'offsetTop', { value: 60, configurable: true });
      Object.defineProperty(steer, 'offsetHeight', { value: 40, configurable: true });
      (content.lastElementChild as HTMLElement).appendChild(steer);
      const end = document.createElement('div');
      end.id = 'messages-end';
      Object.defineProperty(end, 'offsetTop', { value: 2400, configurable: true });
      Object.defineProperty(end, 'offsetHeight', { value: 0, configurable: true });
      content.appendChild(end);
      document.body.appendChild(scrollable);

      const scrollableRef = { current: scrollable } as RefObject<HTMLDivElement>;
      const { container } = render(<MessageNav scrollableRef={scrollableRef} />);
      act(() => {
        jest.advanceTimersByTime(250);
      });

      (scrollable as HTMLElement).scrollTop = 2400;
      act(() => {
        fireEvent.scroll(scrollable);
        jest.advanceTimersByTime(32);
      });

      const current = container.querySelectorAll('[aria-current="true"]');
      expect(current).toHaveLength(1);
      expect(current[0]).toHaveAttribute('data-msg-id', 'messages-end');
    });

    it('disables the up chevron at the top even when the rows out-margin the padding', () => {
      // `.message-render` carries `scroll-margin-top: 4rem` against `pt-14` of
      // content padding, so the first entry's raw snap point is -8px. Compared
      // unclamped it reads as "there is still something above you" at the very
      // top of every conversation.
      const messages = [
        buildMessage({ messageId: 'a', text: 'alpha', isCreatedByUser: true }),
        buildMessage({ messageId: 'b', text: 'bravo' }),
        buildMessage({ messageId: 'c', text: 'charlie', isCreatedByUser: true }),
      ];
      mockUseGetMessagesByConvoId.mockReturnValue({ data: messages });
      const { scrollable, content } = buildDom(messages);
      /** Mirror the real layout: content padding 56px, row scroll margin 64px. */
      for (let i = 0; i < content.children.length; i++) {
        Object.defineProperty(content.children[i], 'offsetTop', {
          value: 56 + i * 200,
          configurable: true,
        });
      }
      const marginSpy = jest
        .spyOn(window, 'getComputedStyle')
        .mockImplementation(() => ({ scrollMarginTop: '64px' }) as CSSStyleDeclaration);

      const scrollableRef = { current: scrollable } as RefObject<HTMLDivElement>;
      const { container } = render(<MessageNav scrollableRef={scrollableRef} />);
      act(() => {
        jest.advanceTimersByTime(250);
        fireEvent.scroll(scrollable);
        jest.advanceTimersByTime(32);
      });

      const prev = container.querySelector(
        'button[aria-label="com_ui_message_nav_previous"]',
      ) as HTMLButtonElement;
      expect(prev.disabled).toBe(true);
      /** And the origin rib reads as reached, not as somewhere still to go. */
      const origin = container.querySelector('[data-msg-id="messages-start"] span');
      expect(origin?.className).not.toContain('bg-text-tertiary');
      marginSpy.mockRestore();
    });

    it('chevron buttons expose a disabled state when there is nothing to navigate to', () => {
      const messages = [
        buildMessage({ messageId: 'a', text: 'one', isCreatedByUser: true }),
        buildMessage({ messageId: 'b', text: 'two' }),
        buildMessage({ messageId: 'c', text: 'three', isCreatedByUser: true }),
      ];
      const { container, scrollable } = renderNav(messages);

      Object.defineProperty(scrollable, 'scrollTop', {
        value: 0,
        configurable: true,
        writable: true,
      });
      act(() => {
        fireEvent.scroll(scrollable);
        jest.advanceTimersByTime(32);
      });

      const prev = container.querySelector(
        'button[aria-label="com_ui_message_nav_previous"]',
      ) as HTMLButtonElement;
      const next = container.querySelector(
        'button[aria-label="com_ui_message_nav_next"]',
      ) as HTMLButtonElement;

      expect(prev.disabled).toBe(true);
      expect(next.disabled).toBe(false);
    });
  });

  describe('scroll behavior', () => {
    it('schedules a rAF when an indicator is clicked', () => {
      const messages = [
        buildMessage({ messageId: 'a', text: 'alpha', isCreatedByUser: true }),
        buildMessage({ messageId: 'b', text: 'bravo' }),
        buildMessage({ messageId: 'c', text: 'charlie', isCreatedByUser: true }),
      ];
      const { container } = renderNav(messages);
      const rafSpy = jest.spyOn(window, 'requestAnimationFrame');

      const target = messageRibs(container)[2] as HTMLButtonElement;
      act(() => {
        fireEvent.click(target);
      });
      expect(rafSpy).toHaveBeenCalled();
      rafSpy.mockRestore();
    });

    it('cancels any prior rAF scroll when a new one starts', () => {
      const messages = [
        buildMessage({ messageId: 'a', text: 'alpha', isCreatedByUser: true }),
        buildMessage({ messageId: 'b', text: 'bravo' }),
        buildMessage({ messageId: 'c', text: 'charlie', isCreatedByUser: true }),
      ];
      const { container } = renderNav(messages);
      const indicators = messageRibs(container);

      const steps: Array<(ts: number) => void> = [];
      const rafSpy = jest
        .spyOn(window, 'requestAnimationFrame')
        .mockImplementation((cb: FrameRequestCallback) => {
          steps.push(cb);
          return steps.length;
        });

      act(() => {
        fireEvent.click(indicators[0] as HTMLElement);
      });
      act(() => {
        fireEvent.click(indicators[2] as HTMLElement);
      });

      expect(steps.length).toBeGreaterThanOrEqual(2);
      expect(() => {
        steps[0](performance.now());
        steps[steps.length - 1](performance.now());
      }).not.toThrow();

      rafSpy.mockRestore();
    });

    it('scrolls the indicator column fully down when the final message is visible', () => {
      const messages = Array.from({ length: 15 }, (_, i) =>
        buildMessage({
          messageId: `m-${i}`,
          text: `message ${i}`,
          isCreatedByUser: i % 2 === 0,
        }),
      );
      const { container, scrollable } = renderNav(messages);
      const column = getColumn(container);
      let scrollHeightReads = 0;

      Object.defineProperty(column, 'clientHeight', { value: 30, configurable: true });
      Object.defineProperty(column, 'scrollHeight', {
        get: () => {
          scrollHeightReads++;
          return scrollHeightReads === 1 ? 170 : 180;
        },
        configurable: true,
      });
      Object.defineProperty(column, 'scrollTop', { value: 0, writable: true, configurable: true });
      Object.defineProperty(scrollable, 'scrollHeight', { value: 3600, configurable: true });
      Object.defineProperty(scrollable, 'scrollTop', {
        value: 2500,
        writable: true,
        configurable: true,
      });

      act(() => {
        fireEvent.scroll(scrollable);
        jest.advanceTimersByTime(32);
      });

      expect(column.scrollTop).toBe(150);
    });

    it('scrolls the indicator column fully down when the chat reaches bottom with stale offsets', () => {
      const messages = Array.from({ length: 15 }, (_, i) =>
        buildMessage({
          messageId: `bottom-${i}`,
          text: `message ${i}`,
          isCreatedByUser: i % 2 === 0,
        }),
      );
      mockUseGetMessagesByConvoId.mockReturnValue({ data: messages });

      const scrollable = document.createElement('div');
      scrollable.className = 'scrollbar-gutter-stable';
      Object.defineProperty(scrollable, 'clientHeight', { value: 600, configurable: true });
      Object.defineProperty(scrollable, 'scrollHeight', { value: 3000, configurable: true });
      Object.defineProperty(scrollable, 'scrollTop', {
        value: 0,
        writable: true,
        configurable: true,
      });

      const content = document.createElement('div');
      scrollable.appendChild(content);
      for (let i = 0; i < messages.length; i++) {
        const div = document.createElement('div');
        div.id = messages[i].messageId;
        div.className = 'message-render';
        div.textContent = messages[i].text ?? '';
        Object.defineProperty(div, 'offsetTop', {
          value: i === messages.length - 1 ? 5000 : 100 + i * 100,
          configurable: true,
        });
        Object.defineProperty(div, 'offsetHeight', { value: 80, configurable: true });
        content.appendChild(div);
      }
      document.body.appendChild(scrollable);

      const { container } = render(
        <MessageNav scrollableRef={{ current: scrollable } as RefObject<HTMLDivElement>} />,
      );
      act(() => {
        jest.advanceTimersByTime(250);
      });

      const column = getColumn(container);
      Object.defineProperty(column, 'clientHeight', { value: 30, configurable: true });
      Object.defineProperty(column, 'scrollHeight', { value: 180, configurable: true });
      Object.defineProperty(column, 'scrollTop', { value: 0, writable: true, configurable: true });
      Object.defineProperty(scrollable, 'scrollTop', {
        value: 2400,
        writable: true,
        configurable: true,
      });

      act(() => {
        fireEvent.scroll(scrollable);
        jest.advanceTimersByTime(32);
      });

      expect(column.scrollTop).toBe(150);
    });

    it('keeps per-instance scroll tokens isolated across mounted MessageNav instances', () => {
      const messagesA = [
        buildMessage({ messageId: 'a1', text: 'one', isCreatedByUser: true }),
        buildMessage({ messageId: 'a2', text: 'two' }),
        buildMessage({ messageId: 'a3', text: 'three', isCreatedByUser: true }),
      ];
      const messagesB = [
        buildMessage({ messageId: 'b1', text: 'alpha', isCreatedByUser: true }),
        buildMessage({ messageId: 'b2', text: 'beta' }),
        buildMessage({ messageId: 'b3', text: 'gamma', isCreatedByUser: true }),
      ];

      mockUseGetMessagesByConvoId.mockReturnValue({ data: messagesA });
      const domA = buildDom(messagesA);
      const { container: navA } = render(
        <MessageNav scrollableRef={{ current: domA.scrollable } as RefObject<HTMLDivElement>} />,
      );
      act(() => {
        jest.advanceTimersByTime(250);
      });

      mockUseGetMessagesByConvoId.mockReturnValue({ data: messagesB });
      const domB = buildDom(messagesB);
      const { container: navB } = render(
        <MessageNav scrollableRef={{ current: domB.scrollable } as RefObject<HTMLDivElement>} />,
      );
      act(() => {
        jest.advanceTimersByTime(250);
      });

      const steps: Array<(ts: number) => void> = [];
      const rafSpy = jest
        .spyOn(window, 'requestAnimationFrame')
        .mockImplementation((cb: FrameRequestCallback) => {
          steps.push(cb);
          return steps.length;
        });

      const indA = messageRibs(navA)[2] as HTMLButtonElement;
      const indB = messageRibs(navB)[2] as HTMLButtonElement;

      act(() => {
        fireEvent.click(indA);
      });
      act(() => {
        fireEvent.click(indB);
      });

      expect(steps.length).toBeGreaterThanOrEqual(2);

      let aScrollTouched = false;
      Object.defineProperty(domA.scrollable, 'scrollTop', {
        get: () => 0,
        set: () => {
          aScrollTouched = true;
        },
        configurable: true,
      });
      act(() => {
        steps[0](performance.now());
      });
      expect(aScrollTouched).toBe(true);

      rafSpy.mockRestore();
    });
  });

  describe('focus management', () => {
    it('moves focus to the target message when an indicator is clicked', () => {
      const messages = [
        buildMessage({ messageId: 'a', text: 'alpha', isCreatedByUser: true }),
        buildMessage({ messageId: 'b', text: 'bravo' }),
        buildMessage({ messageId: 'c', text: 'charlie', isCreatedByUser: true }),
      ];
      const { container } = renderNav(messages);

      const indicator = messageRibs(container)[1] as HTMLButtonElement;
      act(() => {
        fireEvent.click(indicator);
      });

      const message = document.getElementById('b');
      expect(message).toHaveAttribute('tabindex', '-1');
      expect(document.activeElement).toBe(message);
    });

    it('focuses the current indicator when Shift+Alt+M is pressed', () => {
      const messages = [
        buildMessage({ messageId: 'a', text: 'alpha', isCreatedByUser: true }),
        buildMessage({ messageId: 'b', text: 'bravo' }),
        buildMessage({ messageId: 'c', text: 'charlie', isCreatedByUser: true }),
      ];
      const { container, scrollable } = renderNav(messages);

      (scrollable as HTMLElement).scrollTop = 350;
      act(() => {
        fireEvent.scroll(scrollable);
        jest.advanceTimersByTime(32);
      });

      act(() => {
        fireEvent.keyDown(document, { code: 'KeyM', altKey: true, shiftKey: true });
      });

      expect(document.activeElement).toBe(container.querySelector('[data-msg-id="b"]'));
    });

    it('focuses the current indicator via the produced key on non-QWERTY layouts', () => {
      const messages = [
        buildMessage({ messageId: 'a', text: 'alpha', isCreatedByUser: true }),
        buildMessage({ messageId: 'b', text: 'bravo' }),
        buildMessage({ messageId: 'c', text: 'charlie', isCreatedByUser: true }),
      ];
      const { container, scrollable } = renderNav(messages);

      (scrollable as HTMLElement).scrollTop = 350;
      act(() => {
        fireEvent.scroll(scrollable);
        jest.advanceTimersByTime(32);
      });

      act(() => {
        fireEvent.keyDown(document, { key: 'm', code: 'Semicolon', altKey: true, shiftKey: true });
      });

      expect(document.activeElement).toBe(container.querySelector('[data-msg-id="b"]'));
    });

    it('consumes Shift+Alt+M only when the nav is rendered', () => {
      const messages = [
        buildMessage({ messageId: 'a', text: 'alpha', isCreatedByUser: true }),
        buildMessage({ messageId: 'b', text: 'bravo' }),
        buildMessage({ messageId: 'c', text: 'charlie', isCreatedByUser: true }),
      ];
      renderNav(messages);

      let notPrevented = true;
      act(() => {
        notPrevented = fireEvent.keyDown(document, {
          code: 'KeyM',
          altKey: true,
          shiftKey: true,
        });
      });

      expect(notPrevented).toBe(false);
    });

    it('does not consume Shift+Alt+M when the nav is not rendered', () => {
      renderNav([buildMessage({ messageId: 'solo', text: 'only one', isCreatedByUser: true })]);

      let notPrevented = true;
      act(() => {
        notPrevented = fireEvent.keyDown(document, {
          code: 'KeyM',
          altKey: true,
          shiftKey: true,
        });
      });

      expect(notPrevented).toBe(true);
    });

    it('ignores the keyboard shortcut without the alt and shift modifiers', () => {
      const messages = [
        buildMessage({ messageId: 'a', text: 'alpha', isCreatedByUser: true }),
        buildMessage({ messageId: 'b', text: 'bravo' }),
        buildMessage({ messageId: 'c', text: 'charlie', isCreatedByUser: true }),
      ];
      const { container } = renderNav(messages);

      act(() => {
        fireEvent.keyDown(document, { code: 'KeyM' });
      });

      const navButtons = messageRibs(container);
      expect(Array.from(navButtons)).not.toContain(document.activeElement);
    });
  });

  /** The tooltip anchors off the column's `left`, so a rect stub without one makes
   * the computed `right` NaN and React rejects the style write. Keep the stub a
   * complete rect. */
  const COLUMN_RECT = { top: 0, bottom: 50, height: 50, left: 0, right: 0 } as DOMRect;

  describe('click to jump', () => {
    it('jumps to the hovered (focused) message when the column is clicked off a rib line', () => {
      const messages = [
        buildMessage({ messageId: 'a', text: 'alpha', isCreatedByUser: true }),
        buildMessage({ messageId: 'b', text: 'bravo' }),
        buildMessage({ messageId: 'c', text: 'charlie', isCreatedByUser: true }),
      ];
      const { container, scrollable } = renderNav(messages);
      const column = getColumn(container);
      column.getBoundingClientRect = () => COLUMN_RECT;

      const writes: number[] = [];
      Object.defineProperty(scrollable, 'scrollTop', {
        get: () => 0,
        set: (v: number) => writes.push(v),
        configurable: true,
      });

      act(() => {
        fireEvent.pointerMove(column, { pointerId: 1, clientY: 5 });
        jest.advanceTimersByTime(120);
      });

      act(() => {
        fireEvent.click(column);
        jest.advanceTimersByTime(32);
      });

      expect(writes.length).toBeGreaterThan(0);
    });

    it('highlights only the hovered rib, dimming the rest', () => {
      const messages = [
        buildMessage({ messageId: 'a', text: 'alpha', isCreatedByUser: true }),
        buildMessage({ messageId: 'b', text: 'bravo' }),
        buildMessage({ messageId: 'c', text: 'charlie', isCreatedByUser: true }),
      ];
      const { container } = renderNav(messages);
      const column = getColumn(container);
      column.getBoundingClientRect = () => COLUMN_RECT;

      act(() => {
        fireEvent.pointerMove(column, { pointerId: 1, clientY: 5 });
        jest.advanceTimersByTime(20);
      });

      const ribs = messageRibs(container);
      const highlighted = ribs.filter((r) =>
        r.querySelector('span')?.className.includes('bg-text-primary'),
      );
      expect(highlighted).toHaveLength(1);
      expect(highlighted[0]).toHaveAttribute('data-msg-id', 'a');
    });
  });

  describe('keyboard accessibility', () => {
    function setupFocusableNav() {
      const messages = [
        buildMessage({ messageId: 'a', text: 'alpha', isCreatedByUser: true }),
        buildMessage({ messageId: 'b', text: 'bravo' }),
        buildMessage({ messageId: 'c', text: 'charlie', isCreatedByUser: true }),
      ];
      const result = renderNav(messages);
      const column = getColumn(result.container);
      column.getBoundingClientRect = () => COLUMN_RECT;
      return { ...result, column };
    }

    it('highlights and previews a rib when it receives keyboard focus, like hover', () => {
      const { container, column } = setupFocusableNav();
      const ribA = container.querySelector('[data-msg-id="a"]') as HTMLElement;

      act(() => {
        ribA.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        jest.advanceTimersByTime(80);
      });

      expect(ribA.querySelector('span')?.className).toContain('bg-text-primary');
      const tip = document.body.querySelector('[role="tooltip"]');
      expect(tip).not.toBeNull();
      expect(tip).toHaveTextContent('alpha');
      expect(column).toBeDefined();
    });

    it('clears the highlight and preview when focus leaves the rail', () => {
      const { container } = setupFocusableNav();
      const ribA = container.querySelector('[data-msg-id="a"]') as HTMLElement;

      act(() => {
        ribA.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        jest.advanceTimersByTime(80);
      });
      act(() => {
        ribA.dispatchEvent(
          new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body }),
        );
      });

      expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
      /** Only the current rib keeps the strong tone; the previewed rib returns
       *  to the band. The rail must never lose its "you are here" mark just
       *  because focus left it. */
      const strong = messageRibs(container).filter((rib) =>
        rib.querySelector('span')?.className.includes('bg-text-primary'),
      );
      expect(strong.map((rib) => rib.getAttribute('data-msg-id'))).toEqual(['a']);
      expect(strong[0].getAttribute('aria-current')).toBe('true');
    });
  });

  describe('preview live sync', () => {
    it('refreshes the open tooltip text when the hovered message updates in place', () => {
      const messages = [
        buildMessage({ messageId: 'a', text: 'alpha', isCreatedByUser: true }),
        buildMessage({ messageId: 'b', text: 'bravo' }),
        buildMessage({ messageId: 'c', text: 'charlie', isCreatedByUser: true }),
      ];
      const { container } = renderNav(messages);
      const column = getColumn(container);
      column.getBoundingClientRect = () => COLUMN_RECT;

      act(() => {
        fireEvent.pointerMove(column, { pointerId: 1, clientY: 5 });
        jest.advanceTimersByTime(80);
      });
      expect(document.body.querySelector('[role="tooltip"]')).toHaveTextContent('alpha');

      // Message text updates in place (e.g. streaming). A re-render happens without
      // the pointer leaving the rail; the tooltip should reflect the new preview.
      mockUseGetMessagesByConvoId.mockReturnValue({
        data: [
          buildMessage({ messageId: 'a', text: 'alpha streamed more', isCreatedByUser: true }),
          buildMessage({ messageId: 'b', text: 'bravo' }),
          buildMessage({ messageId: 'c', text: 'charlie', isCreatedByUser: true }),
        ],
      });
      const io = MockIntersectionObserver.last();
      act(() => {
        io!.trigger([{ target: document.getElementById('a')!, isIntersecting: true }]);
        jest.advanceTimersByTime(20);
      });
      act(() => {
        jest.advanceTimersByTime(260);
      });

      expect(document.body.querySelector('[role="tooltip"]')).toHaveTextContent(
        'alpha streamed more',
      );
    });
  });

  describe('browser compatibility', () => {
    it('uses legacy MediaQueryList listeners when addEventListener is unavailable', () => {
      const original = window.matchMedia;
      const addListener = jest.fn();
      const removeListener = jest.fn();
      window.matchMedia = (() => ({ matches: false, addListener, removeListener })) as never;
      try {
        const messages = [
          buildMessage({ messageId: 'a', text: 'alpha', isCreatedByUser: true }),
          buildMessage({ messageId: 'b', text: 'bravo' }),
          buildMessage({ messageId: 'c', text: 'charlie', isCreatedByUser: true }),
        ];
        let result: ReturnType<typeof renderNav> | undefined;
        expect(() => {
          result = renderNav(messages);
        }).not.toThrow();
        expect(addListener).toHaveBeenCalledTimes(1);
        result?.unmount();
        expect(removeListener).toHaveBeenCalledTimes(1);
      } finally {
        window.matchMedia = original;
      }
    });
  });

  describe('drag to scroll', () => {
    function setupDraggableNav() {
      const messages = Array.from({ length: 5 }, (_, i) =>
        buildMessage({
          messageId: `m-${i}`,
          text: `message ${i}`,
          isCreatedByUser: i % 2 === 0,
        }),
      );
      const restoreLayout = stubRibLayout(messages.map((m) => m.messageId));
      const result = renderNav(messages);
      const column = getColumn(result.container);
      column.getBoundingClientRect = () => COLUMN_RECT;

      const ribs = Array.from(column.querySelectorAll('[data-msg-id]')) as HTMLElement[];

      const writes: number[] = [];
      Object.defineProperty(result.scrollable, 'scrollTop', {
        get: () => 0,
        set: (v: number) => {
          writes.push(v);
        },
        configurable: true,
      });

      return { ...result, column, ribs, writes, restoreLayout };
    }

    it('scrubs the conversation while dragging past the threshold', () => {
      const { column, writes } = setupDraggableNav();

      act(() => {
        fireEvent.pointerDown(column, { pointerId: 1, button: 0, buttons: 1, clientY: 0 });
        fireEvent.pointerMove(document, { pointerId: 1, buttons: 1, clientY: 25 });
      });

      expect(writes.length).toBeGreaterThan(0);
    });

    it('keeps tracking the drag after the pointer leaves the narrow column', () => {
      const { column, writes } = setupDraggableNav();

      act(() => {
        fireEvent.pointerDown(column, { pointerId: 1, button: 0, buttons: 1, clientY: 0 });
        // pointer has moved off the column; the move bubbles to the document listener
        fireEvent.pointerMove(document.body, { pointerId: 1, buttons: 1, clientY: 25 });
      });

      expect(writes.length).toBeGreaterThan(0);
    });

    it('lands on the rib under the pointer, not a proportional index', () => {
      // Ribs sit on a 12px pitch, so 25 is inside m-2 and 50 inside m-4. A
      // mapping built from the pointer's fraction of the column's *visible*
      // height across the *whole* rib list answers with neither once the rail
      // scrolls, and disagrees with the preview, which is nearest-centre.
      const { column, restoreLayout } = setupDraggableNav();
      const getById = jest.spyOn(document, 'getElementById');

      act(() => {
        fireEvent.pointerDown(column, { pointerId: 1, button: 0, buttons: 1, clientY: 0 });
        fireEvent.pointerMove(document, { pointerId: 1, buttons: 1, clientY: 25 });
      });
      expect(getById.mock.calls.map((c) => c[0])).toContain('m-2');

      getById.mockClear();
      act(() => {
        fireEvent.pointerMove(document, { pointerId: 1, buttons: 1, clientY: 50 });
      });
      expect(getById.mock.calls.map((c) => c[0])).toContain('m-4');

      getById.mockRestore();
      restoreLayout();
    });

    it('keeps scrubbing honest once the rail has scrolled under the pointer', () => {
      // The column carries its own scroll in a long thread. Reading the pointer
      // in the column's content space is what keeps a scrolled rail pointing at
      // the rib the reader can actually see.
      const { column, restoreLayout } = setupDraggableNav();
      Object.defineProperty(column, 'scrollTop', { value: 24, writable: true, configurable: true });
      const getById = jest.spyOn(document, 'getElementById');

      act(() => {
        fireEvent.pointerDown(column, { pointerId: 1, button: 0, buttons: 1, clientY: 0 });
        fireEvent.pointerMove(document, { pointerId: 1, buttons: 1, clientY: 15 });
      });

      /** contentY = 15 + 24 = 39, the centre of rib 3. Read without the rail's
       *  own scroll it would be 15 — the centre of rib 1, two messages off. */
      const scrubbed = getById.mock.calls.map((c) => c[0]);
      expect(scrubbed).toContain('m-3');
      expect(scrubbed).not.toContain('m-1');
      getById.mockRestore();
      restoreLayout();
    });

    it('does not scrub for movement under the threshold', () => {
      const { column, writes } = setupDraggableNav();

      act(() => {
        fireEvent.pointerDown(column, { pointerId: 1, button: 0, buttons: 1, clientY: 0 });
        fireEvent.pointerMove(document, { pointerId: 1, buttons: 1, clientY: 2 });
      });

      expect(writes.length).toBe(0);
    });

    it('ignores pointer moves after the interaction ends', () => {
      const { column, writes } = setupDraggableNav();

      act(() => {
        fireEvent.pointerDown(column, { pointerId: 1, button: 0, buttons: 1, clientY: 0 });
        fireEvent.pointerUp(document, { pointerId: 1, clientY: 0 });
      });
      act(() => {
        fireEvent.pointerMove(document, { pointerId: 1, buttons: 1, clientY: 40 });
      });

      expect(writes.length).toBe(0);
    });

    it('ends the drag when the primary button is released during a move', () => {
      const { column, writes } = setupDraggableNav();

      act(() => {
        fireEvent.pointerDown(column, { pointerId: 1, button: 0, buttons: 1, clientY: 0 });
        fireEvent.pointerMove(document, { pointerId: 1, buttons: 1, clientY: 25 });
        fireEvent.pointerMove(document, { pointerId: 1, buttons: 0, clientY: 30 });
      });
      const before = writes.length;
      act(() => {
        fireEvent.pointerMove(document, { pointerId: 1, buttons: 1, clientY: 45 });
      });

      expect(writes.length).toBe(before);
    });

    it('ends the drag when the window loses focus', () => {
      const { column, writes } = setupDraggableNav();

      act(() => {
        fireEvent.pointerDown(column, { pointerId: 1, button: 0, buttons: 1, clientY: 0 });
        fireEvent.pointerMove(document, { pointerId: 1, buttons: 1, clientY: 25 });
        window.dispatchEvent(new Event('blur'));
      });
      const before = writes.length;
      act(() => {
        fireEvent.pointerMove(document, { pointerId: 1, buttons: 1, clientY: 45 });
      });

      expect(writes.length).toBe(before);
    });

    it('tears down a previous drag when a new pointer starts', () => {
      const { column, writes } = setupDraggableNav();

      act(() => {
        fireEvent.pointerDown(column, { pointerId: 1, button: 0, buttons: 1, clientY: 0 });
        fireEvent.pointerMove(document, { pointerId: 1, buttons: 1, clientY: 25 });
      });
      act(() => {
        fireEvent.pointerDown(column, { pointerId: 2, button: 0, buttons: 1, clientY: 0 });
      });
      const before = writes.length;
      act(() => {
        fireEvent.pointerMove(document, { pointerId: 1, buttons: 1, clientY: 45 });
      });

      expect(writes.length).toBe(before);
    });

    it('selects via the native click when a press does not become a drag', () => {
      const { column, ribs } = setupDraggableNav();

      act(() => {
        fireEvent.pointerDown(column, { pointerId: 1, button: 0, buttons: 1, clientY: 0 });
        fireEvent.pointerUp(document, { pointerId: 1, clientY: 0 });
      });
      act(() => {
        fireEvent.click(ribs[0]);
      });

      expect(document.activeElement).toBe(document.getElementById('m-0'));
    });

    it('suppresses the click that immediately follows a drag', () => {
      const { column, ribs } = setupDraggableNav();

      act(() => {
        fireEvent.pointerDown(column, { pointerId: 1, button: 0, buttons: 1, clientY: 0 });
        fireEvent.pointerMove(document, { pointerId: 1, buttons: 1, clientY: 25 });
        fireEvent.pointerUp(document, { pointerId: 1, clientY: 25 });
      });

      act(() => {
        fireEvent.click(ribs[0]);
      });

      expect(document.activeElement).not.toBe(document.getElementById('m-0'));
    });

    it('clears click suppression after the drag so a later activation is honored', () => {
      const { column, ribs } = setupDraggableNav();

      act(() => {
        fireEvent.pointerDown(column, { pointerId: 1, button: 0, buttons: 1, clientY: 0 });
        fireEvent.pointerMove(document, { pointerId: 1, buttons: 1, clientY: 25 });
        fireEvent.pointerUp(document, { pointerId: 1, clientY: 25 });
        jest.advanceTimersByTime(1);
      });

      act(() => {
        fireEvent.click(ribs[0]);
      });

      expect(document.activeElement).toBe(document.getElementById('m-0'));
    });
  });

  describe('observers', () => {
    it('observes each message on mount', () => {
      const messages = [
        buildMessage({ messageId: 'a', text: 'alpha', isCreatedByUser: true }),
        buildMessage({ messageId: 'b', text: 'bravo' }),
        buildMessage({ messageId: 'c', text: 'charlie', isCreatedByUser: true }),
      ];
      renderNav(messages);
      const io = MockIntersectionObserver.last();
      expect(io).toBeDefined();
      expect(io!.observed.size).toBe(3);
      expect(io!.observe).toHaveBeenCalledTimes(3);
    });

    it('reuses the same IntersectionObserver when entries change', async () => {
      const messages = [
        buildMessage({ messageId: 'a', text: 'alpha', isCreatedByUser: true }),
        buildMessage({ messageId: 'b', text: 'bravo' }),
        buildMessage({ messageId: 'c', text: 'charlie', isCreatedByUser: true }),
      ];
      const { scrollable } = renderNav(messages);

      const instanceCountAfterMount = MockIntersectionObserver.instances.length;
      const io = MockIntersectionObserver.last()!;
      const initialObserveCalls = io.observe.mock.calls.length;
      const initialUnobserveCalls = io.unobserve.mock.calls.length;

      const newMsg = document.createElement('div');
      newMsg.id = 'd';
      newMsg.className = 'message-render';
      newMsg.textContent = 'delta';
      Object.defineProperty(newMsg, 'offsetTop', { value: 800 });
      Object.defineProperty(newMsg, 'offsetHeight', { value: 150 });

      await act(async () => {
        scrollable.firstElementChild!.appendChild(newMsg);
        await Promise.resolve();
      });
      mockUseGetMessagesByConvoId.mockReturnValue({
        data: [...messages, buildMessage({ messageId: 'd', text: 'delta' })],
      });
      await act(async () => {
        jest.advanceTimersByTime(250);
        await Promise.resolve();
      });

      expect(MockIntersectionObserver.instances.length).toBe(instanceCountAfterMount);
      expect(io.observe.mock.calls.length).toBe(initialObserveCalls + 1);
      expect(io.unobserve.mock.calls.length).toBe(initialUnobserveCalls);
    });

    it('unobserves messages that are removed', async () => {
      const messages = [
        buildMessage({ messageId: 'a', text: 'alpha', isCreatedByUser: true }),
        buildMessage({ messageId: 'b', text: 'bravo' }),
        buildMessage({ messageId: 'c', text: 'charlie', isCreatedByUser: true }),
        buildMessage({ messageId: 'd', text: 'delta' }),
      ];
      const { scrollable } = renderNav(messages);
      const io = MockIntersectionObserver.last()!;
      const initialUnobserve = io.unobserve.mock.calls.length;

      const removed = document.getElementById('d');
      await act(async () => {
        removed?.remove();
        await Promise.resolve();
      });
      mockUseGetMessagesByConvoId.mockReturnValue({ data: messages.slice(0, 3) });
      await act(async () => {
        jest.advanceTimersByTime(250);
        await Promise.resolve();
      });

      expect(io.unobserve.mock.calls.length).toBeGreaterThan(initialUnobserve);
      expect(scrollable.contains(removed as Node)).toBe(false);
    });

    it('disconnects the IntersectionObserver on unmount', () => {
      const messages = [
        buildMessage({ messageId: 'a', text: 'alpha', isCreatedByUser: true }),
        buildMessage({ messageId: 'b', text: 'bravo' }),
        buildMessage({ messageId: 'c', text: 'charlie', isCreatedByUser: true }),
      ];
      const { unmount } = renderNav(messages);
      const io = MockIntersectionObserver.last()!;
      expect(io.disconnect).not.toHaveBeenCalled();
      unmount();
      expect(io.disconnect).toHaveBeenCalled();
    });
  });

  describe('dom-driven refresh', () => {
    it('refreshes entries when a .message-render id attribute changes (SSE lifecycle)', async () => {
      const messages = [
        buildMessage({ messageId: 'client-uuid', text: 'streaming', isCreatedByUser: false }),
        buildMessage({ messageId: 'b', text: 'bravo', isCreatedByUser: true }),
        buildMessage({ messageId: 'c', text: 'charlie', isCreatedByUser: true }),
      ];
      const { container } = renderNav(messages);
      expect(container.querySelector('[data-msg-id="client-uuid"]')).not.toBeNull();

      const streamingNode = document.getElementById('client-uuid') as HTMLElement;
      await act(async () => {
        streamingNode.id = 'server-id';
        await Promise.resolve();
      });
      mockUseGetMessagesByConvoId.mockReturnValue({
        data: [buildMessage({ messageId: 'server-id', text: 'streaming' }), ...messages.slice(1)],
      });
      await act(async () => {
        jest.advanceTimersByTime(250);
        await Promise.resolve();
      });

      expect(container.querySelector('[data-msg-id="client-uuid"]')).toBeNull();
      expect(container.querySelector('[data-msg-id="server-id"]')).not.toBeNull();
    });

    it('refreshes entries when a .message-render is added via MutationObserver', async () => {
      const messages = [
        buildMessage({ messageId: 'a', text: 'alpha', isCreatedByUser: true }),
        buildMessage({ messageId: 'b', text: 'bravo' }),
        buildMessage({ messageId: 'c', text: 'charlie', isCreatedByUser: true }),
      ];
      const { container, scrollable } = renderNav(messages);
      expect(messageRibs(container)).toHaveLength(3);

      const newMsg = document.createElement('div');
      newMsg.id = 'd';
      newMsg.className = 'message-render';
      newMsg.textContent = 'delta';
      Object.defineProperty(newMsg, 'offsetTop', { value: 800 });
      Object.defineProperty(newMsg, 'offsetHeight', { value: 150 });

      await act(async () => {
        scrollable.firstElementChild!.appendChild(newMsg);
        await Promise.resolve();
      });
      await act(async () => {
        jest.advanceTimersByTime(250);
        await Promise.resolve();
      });

      expect(messageRibs(container)).toHaveLength(4);
      expect(container.querySelector('[data-msg-id="d"]')).not.toBeNull();
    });
  });

  describe('end-of-conversation indicator', () => {
    function buildDomWithEnd(
      messages: TestMessage[],
      opts: { endOffsetTop?: number; scrollTop?: number } = {},
    ) {
      const scrollable = document.createElement('div');
      scrollable.className = 'scrollbar-gutter-stable';
      Object.defineProperty(scrollable, 'clientHeight', { value: 600, configurable: true });
      Object.defineProperty(scrollable, 'scrollHeight', { value: 3000, configurable: true });
      Object.defineProperty(scrollable, 'scrollTop', {
        value: opts.scrollTop ?? 0,
        writable: true,
        configurable: true,
      });

      const content = document.createElement('div');
      content.className = 'flex flex-col';
      scrollable.appendChild(content);

      for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        const div = document.createElement('div');
        div.id = m.messageId;
        div.className = 'message-render';
        div.textContent = m.text ?? '';
        Object.defineProperty(div, 'offsetTop', { value: 100 + i * 200, configurable: true });
        Object.defineProperty(div, 'offsetHeight', { value: 150, configurable: true });
        content.appendChild(div);
      }

      const end = document.createElement('div');
      end.id = 'messages-end';
      Object.defineProperty(end, 'offsetTop', {
        value: opts.endOffsetTop ?? 100 + messages.length * 200,
        configurable: true,
      });
      Object.defineProperty(end, 'offsetHeight', { value: 0, configurable: true });
      content.appendChild(end);

      document.body.appendChild(scrollable);
      return { scrollable, content, end };
    }

    function renderNavWithEnd(
      messages: TestMessage[],
      opts?: { endOffsetTop?: number; scrollTop?: number },
    ) {
      mockUseGetMessagesByConvoId.mockReturnValue({ data: messages });
      const dom = buildDomWithEnd(messages, opts);
      const scrollableRef = { current: dom.scrollable } as RefObject<HTMLDivElement>;
      const result = render(<MessageNav scrollableRef={scrollableRef} />);
      act(() => {
        jest.advanceTimersByTime(250);
      });
      return { ...result, ...dom, scrollableRef };
    }

    const threeMessages = (): TestMessage[] => [
      buildMessage({ messageId: 'a', text: 'alpha', isCreatedByUser: true }),
      buildMessage({ messageId: 'b', text: 'bravo' }),
      buildMessage({ messageId: 'c', text: 'charlie', isCreatedByUser: true }),
    ];

    it('appends a terminus indicator as the last rib when #messages-end exists', () => {
      const { container } = renderNavWithEnd(threeMessages());
      const ribs = container.querySelectorAll('[data-msg-id]');
      expect(ribs).toHaveLength(5);
      expect(ribs[0].getAttribute('data-msg-id')).toBe('messages-start');
      expect(ribs[0].getAttribute('aria-label')).toBe('com_ui_scroll_to_top');
      expect(ribs[4].getAttribute('data-msg-id')).toBe('messages-end');
      expect(ribs[4].getAttribute('aria-label')).toBe('com_ui_scroll_to_bottom');
    });

    it('pins the terminus outside the scrolling column, between it and the next chevron', () => {
      const { container } = renderNavWithEnd(threeMessages());
      const nav = container.querySelector('nav') as HTMLElement;
      const column = getColumn(container);

      expect(column.querySelector('[data-msg-id="messages-end"]')).toBeNull();
      expect(nav.querySelector('[data-msg-id="messages-end"]')).not.toBeNull();

      const kids = Array.from(nav.children);
      const endIndex = kids.findIndex((k) => k.querySelector('[data-msg-id="messages-end"]'));
      const nextIndex = kids.findIndex(
        (k) => k.getAttribute('aria-label') === 'com_ui_message_nav_next',
      );
      expect(endIndex).toBe(kids.indexOf(column) + 1);
      expect(nextIndex).toBe(endIndex + 1);
    });

    it('keeps column children aligned with message entries once the terminus is pinned', () => {
      const messages = Array.from({ length: 5 }, (_, i) =>
        buildMessage({ messageId: `m-${i}`, text: `message ${i}`, isCreatedByUser: i % 2 === 0 }),
      );
      const { container } = renderNavWithEnd(messages);
      const column = getColumn(container);

      expect(column.children).toHaveLength(messages.length);
      for (let i = 0; i < messages.length; i++) {
        expect(column.children[i].getAttribute('data-msg-id')).toBe(`m-${i}`);
      }
    });

    it('centers the column on the visible window using the pinned-out child indices', () => {
      const messages = Array.from({ length: 10 }, (_, i) =>
        buildMessage({ messageId: `m-${i}`, text: `message ${i}`, isCreatedByUser: i % 2 === 0 }),
      );
      const { container, scrollable } = renderNavWithEnd(messages);
      const column = getColumn(container);

      Object.defineProperty(column, 'clientHeight', { value: 30, configurable: true });
      Object.defineProperty(column, 'scrollHeight', { value: 200, configurable: true });
      Object.defineProperty(column, 'scrollTop', { value: 0, writable: true, configurable: true });
      for (let i = 0; i < column.children.length; i++) {
        Object.defineProperty(column.children[i], 'offsetTop', { value: i * 10 });
        Object.defineProperty(column.children[i], 'offsetHeight', { value: 6 });
      }
      (scrollable as HTMLElement).scrollTop = 400;

      act(() => {
        fireEvent.scroll(scrollable);
        jest.advanceTimersByTime(32);
      });

      /** Visible rows m-1..m-4 → mid of ribs 1 and 4, minus half the column height. */
      expect(column.scrollTop).toBe(13);
    });

    it('scrubs to the rib under the pointer, not one past it, with the terminus pinned', () => {
      const messages = Array.from({ length: 5 }, (_, i) =>
        buildMessage({ messageId: `m-${i}`, text: `message ${i}`, isCreatedByUser: i % 2 === 0 }),
      );
      const restoreLayout = stubRibLayout(messages.map((m) => m.messageId));
      const { container } = renderNavWithEnd(messages);
      const column = getColumn(container);
      column.getBoundingClientRect = () => COLUMN_RECT;
      const getById = jest.spyOn(document, 'getElementById');

      act(() => {
        fireEvent.pointerDown(column, { pointerId: 1, button: 0, buttons: 1, clientY: 0 });
        fireEvent.pointerMove(document, { pointerId: 1, buttons: 1, clientY: 25 });
      });

      const scrubbed = getById.mock.calls.map((c) => c[0]);
      expect(scrubbed).toContain('m-2');
      expect(scrubbed).not.toContain('m-3');
      getById.mockRestore();
      restoreLayout();
    });

    it('peaks the fisheye and preview on the rib under the pointer', () => {
      const messages = Array.from({ length: 6 }, (_, i) =>
        buildMessage({ messageId: `m-${i}`, text: `message ${i}` }),
      );
      /** Rib i occupies [i*12, i*12+6] — a 6px rib on a 6px gap. */
      const restoreLayout = stubRibLayout(messages.map((m) => m.messageId));
      const { container } = renderNavWithEnd(messages);
      const column = getColumn(container);
      column.getBoundingClientRect = () =>
        ({
          top: 0,
          bottom: messages.length * 12,
          height: messages.length * 12,
          left: 0,
          right: 0,
        }) as DOMRect;

      act(() => {
        fireEvent.pointerMove(column, { pointerId: 1, clientY: 3 * 12 + 3 });
        jest.advanceTimersByTime(80);
      });

      expect(document.body.querySelector('[role="tooltip"]')).toHaveTextContent('message 3');
      const emphasized = messageRibs(container).filter((r) =>
        r.querySelector('span')?.className.includes('bg-text-primary'),
      );
      /** The previewed rib joins the current one at full strength; it does not
       *  replace it, so the rail never loses its "you are here" mark on hover. */
      expect(emphasized.map((r) => r.getAttribute('data-msg-id'))).toEqual(['m-0', 'm-3']);
      restoreLayout();
    });

    it('starts a scrub drag from the pinned terminus', () => {
      const messages = Array.from({ length: 5 }, (_, i) =>
        buildMessage({ messageId: `m-${i}`, text: `message ${i}`, isCreatedByUser: i % 2 === 0 }),
      );
      const restoreLayout = stubRibLayout(messages.map((m) => m.messageId));
      const { container, scrollable } = renderNavWithEnd(messages);
      const column = getColumn(container);
      column.getBoundingClientRect = () => COLUMN_RECT;
      const wrapper = container.querySelector('[data-msg-id="messages-end"]')!
        .parentElement as HTMLElement;
      const getById = jest.spyOn(document, 'getElementById');

      act(() => {
        fireEvent.pointerDown(wrapper, { pointerId: 1, button: 0, buttons: 1, clientY: 60 });
        fireEvent.pointerMove(document, { pointerId: 1, buttons: 1, clientY: 3 });
      });

      expect(getById.mock.calls.map((c) => c[0])).toContain('m-0');
      getById.mockRestore();
      restoreLayout();
      expect(scrollable).toBeDefined();
    });

    it('pins an origin rib above the column that scrolls the thread to the top', () => {
      const { container, scrollable } = renderNavWithEnd(threeMessages());
      const nav = container.querySelector('nav') as HTMLElement;
      const column = getColumn(container);
      const origin = container.querySelector('[data-msg-id="messages-start"]') as HTMLElement;

      expect(column.querySelector('[data-msg-id="messages-start"]')).toBeNull();
      const kids = Array.from(nav.children);
      const originIndex = kids.findIndex((k) => k.querySelector('[data-msg-id="messages-start"]'));
      const prevIndex = kids.findIndex(
        (k) => k.getAttribute('aria-label') === 'com_ui_message_nav_previous',
      );
      expect(originIndex).toBe(prevIndex + 1);
      expect(originIndex).toBe(kids.indexOf(column) - 1);

      const scrollTo = jest.fn();
      (scrollable as HTMLElement).scrollTo = scrollTo;
      act(() => {
        fireEvent.click(origin);
      });
      expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
    });

    it('previews the origin on hover', () => {
      const { container } = renderNavWithEnd(threeMessages());
      const wrapper = container.querySelector('[data-msg-id="messages-start"]')!
        .parentElement as HTMLElement;

      act(() => {
        fireEvent.pointerEnter(wrapper, { pointerId: 1, clientY: 5 });
        jest.advanceTimersByTime(80);
      });
      expect(document.body.querySelector('[role="tooltip"]')).toHaveTextContent(
        'com_ui_scroll_to_top',
      );
    });

    it('leaves the origin out of the current mark, so only one entry is current', () => {
      const { container } = renderNavWithEnd(threeMessages());
      expect(container.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
      expect(
        container.querySelector('[data-msg-id="messages-start"]')?.getAttribute('aria-current'),
      ).toBeNull();
    });

    it('moves the tab stop to the last message once the reader reaches the bottom', () => {
      const { container, scrollable } = renderNavWithEnd(
        Array.from({ length: 5 }, (_, i) =>
          buildMessage({ messageId: `m-${i}`, text: `message ${i}` }),
        ),
      );

      (scrollable as HTMLElement).scrollTop = 2400;
      act(() => {
        fireEvent.scroll(scrollable);
        jest.advanceTimersByTime(32);
      });

      expect(container.querySelector('[aria-current="true"]')?.getAttribute('data-msg-id')).toBe(
        'messages-end',
      );
      const stops = messageRibs(container).filter((rib) => rib.getAttribute('tabindex') === '0');
      expect(stops).toHaveLength(1);
      expect(stops[0].getAttribute('data-msg-id')).toBe('m-4');
    });

    it('previews the terminus on hover even though it sits outside the column', () => {
      const { container } = renderNavWithEnd(threeMessages());
      const wrapper = container.querySelector('[data-msg-id="messages-end"]')!
        .parentElement as HTMLElement;

      act(() => {
        fireEvent.pointerEnter(wrapper, { pointerId: 1, clientY: 5 });
        jest.advanceTimersByTime(80);
      });
      expect(document.body.querySelector('[role="tooltip"]')).toHaveTextContent(
        'com_ui_scroll_to_bottom',
      );

      act(() => {
        fireEvent.pointerLeave(wrapper, { pointerId: 1 });
      });
      expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    });

    it('previews the terminus when it takes keyboard focus', () => {
      const { container } = renderNavWithEnd(threeMessages());
      const endRib = container.querySelector('[data-msg-id="messages-end"]') as HTMLElement;

      act(() => {
        endRib.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        jest.advanceTimersByTime(80);
      });
      expect(document.body.querySelector('[role="tooltip"]')).toHaveTextContent(
        'com_ui_scroll_to_bottom',
      );

      act(() => {
        endRib.dispatchEvent(
          new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body }),
        );
      });
      expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    });

    it('omits the terminus indicator and the nav when there are fewer than 3 messages', () => {
      const messages = [
        buildMessage({ messageId: 'a', text: 'alpha', isCreatedByUser: true }),
        buildMessage({ messageId: 'b', text: 'bravo' }),
      ];
      const { container } = renderNavWithEnd(messages);
      expect(container.querySelector('nav')).toBeNull();
    });

    it('scrolls toward the bottom without moving focus when the terminus is clicked', () => {
      const { container } = renderNavWithEnd(threeMessages());
      const rafSpy = jest.spyOn(window, 'requestAnimationFrame');
      const endRib = container.querySelector('[data-msg-id="messages-end"]') as HTMLButtonElement;

      act(() => {
        fireEvent.click(endRib);
      });

      expect(rafSpy).toHaveBeenCalled();
      const end = document.getElementById('messages-end');
      expect(document.activeElement).not.toBe(end);
      expect(end?.hasAttribute('tabindex')).toBe(false);
      rafSpy.mockRestore();
    });

    it('keeps the next chevron disabled at the bottom even when the terminus sits below max scroll', () => {
      const { container, scrollable } = renderNavWithEnd(threeMessages(), { endOffsetTop: 2900 });

      Object.defineProperty(scrollable, 'scrollTop', {
        value: 2400,
        writable: true,
        configurable: true,
      });
      act(() => {
        fireEvent.scroll(scrollable);
        jest.advanceTimersByTime(32);
      });

      const prev = container.querySelector(
        'button[aria-label="com_ui_message_nav_previous"]',
      ) as HTMLButtonElement;
      const next = container.querySelector(
        'button[aria-label="com_ui_message_nav_next"]',
      ) as HTMLButtonElement;

      expect(next.disabled).toBe(true);
      expect(prev.disabled).toBe(false);
    });

    it('scrubs to the terminus when dragging to the bottom of the column', () => {
      const messages = Array.from({ length: 5 }, (_, i) =>
        buildMessage({
          messageId: `m-${i}`,
          text: `message ${i}`,
          isCreatedByUser: i % 2 === 0,
        }),
      );
      const { container, scrollable } = renderNavWithEnd(messages);
      const column = getColumn(container);
      column.getBoundingClientRect = () => COLUMN_RECT;
      const qs = jest.spyOn(scrollable, 'querySelector');

      act(() => {
        fireEvent.pointerDown(column, { pointerId: 1, button: 0, buttons: 1, clientY: 0 });
        fireEvent.pointerMove(document, { pointerId: 1, buttons: 1, clientY: 50 });
      });

      expect(qs.mock.calls.some((c) => String(c[0]).includes('messages-end'))).toBe(true);
      qs.mockRestore();
    });

    it('resolves the terminus within its own container across multiple mounted navs', () => {
      const messagesA = [
        buildMessage({ messageId: 'a1', text: 'one', isCreatedByUser: true }),
        buildMessage({ messageId: 'a2', text: 'two' }),
        buildMessage({ messageId: 'a3', text: 'three', isCreatedByUser: true }),
      ];
      const messagesB = [
        buildMessage({ messageId: 'b1', text: 'alpha', isCreatedByUser: true }),
        buildMessage({ messageId: 'b2', text: 'beta' }),
        buildMessage({ messageId: 'b3', text: 'gamma', isCreatedByUser: true }),
      ];

      mockUseGetMessagesByConvoId.mockReturnValue({ data: messagesA });
      const domA = buildDomWithEnd(messagesA);
      render(
        <MessageNav scrollableRef={{ current: domA.scrollable } as RefObject<HTMLDivElement>} />,
      );
      act(() => {
        jest.advanceTimersByTime(250);
      });

      mockUseGetMessagesByConvoId.mockReturnValue({ data: messagesB });
      const domB = buildDomWithEnd(messagesB);
      const { container: navB } = render(
        <MessageNav scrollableRef={{ current: domB.scrollable } as RefObject<HTMLDivElement>} />,
      );
      act(() => {
        jest.advanceTimersByTime(250);
      });

      const qsA = jest.spyOn(domA.scrollable, 'querySelector');
      const qsB = jest.spyOn(domB.scrollable, 'querySelector');

      const endRibB = navB.querySelector('[data-msg-id="messages-end"]') as HTMLButtonElement;
      act(() => {
        fireEvent.click(endRibB);
      });

      expect(qsB.mock.calls.some((c) => String(c[0]).includes('messages-end'))).toBe(true);
      expect(qsA.mock.calls.some((c) => String(c[0]).includes('messages-end'))).toBe(false);
      qsA.mockRestore();
      qsB.mockRestore();
    });
  });

  describe('a pending response', () => {
    function streamingMessages(): TestMessage[] {
      return [
        buildMessage({ messageId: 'a', text: 'alpha', isCreatedByUser: true }),
        buildMessage({ messageId: 'b', text: 'bravo' }),
        buildMessage({ messageId: 'c', text: 'charlie', isCreatedByUser: true }),
        /** A response mounts its row a frame before its first token. */
        buildMessage({ messageId: 'd', text: '', content: [] }),
      ];
    }

    it('names the pending state instead of labelling the rib with nothing', () => {
      mockUseMessagesSubmission.mockReturnValue({ isSubmitting: true });
      const { container } = renderNav(streamingMessages());
      const pending = container.querySelector('[data-msg-id="d"]') as HTMLElement;
      expect(pending.getAttribute('aria-label')).toBe(
        'com_ui_message_nav_go_to_assistant|{"0":"com_ui_generating"}',
      );
    });

    it('never opens an empty preview beside a rib with no text yet', () => {
      mockUseMessagesSubmission.mockReturnValue({ isSubmitting: true });
      const messages = streamingMessages();
      const restoreLayout = stubRibLayout(messages.map((m) => m.messageId));
      const { container } = renderNav(messages);
      const column = getColumn(container);
      column.getBoundingClientRect = () => COLUMN_RECT;

      act(() => {
        fireEvent.pointerMove(column, { pointerId: 1, clientY: 3 * 12 + 3 });
        jest.advanceTimersByTime(80);
      });

      const tip = document.body.querySelector('[role="tooltip"]');
      expect(tip).not.toBeNull();
      expect(tip).toHaveTextContent('com_ui_generating');
      restoreLayout();
    });

    it('does not call a settled message generating just because it has no text', () => {
      // Image-, tool-call- and reasoning-only messages carry no text part, so
      // reopening a finished thread would otherwise announce "Generating"
      // against them forever.
      mockUseMessagesSubmission.mockReturnValue({ isSubmitting: false });
      const { container } = renderNav(streamingMessages());
      const settled = container.querySelector('[data-msg-id="d"]') as HTMLElement;
      expect(settled.getAttribute('aria-label')).toBe(
        'com_ui_message_nav_go_to_assistant|{"0":"com_ui_message_nav_no_preview"}',
      );
    });

    it('only the tail of a live submission is pending, never an earlier gap', () => {
      mockUseMessagesSubmission.mockReturnValue({ isSubmitting: true });
      const { container } = renderNav([
        buildMessage({ messageId: 'a', text: 'alpha', isCreatedByUser: true }),
        /** A tool-call-only response part way up the thread. */
        buildMessage({ messageId: 'b', text: '', content: [] }),
        buildMessage({ messageId: 'c', text: 'charlie', isCreatedByUser: true }),
        buildMessage({ messageId: 'd', text: '', content: [] }),
      ]);
      expect(container.querySelector('[data-msg-id="b"]')?.getAttribute('aria-label')).toContain(
        'com_ui_message_nav_no_preview',
      );
      expect(container.querySelector('[data-msg-id="d"]')?.getAttribute('aria-label')).toContain(
        'com_ui_generating',
      );
    });

    it('reads the body, not the row chrome, so a pending row stays pending', () => {
      // An assistant row renders a VISIBLE h2 naming the sender before its
      // first token lands. Reading the whole row hands back that name, which
      // both invents a preview and masks the pending state entirely.
      const node = document.createElement('div');
      node.className = 'message-render';
      const header = document.createElement('h2');
      header.textContent = 'Claude';
      const body = document.createElement('div');
      body.setAttribute('data-testid', 'message-body');
      node.append(header, body);

      const entry = buildEntry(
        'a',
        asTMessage(buildMessage({ messageId: 'a', text: '', content: [] })),
        node,
      );
      expect(entry.preview).toBe('');
      expect(previewTextFor(entry, (k: string) => k, true)).toBe('com_ui_generating');
    });

    it('does not call the user turn generating while the reply has yet to mount', () => {
      // Between sending and the response's row mounting, the user's own turn is
      // the last entry; a submission in flight is not evidence that it is the
      // thing being generated.
      mockUseMessagesSubmission.mockReturnValue({ isSubmitting: true });
      const { container } = renderNav([
        buildMessage({ messageId: 'a', text: 'alpha', isCreatedByUser: true }),
        buildMessage({ messageId: 'b', text: 'bravo' }),
        /** An image-only turn the reader just sent: no text part at all. */
        buildMessage({ messageId: 'c', text: '', content: [], isCreatedByUser: true }),
      ]);
      const last = container.querySelector('[data-msg-id="c"]');
      expect(last?.getAttribute('aria-label')).toContain('com_ui_message_nav_no_preview');
      expect(last?.getAttribute('aria-label')).not.toContain('com_ui_generating');
    });

    it('reads the rendered row when the message itself carries no text part', () => {
      // A tool card still says something on screen; that is a better preview
      // than any placeholder.
      const node = document.createElement('div');
      node.className = 'message-render';
      node.textContent = 'Searched the web';
      const entry = buildEntry(
        'a',
        asTMessage(buildMessage({ messageId: 'a', text: '', content: [] })),
        node,
      );
      expect(entry.preview).toBe('Searched the web');
    });

    it('prefers the body over the header when the row has both', () => {
      const node = document.createElement('div');
      node.className = 'message-render';
      const header = document.createElement('h2');
      header.textContent = 'Claude';
      const body = document.createElement('div');
      body.setAttribute('data-testid', 'message-body');
      body.textContent = 'Searched the web';
      node.append(header, body);
      const entry = buildEntry(
        'a',
        asTMessage(buildMessage({ messageId: 'a', text: '', content: [] })),
        node,
      );
      expect(entry.preview).toBe('Searched the web');
    });
  });

  describe('rail navigation', () => {
    function renderRail(count = 6) {
      const messages = Array.from({ length: count }, (_, i) =>
        buildMessage({ messageId: `m-${i}`, text: `message ${i}`, isCreatedByUser: i % 2 === 0 }),
      );
      const result = renderNav(messages);
      return { ...result, messages };
    }

    it('puts exactly one rib of the column in the tab order, and it is the current one', () => {
      const { container } = renderRail();
      const ribs = messageRibs(container);
      const stops = ribs.filter((rib) => rib.getAttribute('tabindex') === '0');
      expect(stops).toHaveLength(1);
      expect(stops[0].getAttribute('aria-current')).toBe('true');
    });

    it('walks the ribs with the arrow keys and jumps to the ends with Home and End', () => {
      const { container } = renderRail();
      const column = getColumn(container);
      const ribs = messageRibs(container);

      act(() => {
        ribs[0].focus();
      });
      act(() => {
        fireEvent.keyDown(column, { key: 'ArrowDown' });
      });
      expect(document.activeElement).toBe(ribs[1]);

      act(() => {
        fireEvent.keyDown(column, { key: 'ArrowUp' });
      });
      expect(document.activeElement).toBe(ribs[0]);

      act(() => {
        fireEvent.keyDown(column, { key: 'End' });
      });
      expect(document.activeElement).toBe(ribs[ribs.length - 1]);

      act(() => {
        fireEvent.keyDown(column, { key: 'Home' });
      });
      expect(document.activeElement).toBe(ribs[0]);
    });

    it('moves the tab stop with arrow-key focus so the column keeps one stop', () => {
      // A roving tab stop left behind on the scroll-spy's current rib gives the
      // column two stops: Tab re-enters the rail it just left, and Shift+Tab
      // walks back into it instead of out.
      const { container } = renderRail();
      const column = getColumn(container);
      const ribs = messageRibs(container);
      expect(ribs[0].getAttribute('tabindex')).toBe('0');

      act(() => {
        ribs[0].focus();
      });
      act(() => {
        fireEvent.keyDown(column, { key: 'ArrowDown' });
        fireEvent.keyDown(column, { key: 'ArrowDown' });
      });

      expect(document.activeElement).toBe(ribs[2]);
      const stops = messageRibs(container).filter((rib) => rib.getAttribute('tabindex') === '0');
      expect(stops).toHaveLength(1);
      expect(stops[0]).toBe(ribs[2]);
    });

    it('returns the tab stop to the current rib once focus leaves the rail', () => {
      const { container } = renderRail();
      const column = getColumn(container);
      const ribs = messageRibs(container);

      act(() => {
        ribs[0].focus();
      });
      act(() => {
        fireEvent.keyDown(column, { key: 'End' });
      });
      expect(messageRibs(container).filter((r) => r.getAttribute('tabindex') === '0')[0]).toBe(
        ribs[ribs.length - 1],
      );

      act(() => {
        fireEvent.blur(column, { relatedTarget: document.body });
      });

      const stops = messageRibs(container).filter((rib) => rib.getAttribute('tabindex') === '0');
      expect(stops).toHaveLength(1);
      expect(stops[0].getAttribute('aria-current')).toBe('true');
    });

    it('does not run off either end of the rail', () => {
      const { container } = renderRail();
      const column = getColumn(container);
      const ribs = messageRibs(container);

      act(() => {
        ribs[0].focus();
      });
      act(() => {
        fireEvent.keyDown(column, { key: 'ArrowUp' });
      });
      expect(document.activeElement).toBe(ribs[0]);

      act(() => {
        ribs[ribs.length - 1].focus();
      });
      act(() => {
        fireEvent.keyDown(column, { key: 'ArrowDown' });
      });
      expect(document.activeElement).toBe(ribs[ribs.length - 1]);
    });

    it('redoes the hit test when the rail scrolls under a stationary pointer', () => {
      // Wheeling an overflowing rail moves the ribs without moving the pointer.
      // A cached content-space coordinate goes stale the moment it does, so the
      // preview — and the id a click in the gaps follows — stays on the rib that
      // used to be there.
      const messages = Array.from({ length: 10 }, (_, i) =>
        buildMessage({ messageId: `m-${i}`, text: `message ${i}` }),
      );
      const restoreLayout = stubRibLayout(messages.map((m) => m.messageId));
      const { container } = renderNav(messages);
      const column = getColumn(container);
      column.getBoundingClientRect = () =>
        ({ top: 0, bottom: 40, height: 40, left: 0, right: 0 }) as DOMRect;
      Object.defineProperty(column, 'scrollTop', { value: 0, writable: true, configurable: true });

      act(() => {
        fireEvent.pointerMove(column, { pointerId: 1, clientY: 15 });
        jest.advanceTimersByTime(80);
      });
      expect(document.body.querySelector('[role="tooltip"]')).toHaveTextContent('message 1');

      /** The pointer has not moved; the rail has scrolled two ribs under it. */
      column.scrollTop = 24;
      act(() => {
        fireEvent.scroll(column);
        jest.advanceTimersByTime(80);
      });
      expect(document.body.querySelector('[role="tooltip"]')).toHaveTextContent('message 3');

      /** And a click in the gaps follows the rib now under the pointer. */
      const getById = jest.spyOn(document, 'getElementById');
      act(() => {
        fireEvent.click(column);
      });
      expect(getById.mock.calls.map((c) => c[0])).toContain('m-3');
      getById.mockRestore();
      restoreLayout();
    });

    it('holds the rail still while the pointer is working it, and follows again after', () => {
      const messages = Array.from({ length: 10 }, (_, i) =>
        buildMessage({ messageId: `m-${i}`, text: `message ${i}`, isCreatedByUser: i % 2 === 0 }),
      );
      const restoreLayout = stubRibLayout(messages.map((m) => m.messageId));
      mockUseGetMessagesByConvoId.mockReturnValue({ data: messages });
      const { scrollable } = buildDom(messages);
      const scrollableRef = { current: scrollable } as RefObject<HTMLDivElement>;
      const { container } = render(<MessageNav scrollableRef={scrollableRef} />);
      act(() => {
        jest.advanceTimersByTime(250);
      });
      const column = getColumn(container);
      column.getBoundingClientRect = () => ({ top: 0, bottom: 30, height: 30 }) as DOMRect;
      Object.defineProperty(column, 'clientHeight', { value: 30, configurable: true });
      Object.defineProperty(column, 'scrollHeight', { value: 200, configurable: true });
      Object.defineProperty(column, 'scrollTop', { value: 0, writable: true, configurable: true });

      /** The reader browses the rail itself to reach a distant part of a thread
       *  too long for one column. */
      act(() => {
        fireEvent.pointerMove(column, { pointerId: 1, clientY: 10 });
      });
      column.scrollTop = 90;
      (scrollable as HTMLElement).scrollTop = 400;
      act(() => {
        fireEvent.scroll(scrollable);
        jest.advanceTimersByTime(32);
      });
      expect(column.scrollTop).toBe(90);

      act(() => {
        fireEvent.pointerLeave(column, { pointerId: 1 });
      });
      (scrollable as HTMLElement).scrollTop = 600;
      act(() => {
        fireEvent.scroll(scrollable);
        jest.advanceTimersByTime(32);
      });
      expect(column.scrollTop).not.toBe(90);
      restoreLayout();
    });
  });
});
