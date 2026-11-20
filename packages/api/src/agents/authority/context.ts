import type { ScheduledTokenContext } from '~/schedules/context';
import type { AgentRunProtocol } from '../envelope';
import { readScheduleFireContext } from '~/schedules/trigger';

/** The user whose authority a run exercises. */
export interface ExecutionPrincipal {
  readonly userId: string;
  readonly tenantId?: string;
  readonly role?: string;
}

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

/** Why the run exists, as established by the server at its entry point. */
export type ExecutionSource =
  | {
      readonly type: 'schedule';
      /** The schedule that fired, read from the verified trigger or the saved job. */
      readonly id: string;
      /** Started by the owner's Run Now rather than the schedule's cadence. */
      readonly manual: boolean;
      /** Restored from a saved job after an approval pause, not a fresh occurrence. */
      readonly resumed: boolean;
    }
  | {
      readonly type: 'remote_api';
      readonly protocol: AgentRunProtocol;
      /** A background Responses run, whose events go to a stream the owner can follow. */
      readonly background: boolean;
      /** The personal API key that started the run. Absent for a token or a bound key. */
      readonly keyId?: string;
    }
  | {
      /** Started by a delivery of the trigger engine, for the subject the delivery names. */
      readonly type: 'trigger';
      readonly subject: Subject;
      readonly delivery: Delivery;
    };

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

function principalOf(user: AuthenticatedRequest['user']): ExecutionPrincipal {
  return Object.freeze({ userId: user.id, ...(user.tenantId ? { tenantId: user.tenantId } : {}) });
}

/**
 * The context of a fresh schedule occurrence, from the trigger the trigger host verified.
 * Undefined for any other request, including one whose body copies schedule fields.
 */
export function createScheduleExecutionContext(
  req: AuthenticatedRequest & Parameters<typeof readScheduleFireContext>[0],
): ExecutionContext | undefined {
  const fire = readScheduleFireContext(req);
  if (!fire) return;
  const agentId = req?.body?.agent_id;
  return Object.freeze({
    principal: principalOf(req.user),
    ...(typeof agentId === 'string' ? { agentId } : {}),
    source: Object.freeze({
      type: 'schedule',
      id: fire.scheduleId,
      manual: fire.manual,
      resumed: false,
    }),
    unattended: false,
  });
}

type TriggerRecord = Record<string, unknown>;

function record(value: unknown): TriggerRecord | undefined {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as TriggerRecord)
    : undefined;
}

/**
 * The context of a run a trigger delivery started, from the request the trigger host built
 * and signed. A schedule's occurrence keeps the context it has always had. A delivery whose
 * event an API key posted runs for that key, so the key's grant can be put over the run. Any
 * other request, and any other delivery, has none.
 *
 * Nothing here is read from a field a caller sets: the public event route stamps the source
 * with the authenticated key, and only the trigger host can make a request that is a
 * trigger. A delivery that names a key as its source without saying which is refused, since
 * running it with no context would run it with no grant.
 */
export function createTriggerExecutionContext(
  req: AuthenticatedRequest & Parameters<typeof readScheduleFireContext>[0],
): ExecutionContext | undefined {
  const scheduled = createScheduleExecutionContext(req);
  if (scheduled) return scheduled;
  if (req?._isAgentTrigger !== true) return;
  const fire = record(req.body?.agentTrigger);
  const bound = record(req.body?.agentEventDelivery);
  const event = record((fire ?? bound)?.event);
  const source = record(event?.source);
  if (source?.type !== 'remote_api_key') return;
  const id = typeof source.id === 'string' ? source.id.trim() : '';
  if (
    id.length === 0 ||
    typeof event?.id !== 'string' ||
    typeof event.type !== 'string' ||
    typeof event.occurredAt !== 'number'
  ) {
    throw new Error('Agent trigger names an API key as its source without identifying it.');
  }
  const key = fire ? req.body?.clientRequestId : bound?.deliveryKey;
  const agentId = req.body?.agent_id;
  return Object.freeze({
    principal: principalOf(req.user),
    ...(typeof agentId === 'string' ? { agentId } : {}),
    source: Object.freeze({
      type: 'trigger',
      subject: Object.freeze({ kind: 'key', id }),
      delivery: Object.freeze({
        ...(typeof key === 'string' && key.length > 0 ? { key } : {}),
        event: Object.freeze({ id: event.id, type: event.type, occurredAt: event.occurredAt }),
      }),
    }),
    // As the chat route has always run these: whether a triggered run may publish a sign-in
    // prompt is not decided here.
    unattended: false,
  });
}

/** The personal API key a run acts for, whichever way the key started it. */
export function getSourceKey(context?: ExecutionContext): string | undefined {
  const source = context?.source;
  if (source?.type === 'remote_api') return source.keyId;
  if (source?.type === 'trigger' && source.subject.kind === 'key') return source.subject.id;
}

/** The schedule fields a saved generation job carries. */
export interface ScheduleJobIdentity {
  userId?: string;
  tenantId?: string;
  scheduleId?: string;
  scheduleManual?: boolean;
  agent_id?: string;
}

/**
 * Rebuilds a scheduled run's context from its saved job when it resumes, after the resume
 * host has checked job ownership, tenancy, agent and schedule liveness. Throws when the job
 * belongs to someone other than the authenticated owner. Undefined for an unscheduled job.
 */
export function restoreExecutionContext(
  req: AuthenticatedRequest,
  metadata?: ScheduleJobIdentity,
): ExecutionContext | undefined {
  if (!metadata?.scheduleId) return;
  if (
    metadata.userId !== req.user.id ||
    (metadata.tenantId != null && metadata.tenantId !== req.user.tenantId)
  ) {
    throw new Error('Scheduled job identity does not match the authenticated owner.');
  }
  /** A legacy job that cannot prove both its root agent and its tenant restores without an agent. */
  const complete = Boolean(metadata.agent_id) && !(req.user.tenantId && metadata.tenantId == null);
  return Object.freeze({
    principal: Object.freeze({
      userId: metadata.userId,
      ...(metadata.tenantId ? { tenantId: metadata.tenantId } : {}),
    }),
    ...(complete ? { agentId: metadata.agent_id } : {}),
    source: Object.freeze({
      type: 'schedule',
      id: metadata.scheduleId,
      manual: metadata.scheduleManual === true,
      resumed: true,
    }),
    unattended: false,
  });
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

/** The schedule a run belongs to, or undefined for an unscheduled run. */
export function getScheduleSource(
  context?: ExecutionContext,
): Extract<ExecutionSource, { type: 'schedule' }> | undefined {
  return context?.source.type === 'schedule' ? context.source : undefined;
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
  if (context?.source.type !== 'schedule') return;
  const agentId = context.agentId;
  if (typeof agentId !== 'string' || agentId.trim().length === 0) return;
  return Object.freeze({
    scheduleId: context.source.id,
    ownerId: context.principal.userId,
    ...(context.principal.tenantId ? { tenantId: context.principal.tenantId } : {}),
    agentId,
    invocationMode: 'delegated',
  });
}
