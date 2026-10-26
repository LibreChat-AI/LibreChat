import { buttonVariants } from '@librechat/client';
import cn from './cn';

/**
 * The trailing control on a list row: the conversation overflow menu and every
 * action that sits where it sits, in the bookmark, memory, MCP, prompt and
 * project lists.
 *
 * One recipe because a row action is one idea. Each list had grown its own
 * version, and they disagreed about size, hover fill and when the control was
 * even visible, so the same gesture looked different depending on which list
 * the pointer was over.
 *
 * `open` keeps the control lit and visible while the menu or dialog it owns is
 * open: the pointer has left the row for the popup by then, and a trigger that
 * vanishes underneath an open menu reads as a different control on the way
 * back.
 *
 * `visible` is for a row that already stands out on its own, such as the active
 * conversation, where the action should not wait to be found.
 */
export const rowActionClasses = ({
  open = false,
  visible = false,
}: { open?: boolean; visible?: boolean } = {}): string =>
  cn(
    buttonVariants({ variant: 'row-action-reveal', size: 'icon-xs' }),
    open && 'bg-surface-active text-text-primary',
    (visible || open) && 'opacity-100 no-touch:opacity-100',
  );

/**
 * The slot a row's actions sit in.
 *
 * Collapsed to nothing while the row rests, so the title and the description are
 * measured against the whole row rather than against what is left beside a control
 * no one can see. A slot that always reserved its width truncated text that had the
 * room to be read, and the ellipsis then said the name was longer than it was.
 *
 * Where any pointer is coarse there is no reveal a finger can wait for, so the slot keeps
 * its width and the actions stay reachable, on a 2-in-1 whose trackpad hovers too. Only the collapsed slot clips: once focus is
 * inside, the focused action's ring has to draw past the slot's edge.
 */
export const rowActionSlotClasses = ({ open = false }: { open?: boolean } = {}): string =>
  cn(
    'flex shrink-0 items-center gap-0.5',
    !open && [
      'no-touch:w-0 no-touch:overflow-hidden',
      'no-touch:group-hover:w-auto',
      'no-touch:group-focus-within:w-auto no-touch:group-focus-within:overflow-visible',
    ],
  );
