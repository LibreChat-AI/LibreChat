import { memo, useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { ChevronUp, ChevronDown } from 'lucide-react';
import { ContentTypes } from 'librechat-data-provider';
import type { TMessage, TMessageContentParts } from 'librechat-data-provider';
import { useMessagesConversation, useMessagesSubmission } from '~/Providers';
import { useGetMessagesByConvoId } from '~/data-provider';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

type MessageEntry = {
  id: string;
  isUser: boolean;
  preview: string;
  isEnd?: boolean;
  isStart?: boolean;
};

const MESSAGES_END_ID = 'messages-end';
/** The origin rib has no row of its own — it targets the top of the scroll
 *  container, mirroring the terminus that targets `#messages-end`. */
const MESSAGES_START_ID = 'messages-start';

function isTerminusId(id: string): boolean {
  return id === MESSAGES_END_ID || id === MESSAGES_START_ID;
}

export function extractPreviewFromContent(content?: TMessageContentParts[]): string {
  if (!content) {
    return '';
  }
  for (const part of content) {
    if (part?.type !== ContentTypes.TEXT) {
      continue;
    }
    const textField = part.text;
    if (typeof textField === 'string' && textField.trim()) {
      return textField;
    }
    if (textField && typeof textField === 'object' && textField.value?.trim()) {
      return textField.value;
    }
  }
  return '';
}

const PREVIEW_LIMIT = 80;

function truncatePreview(text: string): string {
  return text.slice(0, PREVIEW_LIMIT) + (text.length > PREVIEW_LIMIT ? '...' : '');
}

/** The row's message body, without its header or footer. An assistant row
 *  renders a VISIBLE `h2` naming the sender, so reading the whole row hands
 *  back "Claude" for a response that has not produced a token yet — chrome
 *  masquerading as content, and worse, masking the pending state entirely. */
const MESSAGE_BODY_SELECTOR = '[data-testid="message-body"]';

/** What a row actually says on screen, for entries whose message carries no
 *  text part of its own. */
function rowText(node: HTMLElement): string {
  const body = node.querySelector(MESSAGE_BODY_SELECTOR);
  return ((body ?? node).textContent ?? '').trim();
}

export function buildEntry(id: string, msg: TMessage, node?: HTMLElement): MessageEntry {
  const raw = msg.text?.trim() ? msg.text : extractPreviewFromContent(msg.content);
  const trimmed = raw.trim();
  /** Image-, tool-call- and reasoning-only messages carry no text part at all,
   *  so the message alone yields nothing to say. Their rendered body does say
   *  something, and reading it is what keeps a settled message from being
   *  mistaken for one that is still generating. */
  const preview = trimmed === '' && node ? rowText(node) : trimmed;
  return {
    id,
    isUser: !!msg.isCreatedByUser,
    preview: truncatePreview(preview),
  };
}

const USER_TURN_SELECTOR = '.user-turn';
const STEER_RENDER_CLASS = 'steer-render';
/** One query, document order: steer nodes interleave at their in-thread
 *  position INSIDE the response that absorbed them. */
const ENTRY_NODE_SELECTOR = `.message-render, .${STEER_RENDER_CLASS}`;

/** Rail-relevant node: a message row or an in-thread steer part. The mutation
 *  filter must match BOTH — a steer node swap (optimistic → persisted) or
 *  removal (cancel) produces no `.message-render` mutation at all. */
function isEntryNode(node: HTMLElement): boolean {
  return (
    node.classList?.contains('message-render') === true ||
    node.classList?.contains(STEER_RENDER_CLASS) === true
  );
}

function containsEntryNode(node: HTMLElement): boolean {
  return (
    node.nodeType === 1 && (isEntryNode(node) || node.querySelector?.(ENTRY_NODE_SELECTOR) != null)
  );
}

export function buildFallbackEntry(node: HTMLElement, id: string): MessageEntry {
  const isUser = node.querySelector(USER_TURN_SELECTOR) != null;
  return {
    id,
    isUser,
    preview: truncatePreview(rowText(node)),
  };
}

/** A mid-run steer is a user message, so its rib reads as one; the preview
 *  comes from the part's text body, skipping the author header. */
export function buildSteerEntry(node: HTMLElement, id: string): MessageEntry {
  const raw = (
    node.querySelector('.message-content')?.textContent ??
    node.textContent ??
    ''
  ).trim();
  return {
    id,
    isUser: true,
    preview: truncatePreview(raw),
  };
}

type LocalizeFn = ReturnType<typeof useLocalize>;

/**
 * What a rib says it will take you to.
 *
 * A response enters the rail the instant its row mounts, which is one frame
 * before its first token, so falling through to the raw preview there labelled
 * the rib with nothing and opened an empty preview card beside it. Only the
 * tail of a live submission earns the pending wording, though: an empty preview
 * is not evidence of generation, and a reopened thread whose rows are settled
 * would otherwise announce "Generating" forever.
 */
export function previewTextFor(
  entry: MessageEntry,
  localize: LocalizeFn,
  isPending = false,
): string {
  if (entry.isStart === true) {
    return localize('com_ui_scroll_to_top');
  }
  if (entry.isEnd === true) {
    return localize('com_ui_scroll_to_bottom');
  }
  if (entry.preview !== '') {
    return entry.preview;
  }
  return localize(isPending ? 'com_ui_generating' : 'com_ui_message_nav_no_preview');
}

function getMessageEntries(root: ParentNode, messagesById: Map<string, TMessage>): MessageEntry[] {
  const nodes = root.querySelectorAll<HTMLElement>(ENTRY_NODE_SELECTOR);
  const entries: MessageEntry[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const id = node.id;
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    if (node.classList.contains(STEER_RENDER_CLASS)) {
      entries.push(buildSteerEntry(node, id));
      continue;
    }
    const msg = messagesById.get(id);
    entries.push(msg ? buildEntry(id, msg, node) : buildFallbackEntry(node, id));
  }
  if (entries.length > 0 && root.querySelector('#' + MESSAGES_END_ID)) {
    entries.push({ id: MESSAGES_END_ID, isUser: false, preview: '', isEnd: true });
  }
  return entries;
}

const JUMP_EPS = 4;
const SCROLL_DURATION = 400;
const BOTTOM_SNAP_RETRIES = 2;
const DRAG_THRESHOLD = 4;

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function readScrollMargin(el: HTMLElement | null): number {
  if (!el) {
    return 0;
  }
  const value = parseFloat(getComputedStyle(el).scrollMarginTop);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Where the container lands when an entry is snapped to the top, clamped to the
 * range it can actually reach.
 *
 * The rows carry `scroll-margin-top: 4rem` against `pt-14` of content padding,
 * so the first entry's raw snap point is -8px. Compared unclamped it reads as
 * "there is still something above you" at the very top of every conversation,
 * which left the up chevron live with nowhere to go and the origin rib showing
 * as out of view while the reader sat at the top.
 */
function snapPointFor(top: number, scrollMargin: number, maxScrollTop: number): number {
  return Math.max(0, Math.min(top - scrollMargin, maxScrollTop));
}

function computeTargetScroll(
  container: HTMLElement,
  el: HTMLElement,
  scrollMargin: number,
): number {
  const cRect = container.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  const target = container.scrollTop + (elRect.top - cRect.top) - scrollMargin;
  const max = container.scrollHeight - container.clientHeight;
  return Math.max(0, Math.min(target, max));
}

/**
 * An entry's top edge in the scroll container's content space — the same space
 * as `container.scrollTop`. A single `offsetTop` is measured from the nearest
 * positioned ancestor, which for an in-thread steer is the response's `relative`
 * content column, not the scroll content. Mixing that local value with the
 * content-space `offsetTop` of top-level rows compares different origins and
 * breaks every rail decision (jump targets, current row, fisheye centering) the
 * moment the viewport reaches a steer. Summing `offsetTop` up the offsetParent
 * chain until it leaves the container folds any nesting back into one origin;
 * top-level rows collapse to a single hop.
 */
function entryTop(el: HTMLElement, container: HTMLElement): number {
  let top = 0;
  let node: Element | null = el;
  while (node instanceof HTMLElement) {
    top += node.offsetTop;
    const parent = node.offsetParent;
    if (!(parent instanceof HTMLElement) || parent === container || !container.contains(parent)) {
      break;
    }
    node = parent;
  }
  return top;
}

type RibDims = { baseW: number; baseH: number; peakW: number; peakH: number };

const RIB_END: RibDims = { baseW: 3, baseH: 3, peakW: 4.5, peakH: 4.5 };
const RIB_MESSAGE: RibDims = { baseW: 12, baseH: 3, peakW: 39, peakH: 6 };
/** The rib you are reading is longer at rest, so the rail answers "where am I"
 *  from length alone — the only axis a 3px line has left once colour is spent
 *  on the in-view band. */
const RIB_CURRENT: RibDims = { baseW: 21, baseH: 3, peakW: 39, peakH: 6 };
/** Row height in px. `peakH` may reach it but never exceed it: the magnifier
 *  writes into normal flow, and a rib taller than its row would reflow every
 *  rib below the pointer — moving the rail out from under the pointer and
 *  leaving the measured centres (and so the preview and the click target)
 *  pointing at the wrong message. */
const RIB_ROW_HEIGHT = 6;

/** Vertical falloff radius (content-space px) over which neighbouring ribs magnify. */
const MAG_INFLUENCE = 50;
/** Delay before the shared preview first opens; subsequent moves reposition instantly. */
const TOOLTIP_OPEN_DELAY = 60;

export function ribDimsFor(entry: MessageEntry, isCurrent = false): RibDims {
  if (entry.isEnd === true || entry.isStart === true) {
    return RIB_END;
  }
  return isCurrent ? RIB_CURRENT : RIB_MESSAGE;
}

/** Cosine bell: 1 at the pointer, easing to 0 at the influence radius. */
export function magnifyFalloff(distance: number, influence: number): number {
  if (distance >= influence) {
    return 0;
  }
  return 0.5 * (1 + Math.cos((Math.PI * distance) / influence));
}

/** `shrink-0` is load-bearing: the ribs are flex items in a scrolling column, so
 *  without it every row compresses to its content the moment the rail overflows —
 *  halving the hit target of every rib in exactly the long conversations the rail
 *  exists to navigate. */
const indicatorButtonClasses = cn(
  'flex w-full shrink-0 items-center justify-end rounded-sm transition-opacity duration-300',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-xheavy',
);

const dimIndicatorClasses =
  'opacity-40 high-contrast:opacity-50 group-hover/nav:opacity-100 group-focus-within/nav:opacity-100';

const MessageIndicator = memo(function MessageIndicator({
  entry,
  isInView,
  isCurrent,
  isFocused,
  label,
  tabIndex,
  onSelect,
}: {
  entry: MessageEntry;
  /** The row intersects the viewport — the soft band around where you are. */
  isInView: boolean;
  /** The row you are reading: the rail's single "you are here" mark. */
  isCurrent: boolean;
  /** The rib the pointer or keyboard is previewing right now. */
  isFocused: boolean;
  label: string;
  tabIndex: number;
  onSelect: (id: string) => void;
}) {
  const dims = ribDimsFor(entry, isCurrent);
  const isEmphasized = isCurrent || isFocused;
  let tone = 'bg-text-tertiary';
  if (isEmphasized) {
    tone = 'bg-text-primary';
  } else if (isInView) {
    tone = 'bg-text-secondary';
  }
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onSelect(entry.id);
      }}
      className={cn(
        indicatorButtonClasses,
        isEmphasized || isInView ? 'opacity-100' : dimIndicatorClasses,
      )}
      style={{ height: RIB_ROW_HEIGHT }}
      aria-label={label}
      aria-current={isCurrent ? 'true' : undefined}
      tabIndex={tabIndex}
      data-msg-id={entry.id}
    >
      <span
        className={cn(
          'block rounded-full',
          entry.isEnd === true || entry.isStart === true ? 'mr-[4.5px]' : '',
          tone,
        )}
        style={{ width: dims.baseW, height: dims.baseH }}
      />
    </button>
  );
});

const chevronButtonClasses = cn(
  '-mr-1 rounded-md p-0.5 text-text-tertiary opacity-40 transition-[color,opacity] duration-300 high-contrast:opacity-50',
  'group-hover/nav:text-text-secondary group-hover/nav:opacity-100',
  'group-focus-within/nav:text-text-secondary group-focus-within/nav:opacity-100',
  'group-hover/nav:hover:text-text-primary',
  'group-hover/nav:disabled:opacity-30 group-focus-within/nav:disabled:opacity-30',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-xheavy',
);

function MessageNav({ scrollableRef }: { scrollableRef: React.RefObject<HTMLDivElement> }) {
  const localize = useLocalize();
  const { conversationId } = useMessagesConversation();
  const { isSubmitting } = useMessagesSubmission();
  const { data: messages } = useGetMessagesByConvoId(
    conversationId ?? '',
    {
      enabled: !!conversationId,
    },
    { isStreaming: isSubmitting },
  );
  const messagesById = useMemo(() => {
    const map = new Map<string, TMessage>();
    if (messages) {
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (m.messageId) {
          map.set(m.messageId, m);
        }
      }
    }
    return map;
  }, [messages]);

  const [entries, setEntries] = useState<MessageEntry[]>([]);
  const [visibleIds, setVisibleIds] = useState<Set<string>>(new Set());
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [canGoUp, setCanGoUp] = useState(false);
  const [canGoDown, setCanGoDown] = useState(false);

  const observerRef = useRef<IntersectionObserver | null>(null);
  const observedRef = useRef(new Map<string, HTMLElement>());
  const columnRef = useRef<HTMLDivElement>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visibleSetRef = useRef(new Set<string>());
  const messagesByIdRef = useRef(messagesById);
  const scrollTokenRef = useRef(0);
  const scrollMarginRef = useRef(0);
  const navRef = useRef<HTMLElement>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const suppressClickRef = useRef(false);
  const isDraggingRef = useRef(false);
  /** True while the pointer or the keyboard is working the rail; freezes the
   *  rail's auto-follow so the ribs stay put under an active gesture. */
  const interactingRef = useRef(false);

  const ribLayoutRef = useRef<
    Array<{ id: string; line: HTMLElement; center: number; dims: RibDims }>
  >([]);
  const measuredCountRef = useRef(-1);
  const measuredCurrentRef = useRef<string | null | undefined>(undefined);
  /** The pointer's VIEWPORT y, converted to the column's content space only at
   *  the moment it is used. Caching the converted value goes stale the instant
   *  the rail is wheel-scrolled under a stationary pointer, leaving the preview
   *  — and the id a click in the gaps follows — on the rib that used to be
   *  there. */
  const pointerClientYRef = useRef<number | null>(null);
  const magRafRef = useRef<number | null>(null);
  const reducedMotionRef = useRef(false);
  const focusedIdRef = useRef<string | null>(null);
  const tipShownRef = useRef(false);
  const tipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tipElRef = useRef<HTMLDivElement | null>(null);
  const tipPosRef = useRef({ top: 0, right: 0 });

  const [tip, setTip] = useState<{ id: string; top: number; right: number } | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  /** The rib the keyboard last landed on. A roving tab stop has to travel with
   *  focus, not sit on the scroll-spy's current rib: leave it behind and the
   *  column holds two tab stops, so Tab re-enters the rail it just left and
   *  Shift+Tab walks back into it instead of out. Distinct from `hoveredId`,
   *  which the pointer also drives — the tab order must not follow the mouse. */
  const [focusedRibId, setFocusedRibId] = useState<string | null>(null);

  /** The terminus rib is pinned beside the down chevron rather than living in
   *  the scrolling column, so it stays reachable however far the rail scrolls.
   *  The origin rib is its mirror above the column, for the same reason: in a
   *  long thread the top of the conversation scrolls out of the rail itself.
   *
   *  Only the terminus is ever `aria-current`: it is a real entry (`#messages-end`
   *  closes the thread), whereas the origin is a control with no row of its own,
   *  and marking both would put two current items in one nav. */
  const { messageEntries, endEntry, startEntry } = useMemo(() => {
    const last = entries[entries.length - 1];
    const hasEnd = last?.isEnd === true;
    const messageEntries = hasEnd ? entries.slice(0, -1) : entries;
    return {
      messageEntries,
      endEntry: hasEnd ? last : null,
      startEntry:
        messageEntries.length > 0
          ? { id: MESSAGES_START_ID, isUser: false, preview: '', isStart: true }
          : null,
    };
  }, [entries]);

  const entryById = useMemo(() => {
    const map = new Map<string, MessageEntry>();
    for (let i = 0; i < entries.length; i++) {
      map.set(entries[i].id, entries[i]);
    }
    if (startEntry) {
      map.set(startEntry.id, startEntry);
    }
    return map;
  }, [entries, startEntry]);

  /**
   * Rib centres in the column's own content space, plus the resting size each
   * rib returns to. Everything that answers "which rib is the pointer on" —
   * the fisheye, the preview, a click in the gaps, a drag — reads this one
   * layout, so they cannot disagree.
   */
  const measureRibs = useCallback(() => {
    const col = columnRef.current;
    if (!col) {
      return;
    }
    const layout: Array<{ id: string; line: HTMLElement; center: number; dims: RibDims }> = [];
    const kids = col.children;
    for (let i = 0; i < kids.length; i++) {
      const button = kids[i] as HTMLElement;
      const id = button.getAttribute('data-msg-id');
      const line = button.firstElementChild as HTMLElement | null;
      const entry = id ? entryById.get(id) : undefined;
      if (!id || !line || !entry) {
        continue;
      }
      layout.push({
        id,
        line,
        center: button.offsetTop + button.offsetHeight / 2,
        dims: ribDimsFor(entry, id === currentId),
      });
    }
    measuredCountRef.current = kids.length;
    measuredCurrentRef.current = currentId;
    ribLayoutRef.current = layout;
  }, [entryById, currentId]);

  /** Re-measures when the rib set or the current rib has changed since the last
   *  measurement, so a gesture that arrives before the scheduled measure still
   *  hit-tests against the ribs on screen and releases them to the resting size
   *  they are actually rendered at. */
  const ensureRibLayout = useCallback(() => {
    const col = columnRef.current;
    if (!col) {
      return;
    }
    if (
      measuredCountRef.current !== col.children.length ||
      measuredCurrentRef.current !== currentId
    ) {
      measureRibs();
    }
  }, [measureRibs, currentId]);

  useEffect(() => {
    messagesByIdRef.current = messagesById;
  }, [messagesById]);

  const resolveEntryEl = useCallback(
    (id: string): HTMLElement | null => {
      if (id === MESSAGES_START_ID) {
        return null;
      }
      if (id === MESSAGES_END_ID) {
        return scrollableRef.current?.querySelector<HTMLElement>('#' + MESSAGES_END_ID) ?? null;
      }
      return document.getElementById(id);
    },
    [scrollableRef],
  );

  /**
   * Re-point the observer at replaced DOM nodes. A steer part swaps its node
   * under the SAME id (optimistic entry → persisted part), which produces no
   * IntersectionObserver exit and — because the entry list dedupes on
   * (id, preview) — no entries change either, so the observer would keep
   * watching a detached node and the rib would stay lit forever. Runs from
   * the mutation-driven refresh regardless of entries identity; visibility is
   * dropped until the fresh node reports (the observer fires its initial
   * intersection immediately on observe, so a truly visible part re-lights
   * within a frame).
   */
  const reconcileObservedElements = useCallback(() => {
    const observer = observerRef.current;
    if (!observer) {
      return;
    }
    const observed = observedRef.current;
    const visibleSet = visibleSetRef.current;
    let visibilityChanged = false;
    for (const [id, el] of [...observed]) {
      const current = resolveEntryEl(id);
      if (current === el) {
        continue;
      }
      observer.unobserve(el);
      if (current) {
        observer.observe(current);
        observed.set(id, current);
      } else {
        observed.delete(id);
      }
      if (visibleSet.delete(id)) {
        visibilityChanged = true;
      }
    }
    if (visibilityChanged) {
      setVisibleIds(new Set(visibleSet));
    }
  }, [resolveEntryEl]);

  const refreshEntries = useCallback(() => {
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
    }
    refreshTimerRef.current = setTimeout(() => {
      const root = scrollableRef.current ?? document;
      const next = getMessageEntries(root, messagesByIdRef.current);
      setEntries((prev) => {
        if (
          prev.length === next.length &&
          prev.every((e, i) => e.id === next[i].id && e.preview === next[i].preview)
        ) {
          return prev;
        }
        return next;
      });
      reconcileObservedElements();
    }, 200);
  }, [scrollableRef, reconcileObservedElements]);

  useEffect(() => {
    refreshEntries();
  }, [messagesById, refreshEntries]);

  const scrollToStart = useCallback(
    (id: string) => {
      if (id === MESSAGES_START_ID) {
        scrollTokenRef.current++;
        scrollableRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      const el = resolveEntryEl(id);
      if (!el) {
        return;
      }
      const container = el.closest<HTMLElement>('.scrollbar-gutter-stable');
      if (!container) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      const token = ++scrollTokenRef.current;
      const scrollMargin = scrollMarginRef.current || readScrollMargin(el);
      const startScroll = container.scrollTop;
      const start = performance.now();

      const step = (now: number) => {
        if (token !== scrollTokenRef.current) {
          return;
        }
        const progress = Math.min(1, (now - start) / SCROLL_DURATION);
        const current = resolveEntryEl(id);
        if (!current) {
          return;
        }
        const clamped = computeTargetScroll(container, current, scrollMargin);
        container.scrollTop = startScroll + (clamped - startScroll) * easeOutCubic(progress);
        if (progress < 1) {
          requestAnimationFrame(step);
        }
      };

      requestAnimationFrame(step);
    },
    [resolveEntryEl, scrollableRef],
  );

  const scrollToImmediate = useCallback(
    (id: string) => {
      if (id === MESSAGES_START_ID) {
        scrollTokenRef.current++;
        const container = scrollableRef.current;
        if (container) {
          container.scrollTop = 0;
        }
        return;
      }
      const el = resolveEntryEl(id);
      if (!el) {
        return;
      }
      const container = el.closest<HTMLElement>('.scrollbar-gutter-stable');
      if (!container) {
        return;
      }
      scrollTokenRef.current++;
      const scrollMargin = scrollMarginRef.current || readScrollMargin(el);
      container.scrollTop = computeTargetScroll(container, el, scrollMargin);
    },
    [resolveEntryEl, scrollableRef],
  );

  const focusMessage = useCallback((id: string) => {
    const el = document.getElementById(id);
    if (!el) {
      return;
    }
    if (!el.hasAttribute('tabindex')) {
      el.setAttribute('tabindex', '-1');
    }
    el.focus({ preventScroll: true });
  }, []);

  const handleSelect = useCallback(
    (id: string) => {
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        return;
      }
      scrollToStart(id);
      if (!isTerminusId(id)) {
        focusMessage(id);
      }
    },
    [scrollToStart, focusMessage],
  );

  const handleColumnClick = useCallback(() => {
    const id = focusedIdRef.current;
    if (id) {
      handleSelect(id);
    }
  }, [handleSelect]);

  const focusNav = useCallback((): boolean => {
    const nav = navRef.current;
    if (!nav) {
      return false;
    }
    const target =
      nav.querySelector<HTMLElement>('[aria-current="true"]') ??
      nav.querySelector<HTMLElement>('[data-msg-id]');
    if (!target) {
      return false;
    }
    target.focus();
    return document.activeElement === target;
  }, []);

  /**
   * The rib nearest the pointer, in the column's own content space.
   *
   * The column scrolls independently once a thread outgrows it, so a mapping
   * built from the pointer's fraction of the column's *visible* height and the
   * *whole* rib list answers with a rib the reader is not pointing at — the
   * error grows with the thread and, worse, disagrees with the preview, which
   * has always been nearest-centre. Both now read the same measured layout, so
   * the rib under the pointer, the message named in the preview, and the
   * message a drag lands on are one and the same.
   */
  const ribIdAt = useCallback(
    (clientY: number): string | null => {
      ensureRibLayout();
      const col = columnRef.current;
      const layout = ribLayoutRef.current;
      if (!col || layout.length === 0) {
        return null;
      }
      const contentY = clientY - col.getBoundingClientRect().top + col.scrollTop;
      let nearestId: string | null = null;
      let nearestD = Number.POSITIVE_INFINITY;
      for (let i = 0; i < layout.length; i++) {
        const d = Math.abs(contentY - layout[i].center);
        if (d >= nearestD) {
          continue;
        }
        nearestD = d;
        nearestId = layout[i].id;
      }
      return nearestId;
    },
    [ensureRibLayout],
  );

  const scrubTo = useCallback(
    (clientY: number) => {
      const col = columnRef.current;
      if (!col) {
        return;
      }
      const rect = col.getBoundingClientRect();
      /** The terminus ribs are pinned outside the column, so the pointer reaches
       *  them by travelling past its edges. */
      if (endEntry && clientY >= rect.bottom) {
        scrollToImmediate(MESSAGES_END_ID);
        return;
      }
      if (startEntry && clientY <= rect.top) {
        scrollToImmediate(MESSAGES_START_ID);
        return;
      }
      const id = ribIdAt(clientY);
      if (id) {
        scrollToImmediate(id);
      }
    },
    [scrollToImmediate, ribIdAt, endEntry, startEntry],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) {
        return;
      }
      dragCleanupRef.current?.();
      suppressClickRef.current = false;
      interactingRef.current = true;
      const state = { pointerId: e.pointerId, startY: e.clientY, dragging: false };

      const finish = (wasDragging: boolean) => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onUp);
        window.removeEventListener('blur', onBlur);
        dragCleanupRef.current = null;
        isDraggingRef.current = false;
        if (pointerClientYRef.current == null) {
          interactingRef.current = false;
        }
        if (wasDragging) {
          suppressClickRef.current = true;
          window.setTimeout(() => {
            suppressClickRef.current = false;
          }, 0);
        }
      };

      function onMove(ev: PointerEvent) {
        if (ev.pointerId !== state.pointerId) {
          return;
        }
        if ((ev.buttons & 1) === 0) {
          finish(state.dragging);
          return;
        }
        if (!state.dragging) {
          if (Math.abs(ev.clientY - state.startY) < DRAG_THRESHOLD) {
            return;
          }
          state.dragging = true;
          isDraggingRef.current = true;
        }
        scrubTo(ev.clientY);
      }

      function onUp(ev: PointerEvent) {
        if (ev.pointerId !== state.pointerId) {
          return;
        }
        finish(state.dragging);
      }

      function onBlur() {
        finish(state.dragging);
      }

      dragCleanupRef.current = () => finish(state.dragging);
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onUp);
      window.addEventListener('blur', onBlur);
    },
    [scrubTo],
  );

  useEffect(() => () => dragCleanupRef.current?.(), []);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    reducedMotionRef.current = mq.matches;
    const onChange = () => {
      reducedMotionRef.current = mq.matches;
    };
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    }
    mq.addListener(onChange);
    return () => mq.removeListener(onChange);
  }, []);

  useEffect(() => {
    const raf = requestAnimationFrame(measureRibs);
    const col = columnRef.current;
    const resize = col ? new ResizeObserver(measureRibs) : null;
    if (col && resize) {
      resize.observe(col);
    }
    return () => {
      cancelAnimationFrame(raf);
      resize?.disconnect();
    };
  }, [entries, currentId, measureRibs]);

  const positionTip = useCallback((top: number, right: number) => {
    tipPosRef.current = { top, right };
    const el = tipElRef.current;
    if (el) {
      el.style.top = `${top}px`;
      el.style.right = `${right}px`;
    }
  }, []);

  const revealTip = useCallback(
    (id: string | null) => {
      if (!id || !entryById.has(id)) {
        setTip(null);
        return;
      }
      setTip({ id, top: tipPosRef.current.top, right: tipPosRef.current.right });
    },
    [entryById],
  );

  const clearTooltip = useCallback(() => {
    if (tipTimerRef.current) {
      clearTimeout(tipTimerRef.current);
      tipTimerRef.current = null;
    }
    if (focusedIdRef.current !== null) {
      focusedIdRef.current = null;
      setHoveredId(null);
    }
    if (tipShownRef.current) {
      tipShownRef.current = false;
      setTip(null);
    }
  }, []);

  const focusTooltip = useCallback(
    (id: string, top: number, right: number) => {
      positionTip(top, right);
      if (focusedIdRef.current === id) {
        return;
      }
      focusedIdRef.current = id;
      setHoveredId(id);
      if (tipShownRef.current) {
        revealTip(id);
        return;
      }
      if (tipTimerRef.current) {
        return;
      }
      tipTimerRef.current = setTimeout(() => {
        tipTimerRef.current = null;
        tipShownRef.current = true;
        revealTip(focusedIdRef.current);
      }, TOOLTIP_OPEN_DELAY);
    },
    [positionTip, revealTip],
  );

  /** The pinned origin and terminus live outside the column, so they drive the
   *  shared preview themselves instead of through the rail's magnification. */
  const showTerminusTip = useCallback(
    (el: HTMLElement, id: string) => {
      const rect = el.getBoundingClientRect();
      const left = columnRef.current?.getBoundingClientRect().left ?? rect.left;
      focusTooltip(id, rect.top + rect.height / 2, window.innerWidth - left + 8);
    },
    [focusTooltip],
  );

  const handleEndPointerEnter = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => showTerminusTip(e.currentTarget, MESSAGES_END_ID),
    [showTerminusTip],
  );

  const handleEndFocus = useCallback(
    (e: React.FocusEvent<HTMLDivElement>) => showTerminusTip(e.currentTarget, MESSAGES_END_ID),
    [showTerminusTip],
  );

  const handleStartPointerEnter = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => showTerminusTip(e.currentTarget, MESSAGES_START_ID),
    [showTerminusTip],
  );

  const handleStartFocus = useCallback(
    (e: React.FocusEvent<HTMLDivElement>) => showTerminusTip(e.currentTarget, MESSAGES_START_ID),
    [showTerminusTip],
  );

  const handleTerminusBlur = useCallback(
    (e: React.FocusEvent<HTMLDivElement>) => {
      const next = e.relatedTarget as Node | null;
      if (next && e.currentTarget.contains(next)) {
        return;
      }
      clearTooltip();
    },
    [clearTooltip],
  );

  const applyMagnify = useCallback(() => {
    magRafRef.current = null;
    ensureRibLayout();
    const col = columnRef.current;
    const layout = ribLayoutRef.current;
    const clientY = pointerClientYRef.current;
    if (!col || clientY == null || layout.length === 0) {
      return;
    }
    const reduce = reducedMotionRef.current;
    const colRect = col.getBoundingClientRect();
    const scrollTop = col.scrollTop;
    const py = clientY - colRect.top + scrollTop;
    let nearestId: string | null = null;
    let nearestD = Number.POSITIVE_INFINITY;
    let nearestCenter = 0;
    for (let i = 0; i < layout.length; i++) {
      const rib = layout[i];
      const d = Math.abs(py - rib.center);
      if (d < nearestD) {
        nearestD = d;
        nearestId = rib.id;
        nearestCenter = rib.center;
      }
      if (reduce) {
        continue;
      }
      const t = magnifyFalloff(d, MAG_INFLUENCE);
      const dims = rib.dims;
      rib.line.style.transition = 'none';
      rib.line.style.width = `${(dims.baseW + (dims.peakW - dims.baseW) * t).toFixed(2)}px`;
      rib.line.style.height = `${(dims.baseH + (dims.peakH - dims.baseH) * t).toFixed(2)}px`;
    }
    if (nearestId != null && nearestD <= MAG_INFLUENCE && !isDraggingRef.current) {
      const top = colRect.top - scrollTop + nearestCenter;
      const right = window.innerWidth - colRect.left + 8;
      focusTooltip(nearestId, top, right);
    } else {
      clearTooltip();
    }
  }, [focusTooltip, clearTooltip, ensureRibLayout]);

  /** Restores the resting dimensions rather than clearing them: the ribs carry
   *  their base size inline, from the same `ribDimsFor` the magnifier reads, so
   *  there is one source of truth for a rib's size and no snap on release. */
  const resetMagnify = useCallback(() => {
    ensureRibLayout();
    const layout = ribLayoutRef.current;
    for (let i = 0; i < layout.length; i++) {
      const rib = layout[i];
      rib.line.style.transition = 'width 140ms ease-out, height 140ms ease-out';
      rib.line.style.width = `${rib.dims.baseW}px`;
      rib.line.style.height = `${rib.dims.baseH}px`;
    }
  }, [ensureRibLayout]);

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const col = columnRef.current;
      if (!col) {
        return;
      }
      interactingRef.current = true;
      pointerClientYRef.current = e.clientY;
      if (magRafRef.current == null) {
        magRafRef.current = requestAnimationFrame(applyMagnify);
      }
    },
    [applyMagnify],
  );

  /** Wheeling the rail moves the ribs without moving the pointer, so the hit
   *  test has to be redone from the same viewport coordinate against the new
   *  scroll offset. */
  const handleColumnScroll = useCallback(() => {
    if (pointerClientYRef.current == null) {
      return;
    }
    if (magRafRef.current == null) {
      magRafRef.current = requestAnimationFrame(applyMagnify);
    }
  }, [applyMagnify]);

  const handlePointerLeave = useCallback(() => {
    pointerClientYRef.current = null;
    if (!isDraggingRef.current) {
      interactingRef.current = false;
    }
    if (magRafRef.current != null) {
      cancelAnimationFrame(magRafRef.current);
      magRafRef.current = null;
    }
    resetMagnify();
    clearTooltip();
  }, [resetMagnify, clearTooltip]);

  const handleColumnFocus = useCallback(
    (e: React.FocusEvent<HTMLDivElement>) => {
      const col = columnRef.current;
      const target = e.target as HTMLElement;
      const id = target.getAttribute?.('data-msg-id');
      if (!col || id == null) {
        return;
      }
      setFocusedRibId(id);
      interactingRef.current = true;
      const rect = target.getBoundingClientRect();
      pointerClientYRef.current = rect.top + rect.height / 2;
      if (magRafRef.current == null) {
        magRafRef.current = requestAnimationFrame(applyMagnify);
      }
    },
    [applyMagnify],
  );

  const handleColumnBlur = useCallback(
    (e: React.FocusEvent<HTMLDivElement>) => {
      const col = columnRef.current;
      const next = e.relatedTarget as Node | null;
      if (col && next && col.contains(next)) {
        return;
      }
      setFocusedRibId(null);
      handlePointerLeave();
    },
    [handlePointerLeave],
  );

  useEffect(
    () => () => {
      if (magRafRef.current != null) {
        cancelAnimationFrame(magRafRef.current);
      }
      if (tipTimerRef.current) {
        clearTimeout(tipTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    refreshEntries();

    const container = scrollableRef.current;
    if (!container) {
      return;
    }

    const mutationObserver = new MutationObserver((mutations) => {
      for (let i = 0; i < mutations.length; i++) {
        const m = mutations[i];
        if (m.type === 'attributes') {
          const target = m.target as HTMLElement;
          if (target.nodeType === 1 && isEntryNode(target)) {
            refreshEntries();
            return;
          }
          continue;
        }
        if (m.addedNodes.length || m.removedNodes.length) {
          for (let j = 0; j < m.addedNodes.length; j++) {
            if (containsEntryNode(m.addedNodes[j] as HTMLElement)) {
              refreshEntries();
              return;
            }
          }
          for (let j = 0; j < m.removedNodes.length; j++) {
            if (containsEntryNode(m.removedNodes[j] as HTMLElement)) {
              refreshEntries();
              return;
            }
          }
        }
      }
    });

    mutationObserver.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['id'],
    });

    return () => {
      mutationObserver.disconnect();
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
      }
    };
  }, [scrollableRef, refreshEntries]);

  useEffect(() => {
    const container = scrollableRef.current;
    if (!container || entries.length === 0) {
      setCanGoUp(false);
      setCanGoDown(false);
      return;
    }

    const offsetsTop: number[] = new Array(entries.length);
    const offsetsBottom: number[] = new Array(entries.length);
    const recomputeOffsets = () => {
      for (let i = 0; i < entries.length; i++) {
        const el = resolveEntryEl(entries[i].id);
        if (!el) {
          offsetsTop[i] = Number.POSITIVE_INFINITY;
          offsetsBottom[i] = Number.POSITIVE_INFINITY;
          continue;
        }
        const top = entryTop(el, container);
        offsetsTop[i] = top;
        offsetsBottom[i] = top + el.offsetHeight;
      }
    };
    recomputeOffsets();

    const firstEl = document.getElementById(entries[0].id);
    const scrollMargin = readScrollMargin(firstEl);
    scrollMarginRef.current = scrollMargin;

    let needsRecompute = false;
    let frameId: number | null = null;
    let bottomFrameId: number | null = null;
    let bottomSnapToken = 0;

    const scrollColumnToBottom = () => {
      const col = columnRef.current;
      if (!col) {
        return;
      }
      col.scrollTop = Math.max(0, col.scrollHeight - col.clientHeight);
    };

    const cancelColumnBottomScroll = () => {
      bottomSnapToken++;
      if (bottomFrameId != null) {
        cancelAnimationFrame(bottomFrameId);
        bottomFrameId = null;
      }
    };

    const scheduleColumnBottomScroll = () => {
      const token = ++bottomSnapToken;
      const run = (remaining: number) => {
        if (token !== bottomSnapToken) {
          return;
        }
        scrollColumnToBottom();
        if (remaining <= 0) {
          bottomFrameId = null;
          return;
        }
        bottomFrameId = requestAnimationFrame(() => run(remaining - 1));
      };
      run(BOTTOM_SNAP_RETRIES);
    };

    const tick = () => {
      frameId = null;
      if (needsRecompute) {
        recomputeOffsets();
        needsRecompute = false;
      }

      const scrollTop = container.scrollTop;
      const containerMaxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
      let nextCanUp = false;
      let nextCanDown = false;
      /**
       * The rail's "you are here" is a scroll-spy over entry spans, not the set
       * of rows the IntersectionObserver reports. A response tall enough to fill
       * the viewport keeps intersecting for screens on end, and an in-thread
       * steer follows its response in document order while sitting *inside* it —
       * so "topmost intersecting row" lights a rib several places short of the
       * end while the reader is looking at the very bottom of the thread. The
       * last entry whose snap point has passed the viewport top is the one being
       * read, and at the bottom every snap clamps to the maximum scroll, which
       * lands current on the terminus.
       */
      let currentIndex = -1;
      for (let i = 0; i < offsetsTop.length; i++) {
        if (offsetsTop[i] === Number.POSITIVE_INFINITY) {
          continue;
        }
        const snap = snapPointFor(offsetsTop[i], scrollMargin, containerMaxScrollTop);
        if (snap > scrollTop + JUMP_EPS) {
          nextCanDown = true;
          break;
        }
        currentIndex = i;
        if (snap < scrollTop - JUMP_EPS) {
          nextCanUp = true;
        }
      }
      if (containerMaxScrollTop <= 0) {
        currentIndex = 0;
      }
      const nextCurrentId = entries[currentIndex < 0 ? 0 : currentIndex]?.id ?? null;
      setCanGoUp((prev) => (prev === nextCanUp ? prev : nextCanUp));
      setCanGoDown((prev) => (prev === nextCanDown ? prev : nextCanDown));
      setCurrentId((prev) => (prev === nextCurrentId ? prev : nextCurrentId));

      const col = columnRef.current;
      if (!col) {
        return;
      }
      /** While the pointer or the keyboard is working the rail, the rail holds
       *  still. Re-centring under an active pointer slides the ribs out from
       *  under it mid-gesture, and it also discards any wheel scroll the reader
       *  did to reach a distant part of a thread too long for one column. */
      if (interactingRef.current) {
        cancelColumnBottomScroll();
        return;
      }
      if (containerMaxScrollTop > 0 && scrollTop >= containerMaxScrollTop - JUMP_EPS) {
        scheduleColumnBottomScroll();
        return;
      }
      const viewBottom = scrollTop + container.clientHeight;
      let first = -1;
      let last = -1;
      for (let i = 0; i < offsetsTop.length; i++) {
        if (offsetsBottom[i] <= scrollTop) {
          continue;
        }
        if (offsetsTop[i] >= viewBottom) {
          break;
        }
        if (first === -1) {
          first = i;
        }
        last = i;
      }
      if (first === -1) {
        return;
      }
      if (last === entries.length - 1) {
        scheduleColumnBottomScroll();
        return;
      }
      cancelColumnBottomScroll();
      const firstInd = col.children[first] as HTMLElement | undefined;
      const lastInd = col.children[last] as HTMLElement | undefined;
      if (!firstInd || !lastInd) {
        return;
      }
      /** `offsetTop` is content-space only because the column is a positioned
       *  ancestor; without that it resolves against the absolutely positioned
       *  `nav` and every centring decision inherits the chevron's height. */
      const mid = (firstInd.offsetTop + lastInd.offsetTop + lastInd.offsetHeight) / 2;
      const target = mid - col.clientHeight / 2;
      const columnMaxScrollTop = Math.max(0, col.scrollHeight - col.clientHeight);
      col.scrollTop = Math.max(0, Math.min(target, columnMaxScrollTop));
    };

    const scheduleTick = () => {
      if (frameId == null) {
        frameId = requestAnimationFrame(tick);
      }
    };

    const content = container.firstElementChild as HTMLElement | null;
    const resizeObserver = new ResizeObserver(() => {
      needsRecompute = true;
      scheduleTick();
    });
    if (content) {
      resizeObserver.observe(content);
    }

    tick();
    container.addEventListener('scroll', scheduleTick, { passive: true });

    return () => {
      container.removeEventListener('scroll', scheduleTick);
      if (frameId != null) {
        cancelAnimationFrame(frameId);
      }
      cancelColumnBottomScroll();
      resizeObserver.disconnect();
    };
  }, [entries, scrollableRef, resolveEntryEl]);

  useEffect(() => {
    const root = scrollableRef.current;
    if (!root) {
      return;
    }

    const visibleSet = visibleSetRef.current;
    const observed = observedRef.current;
    let pendingFrame: number | null = null;

    const flush = () => {
      pendingFrame = null;
      setVisibleIds((prev) => {
        if (prev.size === visibleSet.size) {
          let same = true;
          for (const id of visibleSet) {
            if (!prev.has(id)) {
              same = false;
              break;
            }
          }
          if (same) {
            return prev;
          }
        }
        return new Set(visibleSet);
      });
    };

    const observer = new IntersectionObserver(
      (intersections) => {
        for (const entry of intersections) {
          const id = entry.target.id;
          if (entry.isIntersecting) {
            visibleSet.add(id);
          } else {
            visibleSet.delete(id);
          }
        }
        if (pendingFrame == null) {
          pendingFrame = requestAnimationFrame(flush);
        }
      },
      { root, threshold: 0 },
    );
    observerRef.current = observer;

    return () => {
      observer.disconnect();
      observerRef.current = null;
      observed.clear();
      visibleSet.clear();
      if (pendingFrame != null) {
        cancelAnimationFrame(pendingFrame);
      }
    };
  }, [scrollableRef]);

  useEffect(() => {
    const observer = observerRef.current;
    if (!observer) {
      return;
    }
    const observed = observedRef.current;
    const visibleSet = visibleSetRef.current;

    const elementByNewId = new Map<HTMLElement, string>();
    for (let i = 0; i < entries.length; i++) {
      const id = entries[i].id;
      const el = resolveEntryEl(id);
      if (el) {
        elementByNewId.set(el, id);
      }
    }

    let visibilityChanged = false;
    for (const [oldId, el] of [...observed]) {
      const newId = elementByNewId.get(el);
      if (newId === undefined) {
        observer.unobserve(el);
        observed.delete(oldId);
        if (visibleSet.delete(oldId)) {
          visibilityChanged = true;
        }
        continue;
      }
      if (newId !== oldId) {
        observed.delete(oldId);
        observed.set(newId, el);
        if (visibleSet.delete(oldId)) {
          visibleSet.add(newId);
          visibilityChanged = true;
        }
      }
    }

    for (const [el, id] of elementByNewId) {
      if (!observed.has(id)) {
        observer.observe(el);
        observed.set(id, el);
      }
    }

    if (visibilityChanged) {
      setVisibleIds(new Set(visibleSet));
    }
  }, [entries, resolveEntryEl]);

  const jumpToPrevious = useCallback(() => {
    const container = scrollableRef.current;
    if (!container || entries.length === 0) {
      return;
    }
    const scrollTop = container.scrollTop;
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const scrollMargin =
      scrollMarginRef.current !== 0
        ? scrollMarginRef.current
        : readScrollMargin(document.getElementById(entries[0].id));
    for (let i = entries.length - 1; i >= 0; i--) {
      const el = resolveEntryEl(entries[i].id);
      if (!el) {
        continue;
      }
      if (
        snapPointFor(entryTop(el, container), scrollMargin, maxScrollTop) <
        scrollTop - JUMP_EPS
      ) {
        scrollToStart(entries[i].id);
        return;
      }
    }
    container.scrollTo({ top: 0, behavior: 'smooth' });
  }, [entries, scrollableRef, scrollToStart, resolveEntryEl]);

  const jumpToNext = useCallback(() => {
    const container = scrollableRef.current;
    if (!container || entries.length === 0) {
      return;
    }
    const scrollTop = container.scrollTop;
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const scrollMargin =
      scrollMarginRef.current !== 0
        ? scrollMarginRef.current
        : readScrollMargin(document.getElementById(entries[0].id));
    for (let i = 0; i < entries.length; i++) {
      const el = resolveEntryEl(entries[i].id);
      if (!el) {
        continue;
      }
      if (
        snapPointFor(entryTop(el, container), scrollMargin, maxScrollTop) >
        scrollTop + JUMP_EPS
      ) {
        scrollToStart(entries[i].id);
        return;
      }
    }
  }, [entries, scrollableRef, scrollToStart, resolveEntryEl]);

  /**
   * Arrow keys walk the ribs; only one of them is ever in the tab order.
   * A rail that made every rib a tab stop put the whole transcript between the
   * reader and the next control — hundreds of stops in a long thread.
   */
  const handleColumnKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const col = columnRef.current;
    if (!col) {
      return;
    }
    const { key } = e;
    if (key !== 'ArrowUp' && key !== 'ArrowDown' && key !== 'Home' && key !== 'End') {
      return;
    }
    const ribs = col.querySelectorAll<HTMLElement>('[data-msg-id]');
    if (ribs.length === 0) {
      return;
    }
    let index = -1;
    for (let i = 0; i < ribs.length; i++) {
      if (ribs[i] === document.activeElement) {
        index = i;
        break;
      }
    }
    let next = 0;
    if (key === 'End') {
      next = ribs.length - 1;
    } else if (key === 'ArrowUp') {
      next = index <= 0 ? 0 : index - 1;
    } else if (key === 'ArrowDown') {
      next = index < 0 ? 0 : Math.min(ribs.length - 1, index + 1);
    }
    e.preventDefault();
    ribs[next].focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.altKey && e.shiftKey && (e.code === 'KeyM' || e.key.toLowerCase() === 'm')) {
        if (focusNav()) {
          e.preventDefault();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [focusNav]);

  if (messageEntries.length < 3) {
    return null;
  }

  /** Only a response at the tail of a live submission is actually generating.
   *  Every other entry with no preview is a settled message whose content
   *  simply has no text part — including the user's own turn, which is what
   *  sits last for the frames between sending and the reply's row mounting. */
  const lastEntry = messageEntries[messageEntries.length - 1];
  const pendingId = isSubmitting && !lastEntry.isUser ? lastEntry.id : null;

  const tipEntry = tip ? entryById.get(tip.id) : undefined;
  let tipText = '';
  if (tipEntry) {
    tipText = previewTextFor(tipEntry, localize, tipEntry.id === pendingId);
  }

  /** One tab stop for the whole column; the arrows move within it. It rides the
   *  focused rib while the keyboard is in the rail, and otherwise the current
   *  one, so Tab lands where the reader already is — and at the very bottom,
   *  where current is the pinned terminus, on the last message rather than back
   *  at the top of the thread. */
  let rovingId = messageEntries[0].id;
  if (currentId === MESSAGES_END_ID) {
    rovingId = messageEntries[messageEntries.length - 1].id;
  } else if (currentId != null && entryById.has(currentId)) {
    rovingId = currentId;
  }
  if (focusedRibId != null && !isTerminusId(focusedRibId) && entryById.has(focusedRibId)) {
    rovingId = focusedRibId;
  }

  return (
    <nav
      ref={navRef}
      aria-label={localize('com_ui_message_nav')}
      aria-keyshortcuts="Shift+Alt+M"
      className={cn(
        'group/nav absolute right-2 top-1/2 z-40 hidden max-h-[min(24rem,calc(100%-2rem))]',
        '-translate-y-1/2 flex-col items-end gap-1.5 px-1.5 py-2 md:flex',
      )}
    >
      <button
        type="button"
        onClick={jumpToPrevious}
        disabled={!canGoUp}
        className={chevronButtonClasses}
        aria-label={localize('com_ui_message_nav_previous')}
      >
        <ChevronUp className="h-4 w-4" />
      </button>

      {startEntry && (
        <div
          className="flex w-14 cursor-pointer touch-none select-none flex-col items-stretch"
          onPointerDown={handlePointerDown}
          onPointerEnter={handleStartPointerEnter}
          onPointerLeave={clearTooltip}
          onFocus={handleStartFocus}
          onBlur={handleTerminusBlur}
        >
          <MessageIndicator
            entry={startEntry}
            isInView={!canGoUp}
            isCurrent={false}
            isFocused={hoveredId === startEntry.id}
            tabIndex={0}
            onSelect={handleSelect}
            label={localize('com_ui_scroll_to_top')}
          />
        </div>
      )}

      <div
        ref={columnRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        onFocus={handleColumnFocus}
        onBlur={handleColumnBlur}
        onClick={handleColumnClick}
        onKeyDown={handleColumnKeyDown}
        onScroll={handleColumnScroll}
        data-message-nav-column=""
        className="relative flex min-h-0 w-14 cursor-pointer touch-none select-none flex-col items-stretch gap-1.5 overflow-y-auto [&::-webkit-scrollbar]:hidden"
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
      >
        {messageEntries.map((entry) => {
          const label = localize(
            entry.isUser ? 'com_ui_message_nav_go_to_user' : 'com_ui_message_nav_go_to_assistant',
            { 0: previewTextFor(entry, localize, entry.id === pendingId).slice(0, 30) },
          );
          return (
            <MessageIndicator
              key={entry.id}
              entry={entry}
              isInView={visibleIds.has(entry.id)}
              isCurrent={currentId === entry.id}
              isFocused={hoveredId === entry.id}
              tabIndex={entry.id === rovingId ? 0 : -1}
              onSelect={handleSelect}
              label={label}
            />
          );
        })}
      </div>

      {endEntry && (
        <div
          className="flex w-14 cursor-pointer touch-none select-none flex-col items-stretch"
          onPointerDown={handlePointerDown}
          onPointerEnter={handleEndPointerEnter}
          onPointerLeave={clearTooltip}
          onFocus={handleEndFocus}
          onBlur={handleTerminusBlur}
        >
          <MessageIndicator
            entry={endEntry}
            isInView={visibleIds.has(endEntry.id)}
            isCurrent={currentId === endEntry.id}
            isFocused={hoveredId === endEntry.id}
            tabIndex={0}
            onSelect={handleSelect}
            label={localize('com_ui_scroll_to_bottom')}
          />
        </div>
      )}

      <button
        type="button"
        onClick={jumpToNext}
        disabled={!canGoDown}
        className={chevronButtonClasses}
        aria-label={localize('com_ui_message_nav_next')}
      >
        <ChevronDown className="h-4 w-4" />
      </button>
      {tip &&
        tipText !== '' &&
        createPortal(
          <div
            ref={tipElRef}
            role="tooltip"
            style={{
              position: 'fixed',
              top: tip.top,
              right: tip.right,
              transform: 'translateY(-50%)',
              zIndex: 999,
            }}
            className="pointer-events-none max-w-[280px] rounded-xl border border-border-light bg-surface-secondary px-3 py-2 text-text-secondary shadow-lg"
          >
            <p className="line-clamp-3 text-xs">{tipText}</p>
          </div>,
          document.body,
        )}
    </nav>
  );
}

export default memo(MessageNav);
