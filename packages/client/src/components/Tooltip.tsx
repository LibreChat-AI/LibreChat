import {
  memo,
  forwardRef,
  useCallback,
  useMemo,
  RefAttributes,
  ForwardRefExoticComponent,
} from 'react';
import DOMPurify from 'dompurify';
import * as Ariakit from '@ariakit/react';
import { AnimatePresence, motion } from 'framer-motion';
import type { FocusOutline } from './Focus';
import { useDialogDepth, usePopoverZIndex } from './OriginalDialog';
import { focusOutlineVariants } from './Focus';
import { cn } from '~/utils';
import './Tooltip.css';

interface TooltipAnchorProps extends Ariakit.TooltipAnchorProps {
  focusOutline?: FocusOutline;
  role?: string;
  className?: string;
  description: string;
  enableHTML?: boolean;
  portalElement?: Ariakit.TooltipProps['portalElement'];
  side?: 'top' | 'bottom' | 'left' | 'right';
}

/**
 * Isolated component that subscribes to tooltip store state independently,
 * so the anchor element never re-renders when the tooltip mounts/unmounts.
 */
const TooltipPopup = memo(function TooltipPopup({
  store,
  description,
  enableHTML,
  portalElement,
}: {
  store: Ariakit.TooltipStore;
  description: string;
  enableHTML: boolean;
  portalElement?: Ariakit.TooltipProps['portalElement'];
}) {
  const mounted = Ariakit.useStoreState(store, (state) => state.mounted);
  const placement = Ariakit.useStoreState(store, (state) => state.placement);
  /** Tooltips portal to body at z-150, which nested dialogs (z 200+) cover —
   * inside a dialog, borrow the popover's depth-aware z-index; outside, keep
   * the stylesheet default so tooltips never outrank freshly opened dialogs. */
  const dialogDepth = useDialogDepth();
  const popoverZIndex = usePopoverZIndex();

  const sanitizer = useMemo(() => {
    const instance = DOMPurify();
    instance.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName && node.tagName === 'A') {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    });
    return instance;
  }, []);

  const sanitizedHTML = useMemo(() => {
    if (!enableHTML) {
      return '';
    }
    try {
      return sanitizer.sanitize(description, {
        ALLOWED_TAGS: ['a', 'strong', 'b', 'em', 'i', 'br', 'code'],
        ALLOWED_ATTR: ['href', 'class', 'target', 'rel'],
        ALLOW_DATA_ATTR: false,
        ALLOW_ARIA_ATTR: false,
      });
    } catch (error) {
      console.error('Sanitization failed', error);
      return description;
    }
  }, [enableHTML, description, sanitizer]);

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
          gutter={4}
          alwaysVisible
          portalElement={portalElement}
          className="tooltip"
          render={
            <motion.div
              style={dialogDepth > 0 ? { zIndex: popoverZIndex } : undefined}
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
    onKeyDown,
    tabIndex,
    ...props
  },
  ref,
) {
  const tooltip = Ariakit.useTooltipStore({ placement: side });

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
    <Ariakit.TooltipProvider store={tooltip} hideTimeout={0}>
      <Ariakit.TooltipAnchor
        {...props}
        ref={ref}
        role={role}
        tabIndex={resolvedTabIndex}
        onKeyDown={handleKeyDown}
        className={cn('cursor-pointer', focusOutlineVariants({ focusOutline }), className)}
      />
      <TooltipPopup
        store={tooltip}
        description={description}
        enableHTML={enableHTML}
        portalElement={portalElement}
      />
    </Ariakit.TooltipProvider>
  );
});
