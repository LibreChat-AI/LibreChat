import { memo, useRef, useEffect, useCallback, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { TextQuote } from 'lucide-react';
import { useSetRecoilState } from 'recoil';
import { cn, MAX_QUOTE_COUNT } from '~/utils';
import { mainTextareaId } from '~/common';
import { useLocalize } from '~/hooks';
import store from '~/store';

/** Only selections fully inside a rendered chat message get the popup. */
const MESSAGE_SELECTOR = '.message-render';
/** Max characters captured per excerpt (backend re-caps as defense-in-depth). */
const MAX_QUOTE_LENGTH = 1500;
/** Vertical gap (px) between the selection and the popup. */
const POPUP_OFFSET = 8;
/** Keep the popup this far (px) from the viewport edges. */
const EDGE_MARGIN = 16;
/** Quiet period before a mouse-less selection (touch long-press, native handle
 *  drag, keyboard extend) is treated as final. Every change restarts it, so the
 *  popup lands once the selection stops moving instead of chasing a handle. */
const SELECTION_SETTLE_MS = 300;

type Anchor = {
  /** Viewport-relative bounds of the selection (used to place the button, and
   *  to tell whether it is still visible — hence both axes, since a selection
   *  can also be scrolled sideways out of a wide table or code block). */
  top: number;
  bottom: number;
  left: number;
  right: number;
};

type SelectionState = {
  text: string;
  anchor: Anchor;
  /** Touch selections carry an OS callout above them, so the popup goes below. */
  viaTouch: boolean;
};

type Reading = {
  text: string;
  anchor: Anchor;
  /** Retained so scrolling can re-measure without re-walking the selection. */
  range: Range;
  /** Everything that clips the selection while the page scrolls. */
  clippers: HTMLElement[];
};

const resolveMessageElement = (node: Node | null): HTMLElement | null => {
  const element = node instanceof Element ? node : (node?.parentElement ?? null);
  return (element?.closest(MESSAGE_SELECTOR) as HTMLElement | null) ?? null;
};

const anchorFromRect = (rect: DOMRect): Anchor | null => {
  if (rect.width === 0 && rect.height === 0) {
    return null;
  }
  return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
};

const anchorCenterX = (anchor: Anchor): number => (anchor.left + anchor.right) / 2;

const sameAnchor = (a: Anchor, b: Anchor): boolean =>
  a.top === b.top && a.bottom === b.bottom && a.left === b.left && a.right === b.right;

const stripWhitespace = (value: string): string => value.replace(/\s+/g, '');

const CLIPPING_OVERFLOWS = new Set(['auto', 'scroll', 'hidden']);

/**
 * Every ancestor that clips the element, innermost first, so visibility can be
 * judged against all of them at once.
 *
 * Walking from the *selection* rather than from the message matters: a wide
 * table or a long code line scrolls inside its own container (and `overflow-x:
 * auto` makes the computed `overflow-y` auto too, so it is a clipper on both
 * axes), and scrolling that container sideways carries the selected text out of
 * view while the message itself has not moved at all.
 */
const findClippingAncestors = (element: HTMLElement): HTMLElement[] => {
  const clippers: HTMLElement[] = [];
  let current = element.parentElement;
  while (current && current !== document.body) {
    const { overflowX, overflowY } = getComputedStyle(current);
    if (CLIPPING_OVERFLOWS.has(overflowX) || CLIPPING_OVERFLOWS.has(overflowY)) {
      clippers.push(current);
    }
    current = current.parentElement;
  }
  return clippers;
};

const sameRange = (a: Range, b: Range): boolean => {
  try {
    return (
      a.compareBoundaryPoints(Range.START_TO_START, b) === 0 &&
      a.compareBoundaryPoints(Range.END_TO_END, b) === 0
    );
  } catch {
    /** Detached or cross-document ranges cannot be compared; treat as changed. */
    return false;
  }
};

/**
 * Block-granularity gestures (triple-click, double-click then drag) park the
 * selection's far boundary at the start of the *next* block. For the last block
 * of a message that boundary sits outside `.message-render` — on the composer
 * wrapper or the following message — even though no text out there is selected,
 * which used to suppress the popup for any triple-clicked closing paragraph.
 *
 * Clamping the range to the message keeps those gestures eligible; comparing
 * visible text (whitespace-insensitive, since the overhang contributes only
 * collapsed whitespace) still rejects selections that truly span messages.
 */
const clampToMessage = (range: Range, message: HTMLElement): Range | null => {
  const bounds = document.createRange();
  bounds.selectNodeContents(message);

  const clamped = range.cloneRange();
  if (clamped.compareBoundaryPoints(Range.START_TO_START, bounds) < 0) {
    clamped.setStart(bounds.startContainer, bounds.startOffset);
  }
  if (clamped.compareBoundaryPoints(Range.END_TO_END, bounds) > 0) {
    clamped.setEnd(bounds.endContainer, bounds.endOffset);
  }

  return stripWhitespace(clamped.toString()) === stripWhitespace(range.toString()) ? clamped : null;
};

const readSelection = (): Reading | null => {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const startMessage = resolveMessageElement(range.startContainer);
  const endMessage = resolveMessageElement(range.endContainer);
  const message = startMessage ?? endMessage;
  if (!message) {
    return null;
  }

  let measured = range;
  if (startMessage !== endMessage) {
    const clamped = clampToMessage(range, message);
    if (!clamped) {
      return null;
    }
    measured = clamped;
  }

  /** `Selection.toString()` reflects rendered text, so it stays the quote source
   *  even when the measured range was clamped to the message. */
  const text = selection
    .toString()
    .replace(/\u00a0/g, ' ')
    .trim();
  if (text.length === 0) {
    return null;
  }

  const anchor = anchorFromRect(measured.getBoundingClientRect());
  if (!anchor) {
    return null;
  }

  const selectionElement =
    measured.startContainer instanceof Element
      ? (measured.startContainer as HTMLElement)
      : (measured.startContainer.parentElement ?? message);

  return {
    text: text.slice(0, MAX_QUOTE_LENGTH),
    anchor,
    range: measured,
    clippers: findClippingAncestors(selectionElement),
  };
};

/**
 * Whether the selection is still on screen, judged against the window
 * intersected with every ancestor that clips it, on both axes. Text slipping
 * under the chat header or sideways out of a table is invisible even though its
 * un-clipped rect is still inside the window, and checking the window alone
 * would leave the popup floating over unrelated UI.
 */
const isAnchorVisible = (anchor: Anchor, clippers: HTMLElement[]): boolean => {
  let top = 0;
  let bottom = window.innerHeight;
  let left = 0;
  let right = window.innerWidth;
  for (let index = 0; index < clippers.length; index++) {
    const bounds = clippers[index].getBoundingClientRect();
    top = Math.max(top, bounds.top);
    bottom = Math.min(bottom, bounds.bottom);
    left = Math.max(left, bounds.left);
    right = Math.min(right, bounds.right);
    if (top > bottom || left > right) {
      return false;
    }
  }
  return (
    anchor.bottom >= top && anchor.top <= bottom && anchor.right >= left && anchor.left <= right
  );
};

/** Place the popup on the preferred side, falling back to the other side and
 *  finally clamping into the viewport. */
const resolveTop = (anchor: Anchor, height: number, preferBelow: boolean): number => {
  const above = anchor.top - POPUP_OFFSET - height;
  const below = anchor.bottom + POPUP_OFFSET;
  const maxTop = Math.max(EDGE_MARGIN, window.innerHeight - height - EDGE_MARGIN);
  const fits = (value: number) => value >= EDGE_MARGIN && value <= maxTop;

  const [preferred, fallback] = preferBelow ? [below, above] : [above, below];
  if (fits(preferred)) {
    return preferred;
  }
  if (fits(fallback)) {
    return fallback;
  }
  return Math.min(Math.max(preferred, EDGE_MARGIN), maxTop);
};

/**
 * ChatGPT-style floating "Add to chat" button. Watches for text selections
 * inside chat messages and, on click, appends the selected excerpt to the
 * conversation's pending-quotes queue so it shows as a removable chip above
 * the composer and rides along with the next submission.
 *
 * Pointer and touch platforms surface selections through different events:
 * a mouse drag ends in `mouseup`, but a long-press or a drag of the native
 * selection handles emits no mouse event at all, only `selectionchange`. Both
 * are handled — mouse paths show immediately, mouse-less ones after the
 * selection settles — so the popup is reachable on phones as well as desktops.
 *
 * Rendered through a portal so the `fixed` positioning stays viewport-relative
 * regardless of any transformed ancestor in the composer tree. The on-screen
 * position is computed from the button's measured size (no CSS transform), so it
 * is clamped accurately to the viewport, and it tracks the selection while the
 * page scrolls rather than dismissing on the first scroll event.
 */
function QuoteButton({ conversationId }: { conversationId: string }) {
  const localize = useLocalize();
  const selectionRef = useRef<SelectionState | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const rangeRef = useRef<Range | null>(null);
  const clippersRef = useRef<HTMLElement[]>([]);
  /** Excerpt captured when a touch press begins, committed only if that press
   *  completes on the button. */
  const pressedTextRef = useRef<string | null>(null);
  /** Set by the listener effect so the press handlers can dismiss the popup. */
  const hideRef = useRef<() => void>(() => undefined);
  const setQuotes = useSetRecoilState(store.pendingQuotesByConvoId(conversationId));

  /** Selection and scroll events must not enter React's commit/selection-restoration
   *  path. Keep the portal mounted and update only its transient presentation. */
  const presentSelection = useCallback((next: SelectionState | null) => {
    selectionRef.current = next;
    const button = buttonRef.current;
    if (!button) {
      return;
    }
    if (!next) {
      button.style.display = 'none';
      return;
    }
    const touch = String(next.viaTouch);
    if (button.dataset.touch !== touch) {
      button.dataset.touch = touch;
    }
    if (button.style.display === 'none') {
      button.style.display = 'inline-flex';
    }
    const { width, height } = button.getBoundingClientRect();
    const maxLeft = Math.max(EDGE_MARGIN, window.innerWidth - width - EDGE_MARGIN);
    const left = Math.min(Math.max(anchorCenterX(next.anchor) - width / 2, EDGE_MARGIN), maxLeft);
    button.style.top = `${resolveTop(next.anchor, height, next.viaTouch)}px`;
    button.style.left = `${left}px`;
  }, []);

  useEffect(() => {
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let frame = 0;
    /** Suppresses showing mid-drag, which would flicker the popup across the
     *  growing selection; the closing `mouseup` shows it. */
    let mouseDragging = false;
    let viaTouch = false;

    const clearSettleTimer = () => {
      if (settleTimer !== undefined) {
        clearTimeout(settleTimer);
        settleTimer = undefined;
      }
    };

    /** Drop what is on screen, keeping any pending settle intact. */
    const dropVisible = () => {
      /** Never yank the button out from under an in-flight touch press — its
       *  release still has to land on a live target to count. */
      if (pressedTextRef.current !== null) {
        return;
      }
      rangeRef.current = null;
      clippersRef.current = [];
      presentSelection(null);
    };

    const hide = () => {
      clearSettleTimer();
      dropVisible();
    };
    hideRef.current = hide;

    const show = (touch = viaTouch) => {
      clearSettleTimer();
      const reading = readSelection();
      /** Also gate on visibility here, not just while re-anchoring: nothing is
       *  tracked during the settle window, so a selection scrolled out of the
       *  chat in those 300ms would otherwise be published off-screen and
       *  clamped into view, stranding the popup over unrelated UI. */
      if (!reading || !isAnchorVisible(reading.anchor, reading.clippers)) {
        hide();
        return;
      }
      /** Native handle drags can mutate the Selection's Range in place. */
      rangeRef.current = reading.range.cloneRange();
      clippersRef.current = reading.clippers;
      const previous = selectionRef.current;
      if (
        !previous ||
        previous.text !== reading.text ||
        previous.viaTouch !== touch ||
        !sameAnchor(previous.anchor, reading.anchor)
      ) {
        presentSelection({ text: reading.text, anchor: reading.anchor, viaTouch: touch });
      }
    };

    const handlePointerDown = (event: PointerEvent) => {
      viaTouch = event.pointerType !== 'mouse';
      mouseDragging = !viaTouch;
    };

    const endPointer = (event: PointerEvent) => {
      if (event.pointerType === 'mouse') {
        mouseDragging = false;
      }
    };

    const handleMouseUp = () => {
      mouseDragging = false;
      show();
    };

    /** Chromium commits a double-click word selection on `dblclick`, after
     *  `mouseup` has already read a still-collapsed range, so listen here too. */
    const handleDoubleClick = () => show();
    /** Keyboard selections carry no OS callout, so they never prefer below.
     *  Clearing the flag on the way down also stops a settle pass scheduled by
     *  the resulting `selectionchange` from reviving the touch layout on a
     *  hybrid device whose last press happened to be a finger. */
    const handleKeyDown = () => {
      viaTouch = false;
    };
    const handleKeyUp = () => show(false);

    /**
     * The only signal touch platforms give: long-press selection and native
     * handle drags fire no mouse events. Also hides the instant a selection
     * collapses or empties through paths that fire no input event — e.g. a
     * streaming markdown re-render replacing the selected text node, which
     * would otherwise strand the button over a now-collapsed caret.
     */
    const handleSelectionChange = () => {
      const current = window.getSelection();
      if (!current || current.rangeCount === 0 || current.isCollapsed) {
        hide();
        return;
      }
      if (mouseDragging) {
        return;
      }
      /** The visible popup still describes the previous selection. Drop it now,
       *  or a tap landing during the settle window — easy to do while dragging a
       *  native selection handle — would queue the stale excerpt. */
      if (rangeRef.current && !sameRange(rangeRef.current, current.getRangeAt(0))) {
        dropVisible();
      }
      clearSettleTimer();
      const touch = viaTouch;
      settleTimer = setTimeout(() => show(touch), SELECTION_SETTLE_MS);
    };

    /** Follow the selection instead of dismissing on the first scroll: chat
     *  auto-scrolls while streaming, and on mobile the URL bar collapsing fires
     *  resize, both of which used to drop a selection the user just made. */
    const reanchor = () => {
      frame = 0;
      const range = rangeRef.current;
      if (!range) {
        return;
      }
      const anchor = anchorFromRect(range.getBoundingClientRect());
      if (!anchor || !isAnchorVisible(anchor, clippersRef.current)) {
        hide();
        return;
      }
      const previous = selectionRef.current;
      if (previous && !sameAnchor(previous.anchor, anchor)) {
        presentSelection({ ...previous, anchor });
      }
    };

    const scheduleReanchor = () => {
      if (rangeRef.current === null || frame !== 0) {
        return;
      }
      frame = requestAnimationFrame(reanchor);
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('pointerup', endPointer, true);
    document.addEventListener('pointercancel', endPointer, true);
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('dblclick', handleDoubleClick);
    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('keyup', handleKeyUp);
    document.addEventListener('selectionchange', handleSelectionChange);
    document.addEventListener('scroll', scheduleReanchor, true);
    window.addEventListener('resize', scheduleReanchor);

    return () => {
      clearSettleTimer();
      if (frame !== 0) {
        cancelAnimationFrame(frame);
      }
      rangeRef.current = null;
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('pointerup', endPointer, true);
      document.removeEventListener('pointercancel', endPointer, true);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('dblclick', handleDoubleClick);
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('keyup', handleKeyUp);
      document.removeEventListener('selectionchange', handleSelectionChange);
      document.removeEventListener('scroll', scheduleReanchor, true);
      window.removeEventListener('resize', scheduleReanchor);
    };
  }, [presentSelection]);

  /** A parent render (for example a locale change) can change the button size. */
  useLayoutEffect(() => {
    presentSelection(selectionRef.current);
  });

  useLayoutEffect(() => {
    pressedTextRef.current = null;
    hideRef.current();
  }, [conversationId]);

  const commitQuote = useCallback(
    (text: string) => {
      setQuotes((prev) =>
        prev.includes(text) || prev.length >= MAX_QUOTE_COUNT ? prev : [...prev, text],
      );
      rangeRef.current = null;
      clippersRef.current = [];
      pressedTextRef.current = null;
      presentSelection(null);
      window.getSelection()?.removeAllRanges();
      document.getElementById(mainTextareaId)?.focus();
    },
    [setQuotes, presentSelection],
  );

  const addQuote = useCallback(() => {
    const selection = selectionRef.current;
    if (selection) {
      commitQuote(selection.text);
    }
  }, [commitQuote]);

  /**
   * End a touch press that did not commit. While a press is in flight the
   * listener effect deliberately ignores a collapsing selection so the button
   * survives to judge the release — which means a cancel leaves the popup
   * backed by a range that may no longer be selected. Re-check once the press
   * is over, and dismiss if the selection went away with it.
   */
  const abandonPress = useCallback(() => {
    pressedTextRef.current = null;
    const live = window.getSelection();
    if (!live || live.rangeCount === 0 || live.isCollapsed) {
      hideRef.current();
    }
  }, []);

  return createPortal(
    <button
      ref={buttonRef}
      type="button"
      /** A tap is also the gesture that dismisses a selection, so `click` can
       *  never be relied on here: the button can be hidden by the time it
       *  would fire. The excerpt is captured on the press and committed on the
       *  release instead, which keeps a button's normal escape hatches — drag
       *  off the button, or have the gesture stolen by a scroll, and nothing is
       *  added. Pointer capture guarantees the release lands here to be judged. */
      onPointerDown={(event) => {
        if (event.pointerType === 'mouse') {
          return;
        }
        event.preventDefault();
        pressedTextRef.current = selectionRef.current?.text ?? null;
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          /** Capture is an optimisation — without it the release is simply
           *  judged wherever it lands. */
        }
      }}
      onPointerUp={(event) => {
        if (event.pointerType === 'mouse') {
          return;
        }
        const text = pressedTextRef.current;
        if (text === null) {
          return;
        }
        const bounds = event.currentTarget.getBoundingClientRect();
        const releasedOnButton =
          event.clientX >= bounds.left &&
          event.clientX <= bounds.right &&
          event.clientY >= bounds.top &&
          event.clientY <= bounds.bottom;
        if (!releasedOnButton) {
          abandonPress();
          return;
        }
        pressedTextRef.current = null;
        commitQuote(text);
      }}
      onPointerCancel={abandonPress}
      /** Keep the selection alive while a mouse click lands. */
      onMouseDown={(event) => event.preventDefault()}
      onClick={addQuote}
      aria-label={localize('com_ui_add_to_chat')}
      data-testid="add-to-chat-button"
      style={{
        top: 0,
        left: 0,
        display: 'none',
      }}
      className={cn(
        'fixed z-50 inline-flex items-center gap-1.5 rounded-full border border-border-light bg-surface-secondary text-sm font-medium text-text-primary shadow-lg transition-colors hover:bg-surface-tertiary',
        /** Comfortable tap target when the selection came from a finger. */
        'px-3 py-1.5 data-[touch=true]:min-h-11 data-[touch=true]:px-4 data-[touch=true]:py-2.5',
      )}
    >
      <TextQuote className="h-4 w-4" aria-hidden="true" />
      {localize('com_ui_add_to_chat')}
    </button>,
    document.body,
  );
}

export default memo(QuoteButton);
