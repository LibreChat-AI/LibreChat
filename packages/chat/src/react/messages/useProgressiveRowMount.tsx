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

/** Renders its row once the window reaches `depth`, for a renderer that lists rows flat. */
export function RowGate({ depth, children }: { depth: number; children: ReactNode }): ReactNode {
  return useRowMounted(depth) ? children : null;
}

/**
 * Whether this row mounted in a widening step: one of the rows a long thread adds after its
 * first commit, away from where the reader is. Fixed for the row's life.
 */
export function useWidenedRow(): boolean {
  const gates = useContext(RowGatesContext);
  return useState(() => gates != null && gates.window != null && gates.window !== gates.opened)[0];
}

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
 * Bottom-anchored expansion inserts rows above the viewport; the layout
 * effect re-pins the previously first-mounted row to its pre-commit viewport
 * offset by measuring its actual shift, which also degrades to a no-op
 * wherever native scroll anchoring already compensated.
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
}: ProgressiveRowMountOptions): RowMountWindow {
  const [mountWindow, setMountWindow] = useState<RowMountWindow>(() =>
    initialWindow(tailDepth, anchorBottom),
  );
  const anchorRef = useRef<{ element: Element; documentOffset: number } | null>(null);

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
      moveTo(null);
      return;
    }
    const chunk = isSubmitting ? LIVE_CHUNK_ROWS : CHUNK_ROWS;
    const frameId = requestAnimationFrame(() => {
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
    });
    return () => cancelAnimationFrame(frameId);
  }, [mountWindow, tailDepth, isSubmitting, captureAnchor, moveTo]);

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
        moveTo(null);
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
    activeCompleters.add(complete);
    return () => {
      activeCompleters.delete(complete);
    };
  }, [isWindowActive, moveTo]);

  return mountWindow;
}

const activeCompleters = new Set<() => Promise<void>>();

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
