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
 * Sources that reserve a run record and a capacity slot before they enqueue, and whose sweep
 * ends both once the delivery is dead. Reviving such a delivery would start a run that no
 * record or slot covers, so it is run again from its source instead: a schedule is run now.
 */
const RESERVING_SOURCES: readonly string[] = ['schedule'];

function describe(letter: AgentTriggerDeadLetter): AgentTriggerDeadLetter {
  return letter.source != null && RESERVING_SOURCES.includes(letter.source)
    ? { ...letter, requeueable: false }
    : letter;
}

/**
 * The queue is written by workers outside any request, so its rows are read as the system
 * and the partition is part of each query rather than taken from the caller's context.
 */
export function createDeadLetters({ methods, requeue }: DeadLetterDeps): DeadLetters {
  return {
    list: async (tenantId, page) => {
      const found = await runAsSystem(async () =>
        methods.listAgentTriggerDeadLetterPage(tenantId, page),
      );
      return { letters: found.letters.map(describe), total: found.total };
    },
    get: async (tenantId, id) => {
      const letter = await runAsSystem(async () => methods.getAgentTriggerDeadLetter(tenantId, id));
      return letter == null ? null : describe(letter);
    },
    requeue: async (tenantId, id) => {
      try {
        const revived = await requeue(id, undefined, { tenantId, except: RESERVING_SOURCES });
        return revived == null ? CONFLICT : { ok: true };
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
