import { useContext } from 'react';
import { LoneGroupContext, SoleToolContext } from '../disclosure';

/**
 * The settled outcome of a sole call, spoken after its row is gone. The row's
 * text changes from the running label to the finished one, but a row that
 * unmounts in the same render cannot announce that, and the group header keeps
 * the tool's name. This region mounts with the card and stays, so the text it
 * gains when the row leaves is announced; a card that mounts already settled
 * (a restored message) starts with the text in place and says nothing.
 *
 * Only a call that can drop its row renders it, so a card with a row of its
 * own never carries a second, empty live region.
 */
export default function BareStatus({ active, text }: { active: boolean; text: string }) {
  const sole = useContext(SoleToolContext) === true;
  const lone = useContext(LoneGroupContext);
  if (!sole && !lone) {
    return null;
  }
  return (
    <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {active ? text : ''}
    </span>
  );
}
