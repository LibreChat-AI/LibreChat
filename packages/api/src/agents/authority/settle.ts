import { logger } from '@librechat/data-schemas';
import type { SubjectAdapter, SubjectInput, Settle } from './subject';
import { createTriggerExecutionContext } from './context';
import { getSafeErrorMetadata } from '~/utils/errors';

type TriggerRequest = Parameters<typeof createTriggerExecutionContext>[0];

/** A turn's outcome as the chat route has it, without the context the settler reads itself. */
export type TurnOutcome = Omit<Settle, 'executionContext'>;

/**
 * Hands how a turn of a triggered run ended to the subject the run acts for, so each kind of
 * subject records its own runs. `true` when no subject records this run, or the one that
 * does recorded it; `false` when it could not.
 *
 * A schedule's runs are settled by the chat route itself, as they always were; this is for
 * every other subject that keeps a record of its runs.
 */
export function createRunSettler(
  adapters: ReadonlyArray<Pick<SubjectAdapter, 'claims' | 'settle'>>,
): (req: TriggerRequest, outcome: TurnOutcome) => Promise<boolean> {
  return async (req, outcome) => {
    if (req?._isAgentTrigger !== true) return true;
    // The run started, so its trigger was read once already and reads the same now.
    const executionContext = createTriggerExecutionContext(req);
    if (!executionContext) return true;
    const input: SubjectInput = { req, executionContext };
    const adapter = adapters.find((candidate) => candidate.settle && candidate.claims(input));
    if (!adapter?.settle) return true;
    // Never thrown into the caller: the chat route settles on its way out, and its cleanup
    // after (releasing the generation, the owner's concurrency) must run. A run left active
    // is finished by its subject's sweep.
    try {
      return await adapter.settle({ ...outcome, executionContext, request: req });
    } catch (error) {
      logger.error('[agents] a triggered run could not be settled', getSafeErrorMetadata(error));
      return false;
    }
  };
}
