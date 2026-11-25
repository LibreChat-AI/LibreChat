import type { ScheduledPause } from '~/agents/hitl/admission';
import { resolveScheduledPause } from '~/agents/hitl/admission';
import { createTriggerExecutionContext } from './context';

type TriggerRequest = Parameters<typeof createTriggerExecutionContext>[0] & {
  _isScheduledFire?: boolean;
};

/**
 * Whether a run may pause for its owner, from the request it runs in. Any turn of a run an
 * event subscription started may not: nothing records the run again when a resume finishes
 * it, so the run starts without the ask-user tool and a call that needs approval is refused,
 * never run unapproved. A schedule's run is asked as before; any other run may pause.
 */
export async function resolveRunPause({
  req,
  ...rest
}: Omit<Parameters<typeof resolveScheduledPause>[0], 'scheduled'> & {
  req?: TriggerRequest;
}): Promise<ScheduledPause> {
  if (req?._isAgentTrigger === true) {
    const source = createTriggerExecutionContext(req)?.source;
    if (source?.type === 'trigger' && source.subject?.kind === 'subscription') {
      return { capable: false, prunes: true, missing: 'unattended' };
    }
  }
  return resolveScheduledPause({ ...rest, scheduled: req?._isScheduledFire === true });
}
