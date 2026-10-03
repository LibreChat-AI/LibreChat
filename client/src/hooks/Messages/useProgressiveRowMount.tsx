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

const activeCompleters = new Set<() => Promise<void>>();
const activeFlushers = new Set<() => void>();

/**
 * Depth range (inclusive) of visible-path rows allowed to mount; `null` means
 * no restriction. `MultiMessage` reads this to gate each row while always
 * continuing its recursion, so the tree's structure, sibling state, and
 * streaming spine are identical whether or not a window is active.
 */
export type RowMountWindow = { start: number; end: number } | null;

const RowMountContext = createContext<RowMountWindow>(null);

export function RowMountProvider({
  mountWindow,
  children,
}: {
  mountWindow: RowMountWindow;
  children: ReactNode;
}) {
  return <RowMountContext.Provider value={mountWindow}>{children}</RowMountContext.Provider>;
}

export function useRowMountWindow(): RowMountWindow {
  return useContext(RowMountContext);
}

/** Below this path length every row mounts in one commit, exactly as before. */
const MIN_PROGRESSIVE_ROWS = 40;
/** Rows in the first anchored commit — about one viewport plus overscan. */
const INITIAL_ROWS = 16;
/** Rows added per expansion step until the window covers the whole path. */
const CHUNK_ROWS = 32;

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
};

function initialWindow(
  tailDepth: number | undefined,
  anchorBottom: boolean,
  isSubmitting: boolean,
): RowMountWindow {
  if (isSubmitting || tailDepth == null || tailDepth + 1 <= MIN_PROGRESSIVE_ROWS) {
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
 * Bottom-anchored expansion inserts rows above the viewport; the layout
 * effect re-pins the previously first-mounted row to its pre-commit viewport
 * offset by measuring its actual shift, which also degrades to a no-op
 * wherever native scroll anchoring already compensated.
 */
export function useProgressiveRowMount({
  tailDepth,
  anchorBottom,
  isSubmitting,
  conversationId,
  scrollableRef,
}: ProgressiveRowMountOptions): RowMountWindow {
  const [mountWindow, setMountWindow] = useState<RowMountWindow>(() =>
    initialWindow(tailDepth, anchorBottom, isSubmitting),
  );
  const anchorRef = useRef<{ element: Element; documentOffset: number } | null>(null);

  /** Re-arm per conversation so every navigation gets the anchored fast
   *  first commit (state adjustment during render, per React's guidance,
   *  so the old conversation's window never gates the new tree). */
  const [prevConversationId, setPrevConversationId] = useState(conversationId);
  if (prevConversationId !== conversationId) {
    setPrevConversationId(conversationId);
    setMountWindow(initialWindow(tailDepth, anchorBottom, isSubmitting));
    anchorRef.current = null;
  }

  useEffect(() => {
    if (isSubmitting && mountWindow != null) {
      setMountWindow(null);
    }
  }, [isSubmitting, mountWindow]);

  const captureAnchor = useCallback(() => {
    const container = scrollableRef.current;
    if (!container || !anchorBottom) {
      anchorRef.current = null;
      return;
    }
    const element = container.querySelector('.message-render');
    /** Document-space offset (viewport top + scrollTop): the widening commit
     *  is transition-deferred, so the user may scroll between capture and
     *  commit. User scrolling moves viewport coordinates but not document
     *  ones, so measuring here isolates the inserted-row shift and never
     *  folds the user's own movement into the correction. */
    anchorRef.current = element
      ? { element, documentOffset: element.getBoundingClientRect().top + container.scrollTop }
      : null;
  }, [anchorBottom, scrollableRef]);

  useEffect(() => {
    if (mountWindow == null || tailDepth == null) {
      return;
    }
    if (mountWindow.start <= 0 && mountWindow.end >= tailDepth) {
      setMountWindow(null);
      return;
    }
    const frameId = requestAnimationFrame(() => {
      captureAnchor();
      startTransition(() => {
        setMountWindow((current) => {
          if (current == null) {
            return current;
          }
          return {
            start: Math.max(0, current.start - CHUNK_ROWS),
            end: current.end >= tailDepth ? current.end : current.end + CHUNK_ROWS,
          };
        });
      });
    });
    return () => cancelAnimationFrame(frameId);
  }, [mountWindow, tailDepth, captureAnchor]);

  useLayoutEffect(() => {
    const captured = anchorRef.current;
    anchorRef.current = null;
    const container = scrollableRef.current;
    if (!captured || !container || !captured.element.isConnected) {
      return;
    }
    const shift =
      captured.element.getBoundingClientRect().top + container.scrollTop - captured.documentOffset;
    if (shift !== 0) {
      container.scrollTop += shift;
    }
  }, [mountWindow, scrollableRef]);

  /** Registered while a window is active so `completeProgressiveRowMounts`
   *  (screenshot capture) can force the remaining rows in and wait for the
   *  commit to paint before cloning the DOM. */
  const isWindowActive = mountWindow != null;
  useEffect(() => {
    if (!isWindowActive) {
      return;
    }
    const complete = () =>
      new Promise<void>((resolve) => {
        setMountWindow(null);
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
    activeCompleters.add(complete);
    /** Synchronous counterpart for callers that cannot await — namely the
     *  `beforeprint` listener, since the browser never waits on a handler's
     *  returned promise. `flushSync` forces the commit before returning, so
     *  by the time the (unawaited) call site regains control the full
     *  thread is already in the DOM. Kept as a separate registration so
     *  `completeProgressiveRowMounts` and its async/rAF behavior for the
     *  screenshot path are untouched. */
    const flush = () => flushSync(() => setMountWindow(null));
    activeFlushers.add(flush);
    return () => {
      activeCompleters.delete(complete);
      activeFlushers.delete(flush);
    };
  }, [isWindowActive]);

  return mountWindow;
}

/**
 * Forces every in-flight progressive mount to completion and resolves after
 * the resulting commit has painted. DOM consumers that clone the thread
 * (screenshot export) call this so a capture taken mid-widening cannot
 * silently truncate the rows still outside the window.
 */
export async function completeProgressiveRowMounts(): Promise<void> {
  if (activeCompleters.size === 0) {
    return;
  }
  await Promise.all([...activeCompleters].map((complete) => complete()));
}

/**
 * Synchronous counterpart to `completeProgressiveRowMounts`, for callers
 * that cannot await a promise — the `beforeprint` listener, since the
 * browser dispatches that event synchronously and never waits on a
 * handler's return value. Forces every in-flight progressive mount to
 * completion via `flushSync`, so the full thread is committed to the DOM
 * before this function returns.
 */
export function flushProgressiveRowMounts(): void {
  for (const flush of [...activeFlushers]) {
    flush();
  }
}
