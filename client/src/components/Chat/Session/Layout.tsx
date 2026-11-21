import { createContext, memo, useCallback, useContext, useRef } from 'react';
import { usePanelRef } from 'react-resizable-panels';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { ResizableHandleAlt, ResizablePanel, ResizablePanelGroup } from '@librechat/client';
import {
  sessionRailSlot,
  sessionRailWidth,
  sessionRailDocked,
  sessionRailSheetSlot,
  SESSION_RAIL_MAX_WIDTH,
  SESSION_RAIL_MIN_WIDTH,
} from './state';
import useDirection from '~/hooks/Nav/useDirection';
import { useLocalize } from '~/hooks';

/** The keys the library resizes a horizontal group with; any other key leaves the layout alone. */
const RESIZE_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End']);

/**
 * What ends a drag, as the library sees it: the release, a cancelled pointer, or a move with no
 * button held, which is how a release outside the window shows up.
 */
const DRAG_END = ['pointerup', 'pointercancel', 'pointermove'] as const;

/**
 * The conversation, handed past the resize group instead of through it. The layout above this
 * makes a new element for the conversation whenever it renders; passed as the group's child,
 * that would render the group, its panels and its handle each time as well. Read from context
 * inside the panel, only the conversation renders.
 */
const Conversation = createContext<React.ReactNode>(null);

function ConversationOutlet() {
  return useContext(Conversation);
}

/**
 * The chat column with the session rail's own column beside it, past the side panel, so the
 * list of what is running stays put while a panel opens. The header's control draws the rail
 * into the column; this only gives it room, and a handle to change how much.
 *
 * The rail's column exists only while a docked rail is showing, so a closed rail takes nothing
 * and adds no handle. It keeps its width in pixels when the window changes size, as a sidebar
 * does, and that width is remembered once the reader has set it. The small-screen sheet covers
 * the page instead and is drawn into a slot that takes no room.
 *
 * The group takes no props, so nothing above it can make it render: it renders when a rail docks
 * or leaves, when the reader's width or the text direction changes, and for the library's own
 * layout.
 */
const Columns = memo(function Columns() {
  const localize = useLocalize();
  const docked = useAtomValue(sessionRailDocked);
  const setSlot = useSetAtom(sessionRailSlot);
  const setSheetSlot = useSetAtom(sessionRailSheetSlot);
  const [width, setWidth] = useAtom(sessionRailWidth);
  const railRef = usePanelRef();
  /**
   * Only a width the reader chose is remembered, so the handle is watched for the drag or key
   * that changes it. Any other change is the window: a narrow one squeezes the rail under its
   * share of the room, and when the room comes back the rail goes back to the reader's width
   * rather than staying where it was squeezed to.
   *
   * The mark lasts only as long as the press it was made for. The library reports a drag from
   * the release that ends it and a key from the key press itself, both before the listeners
   * here that take the mark away, so a press that changes nothing (a click, a key the handle
   * does not resize with, an arrow at the limit) leaves no mark for the window to be read by.
   *
   * A key press is reported before the panel has its new size and a drag after, so the panel
   * is read on the next frame.
   */
  const resizing = useRef(false);
  const startDrag = useCallback(() => {
    resizing.current = true;
    const end = (event: PointerEvent) => {
      if (event.type === 'pointermove' && event.buttons !== 0) {
        return;
      }
      resizing.current = false;
      DRAG_END.forEach((type) => window.removeEventListener(type, end));
    };
    DRAG_END.forEach((type) => window.addEventListener(type, end));
  }, []);
  const startKey = useCallback((event: React.KeyboardEvent) => {
    if (!RESIZE_KEYS.has(event.key)) {
      return;
    }
    resizing.current = true;
    setTimeout(() => {
      resizing.current = false;
    });
  }, []);
  const settle = useCallback(() => {
    const chosen = resizing.current;
    resizing.current = false;
    requestAnimationFrame(() => {
      const panel = railRef.current;
      const size = panel?.getSize();
      if (panel == null || size == null || size.inPixels <= 0) {
        return;
      }
      if (chosen) {
        setWidth(Math.round(size.inPixels));
      } else if (size.inPixels < width - 1) {
        panel.resize(width);
      }
    });
  }, [railRef, setWidth, width]);
  /**
   * The library reads drags and arrow keys physically, so under RTL the group stays LTR and
   * the panels are drawn in reverse, the way the side panel's group does it.
   */
  const direction = useDirection();
  const panels = [
    <ResizablePanel key="chat" id="chat-column" minSize="30" className="flex" dir={direction}>
      <ConversationOutlet />
    </ResizablePanel>,
    docked && (
      <ResizableHandleAlt
        key="handle"
        withHandle
        aria-label={localize('com_ui_session_resize')}
        onPointerDownCapture={startDrag}
        onKeyDownCapture={startKey}
      />
    ),
    docked && (
      <ResizablePanel
        key="rail"
        id="session-rail-column"
        panelRef={railRef}
        defaultSize={width}
        minSize={SESSION_RAIL_MIN_WIDTH}
        maxSize={SESSION_RAIL_MAX_WIDTH}
        groupResizeBehavior="preserve-pixel-size"
        dir={direction}
      >
        <div ref={setSlot} className="h-full" data-testid="session-rail-slot" />
      </ResizablePanel>
    ),
  ];

  return (
    <>
      <div className="relative min-w-0 flex-1">
        <ResizablePanelGroup orientation="horizontal" dir="ltr" onLayoutChanged={settle}>
          {direction === 'rtl' ? panels.reverse() : panels}
        </ResizablePanelGroup>
      </div>
      <div ref={setSheetSlot} className="contents" data-testid="session-rail-sheet-slot" />
    </>
  );
});

export default function SessionRailLayout({ children }: { children?: React.ReactNode }) {
  return (
    <Conversation.Provider value={children}>
      <Columns />
    </Conversation.Provider>
  );
}
