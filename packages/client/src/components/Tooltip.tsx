import {
  memo,
  useRef,
  useMemo,
  useState,
  useEffect,
  forwardRef,
  useCallback,
  RefAttributes,
  useLayoutEffect,
  ForwardRefExoticComponent,
} from 'react';
import DOMPurify from 'dompurify';
import * as Ariakit from '@ariakit/react';
import { AnimatePresence, motion } from 'framer-motion';
import type { FocusOutline } from './Focus';
import { useDialogDepth, usePopoverZIndex } from './OriginalDialog';
import { focusOutlineVariants } from './Focus';
import { cn, resolveSide } from '~/utils';
import './Tooltip.css';

/** The tooltip's store is the anchor's own, made when the anchor is first used. */
interface TooltipAnchorProps extends Omit<Ariakit.TooltipAnchorProps, 'store'> {
  focusOutline?: FocusOutline;
  role?: string;
  className?: string;
  description: string;
  enableHTML?: boolean;
  portalElement?: Ariakit.TooltipProps['portalElement'];
  /** Overrides the popup's z-index, for anchors inside a host layer above the default. */
  zIndex?: number;
  side?: 'top' | 'bottom' | 'left' | 'right';
}

type Sanitizer = ReturnType<typeof DOMPurify>;

let sanitizer: Sanitizer | undefined;

/**
 * One sanitizer for every tooltip, built the first time a tooltip has markup to show. Building
 * one is not cheap (it copies its allow lists and probes the document), and a tooltip with a
 * plain description never uses it: an instance per tooltip was most of what a toolbar button
 * cost to mount, on pages that mount hundreds of them.
 */
function getSanitizer(): Sanitizer {
  if (sanitizer == null) {
    sanitizer = DOMPurify();
    sanitizer.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName && node.tagName === 'A') {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    });
  }
  return sanitizer;
}

/**
 * Whether the pointer is being moved by hand. An anchor that scrolls under a pointer at rest
 * gets the same mouse events as one the reader moved onto, and must not open for it. One set
 * of listeners for every tooltip, installed when the first one is used.
 */
let mouseMoving = false;
let mouseTracked = false;
let lastScreenX = 0;
let lastScreenY = 0;

function trackMouse(): void {
  if (mouseTracked || typeof document === 'undefined') {
    return;
  }
  mouseTracked = true;
  document.addEventListener(
    'mousemove',
    (event) => {
      const movedX = event.movementX || event.screenX - lastScreenX;
      const movedY = event.movementY || event.screenY - lastScreenY;
      lastScreenX = event.screenX;
      lastScreenY = event.screenY;
      /** A synthetic move in a test carries no distance. */
      if (movedX || movedY || process.env.NODE_ENV === 'test') {
        mouseMoving = true;
      }
    },
    true,
  );
  const rest = () => {
    mouseMoving = false;
  };
  for (const type of ['mousedown', 'mouseup', 'keydown', 'scroll']) {
    document.addEventListener(type, rest, true);
  }
}

/** The tooltip on screen, so the next one can replace it at once instead of after its delay. */
let active: Ariakit.TooltipStore | null = null;
const replacing = new WeakSet<Ariakit.TooltipStore>();

/** What an anchor asks of its tooltip once the tooltip exists. */
type TooltipHandle = {
  /** The pointer is moving over the anchor: show after the delay. */
  hover: (anchor: HTMLElement) => void;
  /** Keyboard focus is on the anchor: show now. */
  focus: (anchor: HTMLElement) => void;
  /** The pointer left or pressed: drop a show that has not happened yet. */
  cancel: () => void;
};

/**
 * The tooltip itself: its store, its delay and the popup. Mounted the first time its anchor is
 * hovered or focused and kept from then on, so an anchor nobody has touched carries none of it.
 * Subscribes to the store on its own, so the anchor never re-renders as the popup comes and goes.
 */
const TooltipPopup = memo(function TooltipPopup({
  side,
  description,
  enableHTML,
  portalElement,
  zIndex,
  bind,
  onHidden,
}: {
  side: NonNullable<TooltipAnchorProps['side']>;
  description: string;
  enableHTML: boolean;
  portalElement?: Ariakit.TooltipProps['portalElement'];
  zIndex?: number;
  bind: (handle: TooltipHandle | null) => void;
  onHidden: () => void;
}) {
  const store = Ariakit.useTooltipStore({ placement: side, hideTimeout: 0 });
  const mounted = Ariakit.useStoreState(store, (state) => state.mounted);
  const placement = Ariakit.useStoreState(store, (state) => state.placement);

  /** `side` is physical; resolve it against the anchor's own direction so `right` stays the
   *  inline-end side in an RTL layout without every caller having to know. The selector re-runs
   *  on every store change, opening included, so a language switch that flips the direction
   *  without remounting is still picked up. */
  const resolvedSide = Ariakit.useStoreState(store, (state) =>
    resolveSide(side, state.anchorElement),
  );
  useLayoutEffect(() => {
    store.setState('placement', resolvedSide);
  }, [store, resolvedSide]);

  const timer = useRef(0);
  useLayoutEffect(() => {
    trackMouse();
    const cancel = () => {
      window.clearTimeout(timer.current);
      timer.current = 0;
    };
    bind({
      hover: (anchor) => {
        if (timer.current || !mouseMoving) {
          return;
        }
        store.setAnchorElement(anchor);
        /** Moving from one tooltip to the next shows it without the wait. */
        if (active != null && active !== store) {
          store.show();
          return;
        }
        store.setDisclosureElement(anchor);
        const { showTimeout, timeout } = store.getState();
        timer.current = window.setTimeout(() => {
          timer.current = 0;
          if (!mouseMoving || !anchor.isConnected) {
            return;
          }
          store.setAnchorElement(anchor);
          store.show();
          queueMicrotask(() => store.setDisclosureElement(anchor));
        }, showTimeout ?? timeout);
      },
      focus: (anchor) => {
        store.setAnchorElement(anchor);
        store.show();
      },
      cancel,
    });
    return () => {
      cancel();
      bind(null);
      if (active === store) {
        active = null;
      }
    };
  }, [store, bind]);

  const shown = useRef(false);
  useEffect(() => {
    if (mounted) {
      shown.current = true;
      if (active != null && active !== store && !replacing.has(store)) {
        const previous = active;
        replacing.add(previous);
        previous.hide();
        queueMicrotask(() => replacing.delete(previous));
      }
      active = store;
      return;
    }
    if (!shown.current) {
      return;
    }
    shown.current = false;
    onHidden();
    /** For a moment after it hides, the next tooltip still opens without its delay. */
    const id = window.setTimeout(() => {
      if (active === store) {
        active = null;
      }
    }, store.getState().skipTimeout);
    return () => window.clearTimeout(id);
  }, [mounted, store, onHidden]);

  /** Tooltips portal to body at z-150, which nested dialogs (z 200+) cover —
   * inside a dialog, borrow the popover's depth-aware z-index; outside, keep
   * the stylesheet default so tooltips never outrank freshly opened dialogs. */
  const dialogDepth = useDialogDepth();
  const popoverZIndex = usePopoverZIndex();
  const resolvedZIndex = zIndex ?? (dialogDepth > 0 ? popoverZIndex : undefined);

  const sanitizedHTML = useMemo(() => {
    if (!enableHTML) {
      return '';
    }
    try {
      return getSanitizer().sanitize(description, {
        ALLOWED_TAGS: ['a', 'strong', 'b', 'em', 'i', 'br', 'code'],
        ALLOWED_ATTR: ['href', 'class', 'target', 'rel'],
        ALLOW_DATA_ATTR: false,
        ALLOW_ARIA_ATTR: false,
      });
    } catch (error) {
      console.error('Sanitization failed', error);
      return description;
    }
  }, [enableHTML, description]);

  const { x, y } = useMemo(() => {
    const dir = placement.split('-')[0];
    switch (dir) {
      case 'top':
        return { x: 0, y: -8 };
      case 'bottom':
        return { x: 0, y: 8 };
      case 'left':
        return { x: -8, y: 0 };
      case 'right':
        return { x: 8, y: 0 };
      default:
        return { x: 0, y: 0 };
    }
  }, [placement]);

  return (
    <AnimatePresence>
      {mounted === true && (
        <Ariakit.Tooltip
          store={store}
          gutter={4}
          alwaysVisible
          portalElement={portalElement}
          className="tooltip"
          render={
            <motion.div
              style={resolvedZIndex != null ? { zIndex: resolvedZIndex } : undefined}
              initial={{ opacity: 0, x, y }}
              animate={{ opacity: 1, x: 0, y: 0 }}
              exit={{ opacity: 0, x, y }}
            />
          }
        >
          <Ariakit.TooltipArrow />
          {enableHTML ? (
            <div
              dangerouslySetInnerHTML={{
                __html: sanitizedHTML,
              }}
            />
          ) : (
            description
          )}
        </Ariakit.Tooltip>
      )}
    </AnimatePresence>
  );
});

/** Whether the caller switched the anchor off, natively or for assistive technology only. */
function isDisabled(props: { disabled?: boolean; 'aria-disabled'?: boolean | 'true' | 'false' }) {
  return (
    props.disabled === true || props['aria-disabled'] === true || props['aria-disabled'] === 'true'
  );
}

/**
 * An element with a tooltip.
 *
 * The element is all an untouched anchor mounts. A tooltip's store, its show delay and the
 * library's anchor behaviour (which listens on the document for every anchor on the page, so a
 * thread with thousands of them answers each pointer movement thousands of times) are for an
 * anchor someone is using: they mount on the first hover or focus and the element stays the
 * element it was, focus and all.
 */
export const TooltipAnchor: ForwardRefExoticComponent<
  Omit<TooltipAnchorProps, 'ref'> & RefAttributes<HTMLDivElement>
> = forwardRef<HTMLDivElement, TooltipAnchorProps>(function TooltipAnchor(
  {
    description,
    side = 'top',
    className,
    focusOutline,
    role,
    enableHTML = false,
    portalElement,
    zIndex,
    onKeyDown,
    tabIndex,
    showOnHover = true,
    onMouseEnter,
    onMouseMove,
    onMouseLeave,
    onClick,
    onFocusVisible,
    onBlur,
    ...props
  },
  ref,
) {
  const [used, setUsed] = useState(false);
  const handle = useRef<TooltipHandle | null>(null);
  /** The pointer has entered since the tooltip last hid: a tooltip dismissed with the pointer
   *  still over its anchor stays away until the pointer comes back. */
  const entered = useRef(false);
  /** Focus that arrived before the tooltip existed, for the tooltip to answer once it does. */
  const focused = useRef<HTMLElement | null>(null);
  /** The same for the pointer. A pointer that comes to rest on the anchor may move over it
   *  exactly once, in the same instant it enters, which is before the tooltip has mounted. */
  const hovered = useRef<HTMLElement | null>(null);
  const disabled = isDisabled(props);

  const bind = useCallback((next: TooltipHandle | null) => {
    handle.current = next;
    const focusedAnchor = focused.current;
    const hoveredAnchor = hovered.current;
    focused.current = null;
    hovered.current = null;
    if (next == null) {
      return;
    }
    if (focusedAnchor && focusedAnchor.ownerDocument.activeElement === focusedAnchor) {
      next.focus(focusedAnchor);
    }
    if (hoveredAnchor) {
      next.hover(hoveredAnchor);
    }
  }, []);
  const onHidden = useCallback(() => {
    entered.current = false;
  }, []);

  /**
   * `role="button"` renders a plain element with no native activation, so Enter and
   * Space must both be handled to match a real button (WCAG 2.1.1). Space is always
   * preventDefault'd (including key-repeat) to suppress page scroll. Activation
   * ignores event.repeat so a held Space does not fire click() repeatedly.
   *
   * Default tabIndex to 0 for role="button" so keyboard users can reach consumers
   * that forget an explicit tabIndex (e.g. MCP card actions). Explicit values win.
   */
  const resolvedTabIndex = role === 'button' ? (tabIndex ?? 0) : tabIndex;

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      onKeyDown?.(event);
      if (role !== 'button' || event.defaultPrevented) {
        return;
      }
      if (event.key !== 'Enter' && event.key !== ' ') {
        return;
      }
      event.preventDefault();
      if (event.repeat) {
        return;
      }
      event.currentTarget.click();
    },
    [role, onKeyDown],
  );

  return (
    <>
      <Ariakit.Focusable
        {...props}
        ref={ref}
        role={role}
        tabIndex={resolvedTabIndex}
        onKeyDown={handleKeyDown}
        className={cn('cursor-pointer', focusOutlineVariants({ focusOutline }), className)}
        onMouseEnter={(event) => {
          onMouseEnter?.(event);
          entered.current = true;
          trackMouse();
          setUsed(true);
        }}
        onMouseMove={(event) => {
          onMouseMove?.(event);
          if (disabled || event.defaultPrevented || !entered.current) {
            return;
          }
          if (showOnHover === false || (typeof showOnHover === 'function' && !showOnHover(event))) {
            return;
          }
          if (handle.current) {
            handle.current.hover(event.currentTarget);
            return;
          }
          hovered.current = event.currentTarget;
        }}
        onMouseLeave={(event) => {
          onMouseLeave?.(event);
          hovered.current = null;
          handle.current?.cancel();
        }}
        onClick={(event) => {
          onClick?.(event);
          hovered.current = null;
          handle.current?.cancel();
        }}
        onFocusVisible={(event) => {
          onFocusVisible?.(event);
          if (event.defaultPrevented) {
            return;
          }
          if (handle.current) {
            handle.current.focus(event.currentTarget);
            return;
          }
          focused.current = event.currentTarget;
          setUsed(true);
        }}
        onBlur={(event) => {
          onBlur?.(event);
          if (event.defaultPrevented) {
            return;
          }
          entered.current = false;
          focused.current = null;
        }}
      />
      {used && (
        <TooltipPopup
          side={side}
          description={description}
          enableHTML={enableHTML}
          portalElement={portalElement}
          zIndex={zIndex}
          bind={bind}
          onHidden={onHidden}
        />
      )}
    </>
  );
});
