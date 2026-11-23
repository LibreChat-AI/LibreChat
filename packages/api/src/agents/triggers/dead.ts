import { runAsSystem } from '@librechat/data-schemas';
import type {
  AgentTriggerDeliveryMethods,
  AgentTriggerDeadLetterPage,
  AgentTriggerDeadLetter,
} from '@librechat/data-schemas';
import type { AgentTriggerService } from './service';
import { AgentTriggerServiceUnavailableError } from './service';

/**
 * Why a dead letter was left as it was: `conflict` when it is no longer in a state the
 * action applies to, `unavailable` when this server cannot run the delivery queue.
 */
export type DeadLetterOutcome =
  | { ok: true }
  | { ok: false; error: { code: 'conflict' | 'unavailable' } };

/**
 * Administrative access to dead trigger deliveries. Every call names one tenant partition
 * (`undefined` is the tenantless one) and reaches no row outside it.
 */
export interface DeadLetters {
  list: (
    tenantId: string | undefined,
    page: { limit: number; offset: number },
  ) => Promise<AgentTriggerDeadLetterPage>;
  /** Null when the partition holds no dead letter with this id. */
  get: (tenantId: string | undefined, id: string) => Promise<AgentTriggerDeadLetter | null>;
  requeue: (tenantId: string | undefined, id: string) => Promise<DeadLetterOutcome>;
  dismiss: (tenantId: string | undefined, id: string) => Promise<DeadLetterOutcome>;
}

export interface DeadLetterDeps {
  methods: Pick<
    AgentTriggerDeliveryMethods,
    'listAgentTriggerDeadLetterPage' | 'getAgentTriggerDeadLetter' | 'dismissAgentTriggerDeadLetter'
  >;
  /** The trigger service's requeue, which also wakes the delivery engine. */
  requeue: AgentTriggerService['requeue'];
}

const CONFLICT: DeadLetterOutcome = { ok: false, error: { code: 'conflict' } };

/**
 * The queue is written by workers outside any request, so its rows are read as the system
 * and the partition is part of each query rather than taken from the caller's context.
 */
export function createDeadLetters({ methods, requeue }: DeadLetterDeps): DeadLetters {
  return {
    list: (tenantId, page) =>
      runAsSystem(async () => methods.listAgentTriggerDeadLetterPage(tenantId, page)),
    get: (tenantId, id) => runAsSystem(async () => methods.getAgentTriggerDeadLetter(tenantId, id)),
    requeue: async (tenantId, id) => {
      try {
        return (await requeue(id, undefined, { tenantId })) == null ? CONFLICT : { ok: true };
      } catch (error) {
        if (error instanceof AgentTriggerServiceUnavailableError) {
          return { ok: false, error: { code: 'unavailable' } };
        }
        throw error;
      }
    },
    dismiss: async (tenantId, id) =>
      (await runAsSystem(async () => methods.dismissAgentTriggerDeadLetter(tenantId, id)))
        ? { ok: true }
        : CONFLICT,
  };
}
