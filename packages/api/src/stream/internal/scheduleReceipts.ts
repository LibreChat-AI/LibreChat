import { scheduledMCPFailureReasonSchema } from 'librechat-data-provider';
import { readScheduleMCPReceipts, projectScheduleMCPReceipt } from 'librechat-data-provider';
import type { ScheduleMCPOutcome } from 'librechat-data-provider';

/** Only settlement acknowledgement releases the receipt's hash lifetime. */
export const SCHEDULE_RETENTION_LUA: string = `
local function expireScheduleJob(key, seconds)
  if redis.call('HGET', key, 'preserveForScheduleReconcile') == '1' then
    redis.call('PERSIST', key)
  elseif seconds > 0 then redis.call('EXPIRE', key, seconds)
  else redis.call('DEL', key) end
end
`;

/** Embedded after epoch/status guards in both same-slot job writers. */
export const SCHEDULE_MCP_RECEIPT_LUA: string =
  SCHEDULE_RETENTION_LUA +
  `
local function retainScheduleReceipt(hset, current, force, original)
  local allowed = cjson.decode('${JSON.stringify(Object.fromEntries(scheduledMCPFailureReasonSchema.options.map((reason) => [reason, true])))}')
  local incoming = nil
  local touched = false
  for i = 1, #hset, 2 do
    if hset[i] == 'scheduleOutcomeError' then incoming = hset[i+1] touched = true end
    if hset[i] == 'scheduleOutcome' then touched = true end
  end
  if not touched and not force then return hset end
  local rows = {}
  local seen = {}
  local priority = { mcp_unavailable = 1, mcp_reauth_required = 2, mcp_configuration_missing = 3, mcp_permission_denied = 4 }
  local strongest = 'mcp_unavailable'
  local function collect(raw)
    if type(raw) ~= 'string' then return end
    local prefix, json = string.match(raw, '^(mcp_[%w_]+): (.+)$')
    if not priority[prefix] then return end
    local ok, decoded = pcall(cjson.decode, json)
    if not ok or type(decoded) ~= 'table' then return end
    for _, row in ipairs(decoded) do
      if type(row) == 'table' and type(row.server) == 'string' and priority[row.status]
        and (row.detail == 'unattended_auth_required' or (allowed[row.reason] and row.automaticReplay == false)) and (row.reason == nil or allowed[row.reason])
        and (row.automaticReplay == nil or row.automaticReplay == false) then
        local item = { server = row.server, status = row.status } if row.detail == 'unattended_auth_required' then item.detail = row.detail end
        if type(row.agentId) == 'string' then item.agentId = row.agentId end
        if allowed[row.reason] then item.reason = row.reason end
        if row.recovery == 'authorize' or row.recovery == 'configure' or row.recovery == 'restore_permission' or row.recovery == 'retry_later' then item.recovery = row.recovery end
        if row.automaticReplay == false then item.automaticReplay = false end
        local key = cjson.encode({row.server, row.agentId or '', row.status, row.reason or '', row.recovery or '', row.detail})
        if not seen[key] then rows[#rows+1] = item seen[key] = true end
        if priority[row.status] > priority[strongest] then strongest = row.status end
      end
    end
  end
  collect(current) collect(incoming) collect(original)
  if #rows == 0 then return hset end
  local output = {}
  for i = 1, #hset, 2 do
    if hset[i] ~= 'scheduleOutcome' and hset[i] ~= 'scheduleOutcomeError' then
      output[#output+1] = hset[i] output[#output+1] = hset[i+1]
    end
  end
  output[#output+1] = 'scheduleOutcome' output[#output+1] = 'error'
  output[#output+1] = 'scheduleOutcomeError' output[#output+1] = strongest .. ': ' .. cjson.encode(rows)
  return output
end
`;

export function retainedScheduleReceipt(
  current: { scheduleOutcomeError?: string; scheduleMCPFailure?: ScheduleMCPOutcome },
  patch: {
    scheduleOutcome?: string;
    scheduleOutcomeError?: string;
    scheduleMCPFailure?: ScheduleMCPOutcome;
  },
  clear: readonly string[] = [],
): { scheduleOutcome?: string; scheduleOutcomeError?: string } {
  if (
    patch.scheduleOutcome === undefined &&
    patch.scheduleOutcomeError === undefined &&
    patch.scheduleMCPFailure === undefined &&
    !clear.some((field) => field === 'scheduleOutcome' || field === 'scheduleOutcomeError')
  )
    return {};
  const receipts = [
    ...readScheduleMCPReceipts(current.scheduleOutcomeError),
    ...readScheduleMCPReceipts(patch.scheduleOutcomeError),
    ...(current.scheduleMCPFailure ? [current.scheduleMCPFailure] : []),
    ...(patch.scheduleMCPFailure ? [patch.scheduleMCPFailure] : []),
  ];
  if (!receipts.length) return {};
  const projection = projectScheduleMCPReceipt({ status: 'error' }, receipts);
  return { scheduleOutcome: 'error', scheduleOutcomeError: projection.error };
}
