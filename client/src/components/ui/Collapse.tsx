import type { ReactNode } from 'react';
import { cn } from '~/utils';

interface CollapseProps {
  open: boolean;
  children: ReactNode;
  className?: string;
  overflowVisibleWhenOpen?: boolean;
}

/**
 * Auto-height reveal via grid-template-rows 0fr -> 1fr, matching MCPToolItem and
 * the OAuth QR. The parent's content-driven height follows the tween in a single
 * motion, so stacked collapses (e.g. a loading skeleton swapping to a list) can
 * cross-fade smoothly without a measuring wrapper fighting nested reveals.
 * Content fades to soften the swap; while closed it is `inert` (removed from tab
 * order and the a11y tree) so collapsed form fields can't be focused or read.
 *
 * `overflowVisibleWhenOpen` lifts the clip while open so non-portaled popovers
 * anchored inside (e.g. dropdown menus, which must stay in-tree within modal
 * dialogs to remain inside the focus trap) aren't sheared at the box edge; the
 * closed state and the closing tween still clip, and the opacity fade masks the
 * un-clipped opening tween.
 */
export default function Collapse({
  open,
  children,
  className,
  overflowVisibleWhenOpen = false,
}: CollapseProps) {
  return (
    <div
      aria-hidden={!open || undefined}
      inert={!open ? '' : undefined}
      className={cn(
        'grid transition-[grid-template-rows] [transition-duration:var(--resize-dur)] [transition-timing-function:var(--resize-ease)] motion-reduce:transition-none',
        open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
      )}
    >
      <div
        className={cn(
          'min-h-0',
          open && overflowVisibleWhenOpen ? 'overflow-visible' : 'overflow-hidden',
        )}
      >
        <div
          className={cn(
            'transition-opacity duration-200 ease-out motion-reduce:transition-none',
            open ? 'opacity-100' : 'opacity-0',
            className,
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
