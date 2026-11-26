import { SCHEDULE_APPROVAL_REASON } from 'librechat-data-provider';
import type { ScheduledMCPIdentity, RunGrantIdentity } from 'librechat-data-provider';
import type { RunGrantExecution, PolicyWording } from '~/agents/authority/execution';
import type { SubjectAdapter, SubjectInput } from '~/agents/authority/subject';
import type { RequestScopedMCPConnectionStore } from '~/mcp/types';
import type { readScheduleFireContext } from '../trigger';
import type { ScheduledTokenContext } from '../context';
import { grantExecution } from '~/agents/authority/execution';
import { isCompletionTurn } from '~/agents/authority/host';
import { isScheduleFireRequest } from '../trigger';

/** What the model is told when it calls a tool the schedule's owner did not allow. */
export const SCHEDULE_TOOL_NOT_ALLOWED =
  'The owner of this schedule has not allowed this tool. Continue without it.';

/** A schedule's wording. Both strings are read outside this code: by the model and the client. */
export const SCHEDULE_WORDING: PolicyWording = {
  leftOut: SCHEDULE_TOOL_NOT_ALLOWED,
  ask: SCHEDULE_APPROVAL_REASON,
};

/** The trusted trigger/resume host owns the context. No body-provided schedule opt-in. */
export function scheduledMCPIdentity(context: ScheduledTokenContext): ScheduledMCPIdentity {
  return {
    scheduleId: context.scheduleId,
    ownerId: context.ownerId,
    tenantId: context.tenantId ?? null,
    agentId: context.agentId,
    invocationMode: 'delegated',
  };
}

/**
 * The grant the request's run is under when the run acts for a schedule. A run that acts for
 * any other subject has none here: what reads this writes or reads a schedule's own records.
 */
export function scheduleExecution(
  context?: RequestScopedMCPConnectionStore,
): RunGrantExecution | undefined {
  const execution = grantExecution(context);
  return execution && actsForSchedule(execution) ? execution : undefined;
}

function actsForSchedule(
  execution: RunGrantExecution<RunGrantIdentity>,
): execution is RunGrantExecution {
  return 'scheduleId' in execution.identity;
}

export interface ScheduleInput extends SubjectInput {
  req: NonNullable<Parameters<typeof readScheduleFireContext>[0]> & {
    user: { id: string; tenantId?: string };
  };
  restoredJob?: {
    scheduleId?: string;
    /** The occurrence the saved job belongs to: its run row holds what it went without. */
    scheduledFor?: string | Date;
    scheduleManual?: boolean;
    scheduleMCPCompletion?: ScheduledMCPIdentity;
    /** The conversation the saved job ran in. */
    conversationId?: string;
  };
}

type Schedule = SubjectAdapter<ScheduledMCPIdentity, ScheduleInput>;

/** What the schedule run host answers for the adapter: the parts that read a schedule. */
export type ScheduleHost = Pick<Schedule, 'resolve' | 'execution'> &
  Required<Pick<Schedule, 'restore'>>;

/** The schedule a completion turn's marker names as the one that started its task. */
export function completionOrigin(req: ScheduleInput['req']): unknown {
  const marker = req.body?.agentCompletion;
  return marker != null && typeof marker === 'object' && 'scheduleMCPIdentity' in marker
    ? marker.scheduleMCPIdentity
    : undefined;
}

/**
 * The schedule subject: an occurrence, its resume, and the turns that report work an
 * occurrence sent to the background, which name the schedule on their marker or, once
 * resumed, on their saved job. Its host is built only for a request it claims.
 *
 * `retain` keeps the schedule on a completion turn's job, so the turn finds it again if it
 * pauses and is resumed.
 */
export function scheduleSubject(
  getHost: () => ScheduleHost,
  retain?: (identity: ScheduledMCPIdentity) => Promise<void>,
): Schedule {
  return {
    kind: 'schedule',
    opaque: true,
    claims: ({ req, restoredJob }) =>
      restoredJob?.scheduleMCPCompletion !== undefined ||
      isScheduleFireRequest(req) ||
      (isCompletionTurn(req) && completionOrigin(req) != null),
    resolve: (input) => getHost().resolve(input),
    restore: (input, found) => getHost().restore(input, found),
    get execution() {
      return getHost().execution;
    },
    ...(retain && {
      retain: async (identity: ScheduledMCPIdentity, { req, restoredJob }: ScheduleInput) => {
        if (isCompletionTurn(req) && restoredJob?.scheduleMCPCompletion === undefined)
          await retain(identity);
      },
    }),
  };
}
