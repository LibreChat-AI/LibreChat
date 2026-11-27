import { exemptFromUserLimiter as exemptScheduleFire } from '~/schedules/trigger';
import { createTriggerExecutionContext } from './context';

type TriggerRequest = Parameters<typeof createTriggerExecutionContext>[0];

/**
 * Whether a request is left out of its user's chat limiter: an automatic schedule occurrence,
 * bounded by its cadence and the global capacity, or any turn of a run an event subscription
 * started, bounded by the subscription's hourly cap. The concurrency limiter is not this:
 * a subscription's runs still count there.
 */
export function exemptTriggerFromUserLimiter(req?: TriggerRequest): boolean {
  if (exemptScheduleFire(req)) return true;
  if (req?._isAgentTrigger !== true) return false;
  try {
    const source = createTriggerExecutionContext(req)?.source;
    return source?.type === 'trigger' && source.subject?.kind === 'subscription';
  } catch {
    // A trigger whose context cannot be read is refused later; it is not exempt here.
    return false;
  }
}
