import { cn } from '@librechat/client';
import type { ReactNode } from 'react';
import { revealOnRowHoverClasses, messageFooterClasses } from './styles';
import Elapsed, { shouldShowElapsed } from './Elapsed';
import SiblingSwitch from './SiblingSwitch';
import SubRow from './SubRow';

/** What a message row's footer needs: the row's place in its thread and its toolbar. */
export type MessageFooterProps = {
  /** The pane the row renders in. */
  index: number;
  isSubmitting: boolean;
  isLatestMessage: boolean;
  isCreatedByUser?: boolean;
  /** Whether the row sits on the user's side, which aligns the footer to the end. */
  isUserSide: boolean;
  /** Whether the sibling navigation sits at the outer edge, after the toolbar. */
  siblingsLast?: boolean;
  siblingIdx?: number;
  siblingCount?: number;
  setSiblingIdx?: ((value: number) => void) | null;
  /** The row's hover actions (the package's `HoverButtons`). */
  toolbar: ReactNode;
};

/** A message row's footer: elapsed time while it streams, sibling navigation and the toolbar. */
export default function MessageFooter({
  index,
  isSubmitting,
  isLatestMessage,
  isCreatedByUser,
  isUserSide,
  siblingsLast = false,
  siblingIdx,
  siblingCount,
  setSiblingIdx,
  toolbar,
}: MessageFooterProps): ReactNode {
  return (
    <SubRow classes={cn(messageFooterClasses, isUserSide && 'justify-end')}>
      {/* The reading holds the column start: it takes over the slot the streaming
          dot vacates, so the retry navigation beside it, whose width the footer
          reserves whether or not hover has revealed it, must never push the
          timer inboard of that column. */}
      {shouldShowElapsed({
        isSubmitting,
        isLatestMessage,
        isCreatedByUser,
        siblingIdx,
        siblingCount,
      }) && <Elapsed index={index} />}
      {/* A user turn is right-aligned, so its retry navigation can belong at the
          outer edge under the bubble rather than inboard of the actions.

          While the answer is generating every other action is withheld, which
          would otherwise leave this counter sitting alone under a half-written
          response. It reveals on hover there, like the actions it sits with. */}
      <SiblingSwitch
        siblingIdx={siblingIdx}
        siblingCount={siblingCount}
        setSiblingIdx={setSiblingIdx}
        className={cn(
          siblingsLast && 'order-last',
          isSubmitting && isLatestMessage && revealOnRowHoverClasses,
        )}
      />
      {toolbar}
    </SubRow>
  );
}
