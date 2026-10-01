import { z } from 'zod';

/** Cadences the dialog builds from structured pickers (hour, minute, weekday). */
export const scheduleStructuredFrequencies = ['hourly', 'daily', 'weekdays', 'weekly'] as const;
export type ScheduleStructuredFrequency = (typeof scheduleStructuredFrequencies)[number];

export const scheduleFrequencies = [...scheduleStructuredFrequencies, 'cron'] as const;
export type ScheduleFrequency = (typeof scheduleFrequencies)[number];

/** Bounds a stored expression. Generous for five fields, because each one can hold a
 *  list: an every-minute-of-the-hour cadence spelled out runs past two hundred chars. */
export const SCHEDULE_CRON_MAX_LENGTH = 256;

export const scheduleTargets = ['new'] as const;
export type ScheduleTarget = (typeof scheduleTargets)[number];

export type ScheduleDisabledReason =
  | 'mcp_reauth_required'
  | 'mcp_configuration_missing'
  | 'mcp_permission_denied'
  | 'too_many_failures'
  | 'agent_deleted'
  | 'invalid_schedule'
  | 'permission_revoked'
  | 'insufficient_balance'
  | 'project_deleted'
  | 'project_required';

export type ScheduleRunStatus =
  | 'started'
  | 'requires_action'
  | 'success'
  | 'error'
  | 'interrupted'
  | 'skipped_overlap'
  | 'skipped_balance';

export const structuredCadenceSchema = z.object({
  frequency: z.enum(scheduleStructuredFrequencies),
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
  daysOfWeek: z
    .array(z.number().int().min(0).max(6))
    .min(1)
    .max(7)
    .transform((days) => Array.from(new Set(days)))
    .optional(),
});
export type TStructuredCadence = z.infer<typeof structuredCadenceSchema>;

/**
 * A raw cron expression carries its own hour and minute, so it cannot share the
 * structured shape: there is no single `hour` for `0 9,17 * * 1-5`. Syntax is
 * validated server-side by croner, the same parser the engine fires from, rather
 * than by a regex that would accept patterns croner then rejects at fire time.
 */
export const cronCadenceSchema = z.object({
  frequency: z.literal('cron'),
  expression: z.string().trim().min(1).max(SCHEDULE_CRON_MAX_LENGTH),
});
export type TCronCadence = z.infer<typeof cronCadenceSchema>;

export const scheduleCadenceSchema = z.discriminatedUnion('frequency', [
  structuredCadenceSchema,
  cronCadenceSchema,
]);
export type TScheduleCadence = z.infer<typeof scheduleCadenceSchema>;

export const isCronCadence = (cadence: TScheduleCadence): cadence is TCronCadence =>
  cadence.frequency === 'cron';

export const createSchedulePayloadSchema = z.object({
  name: z.string().trim().min(1).max(256),
  prompt: z.string().trim().min(1).max(32000),
  agent_id: z.string().trim().min(1),
  cadence: scheduleCadenceSchema,
  timezone: z.string().min(1),
  target: z.enum(scheduleTargets).default('new'),
  file_ids: z
    .array(z.string())
    .max(10)
    .transform((ids) => Array.from(new Set(ids)))
    .optional(),
  /**
   * Chat project each run's conversation is filed under. `null` clears the scope.
   * Ownership is checked server-side at write time and again at every fire, so a
   * deleted project disables the schedule instead of silently filing runs loose.
   */
  chatProjectId: z.string().trim().min(1).nullable().optional(),
  enabled: z.boolean().default(true),
  /**
   * Client-generated key making creation idempotent across retries. Creation commits
   * the row and arms it in two writes, so a failure between them leaves the client
   * unable to tell whether anything persisted; retrying blind can produce two recurring
   * schedules. A retry carrying the same key resolves to the original row instead.
   * REQUIRED: an optional key preserves the keyless duplicate path for any client
   * that omits it, which is exactly the failure the key exists to close.
   */
  clientRequestId: z.string().trim().min(1).max(128),
});
export type TCreateSchedule = z.infer<typeof createSchedulePayloadSchema>;

/** Idempotency is a property of the CREATE attempt, not of the schedule's config. */
export const updateSchedulePayloadSchema = createSchedulePayloadSchema
  .omit({ clientRequestId: true })
  .partial()
  .extend({
    /**
     * The configRevision the client's edit was computed from (captured when the
     * dialog opened). The server fences the update on it, so a concurrent edit
     * from another tab answers 409 instead of being silently overwritten by a
     * payload rebuilt from a stale snapshot (cadence is sent whole, so the
     * server-side fresh-read fence alone cannot detect this).
     */
    expectedConfigRevision: z.number().int().min(0).optional(),
  });
export type TUpdateSchedule = z.infer<typeof updateSchedulePayloadSchema>;

export type TScheduleLastRun = {
  conversationId?: string;
  status: ScheduleRunStatus;
  error?: string;
  mcp?: ScheduleMCPOutcome[];
  firedAt: string;
};

export type TSchedule = {
  id: string;
  user: string;
  name: string;
  prompt: string;
  agent_id: string;
  cadence: TScheduleCadence;
  timezone: string;
  target: ScheduleTarget;
  file_ids?: string[];
  chatProjectId?: string | null;
  enabled: boolean;
  disabledReason?: ScheduleDisabledReason;
  nextRunAt?: string;
  lastRun?: TScheduleLastRun;
  /**
   * The occurrences generating right now. Read from their own run rows, not from
   * `lastRun`, which is projected only when a run settles, pauses or skips and is
   * deliberately withheld from a run whose schedule was edited mid-flight. This is
   * the signal a client has that a chat is on its way, and the id to fetch it by.
   * A run parked on an approval is not here: its chat was listed long ago, and the
   * rows can accumulate for as long as approvals wait.
   */
  inFlight?: Array<{ conversationId: string }>;
  runCount: number;
  failureCount: number;
  configRevision?: number;
  createdAt: string;
  updatedAt: string;
};

export type TScheduleRun = {
  mcp?: ScheduleMCPOutcome[];
  scheduleId: string;
  scheduledFor: string;
  firedAt?: string;
  conversationId?: string;
  status: ScheduleRunStatus;
  error?: string;
  droppedFileIds?: string[];
  durationMs?: number;
};

/** Server-resolved policy the dialog must mirror. Sourced from the same
 *  per-principal `interface.schedules` resolution the write handlers and the fire
 *  path enforce, so the form can never offer a choice the server would refuse. */
export type TScheduleLimits = {
  maxPerUser: number;
  /** Served with the list so the dialog can refuse a cadence the floor would reject
   *  rather than surfacing it as a 400 after submit. */
  minIntervalMinutes: number;
  /** Every schedule must be filed under a chat project. */
  requireProject: boolean;
  /** Operator-pinned destination project; when set it is the ONLY destination and
   *  the client must not offer a picker. */
  projectId?: string;
};

export type TSchedulesResponse = {
  schedules: TSchedule[];
  limits: TScheduleLimits;
};

export type TScheduleRunNowResponse = {
  scheduleId: string;
  conversationId: string;
  status: 'started';
};

/** Only structured schedule preflight failures may request immediate suspension. */
export function getScheduleMCPDisabledReason(
  outcomes?: ScheduleMCPOutcome[],
): 'mcp_reauth_required' | 'mcp_configuration_missing' | 'mcp_permission_denied' | undefined {
  const statuses = new Set(outcomes?.map((outcome) => outcome.status));
  if (statuses.has('mcp_permission_denied')) return 'mcp_permission_denied';
  if (statuses.has('mcp_configuration_missing')) return 'mcp_configuration_missing';
  if (statuses.has('mcp_reauth_required')) return 'mcp_reauth_required';
  return undefined;
}

export const scheduleMCPOutcomeSchema = z.object({
  server: z.string(),
  /** Agent whose selected tool requires this server. Used to open the correct
   * recovery chat when the requirement belongs to a handoff or subagent. */
  agentId: z.string().optional(),
  /** Additional diagnosis; older clients ignore unknown keys and retain the known status. */
  detail: z.enum(['unattended_auth_required']).optional(),
  status: z.enum([
    'ready',
    'mcp_reauth_required',
    'mcp_configuration_missing',
    'mcp_permission_denied',
    'mcp_unavailable',
  ]),
});
export type ScheduleMCPOutcome = z.infer<typeof scheduleMCPOutcomeSchema>;
export type ScheduleMCPStatus = ScheduleMCPOutcome['status'];

export function readScheduleMCPOutcomes(error?: string): ScheduleMCPOutcome[] {
  if (
    !error ||
    !/^mcp_(reauth_required|configuration_missing|permission_denied|unavailable): \[/.test(error)
  )
    return [];
  try {
    const result = scheduleMCPOutcomeSchema
      .array()
      .safeParse(JSON.parse(error.slice(error.indexOf(': ') + 2)));
    return result.success ? result.data : [];
  } catch {
    return [];
  }
}
