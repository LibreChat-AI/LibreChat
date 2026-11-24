import {
  useRef,
  useState,
  useEffect,
  useContext,
  useCallback,
  createContext,
  useLayoutEffect,
  startTransition,
} from 'react';
import { flushSync } from 'react-dom';
import type { ReactNode, RefObject } from 'react';

/**
 * Depth range (inclusive) of visible-path rows allowed to mount; `null` means
 * no restriction. Each row is gated on it while the thread's recursion always
 * continues, so the tree's structure, sibling state, and streaming spine are
 * identical whether or not a window is active.
 */
export type RowMountWindow = { start: number; end: number } | null;

/**
 * The window, and the rows still waiting on it. A row outside the window listens here instead
 * of reading the window from context: a context every row reads re-renders every row of the
 * thread each time the window widens, which is work that grows with the thread on every step
 * of mounting it. Told this way, a step costs the rows it adds.
 */
export type RowGates = {
  window: RowMountWindow;
  /** The window the thread opened on: the rows around the scroll anchor. */
  opened: RowMountWindow;
  listeners: Set<(next: RowMountWindow) => void>;
};

export function createRowGates(): RowGates {
  return { window: null, opened: null, listeners: new Set() };
}

function inWindow(mountWindow: RowMountWindow, depth: number): boolean {
  return mountWindow == null || (depth >= mountWindow.start && depth <= mountWindow.end);
}

/** Moves the window and tells the rows waiting on it. Whatever priority the caller is in is the
 *  priority the rows mount at. */
function publish(gates: RowGates, next: RowMountWindow): void {
  gates.window = next;
  for (const listener of gates.listeners) {
    listener(next);
  }
}

const RowGatesContext = createContext<RowGates | null>(null);

export function RowMountProvider({
  mountWindow,
  gates,
  children,
}: {
  mountWindow: RowMountWindow;
  /** The gates `useProgressiveRowMount` publishes to, so the rows a step adds render in the
   *  step's own pass. Without them the rows follow `mountWindow` a commit later. */
  gates?: RowGates;
  children: ReactNode;
}): ReactNode {
  const [own] = useState(createRowGates);
  const target = gates ?? own;
  /** The thread remounts per conversation, so the first window seen here is the one it opened
   *  on. Assigned while rendering, ahead of the rows below, which read it as they mount. */
  const mounted = useRef(false);
  if (!mounted.current) {
    mounted.current = true;
    target.opened = mountWindow;
  }
  target.window = mountWindow;
  useLayoutEffect(() => {
    publish(target, mountWindow);
  }, [target, mountWindow]);
  return <RowGatesContext.Provider value={target}>{children}</RowGatesContext.Provider>;
}

/**
 * Whether the row at `depth` may mount. False only until the window reaches it: the window
 * widens and never narrows within a thread, and a thread remounts for another conversation.
 */
export function useRowMounted(depth: number): boolean {
  const gates = useContext(RowGatesContext);
  const inside = gates == null || inWindow(gates.window, depth);
  const [mounted, setMounted] = useState(inside);
  /** A level's depth is not fixed: the level below the thread's last message is empty until a
   *  turn arrives there. Read while rendering, so that turn's row is in its first commit
   *  rather than one behind it. */
  if (inside && !mounted) {
    setMounted(true);
  }
  useEffect(() => {
    if (!gates || mounted) {
      return;
    }
    const open = (next: RowMountWindow) => {
      if (inWindow(next, depth)) {
        setMounted(true);
      }
    };
    /** The window may have moved between this row's render and now. */
    open(gates.window);
    gates.listeners.add(open);
    return () => {
      gates.listeners.delete(open);
    };
  }, [gates, depth, mounted]);
  return mounted || inside;
}

/**
 * Whether this row mounted in a widening step: one of the rows a long thread adds after its
 * first commit, away from where the reader is. Fixed for the row's life.
 */
export function useWidenedRow(): boolean {
  const gates = useContext(RowGatesContext);
  return useState(() => gates != null && gates.window != null && gates.window !== gates.opened)[0];
}

/**
 * Whether the browser holds a reader in place itself when content is added or resized above
 * them (`overflow-anchor`). It does so for every change, including a row that settles to a
 * different height after it mounts, and without cancelling a scroll the reader is in the middle
 * of. Writing the scroll position by hand can do neither, so the hook pins the anchor row only
 * where this is missing, or cannot be relied on (see `pinsByHand`).
 */
function anchorsNatively(): boolean {
  return (
    typeof CSS !== 'undefined' &&
    typeof CSS.supports === 'function' &&
    CSS.supports('overflow-anchor', 'auto')
  );
}

/**
 * Whether the mount holds the reader itself rather than leaving it to the browser.
 *
 * Beside a reply in flight it does, even where the browser anchors: the thread then mounts a
 * few rows on every frame, and a browser that is adjusting the scroll position frame after
 * frame stops doing it part way through, which leaves the reader tens of thousands of pixels
 * from where they were. The scroller takes `overflow-anchor: none` for as long as this is
 * true, so the two never both react to the same rows.
 */
export function pinsByHand(isSubmitting: boolean): boolean {
  return isSubmitting || !anchorsNatively();
}

/**
 * How long after the reader's last scroll input a step waits. A step that lands in the same
 * frame as a scroll is the one the reader's place does not survive: the browser has dropped
 * its anchor for the scroll, and a position written by hand cancels the scroll under way.
 */
const SCROLL_REST_MS = 150;
/** The reader moving the thread themselves: wheel, touch, or a key that scrolls. */
const SCROLL_INPUTS = ['wheel', 'touchmove', 'keydown'] as const;

/** Below this path length every row mounts in one commit, exactly as before. */
const MIN_PROGRESSIVE_ROWS = 40;
/** Rows in the first anchored commit — about one viewport plus overscan. */
const INITIAL_ROWS = 16;
/** Rows added per expansion step until the window covers the whole path. */
const CHUNK_ROWS = 32;
/**
 * Rows added per step while a reply is in flight. A step then cannot be a transition: every
 * frame of the reply is an urgent update that discards a transition's unfinished render, so a
 * chunk that takes longer to render than the gap between two frames would be started over and
 * over without ever landing. Each step commits in one go instead, and is kept small enough to
 * fit in a frame beside the reply.
 */
const LIVE_CHUNK_ROWS = 4;

type ProgressiveRowMountOptions = {
  /** Depth of the active branch tail (`latestMessageDepth` from ChatContext). */
  tailDepth: number | undefined;
  /** True anchors the first commit at the newest rows (auto-scroll lands
   *  there); false anchors at the conversation start, which is where a
   *  default-settings load rests. */
  anchorBottom: boolean;
  isSubmitting: boolean;
  conversationId: string | null | undefined;
  scrollableRef: RefObject<HTMLDivElement | null>;
  /** The provider's gates. Passing them lets a step mount its rows in its own render. */
  gates?: RowGates;
  /** Told the height a step added above the reader, as its rows commit. The scroll position
   *  moves by that much without the reader having moved, and whatever judges which way they
   *  are heading from the position needs to know. */
  onInsertAbove?: (height: number) => void;
};

function initialWindow(tailDepth: number | undefined, anchorBottom: boolean): RowMountWindow {
  if (tailDepth == null || tailDepth + 1 <= MIN_PROGRESSIVE_ROWS) {
    return null;
  }
  if (anchorBottom) {
    return { start: Math.max(0, tailDepth - INITIAL_ROWS + 1), end: Number.POSITIVE_INFINITY };
  }
  return { start: 0, end: INITIAL_ROWS - 1 };
}

/**
 * Windowed first commit for long threads: mount only the rows around the
 * scroll anchor, then widen the window in transition-wrapped chunks until
 * every row is mounted, then drop the restriction entirely. The DOM converges
 * to the exact full structure — nothing ever unmounts — so message counts,
 * screenshot export, and the nav rail see the same document they always have,
 * just a few frames later.
 *
 * Bottom-anchored expansion inserts rows above the viewport. A browser with
 * scroll anchoring keeps the reader where they are through that; where there
 * is none, and beside a reply in flight (see `pinsByHand`), the layout effect
 * re-pins the previously first-mounted row to its pre-commit viewport offset
 * by measuring its actual shift.
 *
 * A reply in flight does not end the windowing. Its row is at the thread's end, which a window
 * anchored there always holds, so the rows above keep arriving, in smaller steps that each
 * commit at once (see `LIVE_CHUNK_ROWS`). Mounting them all in one commit instead froze the
 * page for as long as the whole thread takes to render, on every return to a conversation with
 * a run under way. Only a window anchored at the conversation's start, which the reply is
 * outside of, still completes the moment a run starts.
 */
export function useProgressiveRowMount({
  tailDepth,
  anchorBottom,
  isSubmitting,
  conversationId,
  scrollableRef,
  gates,
  onInsertAbove,
}: ProgressiveRowMountOptions): RowMountWindow {
  const [mountWindow, setMountWindow] = useState<RowMountWindow>(() =>
    initialWindow(tailDepth, anchorBottom),
  );
  const anchorRef = useRef<{
    element: Element;
    documentOffset: number;
    /** Whether the mount is the one holding the reader for this step (`pinsByHand`). */
    byHand: boolean;
    /** Where the anchor sat on the reader's screen, when the commit follows its capture within
     *  the same task (`finish`): the reader cannot have scrolled between the two. */
    restingTop: number | null;
  } | null>(null);
  /**
   * What the scroll position still owes the reader after a step, and the position that step
   * left it at.
   *
   * Chromium keeps a scroll position in whole pixels, and rows are not whole pixels tall:
   * asked to move by the 458.375px that four one-line turns come to, it moves by 458.
   * Each step measures its own rows and nothing else, so what a step lost stayed lost, and a
   * reader beside a reply in flight, where a step lands on every frame, watched the row they
   * were reading sink 60px while 800 rows mounted above it. What a step could not apply goes
   * into the next one instead, for as long as the position is still where the mount left it:
   * any other move is the reader's, or the stream's, and is a place of its own.
   */
  const owedRef = useRef<{ top: number; height: number } | null>(null);
  /** The thread's height before the step in flight, while one is. */
  const heightRef = useRef<number | null>(null);
  const onInsertAboveRef = useRef(onInsertAbove);
  onInsertAboveRef.current = onInsertAbove;
  /** When the reader last scrolled the thread themselves. */
  const scrolledAtRef = useRef(Number.NEGATIVE_INFINITY);

  const isWindowed = mountWindow != null;
  useEffect(() => {
    const container = scrollableRef.current;
    if (!container || !isWindowed) {
      return;
    }
    const mark = () => {
      scrolledAtRef.current = performance.now();
    };
    for (const type of SCROLL_INPUTS) {
      container.addEventListener(type, mark, { passive: true });
    }
    return () => {
      for (const type of SCROLL_INPUTS) {
        container.removeEventListener(type, mark);
      }
    };
  }, [isWindowed, scrollableRef]);

  /** The window and the waiting rows move together, so the rows a step adds render in the
   *  same pass as the step, at whatever priority it was made. */
  const moveTo = useCallback(
    (next: RowMountWindow) => {
      setMountWindow(next);
      if (gates) {
        publish(gates, next);
      }
    },
    [gates],
  );

  /** Re-arm per conversation so every navigation gets the anchored fast
   *  first commit (state adjustment during render, per React's guidance,
   *  so the old conversation's window never gates the new tree). */
  const [prevConversationId, setPrevConversationId] = useState(conversationId);
  if (prevConversationId !== conversationId) {
    setPrevConversationId(conversationId);
    setMountWindow(initialWindow(tailDepth, anchorBottom));
    anchorRef.current = null;
  }

  useEffect(() => {
    if (isSubmitting && mountWindow != null && Number.isFinite(mountWindow.end)) {
      moveTo(null);
    }
  }, [isSubmitting, mountWindow, moveTo]);

  const captureAnchor = useCallback(
    (finishing = false) => {
      const container = scrollableRef.current;
      heightRef.current = container && anchorBottom ? container.scrollHeight : null;
      if (!container || !anchorBottom) {
        anchorRef.current = null;
        return;
      }
      /** Taken even where the browser anchors: whether it will for this step is only known once
       *  the rows are in, by where the reader is then. */
      const element = container.querySelector('.message-render');
      if (!element) {
        anchorRef.current = null;
        return;
      }
      const top = element.getBoundingClientRect().top;
      /** Document-space offset (viewport top + scrollTop): the widening commit
       *  is transition-deferred, so the user may scroll between capture and
       *  commit. User scrolling moves viewport coordinates but not document
       *  ones, so measuring here isolates the inserted-row shift and never
       *  folds the user's own movement into the correction. */
      anchorRef.current = {
        element,
        documentOffset: top + container.scrollTop,
        byHand: pinsByHand(isSubmitting),
        restingTop: finishing ? top : null,
      };
    },
    [anchorBottom, isSubmitting, scrollableRef],
  );

  useEffect(() => {
    if (mountWindow == null || tailDepth == null) {
      return;
    }
    if (mountWindow.start <= 0 && mountWindow.end >= tailDepth) {
      moveTo(null);
      return;
    }
    const chunk = isSubmitting ? LIVE_CHUNK_ROWS : CHUNK_ROWS;
    const step = () => {
      /** Rows the reader is about to scroll into can wait for the scroll to rest. */
      if (performance.now() - scrolledAtRef.current < SCROLL_REST_MS) {
        frameId = requestAnimationFrame(step);
        return;
      }
      captureAnchor();
      const widen = () =>
        moveTo({
          start: Math.max(0, mountWindow.start - chunk),
          end: mountWindow.end >= tailDepth ? mountWindow.end : mountWindow.end + chunk,
        });
      if (isSubmitting) {
        widen();
        return;
      }
      startTransition(widen);
    };
    let frameId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frameId);
  }, [mountWindow, tailDepth, isSubmitting, captureAnchor, moveTo]);

  useLayoutEffect(() => {
    const captured = anchorRef.current;
    anchorRef.current = null;
    /** Owed to the step that follows the one it came from, and to no other. */
    const owed = owedRef.current;
    owedRef.current = null;
    const container = scrollableRef.current;
    const height = heightRef.current;
    heightRef.current = null;
    if (container && height != null) {
      const added = container.scrollHeight - height;
      if (added !== 0) {
        onInsertAboveRef.current?.(added);
      }
    }
    if (!captured || !container || !captured.element.isConnected) {
      return;
    }
    const { element, restingTop: sat } = captured;
    if (sat != null) {
      /**
       * The rest of the thread, landed in the commit that also ends the window (`finish`). The
       * scroller's anchoring comes back on in this commit, and who holds the reader through it
       * is not known beforehand. A browser that was anchoring all along has. One whose anchoring
       * was off until now, beside a reply, may have (Chromium, Firefox) or may not (WebKit), and
       * one that does not anchor never has. Pinning the reader regardless corrects twice wherever
       * the browser did hold them, and throws them to the end of the thread. So the mount looks:
       * any adjustment the browser makes is in by the time the row is measured here, and the row
       * is put back where it sat only when it is not there. Again once the commit has finished,
       * as for a step below.
       */
      const putBack = () => {
        if (!element.isConnected) {
          return;
        }
        const drift = element.getBoundingClientRect().top - sat;
        if (Math.abs(drift) >= 1) {
          container.scrollTop += drift;
        }
      };
      putBack();
      queueMicrotask(putBack);
      return;
    }
    const before = container.scrollTop;
    /**
     * A browser that anchors has already held the reader, unless they are at the very top:
     * scroll anchoring selects no anchor at the scroll origin. A reader who scrolled past the
     * rows mounted so far, or pressed Home, is exactly there, and would stay at the top of each
     * chunk as it arrived while the row they had reached moved out of view below. There the
     * mount pins them as it does where nothing else would.
     */
    if (!captured.byHand && before > 0) {
      return;
    }
    const carried = owed != null && owed.top === before ? owed.height : 0;
    /** Rows added above have not moved the scroll position, so what it reads is where the
     *  reader was before the step. This is where the anchor belongs on their screen: where it
     *  sat, less what the position was already short of. */
    const restingTop = captured.documentOffset - before - carried;
    const shift = captured.element.getBoundingClientRect().top + before - captured.documentOffset;
    if (shift !== 0) {
      container.scrollTop = before + shift + carried;
    }
    /**
     * Once more when the commit has finished. A row that mounts can change its height before
     * the frame is painted: a long user message measures itself in a layout effect and renders
     * again clamped, after this effect has already counted its full height. Correcting only
     * above left a reader who had scrolled up a clamp's worth further down the thread, once for
     * every such message that mounted above them.
     *
     * The anchor is put back where it sat, not moved by a second difference: a reader on the
     * thread's end is already there, because the browser pulled the scroll position in as the
     * content shrank under it, and a difference taken from before that would move them twice.
     */
    queueMicrotask(() => {
      if (!captured.element.isConnected) {
        return;
      }
      /** How far below where it belongs the anchor sits: under a pixel when nothing changed
       *  height, which is the part of the step the scroll position could not take. */
      let short = captured.element.getBoundingClientRect().top - restingTop;
      let top = container.scrollTop;
      if (Math.abs(short) >= 1) {
        container.scrollTop = top + short;
        const moved = container.scrollTop - top;
        short -= moved;
        top += moved;
      }
      /** A pixel or more left over is the end of the scroll range, where there is no further
       *  to go, and not something a later step should make up. */
      owedRef.current = Math.abs(short) < 1 ? { top, height: short } : null;
    });
  }, [mountWindow, scrollableRef]);

  /** Registered while a window is active, so a consumer of the whole thread can bring the
   *  remaining rows in (`completeProgressiveRowMounts`, `finishProgressiveRowMounts`). */
  const isWindowActive = mountWindow != null;
  /** Whether rows after the mounted ones are still to come: a thread that opened at its start
   *  mounts towards its end, where one that opened at its end has had its latest rows all along. */
  const laterRef = useRef(false);
  laterRef.current = mountWindow != null && tailDepth != null && mountWindow.end < tailDepth;
  useEffect(() => {
    if (!isWindowActive) {
      return;
    }
    /**
     * The rest of the thread lands above the reader like any step, in the commit that ends the
     * window. Called inside `flushSync`, so that commit follows the capture at once and the
     * layout effect can tell whether the reader's row is still where it sat.
     */
    const finish = () => {
      captureAnchor(true);
      moveTo(null);
    };
    const thread = { finish, later: () => laterRef.current };
    mounting.add(thread);
    return () => {
      mounting.delete(thread);
    };
  }, [isWindowActive, captureAnchor, moveTo]);

  return mountWindow;
}

/** Each thread that is still mounting: what mounts the rest of its rows, and whether any of
 *  those come after the rows already in. */
const mounting = new Set<{ finish: () => void; later: () => boolean }>();

/**
 * Forces every in-flight progressive mount to completion and resolves after
 * the resulting commit has painted. DOM consumers that clone the thread
 * (screenshot export) call this so a capture taken mid-widening cannot
 * silently truncate the rows still outside the window.
 */
export async function completeProgressiveRowMounts(): Promise<void> {
  if (mounting.size === 0) {
    return;
  }
  flushSync(() => {
    for (const thread of [...mounting]) {
      thread.finish();
    }
  });
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/**
 * Mounts the remaining rows of every thread still mounting before it returns, and says whether
 * there were any. For an action that reads the thread from the document and has to answer
 * inside the event that asked: a keyboard shortcut reports whether it did anything, and a copy
 * made after the key press is one the browser may refuse.
 *
 * The rest of the thread lands in one commit, which is what mounting in steps exists to avoid,
 * so call it once the rows already in have been found not to hold the answer. `'later'` keeps
 * to the threads with rows still to come after the ones already in, for an action that wants
 * the latest of something: there the rows already in cannot be trusted to hold it.
 */
export function finishProgressiveRowMounts(which: 'all' | 'later' = 'all'): boolean {
  const threads = [...mounting].filter((thread) => which === 'all' || thread.later());
  if (threads.length === 0) {
    return false;
  }
  flushSync(() => {
    for (const thread of threads) {
      thread.finish();
    }
  });
  return true;
}
