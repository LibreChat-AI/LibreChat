import { PinOff } from 'lucide-react';
import { Button, TooltipAnchor, useMediaQuery } from '@librechat/client';
import type { KeyboardEvent, MouseEvent } from 'react';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

interface UnpinButtonProps {
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  /** Which row kind reports the click, for the tests that drive each one. */
  testId: string;
  /** Holds the badge open past the pointer leaving, for a row whose overflow
   *  menu is open: the pointer is on the menu, not on the row, and a control
   *  that vanished while its own row's menu stood open read as the row losing
   *  half its actions. */
  keepVisible?: boolean;
  /** Row-local placement only; the badge owns its own appearance. */
  className?: string;
}

/**
 * The unpin badge a pinned row carries, shared by both kinds of row in the
 * Pinned section: conversations and agents/models/specs. They sit in one list
 * and are reordered against each other, so a badge that differed in colour,
 * size or in when it appears read as two different controls.
 *
 * Hidden until the row is hovered or holds focus, and inert while hidden so an
 * invisible badge cannot swallow a click meant for the row. The reveal is asked
 * for in JS rather than through an `@media (hover: hover)` variant, the way the
 * row's overflow trigger does it: a variant only ever loses or wins the cascade
 * against the `group-hover` rules it has to override, and which way it goes
 * differs per property. A device with any coarse pointer gets no gating at all,
 * which is the only thing that makes the badge reachable by touch, including on
 * a 2-in-1 whose trackpad answers `(hover: hover)`.
 */
export default function UnpinButton({
  onClick,
  onKeyDown,
  testId,
  keepVisible = false,
  className,
}: UnpinButtonProps) {
  const localize = useLocalize();
  const hasHoverPointer = useMediaQuery('(hover: hover)');
  const hasCoarsePointer = useMediaQuery('(any-pointer: coarse)');

  return (
    <TooltipAnchor
      description={localize('com_ui_unpin')}
      side="top"
      render={
        <Button
          variant="row-action"
          size="icon-xs"
          aria-label={localize('com_ui_unpin')}
          data-testid={testId}
          onClick={onClick}
          onKeyDown={onKeyDown}
          className={cn(
            'text-text-secondary shrink-0',
            hasHoverPointer &&
              !hasCoarsePointer &&
              !keepVisible &&
              'pointer-events-none opacity-0 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100',
            className,
          )}
        >
          <PinOff className="size-4" aria-hidden="true" />
        </Button>
      }
    />
  );
}
