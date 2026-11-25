import type { TMessageTrigger } from 'librechat-data-provider';
import type { ScheduledTokenContext } from '~/schedules/context';
import type { Delivery, RunTrigger } from './trigger';
import type { AgentRunProtocol } from '../envelope';
import { readScheduleFireContext } from '~/schedules/trigger';
import { toDelivery, readRunTrigger } from './trigger';

/**
 * The source type of a delivery an event subscription matched. Only code inside the server
 * enqueues one: the public event route stamps every delivery it takes with the API key.
 */
export const SUBSCRIPTION_SOURCE = 'subscription';

/** The user whose authority a run exercises. */
export interface ExecutionPrincipal {
  readonly userId: string;
  readonly tenantId?: string;
  readonly role?: string;
}

/** Why the run exists, as established by the server at its entry point. */
export type ExecutionSource =
  | {
      readonly type: 'remote_api';
      readonly protocol: AgentRunProtocol;
      /** A background Responses run, whose events go to a stream the owner can follow. */
      readonly background: boolean;
      /** The personal API key that started the run. Absent for a token or a bound key. */
      readonly keyId?: string;
    }
  | (RunTrigger & {
      /** Started by a delivery of the trigger engine. */
      readonly type: 'trigger';
      /** Started by its owner's hand, as a schedule's Run Now is, not by its cadence. */
      readonly manual: boolean;
      /** Restored from a saved job after an approval pause, not a fresh delivery. */
      readonly resumed: boolean;
    });

/**
 * Who a run acts for and why, built once by the server where the run enters and passed
 * down from there. No client or model input sets any field. Frozen: a consumer cannot
 * change what a later consumer sees.
 */
export interface ExecutionContext {
  readonly principal: ExecutionPrincipal;
  /** The root agent the run was admitted for. Subagents and handoffs keep it. */
  readonly agentId?: string;
  readonly source: ExecutionSource;
  /**
   * Nobody can follow a sign-in prompt for this run: a remote API run with no generation
   * stream answers an API client, not a person. Decided here, so nothing that loads tools
   * for the run works it out again.
   */
  readonly unattended: boolean;
}

interface AuthenticatedRequest {
  user: { id: string; tenantId?: string };
}

type TriggerRequest = AuthenticatedRequest & Parameters<typeof readScheduleFireContext>[0];

function principalOf(user: AuthenticatedRequest['user']): ExecutionPrincipal {
  return Object.freeze({ userId: user.id, ...(user.tenantId ? { tenantId: user.tenantId } : {}) });
}

type TriggerRecord = Record<string, unknown>;

function record(value: unknown): TriggerRecord | undefined {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as TriggerRecord)
    : undefined;
}

function triggered(
  req: AuthenticatedRequest,
  agentId: unknown,
  trigger: RunTrigger,
  manual: boolean,
  resumed: boolean,
): ExecutionContext {
  return Object.freeze({
    principal: principalOf(req.user),
    ...(typeof agentId === 'string' ? { agentId } : {}),
    source: Object.freeze({
      type: 'trigger',
      ...(trigger.subject && { subject: trigger.subject }),
      ...(trigger.delivery && { delivery: trigger.delivery }),
      ...(trigger.origin && { origin: trigger.origin }),
      manual,
      resumed,
    }),
    // Nobody follows a run an outside event started, on any of its turns, so it never asks
    // for a sign-in. For any other subject the chat route runs these as it always has:
    // whether such a run may publish a sign-in prompt is not decided here.
    unattended: trigger.subject?.kind === 'subscription',
  });
}

/**
 * The context of a run a trigger delivery started, from the request the trigger host built
 * and signed. Undefined for any other request, including one whose body copies these fields.
 *
 * The delivery is the request's own: its key in the trigger queue and the identity of the
 * event it carried, which the host names in the body of every request it makes. The subject
 * is whoever the event's source names. A schedule's occurrence runs for the schedule. An
 * event an API key posted runs for that key, so the key's grant can be put over the run. An
 * event a subscription matched runs for the subscription. A delivery the server made for
 * itself, such as a queued turn, has none.
 *
 * A turn that reports work sent to the background is the exception: its delivery is the
 * server's own, and it acts for whoever the run that began the work acted for. The work
 * kept that run's trigger, and the trigger host hands it back: on the completion marker of
 * the turn that reports a task, and on the delivery that resumes an actor suspended on a
 * detached action. The turn takes its subject, its origin and its root agent from there, so
 * a grant held for the first run is found again for this one.
 *
 * Nothing here is read from a field a caller sets: the public event route stamps the source
 * with the authenticated key, the captured trigger is written and read back by the server,
 * and only the trigger host can make a request that is a trigger. A delivery that names a
 * key or a subscription as its source without saying which, or without an event to identify
 * it by, is refused, as is a turn whose captured trigger cannot be read, since running either
 * with no context would run it with no grant.
 */
export function createTriggerExecutionContext(req: TriggerRequest): ExecutionContext | undefined {
  if (req?._isAgentTrigger !== true) return;
  const body = req.body;
  const fire = record(body?.agentTrigger);
  const bound = fire ? undefined : record(body?.agentEventDelivery);
  /** A new turn and a bound continuation name their event themselves; any other names it beside. */
  const named = fire ?? bound;
  const event = record(named ? named.event : body?.agentEvent);
  const carried = toDelivery(bound ? bound.deliveryKey : body?.clientRequestId, event);
  const schedule = readScheduleFireContext(req);
  if (schedule) {
    const who = Object.freeze({ kind: 'schedule', id: schedule.scheduleId } as const);
    return triggered(
      req,
      body?.agent_id,
      { subject: who, delivery: carried },
      schedule.manual,
      false,
    );
  }
  const source = record(event?.source);
  if (source?.type === SUBSCRIPTION_SOURCE) {
    const id = typeof source.id === 'string' ? source.id.trim() : '';
    if (id.length === 0 || !carried)
      throw new Error('Agent trigger names a subscription as its source without identifying it.');
    const who = Object.freeze({ kind: 'subscription', id } as const);
    return triggered(req, body?.agent_id, { subject: who, delivery: carried }, false, false);
  }
  if (source?.type !== 'remote_api_key') {
    // Only a delivery the server made for itself reports work an earlier run began: a task's
    // wake-up on its completion marker, a suspended actor's resumption on its delivery. One
    // that names no source is read too, so that it is refused below, not run with no context.
    const made = !fire && (source == null || source.type === 'internal');
    const began = made ? readRunTrigger(bound ?? body?.agentCompletion) : undefined;
    if (began && !carried)
      throw new Error('Agent completion names the run that began its work without an event.');
    if (!carried) return;
    return triggered(
      req,
      began?.origin?.agentId ?? body?.agent_id,
      { subject: began?.subject, delivery: carried, origin: began?.origin },
      false,
      false,
    );
  }
  const id = typeof source.id === 'string' ? source.id.trim() : '';
  if (id.length === 0 || !carried) {
    throw new Error('Agent trigger names an API key as its source without identifying it.');
  }
  const who = Object.freeze({ kind: 'key', id } as const);
  return triggered(req, body?.agent_id, { subject: who, delivery: carried }, false, false);
}

/**
 * The context of a fresh schedule occurrence, from the trigger the trigger host verified.
 * Undefined for any other request, including one whose body copies schedule fields.
 */
export function createScheduleExecutionContext(req: TriggerRequest): ExecutionContext | undefined {
  const context = createTriggerExecutionContext(req);
  return getScheduleSource(context) ? context : undefined;
}

/** The longest event type a message keeps. */
const TYPE_LIMIT = 256;
/** Controls, format characters such as direction overrides, and line and paragraph breaks. */
const UNSHOWN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;

/**
 * An event type as an owner may be shown it. An outside system names the type of an event
 * it posts, so it may be any length and may carry characters that reorder what is on screen.
 */
function shown(type: string): string {
  const bounded = type.length > TYPE_LIMIT * 2 ? type.slice(0, TYPE_LIMIT * 2) : type;
  const plain = bounded.normalize('NFC').replace(UNSHOWN, ' ').trim();
  return plain.length > TYPE_LIMIT ? Array.from(plain).slice(0, TYPE_LIMIT).join('') : plain;
}

function toEvent(delivery?: Delivery): TMessageTrigger['event'] | undefined {
  if (!delivery) return;
  const at = new Date(delivery.event.occurredAt);
  const type = shown(delivery.event.type);
  if (Number.isNaN(at.getTime()) || type.length === 0) return;
  return { type, occurredAt: at.toISOString() };
}

/**
 * What the first message of a triggered turn records of what started it: the event the
 * turn's own delivery carried, who the run acts for and, on a turn that reports work an
 * earlier run sent to the background, the event that began that run. Undefined for a run no
 * trigger started, and for one whose delivery named no event.
 *
 * Read from the context alone, so a request cannot write it. It is what the owner is shown,
 * so it names events and not deliveries, with their types made safe to show: the delivery
 * key, the event id and the type as it was sent stay on the job.
 */
export function toMessageTrigger(context?: ExecutionContext): TMessageTrigger | undefined {
  const source = context?.source;
  if (source?.type !== 'trigger') return;
  const event = toEvent(source.delivery);
  if (!event) return;
  const began = toEvent(source.origin?.delivery);
  return {
    event,
    ...(source.subject && { subject: { kind: source.subject.kind, id: source.subject.id } }),
    ...(began && { origin: { event: began } }),
  };
}

/** The request a turn is served on, where the chat route keeps what `toMessageTrigger` returned. */
interface TurnRequest {
  _messageTrigger?: TMessageTrigger;
}

/**
 * A first message of the turn a request serves, recording what started the turn. The message
 * is returned as it is when the turn has no such record, so a caller stamps every first
 * message it builds without asking whether a trigger started it.
 */
export function stampMessageTrigger<T extends object | null | undefined>(
  req: TurnRequest | undefined,
  message: T,
): T {
  const trigger = req?._messageTrigger;
  return trigger == null || message == null ? message : { ...message, trigger };
}

/** The personal API key a run acts for, whichever way the key started it. */
export function getSourceKey(context?: ExecutionContext): string | undefined {
  const source = context?.source;
  if (source?.type === 'remote_api') return source.keyId;
  if (source?.type === 'trigger' && source.subject?.kind === 'key') return source.subject.id;
}

/** What a saved generation job carries of the run it belongs to. */
export interface SavedRun {
  userId?: string;
  tenantId?: string;
  agent_id?: string;
  /** The trigger that started the run. Absent on a job saved before it was recorded. */
  trigger?: RunTrigger;
  /** The schedule fields, which a scheduled job has always carried. */
  scheduleId?: string;
  scheduleManual?: boolean;
}

/**
 * Rebuilds a triggered run's context from its saved job when it resumes, after the resume
 * host has checked job ownership, tenancy, agent and schedule liveness: the same subject,
 * delivery and origin the run started with. A job saved before its trigger was recorded
 * restores from its schedule fields alone, with no delivery. Throws when the job belongs to
 * someone other than the authenticated owner, or names a schedule its saved trigger does not.
 * Undefined for a job no trigger started.
 */
export function restoreExecutionContext(
  req: AuthenticatedRequest,
  metadata?: SavedRun,
): ExecutionContext | undefined {
  const saved = metadata?.trigger;
  const scheduleId = metadata?.scheduleId;
  if (!metadata || (!scheduleId && !saved)) return;
  if (
    metadata.userId !== req.user.id ||
    (metadata.tenantId != null && metadata.tenantId !== req.user.tenantId)
  ) {
    throw new Error(
      `${scheduleId ? 'Scheduled' : 'Saved'} job identity does not match the authenticated owner.`,
    );
  }
  const named = saved?.subject;
  if (scheduleId && named && (named.kind !== 'schedule' || named.id !== scheduleId))
    throw new Error('Scheduled job identity does not match its saved trigger.');
  const who = scheduleId ? Object.freeze({ kind: 'schedule', id: scheduleId } as const) : named;
  /** A legacy job that cannot prove both its root agent and its tenant restores without an agent. */
  const complete = Boolean(metadata.agent_id) && !(req.user.tenantId && metadata.tenantId == null);
  return triggered(
    {
      user: { id: metadata.userId, ...(metadata.tenantId ? { tenantId: metadata.tenantId } : {}) },
    },
    // A turn that reports earlier work keeps the root agent of the run that began it.
    complete ? (saved?.origin?.agentId ?? metadata.agent_id) : undefined,
    { subject: who, delivery: saved?.delivery, origin: saved?.origin },
    metadata.scheduleManual === true,
    true,
  );
}

/** The context of a run started through the remote agent API. */
export function createRemoteExecutionContext({
  principal,
  agentId,
  protocol,
  background,
  keyId,
}: {
  principal: ExecutionPrincipal;
  agentId?: string;
  protocol: AgentRunProtocol;
  background: boolean;
  /** The personal API key that started the run. Absent for a token or a bound key. */
  keyId?: string;
}): ExecutionContext {
  return Object.freeze({
    principal: Object.freeze({
      userId: principal.userId,
      ...(principal.tenantId ? { tenantId: principal.tenantId } : {}),
      ...(principal.role ? { role: principal.role } : {}),
    }),
    ...(agentId ? { agentId } : {}),
    source: Object.freeze({ type: 'remote_api', protocol, background, ...(keyId && { keyId }) }),
    unattended: !background,
  });
}

/** What a run a schedule's occurrence started says of it. */
export interface ScheduleSource {
  /** The schedule that fired, read from the verified trigger or the saved job. */
  readonly id: string;
  /** Started by the owner's Run Now rather than the schedule's cadence. */
  readonly manual: boolean;
  /** Restored from a saved job after an approval pause, not a fresh occurrence. */
  readonly resumed: boolean;
}

/**
 * The schedule whose occurrence a run is, or undefined for any other run. A turn that
 * reports work an occurrence sent to the background acts for the schedule but is not the
 * occurrence: the schedule's run host finds the schedule for it by the identity the work
 * captured, and nothing that reads the occurrence here applies to it.
 */
export function getScheduleSource(context?: ExecutionContext): ScheduleSource | undefined {
  const source = context?.source;
  if (source?.type !== 'trigger' || source.subject?.kind !== 'schedule' || source.origin) return;
  return { id: source.subject.id, manual: source.manual, resumed: source.resumed };
}

/**
 * The schedule identity that host credential providers and scheduled MCP authority bind to.
 * Undefined unless the run is scheduled and its root agent is known: a job saved before the
 * agent was recorded, or by a tenant-less writer for a tenant member, stays resumable but
 * cannot claim a complete minting identity.
 */
export function toScheduledTokenContext(
  context?: ExecutionContext,
): ScheduledTokenContext | undefined {
  const schedule = getScheduleSource(context);
  const agentId = context?.agentId;
  if (!context || !schedule || typeof agentId !== 'string' || agentId.trim().length === 0) return;
  return Object.freeze({
    scheduleId: schedule.id,
    ownerId: context.principal.userId,
    ...(context.principal.tenantId ? { tenantId: context.principal.tenantId } : {}),
    agentId,
    invocationMode: 'delegated',
  });
}
