import {
  scheduleMCPOutcomeSchema,
  isScheduleMCPAuthorizationFailure,
} from 'librechat-data-provider';
import type { ScheduleMCPOutcome } from 'librechat-data-provider';
import type { SerializableJobData } from './interfaces/IJobStore';

const priorities: Record<ScheduleMCPOutcome['status'], number> = {
  ready: 0,
  mcp_unavailable: 1,
  mcp_reauth_required: 2,
  mcp_configuration_missing: 3,
  mcp_permission_denied: 4,
};

export function scheduleMCPFailurePriority(outcome?: ScheduleMCPOutcome): number {
  return outcome && isScheduleMCPAuthorizationFailure(outcome) ? priorities[outcome.status] : 0;
}

/** Called inside the in-memory writer's non-awaiting section. */
export function retainScheduleMCPFailure(
  current: SerializableJobData,
  patch: Partial<SerializableJobData>,
): Partial<SerializableJobData> {
  if (patch.scheduleMCPFailure === undefined) return patch;
  const incoming = scheduleMCPOutcomeSchema.safeParse(patch.scheduleMCPFailure);
  const retained = current.scheduleMCPFailure;
  const next =
    incoming.success && scheduleMCPFailurePriority(incoming.data) > 0 ? incoming.data : undefined;
  const failure =
    scheduleMCPFailurePriority(retained) >= scheduleMCPFailurePriority(next) ? retained : next;
  const { scheduleMCPFailure: _failure, ...rest } = patch;
  return failure
    ? {
        ...rest,
        scheduleMCPFailure: failure,
        scheduleOutcome: 'error',
        scheduleOutcomeError: `${failure.status}: ${JSON.stringify([failure])}`,
      }
    : rest;
}

/** Normalizes HSET pairs inside the already epoch-fenced Redis CAS, never a prior read. */
export const SCHEDULE_MCP_FAILURE_PATCH_LUA: string =
  'local incomingFailure = nil ' +
  'for i = 1, #hset, 2 do if hset[i] == "scheduleMCPFailure" then incomingFailure = hset[i + 1] end end ' +
  'if incomingFailure then ' +
  'local priorities = { mcp_unavailable = 1, mcp_reauth_required = 2, mcp_configuration_missing = 3, mcp_permission_denied = 4 } ' +
  'local function priority(raw) if not raw then return 0 end local ok, value = pcall(cjson.decode, raw) ' +
  'if not ok or type(value) ~= "table" or (value.detail ~= "unattended_auth_required" and (not value.reason or value.automaticReplay ~= false)) then return 0 end ' +
  'return priorities[value.status] or 0 end ' +
  'local retained = redis.call("HGET", KEYS[1], "scheduleMCPFailure") ' +
  'local winner = priority(retained) >= priority(incomingFailure) and retained or incomingFailure ' +
  'local filtered = {} for i = 1, #hset, 2 do local field = hset[i] ' +
  'if field ~= "scheduleMCPFailure" and field ~= "scheduleOutcome" and field ~= "scheduleOutcomeError" then ' +
  'filtered[#filtered + 1] = field filtered[#filtered + 1] = hset[i + 1] end end ' +
  'if priority(winner) > 0 then local value = cjson.decode(winner) ' +
  'filtered[#filtered + 1] = "scheduleMCPFailure" filtered[#filtered + 1] = winner ' +
  'filtered[#filtered + 1] = "scheduleOutcome" filtered[#filtered + 1] = "error" ' +
  'filtered[#filtered + 1] = "scheduleOutcomeError" filtered[#filtered + 1] = value.status .. ": [" .. winner .. "]" end ' +
  'hset = filtered end ';
