/**
 * What a run a trigger delivery started is known by: who it acts for and the delivery that
 * carried it. Imports nothing, so the job store can save and read it without reaching the
 * rest of the run context.
 */

/**
 * Who a triggered run acts for: the thing its owner set up, which holds what the run was
 * granted. A schedule, a personal API key, or an event subscription.
 */
export interface Subject {
  readonly kind: 'schedule' | 'key' | 'subscription';
  readonly id: string;
}

/** The one trigger delivery that started a run. */
export interface Delivery {
  /** The delivery's key in the trigger queue, where the request names it. */
  readonly key?: string;
  /** The event the delivery carried: its identity, never its payload. */
  readonly event: {
    readonly id: string;
    readonly type: string;
    readonly occurredAt: number;
  };
}

/**
 * The trigger that started a run, as its generation job saves it and a later request of the
 * same run reads it back.
 */
export interface RunTrigger {
  /**
   * Who the run acts for. Absent for a delivery the server made for itself, such as a task's
   * wake-up or a queued turn.
   */
  readonly subject?: Subject;
  /** Absent only where none was recorded: a job saved before its trigger was. */
  readonly delivery?: Delivery;
}

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

/**
 * Reads a saved trigger back from a generation job, or takes the one a run's source holds to
 * save it. Nothing for a value that names neither a subject nor a delivery. A stored value
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
  if ((saved.subject != null && !who) || (saved.delivery != null && !what))
    throw new Error('run_trigger_invalid');
  if (!who && !what) return;
  return Object.freeze({ ...(who && { subject: who }), ...(what && { delivery: what }) });
}
