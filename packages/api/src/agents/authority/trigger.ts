/**
 * What a run a trigger delivery started is known by: who it acts for and the delivery that
 * carried it. Imports nothing, so the job store can save and read it without reaching the
 * rest of the run context.
 */

/**
 * Who a triggered run acts for: the thing its owner set up, which holds what the run was
 * granted. A schedule, a personal API key, or an event subscription.
 */
export type Subject = {
  readonly kind: 'schedule' | 'key' | 'subscription';
  readonly id: string;
};

/** The one trigger delivery that started a run. */
export type Delivery = {
  /** The delivery's key in the trigger queue, where the request names it. */
  readonly key?: string;
  /** The event the delivery carried: its identity, never its payload. */
  readonly event: {
    readonly id: string;
    readonly type: string;
    readonly occurredAt: number;
  };
};

/** The run that began the work a later turn reports. */
export type Origin = {
  /** The root agent that run was admitted for, which a grant held per agent is found by. */
  readonly agentId?: string;
  /** The delivery that started that run. Absent where it recorded none. */
  readonly delivery?: Delivery;
};

/**
 * The trigger that started a run, as its generation job saves it and a later request of the
 * same run reads it back. Work the run sends to the background keeps the subject and the
 * origin, and the turn that reports the work is given both.
 */
export type RunTrigger = {
  /**
   * Who the run acts for. Absent for a delivery the server made for itself, such as a queued
   * turn, unless it reports work that a run with a subject began.
   */
  readonly subject?: Subject;
  /** Absent only where none was recorded: a job saved before its trigger was. */
  readonly delivery?: Delivery;
  /**
   * On a turn that reports work an earlier run sent to the background: that run. The turn
   * acts for the same subject and has a delivery of its own. Absent on the run itself.
   */
  readonly origin?: Origin;
};

type TriggerRecord = Record<string, unknown>;

function record(value: unknown): TriggerRecord | undefined {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as TriggerRecord)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/** A delivery from its key and the identity of its event, or nothing when the event is malformed. */
export function toDelivery(key: unknown, value: unknown): Delivery | undefined {
  const event = record(value);
  const id = text(event?.id);
  const type = text(event?.type);
  const occurredAt = event?.occurredAt;
  if (id == null || type == null || typeof occurredAt !== 'number' || !Number.isFinite(occurredAt))
    return;
  const named = text(key);
  return Object.freeze({
    ...(named != null && { key: named }),
    event: Object.freeze({ id, type, occurredAt }),
  });
}

function subject(value: unknown): Subject | undefined {
  const { kind, id } = record(value) ?? {};
  if (kind !== 'schedule' && kind !== 'key' && kind !== 'subscription') return;
  const named = text(id);
  return named == null ? undefined : Object.freeze({ kind, id: named });
}

/** Undefined for no origin, null for one that cannot be read. */
function origin(value: unknown): Origin | null | undefined {
  if (value == null) return;
  const saved = record(value);
  const agentId = text(saved?.agentId);
  const delivery = toDelivery(record(saved?.delivery)?.key, record(saved?.delivery)?.event);
  if (
    !saved ||
    (saved.agentId != null && agentId == null) ||
    (saved.delivery != null && !delivery) ||
    (agentId == null && !delivery)
  )
    return null;
  return Object.freeze({ ...(agentId != null && { agentId }), ...(delivery && { delivery }) });
}

/**
 * Reads a saved trigger back from a generation job, or takes the one a run's source holds to
 * save it. Nothing for a value that names no subject, delivery or origin. A stored value
 * that names one badly is refused: a job whose trigger cannot be read is not an ordinary job,
 * and restoring it as one would run it under nothing.
 */
export function parseRunTrigger(value: unknown, serialized = false): RunTrigger | undefined {
  let saved: TriggerRecord | undefined;
  try {
    saved = record(serialized && typeof value === 'string' ? JSON.parse(value) : value);
  } catch {
    saved = undefined;
  }
  if (!saved) throw new Error('run_trigger_invalid');
  const who = subject(saved.subject);
  const what = toDelivery(record(saved.delivery)?.key, record(saved.delivery)?.event);
  const from = origin(saved.origin);
  if ((saved.subject != null && !who) || (saved.delivery != null && !what) || from === null)
    throw new Error('run_trigger_invalid');
  if (!who && !what && !from) return;
  return Object.freeze({
    ...(who && { subject: who }),
    ...(what && { delivery: what }),
    ...(from && { origin: from }),
  });
}

/**
 * The part of a run's context that says what started the run. An `ExecutionContext` is one.
 * Declared here so the code that starts background work can be handed a run's context
 * without importing the module that builds it.
 */
export interface RunContext {
  readonly agentId?: string;
  readonly source: { readonly type: string } & RunTrigger;
}

/**
 * What work a run sends to the background keeps of the run, for the turn that reports it:
 * who the run acts for, and the run the work began in, by its root agent and its delivery.
 * A turn that itself reports earlier work passes on the origin it was given, so the origin
 * of a chain of tasks stays the run a delivery from outside started. Nothing for a run no
 * trigger started: an interactive chat's task captures nothing, and its turn has no subject.
 */
export function captureTrigger(context?: RunContext): RunTrigger | undefined {
  const source = context?.source;
  if (!context || source?.type !== 'trigger') return;
  const { agentId } = context;
  const began =
    source.origin ??
    (agentId != null || source.delivery
      ? Object.freeze({
          ...(agentId != null && { agentId }),
          ...(source.delivery && { delivery: source.delivery }),
        })
      : undefined);
  if (!source.subject && !began) return;
  return Object.freeze({
    ...(source.subject && { subject: source.subject }),
    ...(began && { origin: began }),
  });
}

/**
 * The trigger some work kept, read from what carries it: the payload of the delivery that
 * reports the work, then what the trigger host puts on the request it makes for it. Nothing
 * where none was kept, as for a task an interactive chat started. One that cannot be read is
 * refused.
 */
export function readRunTrigger(holder: unknown): RunTrigger | undefined {
  const held = record(holder)?.trigger;
  return held == null ? undefined : parseRunTrigger(held);
}
