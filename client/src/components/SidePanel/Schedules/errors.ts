import { readScheduleMCPOutcomes, scheduleMCPOutcomeSchema } from 'librechat-data-provider';
import type { TSchedule, ScheduleMCPStatus, ScheduleMCPOutcome } from 'librechat-data-provider';
import type { TranslationKeys, useLocalize } from '~/hooks';

export const MCP_STATUS_LABELS: Record<ScheduleMCPStatus, TranslationKeys> = {
  ready: 'com_ui_schedule_mcp_ready',
  mcp_reauth_required: 'com_ui_schedule_mcp_reauth',
  mcp_configuration_missing: 'com_ui_schedule_mcp_configuration',
  mcp_permission_denied: 'com_ui_schedule_mcp_permission',
  mcp_unavailable: 'com_ui_schedule_mcp_unavailable',
};

export function scheduleMCPStatusLabel(outcome: ScheduleMCPOutcome): TranslationKeys {
  return outcome.detail === 'unattended_auth_required'
    ? 'com_ui_schedule_mcp_unattended_auth'
    : MCP_STATUS_LABELS[outcome.status];
}

export function scheduleDisabledMCPLabel(
  reason: TSchedule['disabledReason'],
  outcomes: ScheduleMCPOutcome[],
): TranslationKeys | undefined {
  return reason === 'mcp_configuration_missing' &&
    outcomes.some((outcome) => outcome.detail === 'unattended_auth_required')
    ? 'com_ui_schedule_disabled_mcp_unattended_auth'
    : undefined;
}

export function scheduleMCPRecoveryOutcomes(
  schedule: Pick<TSchedule, 'enabled' | 'disabledReason' | 'lastRun'>,
) {
  const reason = schedule.disabledReason;
  const preservesMCPRecovery =
    reason === 'mcp_reauth_required' ||
    reason === 'mcp_configuration_missing' ||
    reason === 'mcp_permission_denied' ||
    reason === 'too_many_failures';
  if (schedule.enabled || !preservesMCPRecovery) return [];
  const persisted = scheduleMCPOutcomeSchema.array().safeParse(schedule.lastRun?.mcp);
  return persisted.success ? persisted.data : readScheduleMCPOutcomes(schedule.lastRun?.error);
}

export type ImmediateScheduleMCPFailure = {
  outcomes: ScheduleMCPOutcome[];
  lastRunKey: string;
};

export function scheduleLastRunKey(schedule: Pick<TSchedule, 'lastRun'>): string {
  return `${schedule.lastRun?.firedAt ?? ''}:${schedule.lastRun?.status ?? ''}`;
}

/** Keeps a request-local error visible until polling reports a different run. */
export function scheduleMCPCardOutcomes(
  schedule: Pick<TSchedule, 'enabled' | 'disabledReason' | 'lastRun'>,
  immediate: ImmediateScheduleMCPFailure | null,
): ScheduleMCPOutcome[] {
  return immediate?.lastRunKey === scheduleLastRunKey(schedule)
    ? immediate.outcomes
    : scheduleMCPRecoveryOutcomes(schedule);
}

export function scheduleMCPNeedsAgentRecovery(outcomes: ScheduleMCPOutcome[]): boolean {
  return outcomes.some(
    (outcome) =>
      outcome.status !== 'ready' &&
      outcome.status !== 'mcp_permission_denied' &&
      outcome.detail !== 'unattended_auth_required',
  );
}

export function scheduleMCPErrorMessage(
  error: Error,
  localize: ReturnType<typeof useLocalize>,
): string | undefined {
  const failures = scheduleMCPErrorOutcomes(error).filter((item) => item.status !== 'ready');
  if (failures.length > 0) {
    return failures
      .map((item) => `${item.server}: ${localize(scheduleMCPStatusLabel(item))}`)
      .join('; ');
  }
  const response = (
    error as Error & { response?: { status?: number; data?: { code?: string; mcp?: object } } }
  ).response;
  return response?.data?.code === 'mcp_unavailable'
    ? localize(MCP_STATUS_LABELS.mcp_unavailable)
    : undefined;
}

/** Preserves the structured recovery projection for immediate create, update, and
 * Run Now failures. The message formatter and every recovery surface consume the
 * same parsed outcome rather than independently interpreting the response. */
export function scheduleMCPErrorOutcomes(error: Error): ScheduleMCPOutcome[] {
  const payload = (error as Error & { response?: { data?: { mcp?: object } } }).response?.data?.mcp;
  const parsed = scheduleMCPOutcomeSchema.array().safeParse(payload);
  return parsed.success ? parsed.data : [];
}
