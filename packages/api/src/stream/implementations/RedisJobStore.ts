import { logger } from '@librechat/data-schemas';
import { createContentAggregator } from '@librechat/agents';
import { ContentTypes, getRunStepDurationMs } from 'librechat-data-provider';
import type { StandardGraph } from '@librechat/agents';
import type { Agents } from 'librechat-data-provider';
import type { Redis, Cluster } from 'ioredis';
import type {
  SerializableJobData,
  CreatedJobData,
  ReplacedGeneration,
  SteerQueueItem,
  UsageMetadata,
  IJobStoreV2,
  JobStatus,
  JobMetadataPatch,
  JobStatusTransition,
  IdempotencyClaimValue,
  IdempotencyClaimResult,
  SteerArmOutcome,
  SteerArmResult,
  SteerEnqueueReceiptResult,
  SteerEnqueueVersionedResult,
  TerminalSteerAdmissionPolicy,
  TerminalSteerAdmissionResult,
  SteerReceipt,
  SteerReceiptInput,
  ParkedSteerClaim,
} from '~/stream/interfaces/IJobStore';
import type { EarlyBufferOverflowState } from '../../types/earlyBufferRecovery';
import type { ResolvedAskUserQuestion } from '~/agents/hitl/resume';
import type { RecoveredSteerPayload } from '~/stream/SteerRecovery';
import {
  JobCreationSupersededError,
  JobStatusTransitionDeadlineError,
  JobPredecessorMismatchError,
  STEER_ENQUEUE_NOT_RUNNING,
  STEER_QUEUE_MAX_DEPTH,
  PAUSE_PERSISTENCE_TIMEOUT_ERROR,
  PAUSE_PERSISTENCE_TIMEOUT_MS,
  PROVIDER_DRAIN_TIMEOUT_MS,
  isPendingActionStale,
  toWireRunSteps,
} from '~/stream/interfaces/IJobStore';
import {
  MAX_COALESCED_BYTES,
  MAX_COALESCED_EVENTS,
  resolveCoalesceWindowMs,
} from '~/stream/internal/coalescing';
import { instrumentIORedisClient, RedisUseCases } from '~/cache/redisTelemetry';
import { RecoveredSteerPayloadMismatchError } from '~/stream/SteerRecovery';
import { createCheckpointNamespace } from '~/stream/checkpoints';
import { evalScript } from '~/cache/redisScript';

const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;

type ReasoningLabelOverlay = {
  stepId: string;
  revision: number;
  label: string;
  status: 'streaming' | 'complete';
};

type ReasoningAttemptOverlay = {
  stepId: string;
  attempts: number;
  submittedChars?: number;
};

type ReasoningContentPart = Agents.MessageContentComplex & {
  reasoning_label?: string;
  reasoning_label_step_id?: string;
  reasoning_label_attempts?: number;
  reasoning_label_submitted_chars?: number;
  reasoning_label_revision?: number;
  reasoning_label_status?: 'streaming' | 'complete';
};

function assertCreateIdempotencyArguments(
  claimKey?: string,
  claimToken?: string,
  clientRequestId?: string,
): void {
  const supplied = [claimKey, claimToken, clientRequestId].filter((value) => value != null).length;
  if (
    (supplied !== 0 && supplied !== 3) ||
    (supplied === 3 &&
      (claimKey!.length === 0 ||
        claimKey!.length > 1024 ||
        claimToken!.length === 0 ||
        claimToken!.length > 128 ||
        !CLIENT_REQUEST_ID_PATTERN.test(clientRequestId!)))
  ) {
    throw new Error('Invalid generation job idempotency arguments');
  }
}

/**
 * Atomic compare-and-set on the job hash — the single-winner decision for a
 * status transition. All supplied keys share the stream hash tag, so updating
 * the job and terminal stream cleanup are atomic on both single-node Redis and
 * Redis Cluster (cross-slot membership sets self-heal during cleanup).
 *
 * Guards on the current `status` and, when supplied, on the flat
 * `pendingActionId` and `createdAt` fields — so a stale decision targeting a
 * different action or replacement epoch loses. On success: removes `clear`
 * fields, writes `status`+patch pairs, refreshes the job-hash TTL, and performs
 * terminal cleanup of same-slot stream state. Returns 1 if it fired, 0 otherwise;
 * the abort-only mode returns the JSON-encoded drained items on success.
 *
 *   KEYS: [job, eventSequence, chunks, runSteps, steers, claimedSteers,
 *          parkedSteers, generationEpoch, steerReceipts, steerReceiptOrder]
 *   ARGV: [
 *     from,
 *     expectActionId | "",
 *     expectCreatedAt | "",
 *     notAfterMs | "",
 *     ttl,
 *     terminal ("0" | "1"),
 *     chunksAfterComplete,
 *     runStepsAfterComplete,
 *     parkedSteersTtl,
 *     generationEpochGraceTtl,
 *     steerReceiptTtl (0 to leave unchanged),
 *     returnDrainedSteers,
 *     hdelCount,
 *     ...hdelFields,
 *     ...hsetPairs
 *   ]
 */
const JOB_CAS_LUA =
  'if redis.call("HGET", KEYS[1], "status") ~= ARGV[1] then return 0 end ' +
  'if ARGV[2] ~= "" and redis.call("HGET", KEYS[1], "pendingActionId") ~= ARGV[2] then return 0 end ' +
  'if ARGV[3] ~= "" and redis.call("HGET", KEYS[1], "createdAt") ~= ARGV[3] then return 0 end ' +
  'if ARGV[4] ~= "" then local now = redis.call("TIME") ' +
  'local nowMs = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000) ' +
  'if nowMs >= tonumber(ARGV[4]) then return -1 end end ' +
  'local currentCreatedAt = redis.call("HGET", KEYS[1], "createdAt") ' +
  'local ttl = tonumber(ARGV[5]) ' +
  'local terminal = ARGV[6] == "1" ' +
  'local chunksTtl = tonumber(ARGV[7]) ' +
  'local runStepsTtl = tonumber(ARGV[8]) ' +
  'local parkedTtl = tonumber(ARGV[9]) ' +
  'local generationEpochGraceTtl = tonumber(ARGV[10]) ' +
  'local receiptTtl = tonumber(ARGV[11]) ' +
  'local ownerUserId = redis.call("HGET", KEYS[1], "userId") ' +
  'local ownerTenantId = redis.call("HGET", KEYS[1], "tenantId") ' +
  'local generationProtocol = redis.call("HGET", KEYS[1], "generationProtocolVersion") == "2" and 2 or 1 ' +
  'local parkedProtocol = generationProtocol ' +
  'local function isDenseArray(value) if type(value) ~= "table" then return false end ' +
  'local count = 0 for key, _ in pairs(value) do ' +
  'if type(key) ~= "number" or key < 1 or key ~= math.floor(key) then return false end count = count + 1 end ' +
  'return count == #value end ' +
  // A terminal transition is destructive. Validate every recovery source
  // before changing status, receipts, queues, or parked state.
  'local validatedPrior = {} ' +
  'if terminal then ' +
  'local claimedRows = {} if generationProtocol == 2 then claimedRows = redis.call("LRANGE", KEYS[6], 0, -1) end ' +
  'local sources = { claimedRows, redis.call("LRANGE", KEYS[5], 0, -1) } ' +
  'for s = 1, #sources do for i = 1, #sources[s] do local ok, item = pcall(cjson.decode, sources[s][i]) ' +
  'if not ok or type(item) ~= "table" or type(item.steerId) ~= "string" or item.steerId == "" then return 0 end end end ' +
  'local parkedRaw = redis.call("GET", KEYS[7]) ' +
  'if parkedRaw then local ok, parked = pcall(cjson.decode, parkedRaw) ' +
  'if not ok or type(parked) ~= "table" or type(parked.userId) ~= "string" or parked.userId == "" ' +
  'or not isDenseArray(parked.steers) or #parked.steers == 0 or parked.userId ~= ownerUserId ' +
  'or (parked.tenantId and parked.tenantId ~= ownerTenantId) then return 0 end ' +
  'if parked.generationProtocolVersion and parked.generationProtocolVersion ~= 1 ' +
  'and parked.generationProtocolVersion ~= 2 then return 0 end ' +
  'if parked.generationProtocolVersion == 2 then parkedProtocol = 2 end ' +
  'for i = 1, #parked.steers do local item = parked.steers[i] ' +
  'if type(item) ~= "table" or type(item.steerId) ~= "string" or item.steerId == "" ' +
  'or (item.clientSteerId and (type(item.clientSteerId) ~= "string" or item.clientSteerId == "")) ' +
  'or (item.text and type(item.text) ~= "string") ' +
  'or (item.createdAt and (type(item.createdAt) ~= "number" or item.createdAt < 0)) ' +
  'or (item.recoveringCreatedAt and (type(item.recoveringCreatedAt) ~= "number" or item.recoveringCreatedAt < 0)) then return 0 end ' +
  'validatedPrior[#validatedPrior + 1] = item end end end ' +
  'local hdelCount = tonumber(ARGV[13]) ' +
  'local idx = 14 ' +
  'for i = 1, hdelCount do redis.call("HDEL", KEYS[1], ARGV[idx]) idx = idx + 1 end ' +
  'local hset = {} ' +
  'for i = idx, #ARGV do hset[#hset + 1] = ARGV[i] end ' +
  'if #hset > 0 then redis.call("HSET", KEYS[1], unpack(hset)) end ' +
  'if terminal then redis.call("HSET", KEYS[1], "steersClosed", "1") end ' +
  // A same-status pause-barrier release does not carry pendingAction again.
  // Preserve an explicit approval window that is longer than the default
  // requires_action TTL instead of shortening the live job and its content.
  'if not terminal and redis.call("HGET", KEYS[1], "status") == "requires_action" then ' +
  'local currentTtl = redis.call("TTL", KEYS[1]) ' +
  'if currentTtl > ttl then ttl = currentTtl end end ' +
  'redis.call("EXPIRE", KEYS[1], ttl) ' +
  'local effectiveReceiptTtl = receiptTtl ' +
  'if not terminal and ttl > effectiveReceiptTtl then effectiveReceiptTtl = ttl end ' +
  'if terminal and parkedTtl > effectiveReceiptTtl then effectiveReceiptTtl = parkedTtl end ' +
  'if not terminal and redis.call("HGET", KEYS[1], "recoveredSteerId") then ' +
  'local recoveryLeaseTtl = ttl + parkedTtl ' +
  'if recoveryLeaseTtl > effectiveReceiptTtl then effectiveReceiptTtl = recoveryLeaseTtl end ' +
  'local pt = redis.call("TTL", KEYS[7]) ' +
  'if pt >= 0 and pt < recoveryLeaseTtl then redis.call("EXPIRE", KEYS[7], recoveryLeaseTtl) end end ' +
  'if effectiveReceiptTtl > 0 then ' +
  'for i = 9, 10 do local rt = redis.call("TTL", KEYS[i]) ' +
  'if rt >= 0 and rt < effectiveReceiptTtl then redis.call("EXPIRE", KEYS[i], effectiveReceiptTtl) end end ' +
  'end ' +
  'local seqTtl = redis.call("TTL", KEYS[2]) ' +
  'if seqTtl >= 0 and seqTtl < ttl then redis.call("EXPIRE", KEYS[2], ttl) end ' +
  'if currentCreatedAt then redis.call("SET", KEYS[8], currentCreatedAt, "EX", ttl + generationEpochGraceTtl) end ' +
  'if terminal then ' +
  'local items = {} local projected = {} local seen = {} ' +
  'local claimedRows = {} if generationProtocol == 2 then claimedRows = redis.call("LRANGE", KEYS[6], 0, -1) end ' +
  'local sources = { claimedRows, redis.call("LRANGE", KEYS[5], 0, -1) } ' +
  'for s = 1, #sources do for i = 1, #sources[s] do ' +
  'local decoded, item = pcall(cjson.decode, sources[s][i]) ' +
  'if decoded and type(item) == "table" and item.steerId and not seen[item.steerId] then ' +
  'seen[item.steerId] = true ' +
  'items[#items + 1] = item ' +
  'local clientItem = { steerId = item.steerId, text = item.text, createdAt = item.createdAt } ' +
  'if item.clientSteerId then clientItem.clientSteerId = item.clientSteerId end ' +
  'if item.files then clientItem.files = item.files end ' +
  'if item.quotes then clientItem.quotes = item.quotes end ' +
  'if item.preempt then clientItem.preempt = item.preempt end ' +
  'if item.preemptRevision then clientItem.preemptRevision = item.preemptRevision end ' +
  'projected[#projected + 1] = clientItem ' +
  'if generationProtocol == 2 and item.clientSteerId then local raw = redis.call("HGET", KEYS[9], item.clientSteerId) ' +
  'if raw then local receiptOk, receipt = pcall(cjson.decode, raw) ' +
  'if receiptOk and type(receipt) == "table" then receipt.item = item receipt.state = "leftover" ' +
  'redis.call("HSET", KEYS[9], item.clientSteerId, cjson.encode(receipt)) end end end ' +
  'end ' +
  'end end ' +
  'if #projected > 0 and ownerUserId then ' +
  'local merged = {} local parkedSeen = {} ' +
  'for i = 1, #validatedPrior do local item = validatedPrior[i] if not parkedSeen[item.steerId] then ' +
  'parkedSeen[item.steerId] = true merged[#merged + 1] = item end end ' +
  'for i = 1, #projected do local item = projected[i] if item.steerId and not parkedSeen[item.steerId] then ' +
  'parkedSeen[item.steerId] = true merged[#merged + 1] = item end end ' +
  'local parked = { userId = ownerUserId, generationProtocolVersion = parkedProtocol, steers = merged } ' +
  'if ownerTenantId then parked.tenantId = ownerTenantId end ' +
  'redis.call("SET", KEYS[7], cjson.encode(parked), "EX", parkedTtl) ' +
  'end ' +
  'redis.call("DEL", KEYS[5], KEYS[6]) ' +
  'if chunksTtl == 0 then redis.call("DEL", KEYS[3]) else redis.call("EXPIRE", KEYS[3], chunksTtl) end ' +
  'if runStepsTtl == 0 then redis.call("DEL", KEYS[4]) else redis.call("EXPIRE", KEYS[4], runStepsTtl) end ' +
  'if ARGV[12] == "1" then if #items == 0 then return "[]" end return cjson.encode(items) end ' +
  'else ' +
  'redis.call("EXPIRE", KEYS[3], ttl) ' +
  'redis.call("EXPIRE", KEYS[4], ttl) ' +
  'redis.call("EXPIRE", KEYS[5], ttl) ' +
  'redis.call("EXPIRE", KEYS[6], ttl) ' +
  'end ' +
  'return 1';

/**
 * Atomic idempotency claim. Single-key `SET NX PX`: returns nil when this caller
 * won the claim, or the already-stored stream JSON when a prior request holds it.
 * Touches ONLY KEYS[1], so it is atomic on single-node and Redis Cluster.
 *
 *   KEYS: [idempotency]
 *   ARGV: [valueJson, ttlMs]
 */
const IDEMPOTENCY_CLAIM_LUA =
  'if redis.call("SET", KEYS[1], ARGV[1], "NX", "PX", tonumber(ARGV[2])) then return false end ' +
  'return redis.call("GET", KEYS[1])';

const IDEMPOTENCY_TAKEOVER_LUA =
  'local raw = redis.call("GET", KEYS[1]) if not raw then return 0 end ' +
  'local ok, current = pcall(cjson.decode, raw) ' +
  'if not ok or current.claimToken ~= ARGV[1] or current.startedAt then return 0 end ' +
  'redis.call("SET", KEYS[1], ARGV[2], "PX", tonumber(ARGV[3])) return 1';

const IDEMPOTENCY_MARK_STARTED_LUA =
  'if ARGV[1] == "" then return 0 end ' +
  'local raw = redis.call("GET", KEYS[1]) if not raw then return 0 end ' +
  'local ok, current = pcall(cjson.decode, raw) ' +
  'if not ok or current.claimToken ~= ARGV[1] then return 0 end ' +
  'if current.startedAt and tostring(current.startedAt) ~= ARGV[2] then return 0 end ' +
  'current.startedAt = tonumber(ARGV[2]) ' +
  'redis.call("SET", KEYS[1], cjson.encode(current), "PX", tonumber(ARGV[3])) return 1';

/** Reacquire an expired claim without replacing the live generation it
 * already started. Both keys carry the stream hash tag, so validation and the
 * started tombstone are one atomic cluster-safe decision. */
const IDEMPOTENCY_ADOPT_LIVE_JOB_LUA =
  'local raw = redis.call("GET", KEYS[1]) if not raw then return 0 end ' +
  'local ok, claim = pcall(cjson.decode, raw) ' +
  'if not ok or claim.claimToken ~= ARGV[1] or claim.startedAt then return 0 end ' +
  'if redis.call("HGET", KEYS[2], "createdAt") ~= ARGV[2] ' +
  'or redis.call("HGET", KEYS[2], "userId") ~= ARGV[3] then return 0 end ' +
  'local storedRequestId = redis.call("HGET", KEYS[2], "idempotencyClientRequestId") ' +
  'if storedRequestId then if storedRequestId ~= ARGV[4] then return 0 end ' +
  'elseif ARGV[7] ~= "1" then return 0 end ' +
  'local storedTenantId = redis.call("HGET", KEYS[2], "tenantId") ' +
  'if storedTenantId and storedTenantId ~= "" and storedTenantId ~= ARGV[5] then return 0 end ' +
  'local status = redis.call("HGET", KEYS[2], "status") ' +
  'if status ~= "running" and status ~= "requires_action" then return 0 end ' +
  'local protocol = redis.call("HGET", KEYS[2], "generationProtocolVersion") ' +
  'if protocol and protocol ~= "1" and protocol ~= "2" then return 0 end ' +
  'claim.startedAt = tonumber(ARGV[2]) ' +
  'claim.generationProtocolVersion = protocol == "2" and 2 or 1 ' +
  'redis.call("SET", KEYS[1], cjson.encode(claim), "PX", tonumber(ARGV[6])) return 1';

const IDEMPOTENCY_RELEASE_LUA =
  'if ARGV[1] ~= "" then local raw = redis.call("GET", KEYS[1]) if not raw then return 0 end ' +
  'local ok, current = pcall(cjson.decode, raw) if not ok or current.claimToken ~= ARGV[1] then return 0 end end ' +
  'return redis.call("DEL", KEYS[1])';

/** Attempt-fenced acknowledgement of transaction-time predecessor receipts.
 * A replacement either inherits the untrimmed chain before this script or
 * changes the attempt id first and makes this late acknowledgement a no-op. */
const REPLACEMENT_RECEIPT_ACK_LUA =
  'if redis.call("HGET", KEYS[1], "__creationAttemptId") ~= ARGV[1] then return 0 end ' +
  'local acknowledged = {} for i = 2, #ARGV do acknowledged[ARGV[i]] = true end ' +
  'local raw = redis.call("HGET", KEYS[1], "__replacedGenerations") ' +
  'if raw then local ok, current = pcall(cjson.decode, raw) ' +
  'if not ok or type(current) ~= "table" then return 0 end ' +
  'local retained = {} for i = 1, #current do local item = current[i] ' +
  'if type(item) ~= "table" or type(item.createdAt) ~= "number" then return 0 end ' +
  'if not acknowledged[tostring(item.createdAt)] then retained[#retained + 1] = item end end ' +
  'if #retained == 0 then ' +
  'redis.call("HDEL", KEYS[1], "__replacedGenerations", "__replacedCreatedAt", "__replacedStatus", "__replacedConversationId") ' +
  'else local latest = retained[#retained] ' +
  'redis.call("HSET", KEYS[1], "__replacedGenerations", cjson.encode(retained), ' +
  '"__replacedCreatedAt", tostring(latest.createdAt), "__replacedStatus", latest.status) ' +
  'if latest.conversationId then redis.call("HSET", KEYS[1], "__replacedConversationId", latest.conversationId) ' +
  'else redis.call("HDEL", KEYS[1], "__replacedConversationId") end end return 1 end ' +
  'local immediate = redis.call("HGET", KEYS[1], "__replacedCreatedAt") ' +
  'if immediate and acknowledged[immediate] then ' +
  'redis.call("HDEL", KEYS[1], "__replacedCreatedAt", "__replacedStatus", "__replacedConversationId") end ' +
  'return 1';

/**
 * Atomic job (re)creation for all generation-scoped same-slot keys. The
 * predecessor hash/content are removed in the same script that installs the
 * replacement hash. Pending and claimed steers are first merged into the
 * owner-scoped parked recovery payload, so replacement cannot discard an ACK.
 *
 *   KEYS: [job, chunks, runSteps, steers, claimedSteers, parkedSteers,
 *          generationEpoch, steerReceipts, steerReceiptOrder, idempotencyClaim]
 *   ARGV: [ttl, requestedCreatedAt, generationEpochGraceTtl, parkedTtl,
 *          recoveredSteerId | "", newOwnerUserId, newOwnerTenantId | "",
 *          idempotencyClaimToken | "",
 *          recoveredSteerPayloadJson | "",
 *          generationProtocolVersion,
 *          creationAttemptId | "",
 *          expectedPredecessorCreatedAt | "", rejectActivePredecessor ("1" | "0"),
 *          ...hsetPairs]
 *   Returns: [previousUserId | "", previousTenantId | "", createdAt, "",
 *             replacedCreatedAt | "", replacedStatus | "", replacedConversationId | "",
 *             replacedProviderAbortReady | "", replacedProviderExecutionId | "",
 *             replacedProviderDrained | ""]
 *   Predecessor mismatch returns the latest retained epoch in the replaced
 *   position plus an eighth active flag and ninth verified flag ("1" | "0").
 *   Job-only metadata is empty when that epoch has outlived its hash. When all
 *   evidence expired, the finite expected epoch is echoed with verified=false.
 */
const JOB_CREATE_LUA =
  'if ARGV[8] ~= "" then local claimRaw = redis.call("GET", KEYS[10]) ' +
  'if not claimRaw then return { "", "", "0", "claim_lost" } end ' +
  'local ok, claim = pcall(cjson.decode, claimRaw) ' +
  'if not ok or claim.claimToken ~= ARGV[8] or claim.startedAt then ' +
  'return { "", "", "0", "claim_lost" } end end ' +
  'local previousJobExists = redis.call("EXISTS", KEYS[1]) ' +
  'local previousUserId = redis.call("HGET", KEYS[1], "userId") ' +
  'local previousTenantId = redis.call("HGET", KEYS[1], "tenantId") ' +
  'if previousJobExists == 1 and (not previousUserId or previousUserId == "" or previousUserId ~= ARGV[6] ' +
  'or (previousTenantId and previousTenantId ~= ARGV[7])) then ' +
  'return { "", "", "0", "owner_mismatch" } end ' +
  'local replacedCreatedAt = redis.call("HGET", KEYS[1], "createdAt") ' +
  'local replacedStatus = redis.call("HGET", KEYS[1], "status") ' +
  'local replacedConversationId = redis.call("HGET", KEYS[1], "conversationId") ' +
  'local replacedProviderAbortReady = redis.call("HGET", KEYS[1], "providerAbortReady") ' +
  'local replacedProviderExecutionId = redis.call("HGET", KEYS[1], "providerExecutionId") ' +
  'local replacedProviderDrained = redis.call("HGET", KEYS[1], "providerDrained") ' +
  'local replacedTerminalPersistencePending = redis.call("HGET", KEYS[1], "terminalPersistencePending") ' +
  'local replacedTerminalHostActionPending = redis.call("HGET", KEYS[1], "terminalHostActionPending") ' +
  'local replacedDetachedTerminalHostActionPending = redis.call("HGET", KEYS[1], "detachedAgentEventTerminalHostActionPending") ' +
  'local replacedProtocol = redis.call("HGET", KEYS[1], "generationProtocolVersion") ' +
  'local MAX_SAFE_EPOCH = 9007199254740991 ' +
  'local function isSafeEpoch(value) return type(value) == "number" and value >= 0 ' +
  'and value <= MAX_SAFE_EPOCH and value == math.floor(value) end ' +
  'local function isValidJobStatus(value) return value == "running" or value == "requires_action" ' +
  'or value == "complete" or value == "error" or value == "aborted" end ' +
  'local detachedTerminalShield = replacedStatus == "detached_terminal_pending_v1" ' +
  'and replacedDetachedTerminalHostActionPending == "1" ' +
  'local replacedEpoch = tonumber(replacedCreatedAt) local previousCreatedAt = replacedEpoch ' +
  'if previousJobExists == 1 and (not isSafeEpoch(replacedEpoch) ' +
  'or (not isValidJobStatus(replacedStatus) and not detachedTerminalShield)) then ' +
  'return { "", "", "0", "replacement_receipt_corrupt" } end ' +
  'if (replacedProviderExecutionId and not replacedProviderDrained) ' +
  'or (replacedProviderDrained and not replacedProviderExecutionId) ' +
  'or (replacedProviderExecutionId and (replacedProviderExecutionId == "" ' +
  'or string.len(replacedProviderExecutionId) > 128)) ' +
  'or (replacedProviderDrained and replacedProviderDrained ~= "0" and replacedProviderDrained ~= "1") then ' +
  'return { "", "", "0", "replacement_receipt_corrupt" } end ' +
  'local retainedEpochRaw = redis.call("GET", KEYS[7]) local retainedEpoch = tonumber(retainedEpochRaw) ' +
  'if retainedEpochRaw and not isSafeEpoch(retainedEpoch) then ' +
  'return { "", "", "0", "generation_epoch_corrupt" } end ' +
  'local observedCreatedAt = replacedCreatedAt local observedStatus = replacedStatus ' +
  'local observedConversationId = replacedConversationId ' +
  'local observedActive = previousJobExists == 1 and ' +
  '(replacedStatus == "running" or replacedStatus == "requires_action" ' +
  'or replacedTerminalPersistencePending == "1" or replacedTerminalHostActionPending == "1" or replacedDetachedTerminalHostActionPending == "1") ' +
  'if retainedEpoch and (not previousCreatedAt or retainedEpoch > previousCreatedAt) then ' +
  'previousCreatedAt = retainedEpoch observedCreatedAt = retainedEpochRaw ' +
  'observedStatus = nil observedConversationId = nil observedActive = false end ' +
  'if observedActive and (replacedTerminalHostActionPending == "1" or replacedDetachedTerminalHostActionPending == "1") then ' +
  'return { previousUserId or "", previousTenantId or "", "0", "predecessor_mismatch", ' +
  'observedCreatedAt, observedStatus or "", observedConversationId or "", "1", "1" } end ' +
  'if ARGV[13] == "1" and observedActive then ' +
  'return { previousUserId or "", previousTenantId or "", "0", "predecessor_mismatch", ' +
  'observedCreatedAt, observedStatus or "", observedConversationId or "", "1", "1" } end ' +
  'if ARGV[12] ~= "" and (not observedCreatedAt or observedCreatedAt ~= ARGV[12]) then ' +
  'return { previousUserId or "", previousTenantId or "", "0", "predecessor_mismatch", ' +
  'observedCreatedAt or ARGV[12], observedStatus or "", observedConversationId or "", ' +
  'observedActive and "1" or "0", observedCreatedAt and "1" or "0" } end ' +
  'local createdAt = tonumber(ARGV[2]) ' +
  'if not isSafeEpoch(createdAt) then return { "", "", "0", "generation_epoch_corrupt" } end ' +
  'if previousCreatedAt and previousCreatedAt >= MAX_SAFE_EPOCH then ' +
  'return { "", "", "0", "generation_epoch_exhausted" } end ' +
  'if previousCreatedAt and previousCreatedAt >= createdAt then createdAt = previousCreatedAt + 1 end ' +
  'local merged = {} local seen = {} local parkedUserId = previousUserId local parkedTenantId = previousTenantId ' +
  'local parkedProtocol = replacedProtocol == "2" and 2 or 1 ' +
  'local function isDenseArray(value) if type(value) ~= "table" then return false end ' +
  'local count = 0 for key, _ in pairs(value) do ' +
  'if type(key) ~= "number" or key < 1 or key ~= math.floor(key) then return false end count = count + 1 end ' +
  'return count == #value end ' +
  // Carry every still-unacknowledged transaction-time predecessor forward.
  // A later replacement can then stop providers skipped when an earlier
  // create reply was lost. Reject before mutation rather than evicting an old
  // active epoch when the bounded receipt chain is full.
  'local replacementChain = {} local replacementSeen = {} local lastReplacementEpoch = -1 ' +
  'local replacementRaw = redis.call("HGET", KEYS[1], "__replacedGenerations") ' +
  'local inheritedCreatedAtRaw = redis.call("HGET", KEYS[1], "__replacedCreatedAt") ' +
  'local inheritedStatus = redis.call("HGET", KEYS[1], "__replacedStatus") ' +
  'local inheritedConversationId = redis.call("HGET", KEYS[1], "__replacedConversationId") ' +
  'if (inheritedCreatedAtRaw and not inheritedStatus) or (inheritedStatus and not inheritedCreatedAtRaw) then ' +
  'return { "", "", "0", "replacement_receipt_corrupt" } end ' +
  'if replacementRaw then local chainOk, inherited = pcall(cjson.decode, replacementRaw) ' +
  'if not chainOk or not isDenseArray(inherited) or #inherited == 0 or #inherited > 32 then ' +
  'return { "", "", "0", "replacement_receipt_corrupt" } end ' +
  'for i = 1, #inherited do local item = inherited[i] ' +
  'local validStatus = type(item) == "table" and isValidJobStatus(item.status) ' +
  'if not validStatus or not isSafeEpoch(item.createdAt) ' +
  'or item.createdAt <= lastReplacementEpoch ' +
  'or (previousJobExists == 1 and item.createdAt >= replacedEpoch) ' +
  'or (item.conversationId and type(item.conversationId) ~= "string") ' +
  'or (item.providerAbortReady ~= nil and type(item.providerAbortReady) ~= "boolean") ' +
  'or (item.providerExecutionId ~= nil and (type(item.providerExecutionId) ~= "string" ' +
  'or item.providerExecutionId == "" or string.len(item.providerExecutionId) > 128)) ' +
  'or (item.providerDrained ~= nil and type(item.providerDrained) ~= "boolean") ' +
  'or ((item.providerExecutionId ~= nil) ~= (item.providerDrained ~= nil)) ' +
  'or replacementSeen[tostring(item.createdAt)] then ' +
  'return { "", "", "0", "replacement_receipt_corrupt" } end ' +
  'lastReplacementEpoch = item.createdAt replacementSeen[tostring(item.createdAt)] = true ' +
  'replacementChain[#replacementChain + 1] = item end ' +
  'if not inheritedCreatedAtRaw then return { "", "", "0", "replacement_receipt_corrupt" } end ' +
  'local inheritedEpoch = tonumber(inheritedCreatedAtRaw) local latest = replacementChain[#replacementChain] ' +
  'if not isSafeEpoch(inheritedEpoch) or not isValidJobStatus(inheritedStatus) ' +
  'or latest.createdAt ~= inheritedEpoch or latest.status ~= inheritedStatus ' +
  'or (latest.conversationId or false) ~= inheritedConversationId then ' +
  'return { "", "", "0", "replacement_receipt_corrupt" } end ' +
  'elseif inheritedCreatedAtRaw then local inheritedEpoch = tonumber(inheritedCreatedAtRaw) ' +
  'if not isSafeEpoch(inheritedEpoch) or not isValidJobStatus(inheritedStatus) ' +
  'or previousJobExists ~= 1 or inheritedEpoch >= replacedEpoch then ' +
  'return { "", "", "0", "replacement_receipt_corrupt" } end ' +
  'local inherited = { createdAt = inheritedEpoch, status = inheritedStatus } ' +
  'if inheritedConversationId then inherited.conversationId = inheritedConversationId end ' +
  'replacementSeen[tostring(inheritedEpoch)] = true replacementChain[1] = inherited end ' +
  'if previousJobExists == 1 then ' +
  'if replacementSeen[tostring(replacedEpoch)] then ' +
  'return { "", "", "0", "replacement_receipt_corrupt" } end ' +
  'if #replacementChain >= 32 then return { "", "", "0", "replacement_chain_full" } end ' +
  'local replaced = { createdAt = replacedEpoch, status = replacedStatus } ' +
  'if replacedConversationId then replaced.conversationId = replacedConversationId end ' +
  'if replacedProviderAbortReady then replaced.providerAbortReady = replacedProviderAbortReady == "1" end ' +
  'if replacedProviderExecutionId then replaced.providerExecutionId = replacedProviderExecutionId end ' +
  'if replacedProviderDrained then replaced.providerDrained = replacedProviderDrained == "1" end ' +
  'replacementChain[#replacementChain + 1] = replaced replacementSeen[tostring(replacedEpoch)] = true end ' +
  'local recoveredSteerId = ARGV[5] local expectedRecovery = nil ' +
  'if recoveredSteerId ~= "" and ARGV[10] ~= "2" then return { "", "", "0", "recovery_protocol_mismatch" } end ' +
  'if recoveredSteerId ~= "" then local ok, decoded = pcall(cjson.decode, ARGV[9]) ' +
  'if not ok or type(decoded) ~= "table" or type(decoded.text) ~= "string" ' +
  'or not isDenseArray(decoded.fileIds) then return { "", "", "0", "recovery_invalid_payload" } end ' +
  'local expectedSeen = {} for i = 1, #decoded.fileIds do local fileId = decoded.fileIds[i] ' +
  'if type(fileId) ~= "string" or fileId == "" or expectedSeen[fileId] then ' +
  'return { "", "", "0", "recovery_invalid_payload" } end expectedSeen[fileId] = true end ' +
  'if decoded.quotes ~= nil then if not isDenseArray(decoded.quotes) then ' +
  'return { "", "", "0", "recovery_invalid_payload" } end ' +
  'for i = 1, #decoded.quotes do if type(decoded.quotes[i]) ~= "string" or decoded.quotes[i] == "" then ' +
  'return { "", "", "0", "recovery_invalid_payload" } end end end ' +
  'expectedRecovery = decoded elseif ARGV[9] ~= "" then ' +
  'return { "", "", "0", "recovery_invalid_payload" } end ' +
  'local function recoveryMatches(item, expected) ' +
  'if not expected or type(item.text) ~= "string" or item.text ~= expected.text then return false end ' +
  // Quotes are model-bound like the text: order-significant identity, with a
  // missing array on either side reading as empty (pre-quotes compatibility).
  'local expectedQuotes = expected.quotes or {} local itemQuotes = item.quotes ' +
  'if itemQuotes ~= nil and not isDenseArray(itemQuotes) then return false end ' +
  'itemQuotes = itemQuotes or {} if #itemQuotes ~= #expectedQuotes then return false end ' +
  'for i = 1, #itemQuotes do if itemQuotes[i] ~= expectedQuotes[i] then return false end end ' +
  'local actualSeen = {} local actualCount = 0 local files = item.files ' +
  'if files then if not isDenseArray(files) then return false end ' +
  'for i = 1, #files do local file = files[i] ' +
  'if type(file) ~= "table" or type(file.file_id) ~= "string" or file.file_id == "" then return false end ' +
  'if not actualSeen[file.file_id] then actualSeen[file.file_id] = true actualCount = actualCount + 1 end end end ' +
  'if actualCount ~= #expected.fileIds then return false end ' +
  'for i = 1, #expected.fileIds do if not actualSeen[expected.fileIds[i]] then return false end end return true end ' +
  'local parkedRaw = redis.call("GET", KEYS[6]) ' +
  'if parkedRaw then local ok, parked = pcall(cjson.decode, parkedRaw) ' +
  'if not ok or type(parked) ~= "table" or type(parked.userId) ~= "string" ' +
  'or parked.userId == "" or not isDenseArray(parked.steers) or #parked.steers == 0 then ' +
  'return { "", "", "0", "recovery_corrupt" } end ' +
  'if parked.generationProtocolVersion and parked.generationProtocolVersion ~= 1 ' +
  'and parked.generationProtocolVersion ~= 2 then return { "", "", "0", "recovery_corrupt" } end ' +
  'if parked.generationProtocolVersion == 2 then parkedProtocol = 2 end ' +
  'for i = 1, #parked.steers do local item = parked.steers[i] ' +
  'if type(item) ~= "table" or type(item.steerId) ~= "string" or item.steerId == "" ' +
  'or (item.clientSteerId and (type(item.clientSteerId) ~= "string" or item.clientSteerId == "")) ' +
  'or (item.text and type(item.text) ~= "string") ' +
  'or (item.createdAt and (type(item.createdAt) ~= "number" or item.createdAt < 0)) ' +
  'or (item.recoveringCreatedAt and (type(item.recoveringCreatedAt) ~= "number" or item.recoveringCreatedAt < 0)) then ' +
  'return { "", "", "0", "recovery_corrupt" } end end ' +
  'if recoveredSteerId ~= "" and parked.generationProtocolVersion ~= 2 then ' +
  'for i = 1, #parked.steers do if parked.steers[i].steerId == recoveredSteerId then ' +
  'return { "", "", "0", "recovery_protocol_mismatch" } end end end ' +
  'if parked.userId ~= ARGV[6] or (parked.tenantId and parked.tenantId ~= ARGV[7]) then ' +
  'return { "", "", "0", "owner_mismatch" } end ' +
  'parkedUserId = parked.userId parkedTenantId = parked.tenantId ' +
  'for i = 1, #parked.steers do local item = parked.steers[i] ' +
  'if item.steerId and not seen[item.steerId] then seen[item.steerId] = true merged[#merged + 1] = item end end end ' +
  'local receiptUpdates = {} local ownerMatches = not parkedUserId or not previousUserId or ' +
  '(parkedUserId == previousUserId and (not parkedTenantId or parkedTenantId == previousTenantId)) ' +
  'if ownerMatches then if not parkedUserId then parkedUserId = previousUserId parkedTenantId = previousTenantId end ' +
  'local claimedRows = {} if replacedProtocol == "2" then claimedRows = redis.call("LRANGE", KEYS[5], 0, -1) end ' +
  'local sources = { claimedRows, redis.call("LRANGE", KEYS[4], 0, -1) } ' +
  'for s = 1, #sources do for i = 1, #sources[s] do local ok, item = pcall(cjson.decode, sources[s][i]) ' +
  'if ok and recoveredSteerId ~= "" and item.steerId == recoveredSteerId and replacedProtocol ~= "2" then ' +
  'return { "", "", "0", "recovery_protocol_mismatch" } end ' +
  'if ok and item.steerId and not seen[item.steerId] then seen[item.steerId] = true ' +
  'local projected = { steerId = item.steerId, text = item.text, createdAt = item.createdAt } ' +
  'if item.clientSteerId then projected.clientSteerId = item.clientSteerId end ' +
  'if item.files then projected.files = item.files end if item.quotes then projected.quotes = item.quotes end ' +
  'if item.preempt then projected.preempt = item.preempt end ' +
  'if item.preemptRevision then projected.preemptRevision = item.preemptRevision end ' +
  'merged[#merged + 1] = projected receiptUpdates[#receiptUpdates + 1] = item end end end end ' +
  'local recoveryOwnerMatches = parkedUserId == ARGV[6] and ' +
  '(not parkedTenantId or parkedTenantId == ARGV[7]) ' +
  'local recoveryFound = recoveredSteerId == "" ' +
  'for i = 1, #merged do local item = merged[i] ' +
  'item.recoveringCreatedAt = nil ' +
  'if recoveredSteerId ~= "" and item.steerId == recoveredSteerId then ' +
  'if not recoveryOwnerMatches then return { "", "", "0", "recovery_owner_mismatch" } end ' +
  'if not recoveryMatches(item, expectedRecovery) then ' +
  'return { "", "", "0", "recovery_payload_mismatch" } end ' +
  'item.recoveringCreatedAt = createdAt recoveryFound = true end end ' +
  'if not recoveryFound then return { "", "", "0", "recovery_source_missing" } end ' +
  'for i = 1, #receiptUpdates do local item = receiptUpdates[i] ' +
  'if replacedProtocol == "2" and item.clientSteerId then local raw = redis.call("HGET", KEYS[8], item.clientSteerId) ' +
  'if raw then local receiptOk, receipt = pcall(cjson.decode, raw) ' +
  'if receiptOk and type(receipt) == "table" then receipt.item = item receipt.state = "leftover" ' +
  'redis.call("HSET", KEYS[8], item.clientSteerId, cjson.encode(receipt)) end end end end ' +
  'if #merged > 0 and parkedUserId then local parked = { userId = parkedUserId, generationProtocolVersion = parkedProtocol, steers = merged } ' +
  'if parkedTenantId then parked.tenantId = parkedTenantId end ' +
  'redis.call("SET", KEYS[6], cjson.encode(parked), "EX", ARGV[4]) else redis.call("DEL", KEYS[6]) end ' +
  'if #merged > 0 then for i = 8, 9 do local rt = redis.call("TTL", KEYS[i]) ' +
  'if rt >= 0 and rt < tonumber(ARGV[4]) then redis.call("EXPIRE", KEYS[i], ARGV[4]) end end end ' +
  'redis.call("DEL", KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5]) ' +
  'local ttl = tonumber(ARGV[1]) ' +
  'local generationEpochGraceTtl = tonumber(ARGV[3]) ' +
  'local hset = {} ' +
  'for i = 14, #ARGV do hset[#hset + 1] = ARGV[i] end ' +
  'redis.call("HSET", KEYS[1], unpack(hset)) ' +
  'redis.call("HSET", KEYS[1], "createdAt", tostring(createdAt)) ' +
  'if ARGV[11] ~= "" then redis.call("HSET", KEYS[1], "__creationAttemptId", ARGV[11]) end ' +
  // Keep the transaction-time predecessor receipt in the replacement hash.
  // deserializeJob reconstructs it as non-enumerable return metadata, so an
  // eval reply lost after commit can still stop the exact replaced provider.
  'if replacedCreatedAt and replacedStatus then ' +
  'redis.call("HSET", KEYS[1], "__replacedCreatedAt", replacedCreatedAt, "__replacedStatus", replacedStatus) ' +
  'if replacedConversationId then redis.call("HSET", KEYS[1], "__replacedConversationId", replacedConversationId) end end ' +
  'if #replacementChain > 0 then redis.call("HSET", KEYS[1], "__replacedGenerations", cjson.encode(replacementChain)) end ' +
  'if ARGV[10] ~= "2" then redis.call("HDEL", KEYS[1], "checkpointNamespace") end ' +
  'redis.call("EXPIRE", KEYS[1], ttl) ' +
  'redis.call("SET", KEYS[7], tostring(createdAt), "EX", ttl + generationEpochGraceTtl) ' +
  'if ARGV[8] ~= "" then local claimRaw = redis.call("GET", KEYS[10]) ' +
  'local claimTtl = redis.call("PTTL", KEYS[10]) local ok, claim = pcall(cjson.decode, claimRaw) ' +
  'if not ok or claim.claimToken ~= ARGV[8] then return { "", "", "0", "claim_lost" } end ' +
  'claim.startedAt = createdAt redis.call("SET", KEYS[10], cjson.encode(claim)) ' +
  'if claimTtl > 0 then redis.call("PEXPIRE", KEYS[10], claimTtl) end end ' +
  'return { previousUserId or "", previousTenantId or "", tostring(createdAt), "", ' +
  'replacedCreatedAt or "", replacedStatus or "", replacedConversationId or "", ' +
  'replacedProviderAbortReady or "", replacedProviderExecutionId or "", ' +
  'replacedProviderDrained or "" }';

/**
 * Epoch-guarded field update. Terminal writes reclaim same-slot content in the
 * same atomic step, so a replacement cannot appear between the guarded write
 * and content cleanup.
 *
 *   KEYS: [job, chunks, runSteps, steers, claimedSteers]
 *   ARGV: [
 *     expectCreatedAt | "",
 *     terminal ("0" | "1"),
 *     completedTtl,
 *     chunksAfterComplete,
 *     runStepsAfterComplete,
 *     ...hsetPairs
 *   ]
 */
const JOB_UPDATE_LUA =
  'if redis.call("EXISTS", KEYS[1]) == 0 then return 0 end ' +
  'if ARGV[1] ~= "" and redis.call("HGET", KEYS[1], "createdAt") ~= ARGV[1] then return 0 end ' +
  'local hset = {} ' +
  'for i = 6, #ARGV do hset[#hset + 1] = ARGV[i] end ' +
  'if #hset > 0 then redis.call("HSET", KEYS[1], unpack(hset)) end ' +
  'if ARGV[2] == "1" then ' +
  'local completedTtl = tonumber(ARGV[3]) ' +
  'local chunksTtl = tonumber(ARGV[4]) ' +
  'local runStepsTtl = tonumber(ARGV[5]) ' +
  'redis.call("EXPIRE", KEYS[1], completedTtl) ' +
  'redis.call("DEL", KEYS[4]) ' +
  'if chunksTtl == 0 then redis.call("DEL", KEYS[2]) else redis.call("EXPIRE", KEYS[2], chunksTtl) end ' +
  'if runStepsTtl == 0 then redis.call("DEL", KEYS[3]) else redis.call("EXPIRE", KEYS[3], runStepsTtl) end ' +
  'end ' +
  'return 1';

/** Owner membership must outlive every paused job and must never shorten a peer's TTL. */
const OWNER_MEMBERSHIP_RECONCILE_LUA =
  'local created = redis.call("EXISTS", KEYS[1]) == 0 ' +
  'redis.call("SADD", KEYS[1], ARGV[1]) ' +
  'local seconds = tonumber(ARGV[2]) ' +
  'local current = redis.call("TTL", KEYS[1]) ' +
  'if seconds > 0 and ((created and current == -1) or (current >= 0 and current < seconds)) then ' +
  'redis.call("EXPIRE", KEYS[1], seconds) end ' +
  'return 1';

/** Single-winner recovery outcome for one generation-scoped overflow. */
const SETTLE_EARLY_BUFFER_RECOVERY_LUA =
  'if redis.call("HGET", KEYS[1], "createdAt") ~= ARGV[1] then return 0 end ' +
  'local raw = redis.call("HGET", KEYS[1], "earlyBufferOverflow") ' +
  'if not raw then return 0 end local ok, overflow = pcall(cjson.decode, raw) ' +
  'if not ok or type(overflow) ~= "table" or overflow.id ~= ARGV[2] ' +
  'or overflow.recoveryOutcome ~= nil then return 0 end ' +
  'local settlementOk, settlement = pcall(cjson.decode, ARGV[3]) ' +
  'if not settlementOk or type(settlement) ~= "table" then return 0 end ' +
  'for key, value in pairs(settlement) do overflow[key] = value end ' +
  'redis.call("HSET", KEYS[1], "earlyBufferOverflow", cjson.encode(overflow)) return 1';

/** Finalizes only the unresolved pending marker installed by this owner. */
const FINALIZE_EARLY_BUFFER_OVERFLOW_LUA =
  'if redis.call("HGET", KEYS[1], "createdAt") ~= ARGV[1] then return 0 end ' +
  'local raw = redis.call("HGET", KEYS[1], "earlyBufferOverflow") ' +
  'if not raw then return 0 end local ok, overflow = pcall(cjson.decode, raw) ' +
  'if not ok or type(overflow) ~= "table" or overflow.id ~= ARGV[2] ' +
  'or overflow.persistencePending ~= true or overflow.recoveryOutcome ~= nil then return 0 end ' +
  'redis.call("HSET", KEYS[1], "earlyBufferOverflow", ARGV[3]) return 1';

const HAS_SUBSCRIBER_ATTACHED_LUA =
  'if redis.call("HGET", KEYS[1], "createdAt") ~= ARGV[1] then return 0 end ' +
  'if redis.call("HEXISTS", KEYS[1], "firstSubscriberAttachedAt") == 1 then return 1 end return 0';

/** Generation-scoped single-winner first-subscriber claim. */
const CLAIM_FIRST_SUBSCRIBER_LUA =
  'if redis.call("HGET", KEYS[1], "createdAt") ~= ARGV[1] then return 0 end ' +
  'redis.call("ZADD", KEYS[2], ARGV[4], ARGV[3]) redis.call("PEXPIRE", KEYS[2], 60000) ' +
  'if redis.call("HEXISTS", KEYS[1], "firstSubscriberAttachedAt") == 1 then return 0 end ' +
  'redis.call("HSET", KEYS[1], "firstSubscriberAttachedAt", ARGV[2]) return 1';

const DETACH_SUBSCRIBER_LUA =
  'if redis.call("HGET", KEYS[1], "createdAt") ~= ARGV[1] then return 0 end ' +
  'redis.call("ZREM", KEYS[2], ARGV[2]) return 1';

const HAS_ACTIVE_SUBSCRIBER_LUA =
  'if redis.call("HGET", KEYS[1], "createdAt") ~= ARGV[1] then return 0 end ' +
  'redis.call("ZREMRANGEBYSCORE", KEYS[2], "-inf", ARGV[2]) ' +
  'if redis.call("ZCARD", KEYS[2]) > 0 then return 1 end return 0';

/** Exact provider-segment completion fence. A paused segment finishing after a
 * resume cannot mark the resumed provider drained because its opaque id differs. */
const PROVIDER_DRAIN_LUA =
  'if redis.call("HGET", KEYS[1], "createdAt") ~= ARGV[1] then return 0 end ' +
  'if redis.call("HGET", KEYS[1], "providerExecutionId") ~= ARGV[2] then return 0 end ' +
  'redis.call("HSET", KEYS[1], "providerDrained", "1") return 1';

/** Recover a terminal host action whose provider-owning process disappeared
 * after the terminal CAS. `completedAt` is immutable for this generation, so
 * the deadline cannot be extended by retry enumeration. */
const RECOVER_TERMINAL_PROVIDER_DRAIN_LUA =
  'if redis.call("HGET", KEYS[1], "createdAt") ~= ARGV[1] then return 0 end ' +
  'if redis.call("HGET", KEYS[1], "terminalHostActionPending") ~= "1" and redis.call("HGET", KEYS[1], "detachedAgentEventTerminalHostActionPending") ~= "1" then return 0 end ' +
  'if redis.call("HGET", KEYS[1], "providerDrained") ~= "0" then return 0 end ' +
  'local completedAt = tonumber(redis.call("HGET", KEYS[1], "completedAt") or "") ' +
  'if not completedAt or completedAt > tonumber(ARGV[2]) then return 0 end ' +
  'redis.call("HSET", KEYS[1], "providerDrained", "1") return 1';

/** Exact initial provider-start fence. The controller rechecks account
 * deletion before this CAS; an abort/replacement that wins next prevents the
 * provider from starting after destructive cleanup has begun. */
const PROVIDER_BEGIN_LUA =
  'if redis.call("HGET", KEYS[1], "createdAt") ~= ARGV[1] then return 0 end ' +
  'if redis.call("HGET", KEYS[1], "providerExecutionId") ~= ARGV[2] then return 0 end ' +
  'if redis.call("HGET", KEYS[1], "status") ~= "running" then return 0 end ' +
  'if redis.call("HGET", KEYS[1], "providerDrained") ~= "1" then return 0 end ' +
  'redis.call("HSET", KEYS[1], "providerDrained", "0", "providerExecutionStartedId", ARGV[2]) return 1';

/** Single-winner promotion from abort-persistence pending to a consumable
 * terminal payload. Owner success/failure and stale-owner recovery share this
 * CAS, so a timeout cannot overwrite a normal FINAL (or vice versa). */
const TERMINAL_PERSISTENCE_FINALIZE_LUA =
  'if redis.call("HGET", KEYS[1], "createdAt") ~= ARGV[1] then return 0 end ' +
  'if redis.call("HGET", KEYS[1], "terminalPersistencePending") ~= "1" then return 0 end ' +
  'redis.call("HSET", KEYS[1], "terminalPersistencePending", "0", "finalEvent", ARGV[2]) ' +
  'return 1';

/**
 * Epoch-guarded hard deletion. `expectMissing` makes an unguarded cleanup of
 * already-absent state safe against a replacement appearing after the read.
 * Parked steers intentionally survive: completion parks before deleting.
 *
 *   KEYS: [job, chunks, runSteps, steers]
 *   ARGV: [expectCreatedAt | "", expectMissing ("0" | "1")]
 */
const JOB_DELETE_LUA =
  'if ARGV[1] ~= "" and redis.call("HGET", KEYS[1], "createdAt") ~= ARGV[1] then return 0 end ' +
  'local existed = redis.call("EXISTS", KEYS[1]) ' +
  'if ARGV[2] == "1" and existed == 1 then return 0 end ' +
  'redis.call("DEL", KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5]) ' +
  'return existed';

/**
 * Atomic stale-running reap. The liveness and epoch checks, steer projection
 * and parking, and same-slot deletion are one operation. A replacement either
 * lands before the script and fails the guard, or lands afterward and clears
 * the predecessor's parked payload in {@link JOB_CREATE_LUA}.
 *
 *   KEYS: [job, chunks, runSteps, steers, claimedSteers, parkedSteers,
 *          generationEpoch, steerReceipts, steerReceiptOrder]
 *   ARGV: [expectCreatedAt, nowMs, staleAfterMs, parkedSteersTtl, generationEpochGraceTtl]
 */
const STALE_JOB_DELETE_LUA =
  'if redis.call("HGET", KEYS[1], "status") ~= "running" then return 0 end ' +
  'if redis.call("HGET", KEYS[1], "createdAt") ~= ARGV[1] then return 0 end ' +
  'local liveSince = tonumber(redis.call("HGET", KEYS[1], "lastActiveAt")) ' +
  'if not liveSince then liveSince = tonumber(redis.call("HGET", KEYS[1], "createdAt")) end ' +
  'if not liveSince or tonumber(ARGV[2]) - liveSince <= tonumber(ARGV[3]) then return 0 end ' +
  'local ownerUserId = redis.call("HGET", KEYS[1], "userId") ' +
  'local ownerTenantId = redis.call("HGET", KEYS[1], "tenantId") ' +
  'local generationProtocol = redis.call("HGET", KEYS[1], "generationProtocolVersion") == "2" and 2 or 1 ' +
  'local parkedProtocol = generationProtocol ' +
  'local function isDenseArray(value) if type(value) ~= "table" then return false end ' +
  'local count = 0 for key, _ in pairs(value) do ' +
  'if type(key) ~= "number" or key < 1 or key ~= math.floor(key) then return false end count = count + 1 end ' +
  'return count == #value end ' +
  'local prior = {} local parkedRaw = redis.call("GET", KEYS[6]) ' +
  'if parkedRaw then local ok, parked = pcall(cjson.decode, parkedRaw) ' +
  'if not ok or type(parked) ~= "table" or type(parked.userId) ~= "string" or parked.userId == "" ' +
  'or not isDenseArray(parked.steers) or #parked.steers == 0 or parked.userId ~= ownerUserId ' +
  'or (parked.tenantId and parked.tenantId ~= ownerTenantId) then return 0 end ' +
  'if parked.generationProtocolVersion and parked.generationProtocolVersion ~= 1 ' +
  'and parked.generationProtocolVersion ~= 2 then return 0 end ' +
  'if parked.generationProtocolVersion == 2 then parkedProtocol = 2 end ' +
  'for i = 1, #parked.steers do local item = parked.steers[i] ' +
  'if type(item) ~= "table" or type(item.steerId) ~= "string" or item.steerId == "" ' +
  'or (item.clientSteerId and (type(item.clientSteerId) ~= "string" or item.clientSteerId == "")) ' +
  'or (item.text and type(item.text) ~= "string") ' +
  'or (item.createdAt and (type(item.createdAt) ~= "number" or item.createdAt < 0)) ' +
  'or (item.recoveringCreatedAt and (type(item.recoveringCreatedAt) ~= "number" or item.recoveringCreatedAt < 0)) then return 0 end ' +
  'prior[#prior + 1] = item end end ' +
  'local claimedRows = {} if generationProtocol == 2 then claimedRows = redis.call("LRANGE", KEYS[5], 0, -1) end ' +
  'local sourceRows = { claimedRows, redis.call("LRANGE", KEYS[4], 0, -1) } ' +
  'for s = 1, #sourceRows do for i = 1, #sourceRows[s] do local ok, item = pcall(cjson.decode, sourceRows[s][i]) ' +
  'if not ok or type(item) ~= "table" or type(item.steerId) ~= "string" or item.steerId == "" then return 0 end end end ' +
  'if (#sourceRows[1] > 0 or #sourceRows[2] > 0) and (not ownerUserId or ownerUserId == "") then return 0 end ' +
  'local fullItems = {} local projected = {} local seen = {} ' +
  'local sources = sourceRows ' +
  'for s = 1, #sources do for i = 1, #sources[s] do ' +
  'local decoded, item = pcall(cjson.decode, sources[s][i]) ' +
  'if decoded and type(item) == "table" then ' +
  'if item.steerId and not seen[item.steerId] then seen[item.steerId] = true fullItems[#fullItems + 1] = item ' +
  'local clientItem = { steerId = item.steerId, text = item.text, createdAt = item.createdAt } ' +
  'if item.clientSteerId then clientItem.clientSteerId = item.clientSteerId end ' +
  'if item.files then clientItem.files = item.files end if item.quotes then clientItem.quotes = item.quotes end ' +
  'if item.preempt then clientItem.preempt = item.preempt end ' +
  'if item.preemptRevision then clientItem.preemptRevision = item.preemptRevision end ' +
  'projected[#projected + 1] = clientItem end ' +
  'if generationProtocol == 2 and item.clientSteerId then local raw = redis.call("HGET", KEYS[8], item.clientSteerId) ' +
  'if raw then local receiptOk, receipt = pcall(cjson.decode, raw) ' +
  'if receiptOk and type(receipt) == "table" then receipt.item = item receipt.state = "leftover" ' +
  'redis.call("HSET", KEYS[8], item.clientSteerId, cjson.encode(receipt)) end end end ' +
  'end ' +
  'end end ' +
  'if #projected > 0 and ownerUserId then ' +
  'local merged = {} local parkedSeen = {} ' +
  'for i = 1, #prior do local item = prior[i] if not parkedSeen[item.steerId] then ' +
  'parkedSeen[item.steerId] = true merged[#merged + 1] = item end end ' +
  'for i = 1, #projected do local item = projected[i] if item.steerId and not parkedSeen[item.steerId] then ' +
  'parkedSeen[item.steerId] = true merged[#merged + 1] = item end end ' +
  'local parked = { userId = ownerUserId, generationProtocolVersion = parkedProtocol, steers = merged } ' +
  'if ownerTenantId then parked.tenantId = ownerTenantId end ' +
  'redis.call("SET", KEYS[6], cjson.encode(parked), "EX", tonumber(ARGV[4])) ' +
  'end ' +
  'for i = 8, 9 do local ttl = redis.call("TTL", KEYS[i]) ' +
  'if ttl >= 0 and ttl < tonumber(ARGV[4]) then redis.call("EXPIRE", KEYS[i], ARGV[4]) end end ' +
  'redis.call("SET", KEYS[7], ARGV[1], "EX", tonumber(ARGV[5])) ' +
  'redis.call("DEL", KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5]) ' +
  'return 1';

/**
 * XADD a chunk + set the chunk-stream TTL to the right window WITHOUT ever shrinking it.
 *
 * During a live stream the running TTL is refreshed on every chunk. But a job paused
 * for HITL review must keep its chunk stream alive for the whole approval window, not
 * the ~20m running TTL — otherwise the pre-pause aggregated content (tool call + earlier
 * text) is evicted before the user resolves and `getResumeState()` loses it.
 *
 * `transitionStatus` extends the chunk-key TTL to the approval window at pause time, but
 * that alone is not enough:
 *   1. The pause's `EXPIRE chunks` is a no-op if the chunk key does not exist yet — and
 *      `appendChunk` is fire-and-forget, so the first chunk's XADD can land AFTER the
 *      pause, or an ask-user pause can occur before any chunk was ever persisted.
 *   2. The `on_pending_action` chunk (and any chunk that races in after the pause) would
 *      otherwise reset an already-extended TTL back to the short running TTL.
 * So this script derives the target window itself: the running TTL normally, but when the
 * job hash is paused (`status == "requires_action"`) it takes the larger of the running
 * TTL and the job key's own remaining TTL (which `transitionStatus` set to the approval
 * window). It only ever EXTENDS — `cur < target` — so a normally-running stream keeps the
 * round-10 extend-only behavior and is never inflated to the approval window.
 *
 * Reading the paused window from the job key (rather than always max-ing against it) is
 * what keeps a normal running run on the short TTL: TTL(jobKey) is only the long approval
 * window while paused; for a running job the job key carries the running TTL, so target
 * stays `run`.
 *
 *   KEYS: [chunks, job, steerReceipts, steerReceiptOrder, claimedSteers, steers,
 *          parkedSteers, generationEpoch]
 *   ARGV: [eventJson, runningTtl, expectCreatedAt | "",
 *          deliveredClientSteerId | "", deliveredItemJson | "", nowMs,
 *          parkedSteersTtl, generationEpochGraceTtl]
 */
const CHUNK_APPEND_LUA =
  'local currentCreatedAt = redis.call("HGET", KEYS[2], "createdAt") ' +
  'if not currentCreatedAt then return 0 end ' +
  'if ARGV[3] ~= "" and currentCreatedAt ~= ARGV[3] then return 0 end ' +
  'local currentStatus = redis.call("HGET", KEYS[2], "status") ' +
  'if currentStatus ~= "running" and currentStatus ~= "requires_action" then return 0 end ' +
  'local retainedEpoch = redis.call("GET", KEYS[8]) ' +
  'if retainedEpoch and retainedEpoch ~= currentCreatedAt then return 0 end ' +
  'local protocolV2 = redis.call("HGET", KEYS[2], "generationProtocolVersion") == "2" ' +
  'local delivered = nil local kept = nil local receipt = nil ' +
  'if ARGV[5] ~= "" then ' +
  'if currentStatus ~= "running" ' +
  'or redis.call("HGET", KEYS[2], "steersClosed") == "1" then return 0 end ' +
  'local deliveredOk, deliveredValue = pcall(cjson.decode, ARGV[5]) ' +
  'if not deliveredOk or type(deliveredValue) ~= "table" or not deliveredValue.steerId then return 0 end ' +
  'delivered = deliveredValue ' +
  'if protocolV2 and delivered.clientSteerId then ' +
  'if ARGV[4] == "" or delivered.clientSteerId ~= ARGV[4] then return 0 end ' +
  'local raw = redis.call("HGET", KEYS[3], ARGV[4]) if not raw then return 0 end ' +
  'local receiptOk, receiptValue = pcall(cjson.decode, raw) ' +
  'if not receiptOk or type(receiptValue) ~= "table" ' +
  'or receiptValue.clientSteerId ~= ARGV[4] ' +
  'or tostring(receiptValue.generationCreatedAt or "") ~= currentCreatedAt ' +
  'or receiptValue.state ~= "claimed" or not receiptValue.item ' +
  'or receiptValue.item.steerId ~= delivered.steerId ' +
  'or receiptValue.item.clientSteerId ~= ARGV[4] then return 0 end ' +
  'receipt = receiptValue ' +
  'elseif protocolV2 and ARGV[4] ~= "" then return 0 end ' +
  'if protocolV2 then ' +
  'local claims = redis.call("LRANGE", KEYS[5], 0, -1) ' +
  'kept = {} local found = false ' +
  'for i = 1, #claims do local ok, item = pcall(cjson.decode, claims[i]) ' +
  'local sameClient = ok and item.clientSteerId == delivered.clientSteerId ' +
  'if not found and ok and item.steerId == delivered.steerId and sameClient then found = true ' +
  'else kept[#kept + 1] = claims[i] end end ' +
  'if not found then return 0 end end ' +
  'end ' +
  'local run = tonumber(ARGV[2]) ' +
  'local target = run ' +
  'local jobTtl = redis.call("TTL", KEYS[2]) ' +
  'if jobTtl < target then redis.call("EXPIRE", KEYS[2], target) ' +
  'elseif jobTtl > target then target = jobTtl end ' +
  'local recoveryTarget = target ' +
  'if redis.call("HGET", KEYS[2], "recoveredSteerId") then ' +
  'recoveryTarget = target + tonumber(ARGV[7]) ' +
  'local pt = redis.call("TTL", KEYS[7]) ' +
  'if pt >= 0 and pt < recoveryTarget then redis.call("EXPIRE", KEYS[7], recoveryTarget) end end ' +
  'local epochTarget = target + tonumber(ARGV[8]) ' +
  'if retainedEpoch then local epochTtl = redis.call("TTL", KEYS[8]) ' +
  'if epochTtl >= 0 and epochTtl < epochTarget then redis.call("EXPIRE", KEYS[8], epochTarget) end ' +
  'else redis.call("SET", KEYS[8], currentCreatedAt, "EX", epochTarget) end ' +
  'if delivered and protocolV2 then local claimTtl = redis.call("PTTL", KEYS[5]) redis.call("DEL", KEYS[5]) ' +
  'if #kept > 0 then redis.call("RPUSH", KEYS[5], unpack(kept)) ' +
  'if claimTtl > 0 then redis.call("PEXPIRE", KEYS[5], claimTtl) end end end ' +
  'redis.call("XADD", KEYS[1], "*", "event", ARGV[1]) ' +
  'local durable = redis.call("HGET", KEYS[2], "durableEventCount") ' +
  'local priorLength = redis.call("XLEN", KEYS[1]) - 1 ' +
  'if not durable or tonumber(durable) < priorLength then durable = priorLength end ' +
  'redis.call("HSET", KEYS[2], "durableEventCount", tonumber(durable) + 1) ' +
  'if currentStatus == "running" then ' +
  'redis.call("HSET", KEYS[2], "lastActiveAt", ARGV[6]) end ' +
  'local cur = redis.call("TTL", KEYS[1]) ' +
  'if cur < target then redis.call("EXPIRE", KEYS[1], target) end ' +
  'for i = 3, 4 do local rt = redis.call("TTL", KEYS[i]) ' +
  'if rt >= 0 and rt < recoveryTarget then redis.call("EXPIRE", KEYS[i], recoveryTarget) end end ' +
  'for i = 5, 6 do local qt = redis.call("TTL", KEYS[i]) ' +
  'if qt >= 0 and qt < target then redis.call("EXPIRE", KEYS[i], target) end end ' +
  'if receipt then receipt.item = delivered receipt.state = "delivered" ' +
  'redis.call("HSET", KEYS[3], ARGV[4], cjson.encode(receipt)) end ' +
  'return 1';

/**
 * Batched CHUNK_APPEND_LUA for plain streaming deltas: identical generation/status/epoch
 * guards and extend-only TTL housekeeping, evaluated once per batch, with one XADD per
 * event. Steer-delivery settlement is deliberately absent — an append carrying a steer
 * receipt is a barrier and stays on the per-event script.
 *
 *   KEYS: [chunks, job, steerReceipts, steerReceiptOrder, claimedSteers, steers,
 *          parkedSteers, generationEpoch]
 *   ARGV: [runningTtl, expectCreatedAt | "", nowMs, parkedSteersTtl,
 *          generationEpochGraceTtl, eventJson...]
 */
const CHUNK_APPEND_BATCH_LUA =
  'local currentCreatedAt = redis.call("HGET", KEYS[2], "createdAt") ' +
  'if not currentCreatedAt then return 0 end ' +
  'if ARGV[2] ~= "" and currentCreatedAt ~= ARGV[2] then return 0 end ' +
  'local currentStatus = redis.call("HGET", KEYS[2], "status") ' +
  'if currentStatus ~= "running" and currentStatus ~= "requires_action" then return 0 end ' +
  'local retainedEpoch = redis.call("GET", KEYS[8]) ' +
  'if retainedEpoch and retainedEpoch ~= currentCreatedAt then return 0 end ' +
  'local run = tonumber(ARGV[1]) ' +
  'local target = run ' +
  'local jobTtl = redis.call("TTL", KEYS[2]) ' +
  'if jobTtl < target then redis.call("EXPIRE", KEYS[2], target) ' +
  'elseif jobTtl > target then target = jobTtl end ' +
  'local recoveryTarget = target ' +
  'if redis.call("HGET", KEYS[2], "recoveredSteerId") then ' +
  'recoveryTarget = target + tonumber(ARGV[4]) ' +
  'local pt = redis.call("TTL", KEYS[7]) ' +
  'if pt >= 0 and pt < recoveryTarget then redis.call("EXPIRE", KEYS[7], recoveryTarget) end end ' +
  'local epochTarget = target + tonumber(ARGV[5]) ' +
  'if retainedEpoch then local epochTtl = redis.call("TTL", KEYS[8]) ' +
  'if epochTtl >= 0 and epochTtl < epochTarget then redis.call("EXPIRE", KEYS[8], epochTarget) end ' +
  'else redis.call("SET", KEYS[8], currentCreatedAt, "EX", epochTarget) end ' +
  'for i = 6, #ARGV do redis.call("XADD", KEYS[1], "*", "event", ARGV[i]) end ' +
  'local durable = redis.call("HGET", KEYS[2], "durableEventCount") ' +
  'local priorLength = redis.call("XLEN", KEYS[1]) - (#ARGV - 5) ' +
  'if not durable or tonumber(durable) < priorLength then durable = priorLength end ' +
  'redis.call("HSET", KEYS[2], "durableEventCount", tonumber(durable) + (#ARGV - 5)) ' +
  'if currentStatus == "running" then ' +
  'redis.call("HSET", KEYS[2], "lastActiveAt", ARGV[3]) end ' +
  'local cur = redis.call("TTL", KEYS[1]) ' +
  'if cur < target then redis.call("EXPIRE", KEYS[1], target) end ' +
  'for i = 3, 4 do local rt = redis.call("TTL", KEYS[i]) ' +
  'if rt >= 0 and rt < recoveryTarget then redis.call("EXPIRE", KEYS[i], recoveryTarget) end end ' +
  'for i = 5, 6 do local qt = redis.call("TTL", KEYS[i]) ' +
  'if qt >= 0 and qt < target then redis.call("EXPIRE", KEYS[i], target) end end ' +
  'return 1';

/**
 * Persist the run-step timeline with the same paused-window TTL as the chunk stream.
 * `saveRunSteps` SETs (overwrites) the whole array, so unlike the chunk append there's no
 * prior key TTL worth preserving — but the write must still extend to the APPROVAL window
 * when the job is paused (`status == "requires_action"`). Otherwise a run-step save that
 * lands at/after a fast pause resets the key to the short running TTL, and a reload of a
 * still-live approval after that window loses the tool/run-step timeline even though the
 * approval remains resumable. Reads the paused window from the job key (which
 * `transitionStatus` set); a normally-running job keeps the short running TTL. The write
 * also requires either an active status or the exact terminal host-action marker. That
 * narrow terminal window lets a draining provider owner commit its final evidence before
 * the host callback acknowledges; after acknowledgement, late writes are fenced out.
 *
 *   KEYS: [runSteps, job]
 *   ARGV: [runStepsJson, runningTtl, expectCreatedAt | ""]
 */
const RUNSTEPS_SAVE_LUA =
  'local currentCreatedAt = redis.call("HGET", KEYS[2], "createdAt") ' +
  'if not currentCreatedAt then return 0 end ' +
  'if ARGV[3] ~= "" and currentCreatedAt ~= ARGV[3] then return 0 end ' +
  'local currentStatus = redis.call("HGET", KEYS[2], "status") ' +
  'local terminalHostActionPending = redis.call("HGET", KEYS[2], "terminalHostActionPending") == "1" or redis.call("HGET", KEYS[2], "detachedAgentEventTerminalHostActionPending") == "1" ' +
  'if currentStatus ~= "running" and currentStatus ~= "requires_action" and not terminalHostActionPending then return 0 end ' +
  'redis.call("SET", KEYS[1], ARGV[1]) ' +
  'local run = tonumber(ARGV[2]) ' +
  'local target = run ' +
  'if currentStatus == "requires_action" or terminalHostActionPending then ' +
  'local jt = redis.call("TTL", KEYS[2]) ' +
  'if jt > target then target = jt end ' +
  'end ' +
  'redis.call("EXPIRE", KEYS[1], target) ' +
  'return 1';

/**
 * Clear same-slot content unless the stream already belongs to a replacement.
 * A missing job is safe: terminal deletion may remove the hash before this
 * best-effort cache cleanup, and Redis executes the check + deletes atomically.
 *
 *   KEYS: [chunks, runSteps, job]
 *   ARGV: [expectCreatedAt | ""]
 */
const CONTENT_CLEAR_LUA =
  'if ARGV[1] ~= "" and redis.call("EXISTS", KEYS[3]) == 1 and redis.call("HGET", KEYS[3], "createdAt") ~= ARGV[1] then return 0 end ' +
  'redis.call("DEL", KEYS[1], KEYS[2]) ' +
  'return 1';

const CHUNKS_READ_LUA =
  'if redis.call("HGET", KEYS[1], "createdAt") ~= ARGV[1] then return {} end ' +
  'return redis.call("XRANGE", KEYS[2], "-", "+")';

const CHUNKS_RECOVERY_READ_LUA =
  'if ARGV[1] ~= "" and redis.call("HGET", KEYS[1], "createdAt") ~= ARGV[1] then return {{}, false} end ' +
  'local entries = redis.call("XRANGE", KEYS[2], "-", "+") ' +
  'local durable = redis.call("HGET", KEYS[1], "durableEventCount") ' +
  'return {entries, durable or false}';

const RUNSTEPS_READ_LUA =
  'if redis.call("HGET", KEYS[1], "createdAt") ~= ARGV[1] then return false end ' +
  'return redis.call("GET", KEYS[2])';

/**
 * Atomically append a steer, guarded on the job hash still being `running`
 * AND the queue not being closed by a terminal drain (`steersClosed` field,
 * set by {@link STEER_CLOSE_DRAIN_LUA}, cleared on createJob). Both keys share
 * the {streamId} hash tag (single slot), so the script is atomic on cluster
 * too — a steer can never land on a completed/aborted/finalizing job, and the
 * depth cap can't be raced past by concurrent enqueues.
 *
 *   KEYS: [job, steers, receipts]
 *   ARGV: [itemJson, ttl, maxDepth]
 *   Returns: new depth, -1 (not running / closed), or -2 (queue full)
 */
const STEER_ENQUEUE_LUA =
  'if ARGV[4] ~= "" and redis.call("HGET", KEYS[1], "createdAt") ~= ARGV[4] then return -1 end ' +
  'if redis.call("HGET", KEYS[1], "status") ~= "running" then return -1 end ' +
  'if redis.call("HGET", KEYS[1], "steersClosed") == "1" then return -1 end ' +
  'if redis.call("LLEN", KEYS[2]) >= tonumber(ARGV[3]) then return -2 end ' +
  'redis.call("RPUSH", KEYS[2], ARGV[1]) ' +
  'redis.call("EXPIRE", KEYS[2], tonumber(ARGV[2])) ' +
  'return redis.call("LLEN", KEYS[2])';

/** Atomic capability-normalized enqueue for callers without a receipt id.
 * The persisted item and its queue position are returned from the same Lua
 * step, eliminating the legacy enqueue→arm failure window. */
const STEER_ENQUEUE_VERSIONED_LUA =
  'if ARGV[4] ~= "" and redis.call("HGET", KEYS[1], "createdAt") ~= ARGV[4] then return -1 end ' +
  'if redis.call("HGET", KEYS[1], "status") ~= "running" then return -1 end ' +
  'if redis.call("HGET", KEYS[1], "steersClosed") == "1" then return -1 end ' +
  'if redis.call("LLEN", KEYS[2]) >= tonumber(ARGV[3]) then return -2 end ' +
  'local item = cjson.decode(ARGV[1]) ' +
  'if item.quotes then local qexec = redis.call("HGET", KEYS[1], "steerQuotesExecutionId") if not qexec or qexec == "" or qexec ~= redis.call("HGET", KEYS[1], "providerExecutionId") then item.quotes = nil end end ' +
  'if ARGV[5] == "1" then item.preemptRevision = 1 ' +
  'if redis.call("HGET", KEYS[1], "preemptCapable") == "1" then item.preempt = true end end ' +
  'local itemJson = cjson.encode(item) ' +
  'redis.call("RPUSH", KEYS[2], itemJson) ' +
  'redis.call("EXPIRE", KEYS[2], tonumber(ARGV[2])) ' +
  'return cjson.encode({ item = item, position = redis.call("LLEN", KEYS[2]) })';

/** Lost-ACK-safe enqueue. The receipt hash deliberately outlives both the
 * queue and job hash; all three keys share the stream hash slot. Existing
 * receipts win before live-job guards, so retry after drain/terminal/replace
 * returns the original ACK instead of re-injecting. */
const STEER_ENQUEUE_RECEIPT_LUA =
  'local existing = redis.call("HGET", KEYS[3], ARGV[5]) ' +
  'if existing then ' +
  'local receipt = cjson.decode(existing) ' +
  'local epoch = redis.call("HGET", KEYS[1], "createdAt") ' +
  'local status = redis.call("HGET", KEYS[1], "status") ' +
  'local sameActive = redis.call("HGET", KEYS[1], "generationProtocolVersion") == "2" ' +
  'and epoch and tostring(receipt.generationCreatedAt or "") == epoch ' +
  'and (status == "running" or status == "requires_action") ' +
  'if receipt.state == "queued" then ' +
  'if not sameActive then receipt.state = "leftover" existing = cjson.encode(receipt) ' +
  'redis.call("HSET", KEYS[3], ARGV[5], existing) else ' +
  'local found = false local queued = redis.call("LRANGE", KEYS[2], 0, -1) ' +
  'for i = 1, #queued do local ok, candidate = pcall(cjson.decode, queued[i]) ' +
  'if ok and candidate.clientSteerId == ARGV[5] then found = true break end end ' +
  'if not found then receipt.state = "leftover" existing = cjson.encode(receipt) ' +
  'redis.call("HSET", KEYS[3], ARGV[5], existing) end end ' +
  'elseif receipt.state == "claimed" and not sameActive then ' +
  'receipt.state = "leftover" existing = cjson.encode(receipt) ' +
  'redis.call("HSET", KEYS[3], ARGV[5], existing) end ' +
  'return existing end ' +
  'if redis.call("HGET", KEYS[1], "generationProtocolVersion") ~= "2" then ' +
  'if ARGV[4] ~= "" and redis.call("HGET", KEYS[1], "createdAt") ~= ARGV[4] then return -1 end ' +
  'if redis.call("HGET", KEYS[1], "status") ~= "running" then return -1 end ' +
  'if redis.call("HGET", KEYS[1], "steersClosed") == "1" then return -1 end ' +
  'if redis.call("LLEN", KEYS[2]) >= tonumber(ARGV[3]) then return -2 end ' +
  'local legacyItem = cjson.decode(ARGV[1]) ' +
  'if legacyItem.quotes then local qexec = redis.call("HGET", KEYS[1], "steerQuotesExecutionId") ' +
  'if not qexec or qexec == "" or qexec ~= redis.call("HGET", KEYS[1], "providerExecutionId") then legacyItem.quotes = nil end end ' +
  'if ARGV[7] == "1" then legacyItem.preemptRevision = 1 ' +
  'if redis.call("HGET", KEYS[1], "preemptCapable") == "1" then legacyItem.preempt = true end end ' +
  'redis.call("RPUSH", KEYS[2], cjson.encode(legacyItem)) ' +
  'redis.call("EXPIRE", KEYS[2], tonumber(ARGV[2])) ' +
  'return cjson.encode({ item = legacyItem, position = redis.call("LLEN", KEYS[2]) }) end ' +
  'if ARGV[4] ~= "" and redis.call("HGET", KEYS[1], "createdAt") ~= ARGV[4] then return -1 end ' +
  'if redis.call("HGET", KEYS[1], "status") ~= "running" then return -1 end ' +
  'if redis.call("HGET", KEYS[1], "steersClosed") == "1" then return -1 end ' +
  'if redis.call("LLEN", KEYS[2]) >= tonumber(ARGV[3]) then return -2 end ' +
  'if redis.call("ZCARD", KEYS[4]) >= tonumber(ARGV[9]) then return -3 end ' +
  'local item = cjson.decode(ARGV[1]) ' +
  'if item.quotes then local qexec = redis.call("HGET", KEYS[1], "steerQuotesExecutionId") if not qexec or qexec == "" or qexec ~= redis.call("HGET", KEYS[1], "providerExecutionId") then item.quotes = nil end end ' +
  'if ARGV[7] == "1" then ' +
  'item.preemptRevision = 1 ' +
  'if redis.call("HGET", KEYS[1], "preemptCapable") == "1" then item.preempt = true end ' +
  'end ' +
  'local itemJson = cjson.encode(item) ' +
  'redis.call("RPUSH", KEYS[2], itemJson) ' +
  'redis.call("EXPIRE", KEYS[2], tonumber(ARGV[2])) ' +
  'local receipt = cjson.decode(ARGV[6]) ' +
  'receipt.item = item receipt.position = redis.call("LLEN", KEYS[2]) receipt.state = "queued" ' +
  'local receiptJson = cjson.encode(receipt) ' +
  'redis.call("HSET", KEYS[3], ARGV[5], receiptJson) ' +
  'redis.call("ZADD", KEYS[4], item.createdAt, ARGV[5]) ' +
  'local receiptTtl = tonumber(ARGV[8]) ' +
  'for i = 3, 4 do local existingTtl = redis.call("TTL", KEYS[i]) ' +
  'if existingTtl == -1 or (existingTtl >= 0 and existingTtl < receiptTtl) then ' +
  'redis.call("EXPIRE", KEYS[i], receiptTtl) end end ' +
  'return receiptJson';

/** Receipt read with lazy repair for terminal/reaper/replacement scripts that
 * delete the queue directly. Generation identity distinguishes a same-run
 * older drain from a replacement that discarded an undrained predecessor. */
const STEER_RECEIPT_GET_LUA =
  'local raw = redis.call("HGET", KEYS[1], ARGV[1]) ' +
  'if not raw then return false end ' +
  'local receipt = cjson.decode(raw) ' +
  'local epoch = redis.call("HGET", KEYS[2], "createdAt") ' +
  'local status = redis.call("HGET", KEYS[2], "status") ' +
  'local sameActive = redis.call("HGET", KEYS[2], "generationProtocolVersion") == "2" ' +
  'and epoch and tostring(receipt.generationCreatedAt or "") == epoch ' +
  'and (status == "running" or status == "requires_action") ' +
  'if receipt.state == "claimed" then ' +
  'if not sameActive then receipt.state = "leftover" raw = cjson.encode(receipt) ' +
  'redis.call("HSET", KEYS[1], ARGV[1], raw) end return raw end ' +
  'if receipt.state ~= "queued" then return raw end ' +
  'if not sameActive then receipt.state = "leftover" raw = cjson.encode(receipt) ' +
  'redis.call("HSET", KEYS[1], ARGV[1], raw) return raw end ' +
  'local items = redis.call("LRANGE", KEYS[3], 0, -1) ' +
  'for i = 1, #items do local ok, item = pcall(cjson.decode, items[i]) ' +
  'if ok and item.clientSteerId == ARGV[1] then return raw end end ' +
  'receipt.state = "leftover" ' +
  'raw = cjson.encode(receipt) redis.call("HSET", KEYS[1], ARGV[1], raw) return raw';

/**
 * Atomic take-all: read the whole queue FIFO and delete the key in one step,
 * so two concurrent drains can never both deliver the same steer. When an
 * expected `createdAt` is supplied, the drain is additionally guarded against
 * job replacement INSIDE the script — a stale run's hook can never consume a
 * replacement job's queue (the check-then-drain would otherwise race
 * `createJob`).
 *
 *   KEYS: [job, steers, claimedSteers, receipts, receiptOrder]
 *   ARGV: [expectedCreatedAt or "", runningTtl]
 *   Returns: array of item JSON strings (possibly empty)
 */
const STEER_DRAIN_LUA =
  'if ARGV[1] ~= "" and redis.call("HGET", KEYS[1], "createdAt") ~= ARGV[1] then return {} end ' +
  'if redis.call("HGET", KEYS[1], "status") ~= "running" ' +
  'or redis.call("HGET", KEYS[1], "steersClosed") == "1" then return {} end ' +
  'local currentCreatedAt = redis.call("HGET", KEYS[1], "createdAt") ' +
  'local items = redis.call("LRANGE", KEYS[2], 0, -1) ' +
  'if redis.call("HGET", KEYS[1], "generationProtocolVersion") ~= "2" then ' +
  'redis.call("DEL", KEYS[2]) return items end ' +
  'local decodedItems = {} local decodedReceipts = {} ' +
  'for i = 1, #items do ' +
  'local ok, item = pcall(cjson.decode, items[i]) ' +
  'if not ok or type(item) ~= "table" or not item.steerId then ' +
  'return redis.error_reply("invalid steer queue item") end ' +
  'decodedItems[i] = item ' +
  'if item.clientSteerId then ' +
  'local raw = redis.call("HGET", KEYS[4], item.clientSteerId) ' +
  'if not raw then return redis.error_reply("missing steer receipt") end ' +
  'local receiptOk, receipt = pcall(cjson.decode, raw) ' +
  'if not receiptOk or type(receipt) ~= "table" ' +
  'or receipt.clientSteerId ~= item.clientSteerId ' +
  'or tostring(receipt.generationCreatedAt or "") ~= currentCreatedAt ' +
  'or receipt.state ~= "queued" or not receipt.item ' +
  'or receipt.item.steerId ~= item.steerId ' +
  'or receipt.item.clientSteerId ~= item.clientSteerId then ' +
  'return redis.error_reply("invalid steer receipt") end ' +
  'decodedReceipts[i] = receipt ' +
  'end end ' +
  'if #items > 0 then redis.call("RPUSH", KEYS[3], unpack(items)) redis.call("EXPIRE", KEYS[3], ARGV[2]) end ' +
  'for i = 1, #items do local item = decodedItems[i] local receipt = decodedReceipts[i] ' +
  'if receipt then receipt.item = item receipt.state = "claimed" ' +
  'redis.call("HSET", KEYS[4], item.clientSteerId, cjson.encode(receipt)) end end ' +
  'for i = 4, 5 do local ttl = redis.call("TTL", KEYS[i]) ' +
  'if ttl >= 0 and ttl < tonumber(ARGV[2]) then redis.call("EXPIRE", KEYS[i], ARGV[2]) end end ' +
  'redis.call("DEL", KEYS[2]) ' +
  'return items';

/** Atomic terminal choice: claim the current v2 FIFO batch, or close steer
 * admission when the queue is empty / the continuation budget is exhausted.
 * The first return entry is the outcome; claimed item JSON follows it. */
const STEER_TERMINAL_ADMISSION_LUA =
  'if ARGV[1] ~= "" and redis.call("HGET", KEYS[1], "createdAt") ~= ARGV[1] then return { "unavailable" } end ' +
  'if redis.call("HGET", KEYS[1], "status") ~= "running" ' +
  'or redis.call("HGET", KEYS[1], "steersClosed") == "1" then return { "unavailable" } end ' +
  'local items = redis.call("LRANGE", KEYS[2], 0, -1) ' +
  'if ARGV[3] ~= "1" or redis.call("HGET", KEYS[1], "generationProtocolVersion") ~= "2" then ' +
  'redis.call("HSET", KEYS[1], "steersClosed", "1") return { "sealed" } end ' +
  'if #items == 0 and ARGV[4] == "1" then return { "open" } end ' +
  'if #items == 0 then redis.call("HSET", KEYS[1], "steersClosed", "1") return { "sealed" } end ' +
  'local currentCreatedAt = redis.call("HGET", KEYS[1], "createdAt") ' +
  'local decodedItems = {} local decodedReceipts = {} ' +
  'for i = 1, #items do local ok, item = pcall(cjson.decode, items[i]) ' +
  'if not ok or type(item) ~= "table" or not item.steerId then ' +
  'return redis.error_reply("invalid steer queue item") end decodedItems[i] = item ' +
  'if item.clientSteerId then local raw = redis.call("HGET", KEYS[4], item.clientSteerId) ' +
  'if not raw then return redis.error_reply("missing steer receipt") end ' +
  'local receiptOk, receipt = pcall(cjson.decode, raw) ' +
  'if not receiptOk or type(receipt) ~= "table" ' +
  'or receipt.clientSteerId ~= item.clientSteerId ' +
  'or tostring(receipt.generationCreatedAt or "") ~= currentCreatedAt ' +
  'or receipt.state ~= "queued" or not receipt.item ' +
  'or receipt.item.steerId ~= item.steerId ' +
  'or receipt.item.clientSteerId ~= item.clientSteerId then ' +
  'return redis.error_reply("invalid steer receipt") end decodedReceipts[i] = receipt end end ' +
  'redis.call("RPUSH", KEYS[3], unpack(items)) redis.call("EXPIRE", KEYS[3], ARGV[2]) ' +
  'for i = 1, #items do local item = decodedItems[i] local receipt = decodedReceipts[i] ' +
  'if receipt then receipt.item = item receipt.state = "claimed" ' +
  'redis.call("HSET", KEYS[4], item.clientSteerId, cjson.encode(receipt)) end end ' +
  'for i = 4, 5 do local ttl = redis.call("TTL", KEYS[i]) ' +
  'if ttl >= 0 and ttl < tonumber(ARGV[2]) then redis.call("EXPIRE", KEYS[i], ARGV[2]) end end ' +
  'redis.call("DEL", KEYS[2]) local result = { "claimed" } ' +
  'for i = 1, #items do result[#result + 1] = items[i] end return result';

/** Roll back claimed items whose durable applied-part write failed. New
 * enqueues may have landed after the drain, so the failed accepted batch is
 * prepended in its original order rather than replacing the live queue. */
const STEER_RESTORE_CLAIMED_LUA =
  'if ARGV[1] ~= "" and redis.call("HGET", KEYS[1], "createdAt") ~= ARGV[1] then return 0 end ' +
  'if redis.call("HGET", KEYS[1], "status") ~= "running" then return 0 end ' +
  'if redis.call("HGET", KEYS[1], "steersClosed") == "1" then return 0 end ' +
  'local currentCreatedAt = redis.call("HGET", KEYS[1], "createdAt") ' +
  'local incoming = cjson.decode(ARGV[2]) local incomingIds = {} ' +
  'for i = 1, #incoming do if incoming[i].steerId then incomingIds[incoming[i].steerId] = true end end ' +
  'if redis.call("HGET", KEYS[1], "generationProtocolVersion") ~= "2" then ' +
  'local present = {} local current = redis.call("LRANGE", KEYS[2], 0, -1) ' +
  'for i = 1, #current do local ok, item = pcall(cjson.decode, current[i]) ' +
  'if not ok or type(item) ~= "table" or not item.steerId then return 0 end present[item.steerId] = true end ' +
  'for i = #incoming, 1, -1 do local item = incoming[i] if item.steerId and not present[item.steerId] then ' +
  'redis.call("LPUSH", KEYS[2], cjson.encode(item)) end end ' +
  'if redis.call("EXISTS", KEYS[2]) == 1 then redis.call("EXPIRE", KEYS[2], ARGV[3]) end return 1 end ' +
  'local claims = redis.call("LRANGE", KEYS[3], 0, -1) local keptClaims = {} local matched = 0 ' +
  'for i = 1, #claims do local ok, item = pcall(cjson.decode, claims[i]) ' +
  'if ok and item.steerId and incomingIds[item.steerId] then matched = matched + 1 ' +
  'else keptClaims[#keptClaims + 1] = claims[i] end end ' +
  'if matched ~= #incoming then return 0 end ' +
  'local receiptByClient = {} ' +
  'for i = 1, #incoming do local item = incoming[i] if item.clientSteerId then ' +
  'local raw = redis.call("HGET", KEYS[4], item.clientSteerId) if not raw then return 0 end ' +
  'local ok, receipt = pcall(cjson.decode, raw) ' +
  'if not ok or type(receipt) ~= "table" ' +
  'or receipt.clientSteerId ~= item.clientSteerId ' +
  'or tostring(receipt.generationCreatedAt or "") ~= currentCreatedAt ' +
  'or receipt.state ~= "claimed" or not receipt.item ' +
  'or receipt.item.steerId ~= item.steerId ' +
  'or receipt.item.clientSteerId ~= item.clientSteerId then return 0 end ' +
  'receiptByClient[item.clientSteerId] = receipt end end ' +
  'local present = {} local current = redis.call("LRANGE", KEYS[2], 0, -1) ' +
  'for i = 1, #current do local ok, item = pcall(cjson.decode, current[i]) ' +
  'if not ok or type(item) ~= "table" or not item.steerId then return 0 end ' +
  'present[item.steerId] = true end ' +
  'local claimsTtl = redis.call("PTTL", KEYS[3]) redis.call("DEL", KEYS[3]) ' +
  'if #keptClaims > 0 then redis.call("RPUSH", KEYS[3], unpack(keptClaims)) ' +
  'if claimsTtl > 0 then redis.call("PEXPIRE", KEYS[3], claimsTtl) end end ' +
  'for i = #incoming, 1, -1 do local item = incoming[i] ' +
  'if item.steerId and not present[item.steerId] then ' +
  'local itemJson = cjson.encode(item) redis.call("LPUSH", KEYS[2], itemJson) ' +
  'if item.clientSteerId then local receipt = receiptByClient[item.clientSteerId] ' +
  'receipt.item = item receipt.state = "queued" ' +
  'redis.call("HSET", KEYS[4], item.clientSteerId, cjson.encode(receipt)) end end end ' +
  'if redis.call("EXISTS", KEYS[2]) == 1 then redis.call("EXPIRE", KEYS[2], ARGV[3]) end ' +
  'return 1';

const STEER_PEEK_LUA =
  'if redis.call("HGET", KEYS[1], "createdAt") ~= ARGV[1] then return {} end ' +
  'return redis.call("LRANGE", KEYS[2], 0, -1)';

const STEER_PEEK_CLAIMED_LUA =
  'if ARGV[1] ~= "" and redis.call("HGET", KEYS[1], "createdAt") ~= ARGV[1] then return {} end ' +
  'if redis.call("HGET", KEYS[1], "generationProtocolVersion") ~= "2" then return {} end ' +
  'return redis.call("LRANGE", KEYS[2], 0, -1)';

/**
 * Remove ONE queued steer by id without disturbing the rest: the list is
 * rebuilt atomically, so a concurrent drain either delivers the steer or the
 * cancel wins — never a torn queue. The generation fence and receipt
 * validation happen before either the queue or receipt is changed. The list
 * TTL survives the rebuild.
 *
 *   KEYS: [job, steers, receipts]
 *   ARGV: [steerId, expectedCreatedAt or ""]
 *   Returns: 1 when removed, 0 when not found
 */
const STEER_REMOVE_LUA =
  'if ARGV[2] ~= "" and redis.call("HGET", KEYS[1], "createdAt") ~= ARGV[2] then return 0 end ' +
  'local currentCreatedAt = redis.call("HGET", KEYS[1], "createdAt") ' +
  'local protocolV2 = redis.call("HGET", KEYS[1], "generationProtocolVersion") == "2" ' +
  'local items = redis.call("LRANGE", KEYS[2], 0, -1) ' +
  'if #items == 0 then return 0 end ' +
  'local target = 0 local targetItem = nil local targetReceipt = nil ' +
  'for i = 1, #items do ' +
  'local ok, item = pcall(cjson.decode, items[i]) ' +
  'if not ok or type(item) ~= "table" or type(item.steerId) ~= "string" or item.steerId == "" then ' +
  'return redis.error_reply("invalid steer queue item") end ' +
  'if item.steerId == ARGV[1] then ' +
  'if target ~= 0 then return redis.error_reply("duplicate steer id") end ' +
  'target = i targetItem = item ' +
  'if protocolV2 and item.clientSteerId then ' +
  'if type(item.clientSteerId) ~= "string" or item.clientSteerId == "" or not currentCreatedAt then ' +
  'return redis.error_reply("invalid steer receipt") end ' +
  'local raw = redis.call("HGET", KEYS[3], item.clientSteerId) ' +
  'if not raw then return redis.error_reply("missing steer receipt") end ' +
  'local receiptOk, receipt = pcall(cjson.decode, raw) ' +
  'if not receiptOk or type(receipt) ~= "table" ' +
  'or receipt.clientSteerId ~= item.clientSteerId ' +
  'or tostring(receipt.generationCreatedAt or "") ~= currentCreatedAt ' +
  'or receipt.state ~= "queued" or type(receipt.item) ~= "table" ' +
  'or receipt.item.steerId ~= item.steerId ' +
  'or receipt.item.clientSteerId ~= item.clientSteerId then ' +
  'return redis.error_reply("invalid steer receipt") end targetReceipt = receipt end end ' +
  'end ' +
  'if target == 0 then return 0 end ' +
  'local ttl = redis.call("PTTL", KEYS[2]) ' +
  'redis.call("DEL", KEYS[2]) ' +
  'local kept = {} for i = 1, #items do if i ~= target then kept[#kept + 1] = items[i] end end ' +
  'if #kept > 0 then ' +
  'redis.call("RPUSH", KEYS[2], unpack(kept)) ' +
  'if ttl > 0 then redis.call("PEXPIRE", KEYS[2], ttl) end ' +
  'end ' +
  'if targetReceipt then targetReceipt.item = targetItem targetReceipt.state = "cancelled" ' +
  'redis.call("HSET", KEYS[3], targetItem.clientSteerId, cjson.encode(targetReceipt)) end ' +
  'return 1';

/**
 * Escalate ONE queued steer to an interrupt IN PLACE: decode the whole item,
 * set `preempt`, and LSET it back at its index, so its FIFO position is
 * untouched (the entire queue drains at the seal, in order). Guarded like
 * {@link STEER_ENQUEUE_LUA}: a non-running job, closed queue, or generation
 * mismatch refuses, so an arm racing a pause cannot leak into the resumed
 * segment and a stale request can never arm a replacement run's steer. The
 * owner's LIVE `preemptCapable` is part of the same atomic predicate — a HITL
 * resume on a rolling deploy rewrites it for the SAME generation, so a value
 * the caller read earlier is not trustworthy.
 *
 *   KEYS: [job, steers, receipts]
 *   ARGV: [steerId, expectedCreatedAt or ""]
 *   Returns: the updated item JSON, 0 not found / non-running / closed / fenced,
 *   or -1 when the owner cannot seal.
 */
const STEER_ARM_LUA =
  'if ARGV[2] ~= "" and redis.call("HGET", KEYS[1], "createdAt") ~= ARGV[2] then return 0 end ' +
  'if redis.call("HGET", KEYS[1], "status") ~= "running" then return 0 end ' +
  'if redis.call("HGET", KEYS[1], "steersClosed") == "1" then return 0 end ' +
  'local protocolV2 = redis.call("HGET", KEYS[1], "generationProtocolVersion") == "2" ' +
  'local currentCreatedAt = redis.call("HGET", KEYS[1], "createdAt") ' +
  'local items = redis.call("LRANGE", KEYS[2], 0, -1) ' +
  'local target = 0 local item = nil ' +
  'for i = 1, #items do ' +
  'local decoded, candidate = pcall(cjson.decode, items[i]) ' +
  'if not decoded or type(candidate) ~= "table" or type(candidate.steerId) ~= "string" ' +
  'or candidate.steerId == "" then return redis.error_reply("invalid steer queue item") end ' +
  'if candidate.steerId == ARGV[1] then ' +
  'if target ~= 0 then return redis.error_reply("duplicate steer id") end ' +
  'target = i item = candidate end ' +
  'end ' +
  'if target == 0 then return 0 end ' +
  'if redis.call("HGET", KEYS[1], "preemptCapable") ~= "1" then return -1 end ' +
  'local receipt = nil ' +
  'if protocolV2 and item.clientSteerId then ' +
  'if type(item.clientSteerId) ~= "string" or item.clientSteerId == "" or not currentCreatedAt then ' +
  'return redis.error_reply("invalid steer receipt") end ' +
  'local receiptJson = redis.call("HGET", KEYS[3], item.clientSteerId) ' +
  'if not receiptJson then return redis.error_reply("missing steer receipt") end ' +
  'local receiptOk, receiptValue = pcall(cjson.decode, receiptJson) ' +
  'if not receiptOk or type(receiptValue) ~= "table" ' +
  'or receiptValue.clientSteerId ~= item.clientSteerId ' +
  'or tostring(receiptValue.generationCreatedAt or "") ~= currentCreatedAt ' +
  'or receiptValue.state ~= "queued" or not receiptValue.item ' +
  'or receiptValue.item.steerId ~= item.steerId ' +
  'or receiptValue.item.clientSteerId ~= item.clientSteerId then ' +
  'return redis.error_reply("invalid steer receipt") end receipt = receiptValue end ' +
  'item.preemptRevision = tonumber(item.preemptRevision or 0) + 1 ' +
  'item.preempt = true ' +
  'redis.call("LSET", KEYS[2], target - 1, cjson.encode(item)) ' +
  'if receipt then receipt.item = item ' +
  'redis.call("HSET", KEYS[3], item.clientSteerId, cjson.encode(receipt)) end ' +
  'return cjson.encode(item)';

/** Downgrade durable interrupt labels during a capable→incapable owner
 * handover. Capability and queue edits share one Lua transaction, so a later
 * capable resume cannot race a stale cleanup from the previous owner. */
const STEER_DOWNGRADE_PREEMPTS_LUA =
  'if ARGV[1] ~= "" and redis.call("HGET", KEYS[1], "createdAt") ~= ARGV[1] then return -1 end ' +
  'if redis.call("EXISTS", KEYS[1]) == 0 then return -1 end ' +
  'if redis.call("HGET", KEYS[1], "preemptCapable") == "1" then return -1 end ' +
  'local protocolV2 = redis.call("HGET", KEYS[1], "generationProtocolVersion") == "2" ' +
  'local items = redis.call("LRANGE", KEYS[2], 0, -1) ' +
  'local decodedItems = {} local decodedReceipts = {} ' +
  'for i = 1, #items do ' +
  'local decoded, item = pcall(cjson.decode, items[i]) ' +
  'if decoded and item.preempt == true then ' +
  'decodedItems[i] = item ' +
  'if protocolV2 and item.clientSteerId then local receiptJson = redis.call("HGET", KEYS[3], item.clientSteerId) ' +
  'if not receiptJson then return redis.error_reply("missing steer receipt") end ' +
  'local receiptOk, receipt = pcall(cjson.decode, receiptJson) ' +
  'local epoch = redis.call("HGET", KEYS[1], "createdAt") ' +
  'if not receiptOk or type(receipt) ~= "table" ' +
  'or receipt.clientSteerId ~= item.clientSteerId ' +
  'or tostring(receipt.generationCreatedAt or "") ~= epoch ' +
  'or receipt.state ~= "queued" or not receipt.item ' +
  'or receipt.item.steerId ~= item.steerId ' +
  'or receipt.item.clientSteerId ~= item.clientSteerId then ' +
  'return redis.error_reply("invalid steer receipt") end decodedReceipts[i] = receipt end end end ' +
  'local changed = {} ' +
  'for i = 1, #items do local item = decodedItems[i] ' +
  'if item then ' +
  'item.preempt = nil ' +
  'item.preemptRevision = tonumber(item.preemptRevision or 0) + 1 ' +
  'redis.call("LSET", KEYS[2], i - 1, cjson.encode(item)) ' +
  'local receipt = decodedReceipts[i] if receipt then receipt.item = item ' +
  'redis.call("HSET", KEYS[3], item.clientSteerId, cjson.encode(receipt)) end ' +
  'changed[#changed + 1] = cjson.encode(item) ' +
  'end ' +
  'end ' +
  'return changed';

/**
 * Owner-gated replay read for parked steers. It intentionally does not delete:
 * createJob only leases the exact recovered item while its deterministic next
 * turn is active. Durable user-message persistence commits the removal, so a
 * failed startup or lost status response cannot erase the only recovery copy.
 *
 *   KEYS: [parkedSteers, job]
 *   ARGV: [ownerUserId, ownerTenantId | "", requestedProtocolVersion]
 *   Returns: [parked payload JSON, protocol], '' when not the owner, or nil
 */
const CLAIM_PARKED_LUA =
  'local v = redis.call("GET", KEYS[1]) ' +
  'if not v then return v end ' +
  'local function isDenseArray(value) if type(value) ~= "table" then return false end ' +
  'local count = 0 for key, _ in pairs(value) do ' +
  'if type(key) ~= "number" or key < 1 or key ~= math.floor(key) then return false end count = count + 1 end ' +
  'return count == #value end ' +
  'local ok, parked = pcall(cjson.decode, v) ' +
  'if not ok or type(parked) ~= "table" or type(parked.userId) ~= "string" or parked.userId == "" ' +
  'or not isDenseArray(parked.steers) or #parked.steers == 0 then return "" end ' +
  'if parked.generationProtocolVersion and parked.generationProtocolVersion ~= 1 ' +
  'and parked.generationProtocolVersion ~= 2 then return "" end ' +
  'for i = 1, #parked.steers do local item = parked.steers[i] ' +
  'if type(item) ~= "table" or type(item.steerId) ~= "string" or item.steerId == "" ' +
  'or (item.clientSteerId and (type(item.clientSteerId) ~= "string" or item.clientSteerId == "")) ' +
  'or (item.text and type(item.text) ~= "string") ' +
  'or (item.createdAt and (type(item.createdAt) ~= "number" or item.createdAt < 0)) ' +
  'or (item.recoveringCreatedAt and (type(item.recoveringCreatedAt) ~= "number" or item.recoveringCreatedAt < 0)) then return "" end end ' +
  'if parked.userId ~= ARGV[1] then return "" end ' +
  'if parked.tenantId and parked.tenantId ~= ARGV[2] then return "" end ' +
  'local createdAt = redis.call("HGET", KEYS[2], "createdAt") ' +
  'local status = redis.call("HGET", KEYS[2], "status") ' +
  'local recoveredSteerId = redis.call("HGET", KEYS[2], "recoveredSteerId") ' +
  'local jobTenantId = redis.call("HGET", KEYS[2], "tenantId") ' +
  'local activeRecovery = createdAt and (status == "running" or status == "requires_action") ' +
  'and redis.call("HGET", KEYS[2], "generationProtocolVersion") == "2" ' +
  'and recoveredSteerId and recoveredSteerId ~= "" ' +
  'and redis.call("HGET", KEYS[2], "userId") == ARGV[1] ' +
  'and (not jobTenantId or jobTenantId == ARGV[2]) ' +
  'local visible = {} local leased = {} for i = 1, #parked.steers do local item = parked.steers[i] ' +
  'if activeRecovery and item.steerId == recoveredSteerId ' +
  'and tostring(item.recoveringCreatedAt or "") == createdAt then leased[#leased + 1] = item ' +
  'else item.recoveringCreatedAt = nil visible[#visible + 1] = item end end ' +
  'local protocol = parked.generationProtocolVersion == 2 and ARGV[3] == "2" and 2 or 1 ' +
  'if protocol == 1 and #leased == 0 then parked.generationProtocolVersion = 1 ' +
  'parked.steers = visible redis.call("DEL", KEYS[1]) ' +
  'return { cjson.encode(parked), "1" } end ' +
  'if #visible == 0 then return "" end parked.steers = visible ' +
  'if protocol == 1 then local ttl = redis.call("PTTL", KEYS[1]) ' +
  'local retained = { userId = parked.userId, generationProtocolVersion = 2, steers = leased } ' +
  'if parked.tenantId then retained.tenantId = parked.tenantId end ' +
  'redis.call("SET", KEYS[1], cjson.encode(retained)) ' +
  'if ttl > 0 then redis.call("PEXPIRE", KEYS[1], ttl) end ' +
  'parked.generationProtocolVersion = 1 end ' +
  'return { cjson.encode(parked), tostring(protocol) }';

/** Commit a leased recovery only after its ordinary user message is durable. */
const CONSUME_PARKED_STEER_LUA =
  'if redis.call("HGET", KEYS[1], "createdAt") ~= ARGV[1] ' +
  'or redis.call("HGET", KEYS[1], "userId") ~= ARGV[3] ' +
  'or redis.call("HGET", KEYS[1], "recoveredSteerId") ~= ARGV[2] then return 0 end ' +
  'local jobTenant = redis.call("HGET", KEYS[1], "tenantId") ' +
  'if jobTenant and jobTenant ~= ARGV[4] then return 0 end ' +
  'local raw = redis.call("GET", KEYS[2]) if not raw then return 1 end ' +
  'local ok, parked = pcall(cjson.decode, raw) ' +
  'if not ok or type(parked) ~= "table" or type(parked.steers) ~= "table" then return 0 end ' +
  'local count = 0 for key, _ in pairs(parked.steers) do ' +
  'if type(key) ~= "number" or key < 1 or key ~= math.floor(key) then return 0 end count = count + 1 end ' +
  'if count == 0 or count ~= #parked.steers then return 0 end ' +
  'if parked.userId ~= ARGV[3] or (parked.tenantId and parked.tenantId ~= ARGV[4]) then return 0 end ' +
  'local consumed = nil local kept = {} for i = 1, #parked.steers do local item = parked.steers[i] ' +
  'if type(item) ~= "table" or type(item.steerId) ~= "string" or item.steerId == "" then return 0 end ' +
  'if not consumed and item.steerId == ARGV[2] ' +
  'and tostring(item.recoveringCreatedAt or "") == ARGV[1] then consumed = item ' +
  'else kept[#kept + 1] = item end end if not consumed then return 0 end ' +
  'local receipt = nil if consumed.clientSteerId then ' +
  'local receiptRaw = redis.call("HGET", KEYS[3], consumed.clientSteerId) if not receiptRaw then return 0 end ' +
  'local receiptOk, decoded = pcall(cjson.decode, receiptRaw) ' +
  'if not receiptOk or decoded.state ~= "leftover" or decoded.userId ~= ARGV[3] ' +
  'or (decoded.tenantId and decoded.tenantId ~= ARGV[4]) or not decoded.item ' +
  'or decoded.item.steerId ~= ARGV[2] then return 0 end receipt = decoded end ' +
  'local ttl = redis.call("PTTL", KEYS[2]) if #kept == 0 then redis.call("DEL", KEYS[2]) ' +
  'else parked.steers = kept redis.call("SET", KEYS[2], cjson.encode(parked)) ' +
  'if ttl > 0 then redis.call("PEXPIRE", KEYS[2], ttl) end end ' +
  'if receipt then receipt.state = "recovered" ' +
  'redis.call("HSET", KEYS[3], consumed.clientSteerId, cjson.encode(receipt)) end return 1';

/** Idempotent terminal reclaim for Edit/Queue/dismiss. */
const DISCARD_STEER_LEFTOVER_LUA =
  'local raw = redis.call("HGET", KEYS[1], ARGV[1]) if not raw then return 0 end ' +
  'local ok, receipt = pcall(cjson.decode, raw) if not ok or type(receipt) ~= "table" then return 0 end ' +
  'if ARGV[5] ~= "" and tostring(receipt.generationCreatedAt or "") ~= ARGV[5] then return 0 end ' +
  'local tenantMatches = not receipt.tenantId or receipt.tenantId == ARGV[4] ' +
  'if receipt.state ~= "leftover" or receipt.userId ~= ARGV[3] or not tenantMatches ' +
  'or not receipt.item or receipt.item.steerId ~= ARGV[2] then return 0 end ' +
  'local status = redis.call("HGET", KEYS[3], "status") ' +
  'local activeRecovery = (status == "running" or status == "requires_action") ' +
  'and redis.call("HGET", KEYS[3], "recoveredSteerId") == ARGV[2] ' +
  'and redis.call("HGET", KEYS[3], "userId") == ARGV[3] ' +
  'local jobTenant = redis.call("HGET", KEYS[3], "tenantId") ' +
  'if activeRecovery and (not jobTenant or jobTenant == ARGV[4]) then return 0 end ' +
  'local parkedRaw = redis.call("GET", KEYS[2]) ' +
  'if parkedRaw then local parsed, parked = pcall(cjson.decode, parkedRaw) ' +
  'if not parsed or type(parked) ~= "table" or type(parked.steers) ~= "table" then return 0 end ' +
  'local count = 0 for key, _ in pairs(parked.steers) do ' +
  'if type(key) ~= "number" or key < 1 or key ~= math.floor(key) then return 0 end count = count + 1 end ' +
  'if count == 0 or count ~= #parked.steers then return 0 end ' +
  'local parkedTenantMatches = not parked.tenantId or parked.tenantId == ARGV[4] ' +
  'if parked.userId ~= ARGV[3] or not parkedTenantMatches then return 0 end ' +
  'local kept = {} for i = 1, #parked.steers do local item = parked.steers[i] ' +
  'if type(item) ~= "table" or type(item.steerId) ~= "string" or item.steerId == "" then return 0 end ' +
  'if item.steerId ~= ARGV[2] then kept[#kept + 1] = item end end ' +
  'if #kept == 0 then redis.call("DEL", KEYS[2]) else parked.steers = kept ' +
  'local ttl = redis.call("PTTL", KEYS[2]) redis.call("SET", KEYS[2], cjson.encode(parked)) ' +
  'if ttl > 0 then redis.call("PEXPIRE", KEYS[2], ttl) end end end ' +
  'receipt.state = "cancelled" redis.call("HSET", KEYS[1], ARGV[1], cjson.encode(receipt)) ' +
  'return 1';

/**
 * Park leftovers only while the generation that drained them still owns the
 * stream ID. If a replacement already exists, writing its parked key would
 * leak predecessor state into the new run. A replacement created afterward
 * retains the owner-gated payload and leases only an explicitly selected item.
 *
 *   KEYS: [job, parkedSteers]
 *   ARGV: [expectedCreatedAt | "", payload, ttl]
 */
const PARK_STEERS_LUA =
  'if ARGV[1] ~= "" and redis.call("HGET", KEYS[1], "createdAt") ~= ARGV[1] then return 0 end ' +
  'local ok, parked = pcall(cjson.decode, ARGV[2]) if not ok or type(parked) ~= "table" then return 0 end ' +
  'local protocol = redis.call("HGET", KEYS[1], "generationProtocolVersion") ' +
  'if protocol == "2" then parked.generationProtocolVersion = 2 ' +
  'else parked.generationProtocolVersion = 1 end ' +
  'redis.call("SET", KEYS[2], cjson.encode(parked), "EX", ARGV[3]) ' +
  'return 1';

/**
 * Terminal close-then-drain in one atomic step: mark the queue closed on the
 * job hash (only when the hash still exists — a bare HSET would resurrect a
 * deleted job as a stray hash), then take the whole queue. Once closed,
 * {@link STEER_ENQUEUE_LUA} rejects, so a steer POST racing finalization can
 * never be ACKed after the last drain and then silently cleared. The same
 * expected-`createdAt` guard as {@link STEER_DRAIN_LUA} keeps a stale run's
 * finalization from closing (and stealing) a replacement job's queue.
 *
 *   KEYS: [job, steers, claimedSteers, receipts, receiptOrder, parkedSteers]
 *   ARGV: [expectedCreatedAt or "", parkedTtl]
 *   Returns: array of item JSON strings (possibly empty), or the
 *   `recovery_corrupt` sentinel when destructive recovery is unsafe.
 */
const STEER_CLOSE_DRAIN_LUA =
  'if ARGV[1] ~= "" and redis.call("HGET", KEYS[1], "createdAt") ~= ARGV[1] then return {} end ' +
  'if redis.call("EXISTS", KEYS[1]) == 0 then return {} end ' +
  'local ownerUserId = redis.call("HGET", KEYS[1], "userId") ' +
  'local ownerTenantId = redis.call("HGET", KEYS[1], "tenantId") ' +
  'local generationProtocol = redis.call("HGET", KEYS[1], "generationProtocolVersion") == "2" and 2 or 1 ' +
  'local parkedProtocol = generationProtocol ' +
  'local function isDenseArray(value) if type(value) ~= "table" then return false end ' +
  'local count = 0 for key, _ in pairs(value) do ' +
  'if type(key) ~= "number" or key < 1 or key ~= math.floor(key) then return false end count = count + 1 end ' +
  'return count == #value end ' +
  'local claimedRows = {} if generationProtocol == 2 then claimedRows = redis.call("LRANGE", KEYS[3], 0, -1) end ' +
  'local sources = { claimedRows, redis.call("LRANGE", KEYS[2], 0, -1) } ' +
  'for s = 1, #sources do for i = 1, #sources[s] do local ok, item = pcall(cjson.decode, sources[s][i]) ' +
  'if not ok or type(item) ~= "table" or type(item.steerId) ~= "string" or item.steerId == "" then return "recovery_corrupt" end end end ' +
  'if (#sources[1] > 0 or #sources[2] > 0) and (not ownerUserId or ownerUserId == "") then return "recovery_corrupt" end ' +
  'local parkedSteers = {} local parkedRaw = redis.call("GET", KEYS[6]) ' +
  'if parkedRaw then local parsed, parked = pcall(cjson.decode, parkedRaw) ' +
  'if not parsed or type(parked) ~= "table" or type(parked.userId) ~= "string" or parked.userId == "" ' +
  'or not isDenseArray(parked.steers) or #parked.steers == 0 or parked.userId ~= ownerUserId ' +
  'or (parked.tenantId and parked.tenantId ~= ownerTenantId) then return "recovery_corrupt" end ' +
  'if parked.generationProtocolVersion and parked.generationProtocolVersion ~= 1 ' +
  'and parked.generationProtocolVersion ~= 2 then return "recovery_corrupt" end ' +
  'if parked.generationProtocolVersion == 2 then parkedProtocol = 2 end ' +
  'for i = 1, #parked.steers do local prior = parked.steers[i] ' +
  'if type(prior) ~= "table" or type(prior.steerId) ~= "string" or prior.steerId == "" ' +
  'or (prior.clientSteerId and (type(prior.clientSteerId) ~= "string" or prior.clientSteerId == "")) ' +
  'or (prior.text and type(prior.text) ~= "string") ' +
  'or (prior.createdAt and (type(prior.createdAt) ~= "number" or prior.createdAt < 0)) ' +
  'or (prior.recoveringCreatedAt and (type(prior.recoveringCreatedAt) ~= "number" or prior.recoveringCreatedAt < 0)) then return "recovery_corrupt" end ' +
  'parkedSteers[#parkedSteers + 1] = prior end end ' +
  'if redis.call("EXISTS", KEYS[1]) == 1 then redis.call("HSET", KEYS[1], "steersClosed", "1") end ' +
  'local combined = {} local seen = {} ' +
  'for s = 1, #sources do for i = 1, #sources[s] do ' +
  'local ok, item = pcall(cjson.decode, sources[s][i]) ' +
  'if ok and item.steerId and not seen[item.steerId] then ' +
  'seen[item.steerId] = true combined[#combined + 1] = item end ' +
  'if generationProtocol == 2 and ok and item.clientSteerId then ' +
  'local raw = redis.call("HGET", KEYS[4], item.clientSteerId) ' +
  'if raw then local receiptOk, receipt = pcall(cjson.decode, raw) ' +
  'if receiptOk and type(receipt) == "table" then receipt.item = item receipt.state = "leftover" ' +
  'redis.call("HSET", KEYS[4], item.clientSteerId, cjson.encode(receipt)) end end ' +
  'end end end ' +
  'if #combined > 0 and ownerUserId then ' +
  'local filteredParkedSteers = {} ' +
  'for i = 1, #parkedSteers do local prior = parkedSteers[i] ' +
  'if not seen[prior.steerId] then seen[prior.steerId] = true ' +
  'filteredParkedSteers[#filteredParkedSteers + 1] = prior end end ' +
  'local currentProjected = {} ' +
  'for i = 1, #combined do local item = combined[i] ' +
  'local projected = { steerId = item.steerId, text = item.text, createdAt = item.createdAt } ' +
  'if item.clientSteerId then projected.clientSteerId = item.clientSteerId end ' +
  'if item.files then projected.files = item.files end ' +
  'if item.quotes then projected.quotes = item.quotes end ' +
  'if item.preempt then projected.preempt = item.preempt end ' +
  'if item.preemptRevision then projected.preemptRevision = item.preemptRevision end ' +
  'currentProjected[#currentProjected + 1] = projected end ' +
  'local merged = {} for i = 1, #filteredParkedSteers do merged[#merged + 1] = filteredParkedSteers[i] end ' +
  'for i = 1, #currentProjected do merged[#merged + 1] = currentProjected[i] end ' +
  'local parked = { userId = ownerUserId, generationProtocolVersion = parkedProtocol, steers = merged } ' +
  'if ownerTenantId then parked.tenantId = ownerTenantId end ' +
  'redis.call("SET", KEYS[6], cjson.encode(parked), "EX", ARGV[2]) end ' +
  'for i = 4, 5 do local ttl = redis.call("TTL", KEYS[i]) ' +
  'if ttl >= 0 and ttl < tonumber(ARGV[2]) then redis.call("EXPIRE", KEYS[i], ARGV[2]) end end ' +
  'redis.call("DEL", KEYS[2], KEYS[3]) ' +
  'local encoded = {} for i = 1, #combined do encoded[i] = cjson.encode(combined[i]) end ' +
  'return encoded';

/** Decision kinds the SDK can emit, used to sanity-check persisted records. */
const KNOWN_INTERRUPT_TYPES = new Set(['tool_approval', 'ask_user_question']);

/** Recovery window (seconds) for parked steers when `completedTtl` is
 *  configured to 0 — Redis rejects `EX 0`, which would silently kill
 *  park-based recovery. */
const PARKED_RECOVERY_TTL_S: number = 300;
const STEER_RECEIPT_MAX_PER_STREAM: number = 100;
/** Grace window for publishing terminal/reaper events after the live job hash expires. */
const GENERATION_EPOCH_GRACE_TTL_S: number = 300;
/** A terminal record carrying an uncommitted final event must survive the
 * persistence-owner timeout even when completedTtl is configured to zero. */
const TERMINAL_PERSISTENCE_RETENTION_TTL_S: number = 300;

/** Bound pathological replacement churn without leaving the request unbounded. */
const MEMBERSHIP_RECONCILE_MAX_ATTEMPTS: number = 8;

/**
 * Key prefixes for Redis storage.
 * All keys include the streamId for easy cleanup.
 * Note: streamId === conversationId, so no separate mapping needed.
 *
 * IMPORTANT: Uses hash tags {streamId} for Redis Cluster compatibility.
 * All keys for the same stream hash to the same slot, enabling:
 * - Pipeline operations across related keys
 * - Atomic multi-key operations
 */
const KEYS = {
  /** Job metadata: stream:{streamId}:job */
  job: (streamId: string) => `stream:{${streamId}}:job`,
  /** Pub/sub event sequence counter: stream:{streamId}:seq */
  sequence: (streamId: string) => `stream:{${streamId}}:seq`,
  /** Chunk stream (Redis Streams): stream:{streamId}:chunks */
  chunks: (streamId: string) => `stream:{${streamId}}:chunks`,
  /** Run steps: stream:{streamId}:runsteps */
  runSteps: (streamId: string) => `stream:{${streamId}}:runsteps`,
  /** Pending steer messages (FIFO list): stream:{streamId}:steers */
  steers: (streamId: string) => `stream:{${streamId}}:steers`,
  /** Drained steers awaiting an atomic durable applied-chunk commit. */
  claimedSteers: (streamId: string) => `stream:{${streamId}}:steers-claimed`,
  /** Parked terminally-drained steers (own TTL — must outlive the job hash,
   *  which the default completeJob path deletes immediately) */
  parkedSteers: (streamId: string) => `stream:{${streamId}}:parked`,
  /** Lost-ACK steer receipts (hash fields are clientSteerIds). */
  steerReceipts: (streamId: string) => `stream:{${streamId}}:steer-receipts`,
  steerReceiptOrder: (streamId: string) => `stream:{${streamId}}:steer-receipt-order`,
  /** Latest generation epoch, retained briefly beyond the live job hash. */
  generationEpoch: (streamId: string) => `stream:{${streamId}}:generation-epoch`,
  /** Expiring, generation-scoped subscriber-group leases. */
  subscriberLeases: (streamId: string, createdAt: number) =>
    `stream:{${streamId}}:subscriber-leases:${createdAt}`,
  /** Running jobs set for cleanup (global set - single slot) */
  runningJobs: 'stream:running',
  /** Jobs paused for human review (global set - single slot) */
  requiresActionJobs: 'stream:requires_action',
  /** Terminal jobs that still owe a durable host lifecycle hook (global set). Retains
   *  the aborted approval-expiry job for cross-replica / post-restart hook retry. */
  terminalHostActionJobs: 'stream:terminal_host_action',
  /** Versioned recovery lane for detached Event Actor completion generations.
   * Pre-detached replicas only scan `terminalHostActionJobs`, so they cannot
   * claim a generation whose host hook requires both invocation identities. */
  detachedAgentEventTerminalHostActionJobsV1: 'stream:agent_event_detached:terminal_host_action:v1',
  /** User's active jobs set, tenant-qualified when tenantId is available */
  userJobs: (userId: string, tenantId?: string) =>
    tenantId ? `stream:user:{${tenantId}:${userId}}:jobs` : `stream:user:{${userId}}:jobs`,
  /** Idempotency claim for a start-generation request: stream:idem:{userId:clientRequestId} */
  idempotency: (key: string) => `stream:idem:${key}`,
};

/** Pre-detached creation scripts reject an unknown status before replacement,
 * while capable readers project the private logical terminal status. */
const DETACHED_TERMINAL_LEGACY_STATUS = 'detached_terminal_pending_v1';

interface TerminalHostActionMember {
  streamId: string;
  createdAt?: number;
}

/** The retry index is global (and therefore outside the per-stream Redis
 * Cluster slot), so its members must carry generation identity. Otherwise an
 * acknowledgement for generation A can remove generation B's pre-armed hint. */
function terminalHostActionMember(streamId: string, createdAt: number): string {
  return JSON.stringify([streamId, createdAt]);
}

function isDetachedAgentEventCompletionJob(job: SerializableJobData): boolean {
  // The invocation key alone is enough to make legacy recovery unsafe. Keep a
  // malformed completion with a missing generation timestamp in the capable
  // lane so it fails closed there instead of exposing it to an old consumer.
  return job.agentEventInvocationKey != null;
}

function parseTerminalHostActionMember(member: string): TerminalHostActionMember {
  try {
    const parsed = JSON.parse(member) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'number' &&
      Number.isSafeInteger(parsed[1]) &&
      parsed[1] >= 0
    ) {
      return { streamId: parsed[0], createdAt: parsed[1] };
    }
  } catch {
    // Older releases indexed the bare stream id. Enumeration migrates any
    // still-live legacy member to the generation-scoped representation.
  }
  return { streamId: member };
}

/**
 * Default TTL values in seconds.
 * Can be overridden via constructor options.
 */
const DEFAULT_TTL = {
  /** TTL for completed jobs (5 minutes) */
  completed: 300,
  /** TTL for running jobs/chunks (20 minutes - failsafe for crashed jobs) */
  running: 1200,
  /** TTL for chunks after completion (0 = delete immediately) */
  chunksAfterComplete: 0,
  /** TTL for run steps after completion (0 = delete immediately) */
  runStepsAfterComplete: 0,
  /** Safety-net TTL for per-user job tracking sets (24 hours). Refreshed on each createJob. */
  userJobsSet: 86400,
  /**
   * Backstop TTL for a job paused for human review (24 hours). A paused job is
   * NOT a hung generation, so it must not inherit the 20-minute running TTL —
   * an approval with no explicit `expiresAt` is "live" per the API contract and
   * would otherwise be evicted mid-window. A pendingAction with a longer
   * `expiresAt` extends beyond this (see pauseTtlSeconds).
   */
  requiresAction: 86400,
};

/**
 * Redis implementation of IJobStoreV2.
 * Enables horizontal scaling with multi-instance deployments.
 *
 * Storage strategy:
 * - Job metadata: Redis Hash (fast field access)
 * - Chunks: Redis Streams (append-only, efficient for streaming)
 * - Run steps: Redis String (JSON serialized)
 *
 * Note: streamId === conversationId, so getJob(conversationId) works directly.
 *
 * @example
 * ```ts
 * import { ioredisClient } from '~/cache';
 * const store = new RedisJobStore(ioredisClient);
 * await store.initialize();
 * ```
 */
/**
 * Configuration options for RedisJobStore
 */
export interface RedisJobStoreOptions {
  /** TTL for completed jobs in seconds (default: 300 = 5 minutes) */
  completedTtl?: number;
  /** TTL for running jobs/chunks in seconds (default: 1200 = 20 minutes) */
  runningTtl?: number;
  /** TTL for chunks after completion in seconds (default: 0 = delete immediately) */
  chunksAfterCompleteTtl?: number;
  /** TTL for run steps after completion in seconds (default: 0 = delete immediately) */
  runStepsAfterCompleteTtl?: number;
  /** TTL for per-user job tracking sets in seconds (default: 86400 = 24 hours). 0 = no TTL. */
  userJobsSetTtl?: number;
  /** Backstop TTL for a paused (requires_action) job in seconds (default: 86400 = 24 hours). */
  requiresActionTtl?: number;
}

interface LocalCacheEntry<T> {
  createdAt?: number;
  value: T;
}

/**
 * Coalescable durable appends buffered for one stream. Events are
 * pre-serialized at enqueue; a flush XADDs them in order under one guard pass.
 * The whole batch shares one fate, so every resolver settles identically.
 */
interface PendingChunkAppendBatch {
  expectedCreatedAt?: number;
  events: string[];
  settlers: Array<{
    resolve: (appended: boolean) => void;
    reject: (err: unknown) => void;
  }>;
  bytes: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export class RedisJobStore implements IJobStoreV2 {
  readonly detachedAgentEventActionStoreMode = 'distributed' as const;

  private redis: Redis | Cluster;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private cleanupMembershipReady?: Promise<void>;
  private ttl: typeof DEFAULT_TTL;
  /** Coalescable chunk appends awaiting their window flush, per stream */
  private pendingAppends = new Map<string, PendingChunkAppendBatch>();
  /** Durable-append coalescing window; 0 keeps every append on the per-event path */
  private readonly coalesceWindowMs: number;

  /** Whether Redis client is in cluster mode (affects pipeline usage) */
  private isCluster: boolean;

  /**
   * Local cache for graph references on THIS instance.
   * Enables fast reconnects when client returns to the same server.
   * Uses WeakRef to allow garbage collection when graph is no longer needed.
   */
  private localGraphCache = new Map<string, LocalCacheEntry<WeakRef<StandardGraph>>>();

  /**
   * Local cache for collectedUsage arrays.
   * Generation happens on a single instance, so collectedUsage is only available locally.
   * For cross-replica abort, the abort handler falls back to text-based token counting.
   */
  private localCollectedUsageCache = new Map<string, LocalCacheEntry<UsageMetadata[]>>();
  /** Same-instance HOST content view (includes host-authored parts like
   *  steers, which the SDK graph never sees). Preferred over the graph cache
   *  on local reads; cross-instance reads reconstruct from chunks. */
  private localContentParts = new Map<
    string,
    LocalCacheEntry<WeakRef<Agents.MessageContentComplex[]>>
  >();

  /** Cleanup interval in ms (1 minute) */
  private cleanupIntervalMs = 60000;

  constructor(redis: Redis | Cluster, options?: RedisJobStoreOptions) {
    this.redis = instrumentIORedisClient(redis, RedisUseCases.GENERATION_STREAM);
    this.coalesceWindowMs = resolveCoalesceWindowMs();
    this.ttl = {
      completed: options?.completedTtl ?? DEFAULT_TTL.completed,
      running: options?.runningTtl ?? DEFAULT_TTL.running,
      chunksAfterComplete: options?.chunksAfterCompleteTtl ?? DEFAULT_TTL.chunksAfterComplete,
      runStepsAfterComplete: options?.runStepsAfterCompleteTtl ?? DEFAULT_TTL.runStepsAfterComplete,
      userJobsSet: options?.userJobsSetTtl ?? DEFAULT_TTL.userJobsSet,
      requiresAction: options?.requiresActionTtl ?? DEFAULT_TTL.requiresAction,
    };
    // Detect cluster mode using ioredis's isCluster property
    this.isCluster = (redis as Cluster).isCluster === true;
  }

  async initialize(): Promise<void> {
    if (this.cleanupInterval) {
      return;
    }

    // Start periodic cleanup
    this.cleanupInterval = setInterval(() => {
      this.cleanup().catch((err) => {
        logger.error('[RedisJobStore] Cleanup error:', err);
      });
    }, this.cleanupIntervalMs);

    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }

    void this.ensureCleanupMembership().catch((err) => {
      logger.error('[RedisJobStore] Owner cleanup membership recovery failed:', err);
    });
    logger.info('[RedisJobStore] Initialized with cleanup interval');
  }

  private getLocalEntry<T>(
    cache: Map<string, LocalCacheEntry<T>>,
    streamId: string,
    expectedCreatedAt?: number,
  ): LocalCacheEntry<T> | undefined {
    const entry = cache.get(streamId);
    if (expectedCreatedAt != null && entry?.createdAt !== expectedCreatedAt) {
      return undefined;
    }
    return entry;
  }

  private setLocalEntry<T>(
    cache: Map<string, LocalCacheEntry<T>>,
    streamId: string,
    entry: LocalCacheEntry<T>,
  ): void {
    const currentEntry = cache.get(streamId);
    if (
      currentEntry?.createdAt != null &&
      (entry.createdAt == null || entry.createdAt < currentEntry.createdAt)
    ) {
      return;
    }
    cache.set(streamId, entry);
  }

  private deleteLocalEntry<T>(
    cache: Map<string, LocalCacheEntry<T>>,
    streamId: string,
    expectedCreatedAt?: number,
    observedEntry?: LocalCacheEntry<T>,
  ): void {
    const entry = cache.get(streamId);
    if (
      !entry ||
      (observedEntry != null && entry !== observedEntry) ||
      (expectedCreatedAt != null && entry.createdAt !== expectedCreatedAt)
    ) {
      return;
    }
    cache.delete(streamId);
  }

  private clearLocalState(streamId: string, expectedCreatedAt?: number): void {
    this.deleteLocalEntry(this.localGraphCache, streamId, expectedCreatedAt);
    this.deleteLocalEntry(this.localContentParts, streamId, expectedCreatedAt);
    this.deleteLocalEntry(this.localCollectedUsageCache, streamId, expectedCreatedAt);
  }

  private clearPredecessorLocalState(streamId: string, createdAt: number): void {
    const graphEntry = this.localGraphCache.get(streamId);
    if (graphEntry && (graphEntry.createdAt == null || graphEntry.createdAt < createdAt)) {
      this.deleteLocalEntry(this.localGraphCache, streamId, undefined, graphEntry);
    }
    const contentEntry = this.localContentParts.get(streamId);
    if (contentEntry && (contentEntry.createdAt == null || contentEntry.createdAt < createdAt)) {
      this.deleteLocalEntry(this.localContentParts, streamId, undefined, contentEntry);
    }
    const usageEntry = this.localCollectedUsageCache.get(streamId);
    if (usageEntry && (usageEntry.createdAt == null || usageEntry.createdAt < createdAt)) {
      this.deleteLocalEntry(this.localCollectedUsageCache, streamId, undefined, usageEntry);
    }
  }

  async createJob(
    streamId: string,
    userId: string,
    conversationId?: string,
    tenantId?: string,
    initialMetadata: JobMetadataPatch = {},
    recoveredSteerId?: string,
    idempotencyClaimKey?: string,
    idempotencyClaimToken?: string,
    idempotencyClientRequestId?: string,
    recoveredSteerPayload?: RecoveredSteerPayload,
    creationAttemptId?: string,
    expectedPredecessorCreatedAt?: number,
    rejectActivePredecessor?: boolean,
  ): Promise<CreatedJobData> {
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new Error('Generation job requires a non-empty user id');
    }
    assertCreateIdempotencyArguments(
      idempotencyClaimKey,
      idempotencyClaimToken,
      idempotencyClientRequestId,
    );
    if (
      creationAttemptId != null &&
      (creationAttemptId.length === 0 || creationAttemptId.length > 128)
    ) {
      throw new Error('Invalid generation creation attempt id');
    }
    if (
      expectedPredecessorCreatedAt != null &&
      (!Number.isSafeInteger(expectedPredecessorCreatedAt) || expectedPredecessorCreatedAt < 0)
    ) {
      throw new Error('Invalid expected generation predecessor');
    }
    if (rejectActivePredecessor != null && typeof rejectActivePredecessor !== 'boolean') {
      throw new Error('Invalid active generation predecessor policy');
    }
    const providerExecutionId = initialMetadata.providerExecutionId;
    if (
      providerExecutionId != null &&
      (providerExecutionId.length === 0 || providerExecutionId.length > 128)
    ) {
      throw new Error('Invalid provider execution id');
    }
    const safeInitialMetadata = { ...initialMetadata };
    delete safeInitialMetadata.providerDrained;
    let generationProtocolVersion: 1 | 2 = 2;
    if (
      initialMetadata.generationProtocolVersion === 1 ||
      initialMetadata.generationProtocolVersion === 2
    ) {
      generationProtocolVersion = initialMetadata.generationProtocolVersion;
    }
    const job: CreatedJobData = {
      ...safeInitialMetadata,
      streamId,
      userId,
      ...(tenantId && { tenantId }),
      status: 'running',
      createdAt: Date.now(),
      generationProtocolVersion,
      ...(generationProtocolVersion === 2 && {
        checkpointNamespace: createCheckpointNamespace(userId, tenantId),
      }),
      ...(conversationId !== undefined && { conversationId }),
      ...(idempotencyClientRequestId !== undefined && {
        idempotencyClientRequestId,
      }),
      ...(recoveredSteerId !== undefined && { recoveredSteerId }),
      providerAbortReady: false,
      ...(providerExecutionId != null && { providerDrained: true }),
      syncSent: false,
    };
    if (creationAttemptId != null) {
      Object.defineProperty(job, 'creationAttemptId', {
        value: creationAttemptId,
        enumerable: false,
        configurable: true,
      });
    }

    const key = KEYS.job(streamId);

    // For cluster mode, we can't pipeline keys on different slots
    // The job key uses hash tag {streamId}, runningJobs and userJobs are on different slots
    // Generation-state reset + job-hash write happen ATOMICALLY (same-slot Lua).
    const hsetPairs = Object.entries(this.serializeJob(job)).flat();
    const parkedTtl = this.parkedRecoveryTtlSeconds();
    /** A leased source is hidden while this job is active. Keep it for one
     * normal recovery window beyond the live job's storage horizon so delayed
     * cleanup or natural job expiry cannot make both keys disappear together. */
    const createParkedTtl =
      recoveredSteerId != null ? this.runningStorageTtlSeconds() + parkedTtl : parkedTtl;
    const previousOwner = await this.redis.eval(
      JOB_CREATE_LUA,
      10,
      key,
      KEYS.chunks(streamId),
      KEYS.runSteps(streamId),
      KEYS.steers(streamId),
      KEYS.claimedSteers(streamId),
      KEYS.parkedSteers(streamId),
      KEYS.generationEpoch(streamId),
      KEYS.steerReceipts(streamId),
      KEYS.steerReceiptOrder(streamId),
      idempotencyClaimKey != null ? KEYS.idempotency(idempotencyClaimKey) : key,
      String(this.runningStorageTtlSeconds()),
      String(job.createdAt),
      String(GENERATION_EPOCH_GRACE_TTL_S),
      String(createParkedTtl),
      recoveredSteerId ?? '',
      userId,
      tenantId ?? '',
      idempotencyClaimToken ?? '',
      recoveredSteerPayload == null ? '' : JSON.stringify(recoveredSteerPayload),
      String(job.generationProtocolVersion),
      creationAttemptId ?? '',
      expectedPredecessorCreatedAt == null ? '' : String(expectedPredecessorCreatedAt),
      rejectActivePredecessor === true ? '1' : '0',
      ...hsetPairs,
    );
    if (Array.isArray(previousOwner) && previousOwner[3] === 'claim_lost') {
      throw new Error('Generation idempotency claim was taken over before job creation');
    }
    if (Array.isArray(previousOwner) && previousOwner[3] === 'owner_mismatch') {
      throw recoveredSteerId != null
        ? new RecoveredSteerPayloadMismatchError('owner_mismatch')
        : new Error('Generation job owner mismatch');
    }
    if (Array.isArray(previousOwner) && previousOwner[3] === 'recovery_corrupt') {
      throw new Error('Generation recovery state is corrupt');
    }
    if (Array.isArray(previousOwner)) {
      switch (previousOwner[3]) {
        case 'recovery_source_missing':
          throw new RecoveredSteerPayloadMismatchError('source_missing');
        case 'recovery_protocol_mismatch':
          throw new RecoveredSteerPayloadMismatchError('protocol_mismatch');
        case 'recovery_owner_mismatch':
          throw new RecoveredSteerPayloadMismatchError('owner_mismatch');
        case 'recovery_invalid_payload':
          throw new RecoveredSteerPayloadMismatchError('invalid_payload');
        case 'recovery_payload_mismatch':
          throw new RecoveredSteerPayloadMismatchError();
      }
    }
    if (Array.isArray(previousOwner) && previousOwner[3] === 'replacement_receipt_corrupt') {
      throw new Error('Generation replacement receipt is corrupt');
    }
    if (Array.isArray(previousOwner) && previousOwner[3] === 'generation_epoch_corrupt') {
      throw new Error('Generation epoch is corrupt');
    }
    if (Array.isArray(previousOwner) && previousOwner[3] === 'generation_epoch_exhausted') {
      throw new Error('Generation epoch is exhausted');
    }
    if (Array.isArray(previousOwner) && previousOwner[3] === 'replacement_chain_full') {
      throw new Error('Generation replacement receipt chain is full');
    }
    if (Array.isArray(previousOwner) && previousOwner[3] === 'predecessor_mismatch') {
      const currentCreatedAt = Number(previousOwner[4]);
      const currentStatus =
        typeof previousOwner[5] === 'string' && previousOwner[5] !== ''
          ? (previousOwner[5] as JobStatus)
          : undefined;
      const currentConversationId =
        typeof previousOwner[6] === 'string' && previousOwner[6] !== ''
          ? previousOwner[6]
          : undefined;
      throw new JobPredecessorMismatchError({
        createdAt: currentCreatedAt,
        active:
          previousOwner[7] === '1' ||
          currentStatus === 'running' ||
          currentStatus === 'requires_action',
        verified: previousOwner[8] !== '0',
        ...(currentStatus !== undefined && { status: currentStatus }),
        ...(currentConversationId !== undefined && {
          conversationId: currentConversationId,
        }),
      });
    }
    const previousUserId =
      Array.isArray(previousOwner) && typeof previousOwner[0] === 'string' ? previousOwner[0] : '';
    const previousTenantId =
      Array.isArray(previousOwner) && typeof previousOwner[1] === 'string' ? previousOwner[1] : '';
    const createdAt =
      Array.isArray(previousOwner) &&
      (typeof previousOwner[2] === 'string' || typeof previousOwner[2] === 'number')
        ? Number(previousOwner[2])
        : job.createdAt;
    job.createdAt = Number.isFinite(createdAt) ? createdAt : job.createdAt;
    const replacedCreatedAt =
      Array.isArray(previousOwner) &&
      (typeof previousOwner[4] === 'string' || typeof previousOwner[4] === 'number') &&
      String(previousOwner[4]) !== ''
        ? Number(previousOwner[4])
        : undefined;
    const replacedStatus =
      Array.isArray(previousOwner) && typeof previousOwner[5] === 'string'
        ? (previousOwner[5] as JobStatus)
        : undefined;
    const replacedConversationId =
      Array.isArray(previousOwner) &&
      typeof previousOwner[6] === 'string' &&
      previousOwner[6] !== ''
        ? previousOwner[6]
        : undefined;
    const replacedProviderAbortReady =
      Array.isArray(previousOwner) &&
      typeof previousOwner[7] === 'string' &&
      previousOwner[7] !== ''
        ? previousOwner[7] === '1'
        : undefined;
    const replacedProviderExecutionId =
      Array.isArray(previousOwner) &&
      typeof previousOwner[8] === 'string' &&
      previousOwner[8] !== ''
        ? previousOwner[8]
        : undefined;
    const replacedProviderDrained =
      Array.isArray(previousOwner) &&
      typeof previousOwner[9] === 'string' &&
      previousOwner[9] !== ''
        ? previousOwner[9] === '1'
        : undefined;
    const replacedJob =
      replacedCreatedAt != null && Number.isFinite(replacedCreatedAt) && replacedStatus != null
        ? {
            createdAt: replacedCreatedAt,
            status: replacedStatus,
            ...(replacedConversationId !== undefined && {
              conversationId: replacedConversationId,
            }),
          }
        : undefined;
    if (replacedJob != null && replacedProviderAbortReady != null) {
      Object.defineProperty(replacedJob, 'providerAbortReady', {
        value: replacedProviderAbortReady,
        enumerable: false,
      });
    }
    if (replacedJob != null && replacedProviderExecutionId != null) {
      Object.defineProperties(replacedJob, {
        providerExecutionId: {
          value: replacedProviderExecutionId,
          enumerable: false,
        },
        providerDrained: {
          value: replacedProviderDrained,
          enumerable: false,
        },
      });
    }
    const previousUserKeys =
      previousUserId !== ''
        ? [KEYS.userJobs(previousUserId, previousTenantId || undefined)]
        : undefined;
    // Cross-slot membership cannot join the creation Lua transaction. Reconcile
    // from the durable hash and verify after writing so an overlapping status
    // transition or same-stream replacement always gets the final word.
    const currentJob = await this.reconcileJobMembership(streamId, {
      initialJob: job,
      previousUserKeys,
    });
    if (
      currentJob !== undefined &&
      (!currentJob || currentJob.createdAt !== job.createdAt || currentJob.status !== 'running')
    ) {
      if (replacedJob != null) {
        Object.defineProperty(job, 'replacedJob', {
          value: replacedJob,
          enumerable: false,
        });
      }
      throw new JobCreationSupersededError(job);
    }
    if (currentJob === undefined) {
      if (replacedJob != null) {
        Object.defineProperty(job, 'replacedJob', {
          value: replacedJob,
          enumerable: false,
        });
      }
      // The same-slot create may already be durable, but exposing a provider
      // before cross-slot running/user membership is verified would strand an
      // untracked generation. The manager's attempt-id recovery probes the
      // durable job, repairs membership, and reconstructs the full predecessor
      // chain before deciding whether it is safe to proceed.
      throw new Error('Created job membership could not be verified');
    }
    this.clearPredecessorLocalState(streamId, currentJob.createdAt);

    if (replacedJob != null) {
      Object.defineProperty(currentJob, 'replacedJob', {
        value: replacedJob,
        enumerable: false,
      });
    }

    logger.debug(`[RedisJobStore] Created job: ${streamId}`);
    return currentJob;
  }

  async getJob(streamId: string): Promise<SerializableJobData | null> {
    const data = await this.redis.hgetall(KEYS.job(streamId));
    if (!data || Object.keys(data).length === 0) {
      return null;
    }
    return this.deserializeJob(data);
  }

  async acknowledgeReplacedJobs(
    streamId: string,
    creationAttemptId: string,
    replacedCreatedAts: readonly number[],
  ): Promise<boolean> {
    if (creationAttemptId.length === 0 || replacedCreatedAts.length === 0) {
      return false;
    }
    const acknowledged = await this.redis.eval(
      REPLACEMENT_RECEIPT_ACK_LUA,
      1,
      KEYS.job(streamId),
      creationAttemptId,
      ...replacedCreatedAts.map(String),
    );
    return acknowledged === 1;
  }

  async updateJob(
    streamId: string,
    updates: Partial<SerializableJobData>,
    expectedCreatedAt?: number,
  ): Promise<void> {
    const key = KEYS.job(streamId);
    const requestedTerminal =
      updates.status != null && ['complete', 'error', 'aborted'].includes(updates.status);
    if (requestedTerminal) {
      const observed = await this.getJob(streamId);
      if (
        observed != null &&
        (expectedCreatedAt == null || observed.createdAt === expectedCreatedAt) &&
        (observed.status === 'running' || observed.status === 'requires_action')
      ) {
        const { status, ...patch } = updates;
        await this.transitionStatus(streamId, {
          from: observed.status,
          to: status!,
          patch,
          expectCreatedAt: expectedCreatedAt ?? observed.createdAt,
        });
        return;
      }
    }

    // Plain field writer. The membership-aware status transitions
    // (running ⇄ requires_action — sets, TTLs, the actionId guard) go solely
    // through transitionStatus. The optional epoch guard keeps late metadata
    // and terminal-event persistence from mutating a same-stream replacement.
    const serialized = this.serializeJob(updates as SerializableJobData);
    if (Object.keys(serialized).length === 0) {
      return;
    }

    const terminal = requestedTerminal;
    const observedJob = terminal ? await this.getJob(streamId) : null;
    const completedTtl =
      updates.terminalPersistencePending === true ||
      observedJob?.terminalPersistencePending === true
        ? Math.max(this.ttl.completed, TERMINAL_PERSISTENCE_RETENTION_TTL_S)
        : this.ttl.completed;
    const fields = Object.entries(serialized).flat();
    const updated = await this.redis.eval(
      JOB_UPDATE_LUA,
      4,
      key,
      KEYS.chunks(streamId),
      KEYS.runSteps(streamId),
      KEYS.steers(streamId),
      expectedCreatedAt != null ? String(expectedCreatedAt) : '',
      terminal ? '1' : '0',
      String(completedTtl),
      String(this.ttl.chunksAfterComplete),
      String(this.ttl.runStepsAfterComplete),
      ...fields,
    );
    if (updated !== 1) {
      return;
    }

    if (terminal) {
      const currentJob = await this.reconcileJobMembership(streamId, {
        previousJob: observedJob,
      });
      this.clearLocalStateUnlessActive(
        streamId,
        currentJob,
        expectedCreatedAt ?? observedJob?.createdAt,
      );
    }
  }

  async settleEarlyBufferRecovery(
    streamId: string,
    expectedCreatedAt: number,
    overflowId: string,
    settlement: Pick<
      EarlyBufferOverflowState,
      'recoveryMethod' | 'recoveryOutcome' | 'recoveryCompletedAt' | 'recoveryFailureReason'
    >,
  ): Promise<boolean> {
    const settled = await this.redis.eval(
      SETTLE_EARLY_BUFFER_RECOVERY_LUA,
      1,
      KEYS.job(streamId),
      String(expectedCreatedAt),
      overflowId,
      JSON.stringify(settlement),
    );
    return settled === 1;
  }

  async finalizeEarlyBufferOverflow(
    streamId: string,
    expectedCreatedAt: number,
    overflowId: string,
    finalizedOverflow: EarlyBufferOverflowState,
  ): Promise<boolean> {
    const finalized = await this.redis.eval(
      FINALIZE_EARLY_BUFFER_OVERFLOW_LUA,
      1,
      KEYS.job(streamId),
      String(expectedCreatedAt),
      overflowId,
      JSON.stringify(finalizedOverflow),
    );
    return finalized === 1;
  }

  async hasSubscriberAttached(streamId: string, expectedCreatedAt: number): Promise<boolean> {
    return (
      Number(
        await this.redis.eval(
          HAS_SUBSCRIBER_ATTACHED_LUA,
          1,
          KEYS.job(streamId),
          String(expectedCreatedAt),
        ),
      ) === 1
    );
  }

  async claimFirstSubscriber(
    streamId: string,
    expectedCreatedAt: number,
    attachedAt: number,
    subscriberId: string,
    leaseExpiresAt: number,
  ): Promise<boolean> {
    return (
      Number(
        await this.redis.eval(
          CLAIM_FIRST_SUBSCRIBER_LUA,
          2,
          KEYS.job(streamId),
          KEYS.subscriberLeases(streamId, expectedCreatedAt),
          String(expectedCreatedAt),
          String(attachedAt),
          subscriberId,
          String(leaseExpiresAt),
        ),
      ) === 1
    );
  }

  async detachSubscriber(
    streamId: string,
    expectedCreatedAt: number,
    subscriberId: string,
  ): Promise<void> {
    await this.redis.eval(
      DETACH_SUBSCRIBER_LUA,
      2,
      KEYS.job(streamId),
      KEYS.subscriberLeases(streamId, expectedCreatedAt),
      String(expectedCreatedAt),
      subscriberId,
    );
  }

  async hasActiveSubscriber(
    streamId: string,
    expectedCreatedAt: number,
    observedAt: number,
  ): Promise<boolean> {
    return (
      Number(
        await this.redis.eval(
          HAS_ACTIVE_SUBSCRIBER_LUA,
          2,
          KEYS.job(streamId),
          KEYS.subscriberLeases(streamId, expectedCreatedAt),
          String(expectedCreatedAt),
          String(observedAt),
        ),
      ) === 1
    );
  }

  async markProviderExecutionDrained(
    streamId: string,
    expectedCreatedAt: number,
    providerExecutionId: string,
  ): Promise<boolean> {
    return (
      Number(
        await this.redis.eval(
          PROVIDER_DRAIN_LUA,
          1,
          KEYS.job(streamId),
          String(expectedCreatedAt),
          providerExecutionId,
        ),
      ) === 1
    );
  }

  async beginProviderExecution(
    streamId: string,
    expectedCreatedAt: number,
    providerExecutionId: string,
  ): Promise<boolean> {
    return (
      Number(
        await this.redis.eval(
          PROVIDER_BEGIN_LUA,
          1,
          KEYS.job(streamId),
          String(expectedCreatedAt),
          providerExecutionId,
        ),
      ) === 1
    );
  }

  async finalizeTerminalPersistence(
    streamId: string,
    expectedCreatedAt: number,
    finalEvent: string,
  ): Promise<boolean> {
    return (
      Number(
        await this.redis.eval(
          TERMINAL_PERSISTENCE_FINALIZE_LUA,
          1,
          KEYS.job(streamId),
          String(expectedCreatedAt),
          finalEvent,
        ),
      ) === 1
    );
  }

  private sameMembershipSource(
    left: SerializableJobData | null,
    right: SerializableJobData | null,
  ): boolean {
    if (left == null || right == null) {
      return left === right;
    }
    return (
      left.createdAt === right.createdAt &&
      left.status === right.status &&
      left.userId === right.userId &&
      left.tenantId === right.tenantId &&
      left.providerDrained === right.providerDrained &&
      left.terminalPersistencePending === right.terminalPersistencePending &&
      left.terminalHostActionPending === right.terminalHostActionPending
    );
  }

  private addObservedUserKey(keys: Set<string>, job: SerializableJobData | null): void {
    if (job?.userId) {
      keys.add(KEYS.userJobs(job.userId, job.tenantId));
    }
  }

  private ownerMembershipTtl(job: SerializableJobData | null): number {
    if (this.ttl.userJobsSet <= 0) return this.ttl.userJobsSet;
    return Math.max(
      this.ttl.userJobsSet,
      job?.status === 'requires_action' ? this.pauseTtlSeconds(job.pendingAction) : 0,
      job?.terminalHostActionPending ? Math.max(this.ttl.completed, this.ttl.requiresAction) : 0,
      job?.terminalPersistencePending
        ? Math.max(this.ttl.completed, TERMINAL_PERSISTENCE_RETENTION_TTL_S)
        : 0,
    );
  }

  private async retainCleanupOwner(job: SerializableJobData): Promise<void> {
    await this.redis.eval(
      OWNER_MEMBERSHIP_RECONCILE_LUA,
      1,
      KEYS.userJobs(job.userId, job.tenantId),
      job.streamId,
      String(this.ownerMembershipTtl(job)),
    );
  }

  /** Recover retained work from older stores once; owner requests await recovery. */
  private ensureCleanupMembership(): Promise<void> {
    if (this.cleanupMembershipReady == null) {
      this.cleanupMembershipReady = Promise.allSettled([
        this.getTerminalHostActionJobs(),
        this.getDetachedAgentEventTerminalHostActionJobs(),
      ])
        .then((results) => {
          const failure = results.find((result) => result.status === 'rejected');
          if (failure?.status === 'rejected') throw failure.reason;
        })
        .catch((err) => {
          this.cleanupMembershipReady = undefined;
          throw err;
        });
    }
    return this.cleanupMembershipReady;
  }

  private async applyMembershipSnapshot(
    streamId: string,
    job: SerializableJobData | null,
    observedUserKeys: Set<string>,
  ): Promise<SerializableJobData | null> {
    const statusKey = job ? this.statusSetKey(job.status) : null;
    const activeUserKey =
      job &&
      (statusKey != null ||
        job.providerDrained === false ||
        job.terminalPersistencePending === true ||
        job.terminalHostActionPending === true)
        ? KEYS.userJobs(job.userId, job.tenantId)
        : null;
    const ownerMembershipTtl = this.ownerMembershipTtl(job);
    const terminalMember = job == null ? null : terminalHostActionMember(streamId, job.createdAt);
    const terminalHostActionIndex =
      job != null && isDetachedAgentEventCompletionJob(job)
        ? KEYS.detachedAgentEventTerminalHostActionJobsV1
        : KEYS.terminalHostActionJobs;
    const otherTerminalHostActionIndex =
      terminalHostActionIndex === KEYS.terminalHostActionJobs
        ? KEYS.detachedAgentEventTerminalHostActionJobsV1
        : KEYS.terminalHostActionJobs;

    if (this.isCluster) {
      const operations: Promise<unknown>[] = [
        statusKey === KEYS.runningJobs
          ? this.redis.sadd(KEYS.runningJobs, streamId)
          : this.redis.srem(KEYS.runningJobs, streamId),
        statusKey === KEYS.requiresActionJobs
          ? this.redis.sadd(KEYS.requiresActionJobs, streamId)
          : this.redis.srem(KEYS.requiresActionJobs, streamId),
      ];
      if (job?.terminalHostActionPending === true) {
        operations.push(this.redis.sadd(terminalHostActionIndex, terminalMember!));
        operations.push(this.redis.srem(otherTerminalHostActionIndex, terminalMember!));
        if (terminalHostActionIndex !== KEYS.terminalHostActionJobs) {
          operations.push(this.redis.srem(KEYS.terminalHostActionJobs, streamId));
        }
      } else if (terminalMember == null) {
        operations.push(this.redis.srem(KEYS.terminalHostActionJobs, streamId));
        operations.push(this.redis.srem(KEYS.detachedAgentEventTerminalHostActionJobsV1, streamId));
      } else {
        operations.push(this.redis.srem(KEYS.terminalHostActionJobs, streamId, terminalMember));
        operations.push(
          this.redis.srem(
            KEYS.detachedAgentEventTerminalHostActionJobsV1,
            streamId,
            terminalMember,
          ),
        );
      }
      // Terminal host-action membership follows the durable hash field, not status, so
      // an aborted approval-expiry job stays enumerable for hook retry until acked.
      for (const userJobsKey of observedUserKeys) {
        if (userJobsKey !== activeUserKey) {
          operations.push(this.redis.srem(userJobsKey, streamId));
        }
      }
      if (activeUserKey) {
        operations.push(
          this.redis.eval(
            OWNER_MEMBERSHIP_RECONCILE_LUA,
            1,
            activeUserKey,
            streamId,
            String(ownerMembershipTtl),
          ),
        );
      }
      await Promise.all(operations);
      return this.getJob(streamId);
    }

    const pipeline = this.redis.pipeline();
    if (statusKey === KEYS.runningJobs) {
      pipeline.sadd(KEYS.runningJobs, streamId);
    } else {
      pipeline.srem(KEYS.runningJobs, streamId);
    }
    if (statusKey === KEYS.requiresActionJobs) {
      pipeline.sadd(KEYS.requiresActionJobs, streamId);
    } else {
      pipeline.srem(KEYS.requiresActionJobs, streamId);
    }
    if (job?.terminalHostActionPending === true) {
      pipeline.sadd(terminalHostActionIndex, terminalMember!);
      pipeline.srem(otherTerminalHostActionIndex, terminalMember!);
      pipeline.srem(KEYS.terminalHostActionJobs, streamId);
    } else if (terminalMember != null) {
      pipeline.srem(KEYS.terminalHostActionJobs, streamId, terminalMember);
      pipeline.srem(KEYS.detachedAgentEventTerminalHostActionJobsV1, streamId, terminalMember);
    } else {
      pipeline.srem(KEYS.terminalHostActionJobs, streamId);
      pipeline.srem(KEYS.detachedAgentEventTerminalHostActionJobsV1, streamId);
    }
    for (const userJobsKey of observedUserKeys) {
      if (userJobsKey !== activeUserKey) {
        pipeline.srem(userJobsKey, streamId);
      }
    }
    if (activeUserKey) {
      pipeline.eval(
        OWNER_MEMBERSHIP_RECONCILE_LUA,
        1,
        activeUserKey,
        streamId,
        String(ownerMembershipTtl),
      );
    }
    // Keep the verification read in this network flush. Redis executes it
    // after the membership commands, preserving the guarded loop without an
    // extra round trip on the default single-node deployment.
    pipeline.hgetall(KEYS.job(streamId));
    const results = await pipeline.exec();
    if (results == null) throw new Error('Owner membership pipeline did not execute');
    const failed = results.find(([err]) => err != null);
    if (failed?.[0]) throw failed[0];
    const verification = results?.[results.length - 1];
    if (verification?.[0]) {
      throw verification[0];
    }
    const data = verification?.[1] as Record<string, string> | null | undefined;
    if (!data || Object.keys(data).length === 0) {
      return null;
    }
    return this.deserializeJob(data);
  }

  /**
   * Cross-slot sets are derived state, so every mutation writes the membership
   * implied by the durable job hash and then reads the hash again. If a status
   * change or replacement crossed that window, the loop repairs from the newer
   * source. Because every writer uses this path, the final writer always
   * converges even when an older reconciliation finishes later.
   */
  private async reconcileJobMembership(
    streamId: string,
    options: {
      initialJob?: SerializableJobData | null;
      previousJob?: SerializableJobData | null;
      previousUserKeys?: string[];
    } = {},
  ): Promise<SerializableJobData | null | undefined> {
    const observedUserKeys = new Set(options.previousUserKeys ?? []);
    this.addObservedUserKey(observedUserKeys, options.previousJob ?? null);
    let currentJob = options.initialJob ?? null;
    try {
      if (options.initialJob === undefined) {
        currentJob = await this.getJob(streamId);
      }

      for (let attempt = 0; attempt < MEMBERSHIP_RECONCILE_MAX_ATTEMPTS; attempt++) {
        this.addObservedUserKey(observedUserKeys, currentJob);
        const verifiedJob = await this.applyMembershipSnapshot(
          streamId,
          currentJob,
          observedUserKeys,
        );
        this.addObservedUserKey(observedUserKeys, verifiedJob);
        if (this.sameMembershipSource(currentJob, verifiedJob)) {
          return verifiedJob;
        }
        currentJob = verifiedJob;
      }

      logger.warn(
        `[RedisJobStore] Membership reconciliation did not stabilize after ${MEMBERSHIP_RECONCILE_MAX_ATTEMPTS} attempts: ${streamId}`,
      );
    } catch (err) {
      logger.warn(`[RedisJobStore] Failed to reconcile job membership ${streamId}:`, err);
    }
    return undefined;
  }

  private clearLocalStateUnlessActive(
    streamId: string,
    currentJob: SerializableJobData | null | undefined,
    expectedCreatedAt?: number,
  ): void {
    if (currentJob === undefined) {
      return;
    }
    if (expectedCreatedAt == null && currentJob && this.statusSetKey(currentJob.status)) {
      return;
    }
    this.clearLocalState(streamId, expectedCreatedAt);
  }

  /**
   * Live-key TTL (seconds) for a paused job. A paused job isn't a hung
   * generation, so it uses the longer requires_action backstop rather than the
   * running TTL — otherwise a no-expiry approval (the buildPendingAction
   * default), which the API treats as "live", would be evicted after the 20m
   * running window. A pendingAction with an `expiresAt` farther out than the
   * backstop extends to cover it, plus a grace margin so a decision arriving
   * right at the deadline can still resume.
   */
  private pauseTtlSeconds(pendingAction?: Agents.PendingAction): number {
    const exp = pendingAction?.expiresAt;
    if (exp == null) {
      return this.ttl.requiresAction + GENERATION_EPOCH_GRACE_TTL_S;
    }
    const secondsUntilExpiry = Math.ceil((exp - Date.now()) / 1000) + 60;
    return Math.max(this.ttl.requiresAction, secondsUntilExpiry) + GENERATION_EPOCH_GRACE_TTL_S;
  }

  /** Same grace lets cleanup park accepted words before Redis expires the
   * live hash/list keys at the semantic stale cutoff. */
  private runningStorageTtlSeconds(): number {
    return this.ttl.running + GENERATION_EPOCH_GRACE_TTL_S;
  }

  private parkedRecoveryTtlSeconds(): number {
    return this.ttl.completed > 0 ? this.ttl.completed : PARKED_RECOVERY_TTL_S;
  }

  /** The membership set a status belongs to; terminal statuses have none. */
  private statusSetKey(status: JobStatus): string | null {
    if (status === 'running') {
      return KEYS.runningJobs;
    }
    if (status === 'requires_action') {
      return KEYS.requiresActionJobs;
    }
    return null;
  }

  async transitionStatus(streamId: string, args: JobStatusTransition): Promise<boolean> {
    return (await this.transitionStatusInternal(streamId, args, false)) === true;
  }

  async transitionStatusAndDrainSteers(
    streamId: string,
    args: JobStatusTransition,
  ): Promise<SteerQueueItem[] | null> {
    if (this.statusSetKey(args.to) !== null) {
      throw new Error('Steer-draining status transitions must be terminal');
    }
    const result = await this.transitionStatusInternal(streamId, args, true);
    return Array.isArray(result) ? result : null;
  }

  private async transitionStatusInternal(
    streamId: string,
    args: JobStatusTransition,
    returnDrainedSteers: boolean,
  ): Promise<true | SteerQueueItem[] | null> {
    const { from, to, patch, clear, expectActionId, expectCreatedAt, notAfterMs } = args;
    const key = KEYS.job(streamId);
    const terminal = this.statusSetKey(to) === null;
    const terminalJob = terminal ? await this.getJob(streamId) : null;
    const detachedTerminalHostActionPending =
      terminal &&
      patch?.terminalHostActionPending === true &&
      terminalJob != null &&
      isDetachedAgentEventCompletionJob(terminalJob);
    const persistedPatch = detachedTerminalHostActionPending
      ? {
          ...patch,
          status: DETACHED_TERMINAL_LEGACY_STATUS,
          terminalHostActionPending: undefined,
          detachedAgentEventTerminalHostActionPending: true,
          detachedAgentEventTerminalStatus: to as Extract<
            JobStatus,
            'complete' | 'aborted' | 'error'
          >,
        }
      : patch;

    // status + patch become HSET pairs; serializeJob skips undefined, so
    // cleared fields go through HDEL (`clear`) instead.
    const fields = Object.entries(
      this.serializeJob({
        status: to,
        ...(persistedPatch ?? {}),
      } as SerializableJobData),
    ).flat();
    const clearFields = (clear ?? []).map(String);

    let ttl = terminal ? this.ttl.completed : this.runningStorageTtlSeconds();
    if (terminal && patch?.terminalPersistencePending === true) {
      ttl = Math.max(ttl, TERMINAL_PERSISTENCE_RETENTION_TTL_S);
    }
    if (terminal && patch?.terminalHostActionPending === true) {
      // A terminal job owing a host hook must outlive the normal completed TTL so cleanup
      // can still enumerate and retry it across restarts; the pause backstop (24h) bounds
      // the retry window. Cleared to the completed TTL on acknowledgement.
      ttl = Math.max(ttl, this.ttl.requiresAction);
    }
    if (to === 'requires_action') {
      // A paused job must outlive its approval window, even when that window is
      // longer than the running TTL — otherwise Redis evicts it before a
      // decision can resume it.
      ttl = this.pauseTtlSeconds(patch?.pendingAction);
    }
    // Redis Cluster cannot atomically update the same-slot job hash and this
    // global retry index. Arm a generation-scoped retry hint before the
    // terminal CAS. A predecessor acknowledgement can remove only its own
    // member, regardless of how a successor's SADD and CAS interleave.
    const terminalMemberCreatedAt = expectCreatedAt ?? terminalJob?.createdAt;
    if (terminal && patch?.terminalHostActionPending === true && terminalMemberCreatedAt != null) {
      const terminalHostActionIndex =
        terminalJob != null && isDetachedAgentEventCompletionJob(terminalJob)
          ? KEYS.detachedAgentEventTerminalHostActionJobsV1
          : KEYS.terminalHostActionJobs;
      await this.redis.sadd(
        terminalHostActionIndex,
        terminalHostActionMember(streamId, terminalMemberCreatedAt),
      );
    }

    if (
      terminalJob != null &&
      (patch?.terminalHostActionPending === true || patch?.terminalPersistencePending === true)
    ) {
      await this.retainCleanupOwner({ ...terminalJob, ...patch, status: to });
    }

    // 1) Single-winner decision: an atomic CAS on the single-slot job hash.
    //    Works identically on cluster and single-node, so two concurrent
    //    resolves can never both win (and drive the run twice).
    const result = await this.redis.eval(
      JOB_CAS_LUA,
      10,
      key,
      KEYS.sequence(streamId),
      KEYS.chunks(streamId),
      KEYS.runSteps(streamId),
      KEYS.steers(streamId),
      KEYS.claimedSteers(streamId),
      KEYS.parkedSteers(streamId),
      KEYS.generationEpoch(streamId),
      KEYS.steerReceipts(streamId),
      KEYS.steerReceiptOrder(streamId),
      from,
      expectActionId ?? '',
      expectCreatedAt != null ? String(expectCreatedAt) : '',
      notAfterMs != null ? String(notAfterMs) : '',
      String(ttl),
      terminal ? '1' : '0',
      String(
        terminal && patch?.terminalHostActionPending === true ? ttl : this.ttl.chunksAfterComplete,
      ),
      String(
        terminal && patch?.terminalHostActionPending === true
          ? ttl
          : this.ttl.runStepsAfterComplete,
      ),
      String(this.parkedRecoveryTtlSeconds()),
      String(GENERATION_EPOCH_GRACE_TTL_S),
      String(args.steerReceiptTtlSeconds ?? 0),
      returnDrainedSteers ? '1' : '0',
      String(clearFields.length),
      ...clearFields,
      ...fields,
    );
    if (result === -1 && notAfterMs != null) {
      throw new JobStatusTransitionDeadlineError(notAfterMs);
    }
    if (returnDrainedSteers ? typeof result !== 'string' : result !== 1) {
      return null;
    }

    // 2) Same-slot TTL/content changes happened atomically in the CAS. Cross-slot
    //    indexes are reconciled last and verified against the durable hash.
    const currentJob = await this.reconcileJobMembership(streamId, {
      previousJob: terminalJob,
    });
    if (terminal) {
      this.clearLocalStateUnlessActive(
        streamId,
        currentJob,
        expectCreatedAt ?? terminalJob?.createdAt,
      );
    }
    if (!returnDrainedSteers) {
      return true;
    }
    const drained = JSON.parse(result as string) as unknown;
    if (!Array.isArray(drained)) {
      throw new Error('Invalid terminal steer drain response');
    }
    return drained as SteerQueueItem[];
  }

  async claimIdempotencyKey(
    key: string,
    value: IdempotencyClaimValue,
    ttlSeconds: number,
  ): Promise<IdempotencyClaimResult> {
    // Contenders need one atomic winner, not dispatch-order fairness. Callers await
    // this claim before dependent writes, so a cache miss may safely delay it.
    const result = await evalScript(
      this.redis,
      IDEMPOTENCY_CLAIM_LUA,
      1,
      KEYS.idempotency(key),
      JSON.stringify(value),
      String(ttlSeconds * 1000),
    );
    if (result == null) {
      return { claimed: true, existing: value };
    }
    try {
      return {
        claimed: false,
        existing: JSON.parse(result as string) as IdempotencyClaimValue,
      };
    } catch {
      // An unreadable existing owner is outcome-ambiguous. Never turn store
      // corruption into a duplicate generation by pretending the key is free.
      throw new Error('Invalid generation idempotency claim');
    }
  }

  async hasIdempotencyKey(key: string): Promise<boolean> {
    return (await this.redis.exists(KEYS.idempotency(key))) === 1;
  }

  async getIdempotencyClaim(key: string): Promise<IdempotencyClaimValue | null> {
    const value = await this.redis.get(KEYS.idempotency(key));
    if (value == null) {
      return null;
    }
    try {
      return JSON.parse(value) as IdempotencyClaimValue;
    } catch {
      throw new Error('Invalid generation idempotency claim');
    }
  }

  async takeoverIdempotencyKey(
    key: string,
    expected: IdempotencyClaimValue,
    value: IdempotencyClaimValue,
    ttlSeconds: number,
  ): Promise<boolean> {
    const taken = await this.redis.eval(
      IDEMPOTENCY_TAKEOVER_LUA,
      1,
      KEYS.idempotency(key),
      expected.claimToken ?? '',
      JSON.stringify(value),
      String(ttlSeconds * 1000),
    );
    return taken === 1;
  }

  async markIdempotencyKeyStarted(
    key: string,
    claimToken: string,
    startedAt: number,
    ttlSeconds: number,
  ): Promise<boolean> {
    const marked = await this.redis.eval(
      IDEMPOTENCY_MARK_STARTED_LUA,
      1,
      KEYS.idempotency(key),
      claimToken,
      String(startedAt),
      String(ttlSeconds * 1000),
    );
    return marked === 1;
  }

  async adoptIdempotencyKeyForJob(
    key: string,
    expected: IdempotencyClaimValue,
    streamId: string,
    userId: string,
    clientRequestId: string,
    tenantId: string | undefined,
    expectedCreatedAt: number,
    ttlSeconds: number,
    allowMissingClientRequestId = false,
  ): Promise<boolean> {
    const adopted = await this.redis.eval(
      IDEMPOTENCY_ADOPT_LIVE_JOB_LUA,
      2,
      KEYS.idempotency(key),
      KEYS.job(streamId),
      expected.claimToken ?? '',
      String(expectedCreatedAt),
      userId,
      clientRequestId,
      tenantId ?? '',
      String(ttlSeconds * 1000),
      allowMissingClientRequestId ? '1' : '0',
    );
    return adopted === 1;
  }

  async releaseIdempotencyKey(key: string, expected?: IdempotencyClaimValue): Promise<void> {
    await this.redis.eval(
      IDEMPOTENCY_RELEASE_LUA,
      1,
      KEYS.idempotency(key),
      expected?.claimToken ?? '',
    );
  }

  async deleteJob(streamId: string, expectedCreatedAt?: number): Promise<boolean> {
    const observedJob = await this.getJob(streamId);
    const targetCreatedAt = expectedCreatedAt ?? observedJob?.createdAt;
    const expectMissing = expectedCreatedAt == null && observedJob == null;
    const deleted = await this.redis.eval(
      JOB_DELETE_LUA,
      5,
      KEYS.job(streamId),
      KEYS.chunks(streamId),
      KEYS.runSteps(streamId),
      KEYS.steers(streamId),
      KEYS.claimedSteers(streamId),
      targetCreatedAt != null ? String(targetCreatedAt) : '',
      expectMissing ? '1' : '0',
    );
    if (deleted !== 1) {
      return false;
    }

    const currentJob = await this.reconcileJobMembership(streamId, {
      initialJob: null,
      previousJob: observedJob,
    });
    this.clearLocalStateUnlessActive(streamId, currentJob, targetCreatedAt);
    logger.debug(`[RedisJobStore] Deleted job: ${streamId}`);
    return true;
  }

  private async deleteStaleRunningJob(
    streamId: string,
    observedJob: SerializableJobData,
    now: number,
  ): Promise<boolean> {
    const deleted = await this.redis.eval(
      STALE_JOB_DELETE_LUA,
      9,
      KEYS.job(streamId),
      KEYS.chunks(streamId),
      KEYS.runSteps(streamId),
      KEYS.steers(streamId),
      KEYS.claimedSteers(streamId),
      KEYS.parkedSteers(streamId),
      KEYS.generationEpoch(streamId),
      KEYS.steerReceipts(streamId),
      KEYS.steerReceiptOrder(streamId),
      String(observedJob.createdAt),
      String(now),
      String(this.ttl.running * 1000),
      String(this.ttl.completed > 0 ? this.ttl.completed : PARKED_RECOVERY_TTL_S),
      String(GENERATION_EPOCH_GRACE_TTL_S),
    );
    if (deleted !== 1) {
      return false;
    }

    const currentJob = await this.reconcileJobMembership(streamId, {
      initialJob: null,
      previousJob: observedJob,
    });
    this.clearLocalStateUnlessActive(streamId, currentJob, observedJob.createdAt);
    return true;
  }

  async hasJob(streamId: string): Promise<boolean> {
    const exists = await this.redis.exists(KEYS.job(streamId));
    return exists === 1;
  }

  async getRunningJobs(): Promise<SerializableJobData[]> {
    const streamIds = await this.redis.smembers(KEYS.runningJobs);
    if (streamIds.length === 0) {
      return [];
    }

    const jobs: SerializableJobData[] = [];
    for (const streamId of streamIds) {
      const job = await this.getJob(streamId);
      if (job && job.status === 'running') {
        jobs.push(job);
      }
    }
    return jobs;
  }

  async getRequiresActionJobs(): Promise<SerializableJobData[]> {
    const streamIds = await this.redis.smembers(KEYS.requiresActionJobs);
    if (streamIds.length === 0) {
      return [];
    }
    const jobs = await Promise.all(streamIds.map((streamId) => this.getJob(streamId)));
    return jobs.filter(
      (job): job is SerializableJobData => job != null && job.status === 'requires_action',
    );
  }

  async getTerminalHostActionJobs(): Promise<SerializableJobData[]> {
    return this.getIndexedTerminalHostActionJobs(KEYS.terminalHostActionJobs, false);
  }

  async getDetachedAgentEventTerminalHostActionJobs(): Promise<SerializableJobData[]> {
    return this.getIndexedTerminalHostActionJobs(
      KEYS.detachedAgentEventTerminalHostActionJobsV1,
      true,
    );
  }

  private async getIndexedTerminalHostActionJobs(
    indexKey: string,
    detachedAgentEventCompletion: boolean,
  ): Promise<SerializableJobData[]> {
    const members = await this.redis.smembers(indexKey);
    if (members.length === 0) {
      return [];
    }
    const indexed = members.map((member) => ({
      member,
      ...parseTerminalHostActionMember(member),
    }));
    const jobs = await Promise.all(indexed.map(({ streamId }) => this.getJob(streamId)));
    // The durable hash field is the source of truth; a stale set entry (job reaped, or the
    // marker/generation already replaced) is filtered out. Bare legacy members
    // are migrated while they are still live.
    const stale: string[] = [];
    const legacy: string[] = [];
    const migrate: string[] = [];
    const rerouteToLegacy: string[] = [];
    const rerouteToDetached: string[] = [];
    const heldByGeneration = new Map<string, SerializableJobData>();
    const ownersToRetain: SerializableJobData[] = [];
    const readyByGeneration = new Map<string, SerializableJobData>();
    const providerLossCutoff = Date.now() - PROVIDER_DRAIN_TIMEOUT_MS;
    for (let i = 0; i < indexed.length; i++) {
      const indexedMember = indexed[i];
      let job = jobs[i];
      if (
        job != null &&
        job.terminalHostActionPending === true &&
        (indexedMember.createdAt == null || indexedMember.createdAt === job.createdAt)
      ) {
        ownersToRetain.push(job);
        const jobIsDetachedCompletion = isDetachedAgentEventCompletionJob(job);
        if (jobIsDetachedCompletion !== detachedAgentEventCompletion) {
          const generationMember = terminalHostActionMember(job.streamId, job.createdAt);
          if (jobIsDetachedCompletion) {
            rerouteToDetached.push(generationMember);
          } else {
            rerouteToLegacy.push(generationMember);
          }
          stale.push(indexedMember.member);
          continue;
        }
        if (indexedMember.createdAt == null) {
          legacy.push(indexedMember.member);
          migrate.push(terminalHostActionMember(job.streamId, job.createdAt));
        }
        if (
          job.providerDrained === false &&
          job.completedAt != null &&
          job.completedAt <= providerLossCutoff
        ) {
          const recovered =
            Number(
              await this.redis.eval(
                RECOVER_TERMINAL_PROVIDER_DRAIN_LUA,
                1,
                KEYS.job(job.streamId),
                String(job.createdAt),
                String(providerLossCutoff),
              ),
            ) === 1;
          if (recovered) {
            job = { ...job, providerDrained: true };
          }
        }
        const generationKey = terminalHostActionMember(job.streamId, job.createdAt);
        heldByGeneration.set(generationKey, job);
        // A terminal provider can still be committing its last tool result.
        // The provider owner persists the complete run-step snapshot before it
        // flips this fence, so another replica must not settle earlier.
        if (job.providerDrained !== false) {
          readyByGeneration.set(generationKey, job);
        }
      } else if (
        job != null &&
        indexedMember.createdAt != null &&
        indexedMember.createdAt === job.createdAt
      ) {
        /** The terminal transition pre-arms this exact generation before its
         * hash CAS. Do not delete that hint merely because the CAS has not
         * become visible yet: the producer can commit and die before its
         * post-CAS reconciliation. The hint becomes removable once the exact
         * generation hash is replaced or reaped. */
        continue;
      } else {
        stale.push(indexedMember.member);
      }
    }
    await Promise.all(ownersToRetain.map((job) => this.retainCleanupOwner(job)));
    // Repair a hint written by an earlier capable build before removing it
    // from the wrong lane. In particular, this drains detached completions out
    // of the legacy set without ever returning them to a capable claimant.
    if (rerouteToLegacy.length > 0) {
      await this.redis.sadd(KEYS.terminalHostActionJobs, ...rerouteToLegacy);
    }
    if (rerouteToDetached.length > 0) {
      await this.redis.sadd(KEYS.detachedAgentEventTerminalHostActionJobsV1, ...rerouteToDetached);
    }
    if (migrate.length > 0) {
      try {
        await this.redis.sadd(indexKey, ...migrate);
        await this.redis.srem(indexKey, ...legacy);
      } catch {
        // Preserve the legacy hint if migration cannot prove the replacement
        // member was written. A duplicate hint is safer than lost discovery.
      }
    }
    if (stale.length > 0) {
      await this.redis.srem(indexKey, ...stale).catch(() => undefined);
    }
    // Enumerating IS the retry attempt: extend each pending job's TTL so unacknowledged
    // host-action evidence outlives a host dependency (e.g. Mongo) that stays unreachable
    // longer than the retention window. A deployment that stops sweeping lets it age out.
    const held = [...heldByGeneration.values()];
    if (held.length > 0 && this.ttl.requiresAction > 0) {
      await Promise.all(
        held.flatMap((job) =>
          [KEYS.job(job.streamId), KEYS.chunks(job.streamId), KEYS.runSteps(job.streamId)].map(
            (key) => this.redis.expire(key, this.ttl.requiresAction).catch(() => undefined),
          ),
        ),
      );
    }
    return [...readyByGeneration.values()];
  }

  async clearTerminalHostAction(streamId: string, expectedCreatedAt?: number): Promise<void> {
    const previousJob = await this.getJob(streamId);
    // Identity-fenced: only clear when the hash still holds this exact generation, so a
    // replacement at the same streamId is never cleared through its predecessor. The HDEL
    // and configured evidence-TTL reset happen atomically. The global retry
    // member includes this generation, so removing it cannot affect a successor.
    const cleared = (await this.redis.eval(
      'if redis.call("HGET", KEYS[1], "createdAt") ~= ARGV[1] then return 0 end ' +
        'local detachedStatus = redis.call("HGET", KEYS[1], "detachedAgentEventTerminalStatus") ' +
        'if detachedStatus then redis.call("HSET", KEYS[1], "status", detachedStatus) end ' +
        'redis.call("HDEL", KEYS[1], "terminalHostActionPending", "detachedAgentEventTerminalHostActionPending", "detachedAgentEventTerminalStatus") ' +
        'if detachedStatus then redis.call("HDEL", KEYS[1], "lastActiveAt") end ' +
        'if tonumber(ARGV[2]) > 0 then redis.call("EXPIRE", KEYS[1], ARGV[2]) else redis.call("DEL", KEYS[1]) end ' +
        'if tonumber(ARGV[3]) > 0 then redis.call("EXPIRE", KEYS[2], ARGV[3]) else redis.call("DEL", KEYS[2]) end ' +
        'if tonumber(ARGV[4]) > 0 then redis.call("EXPIRE", KEYS[3], ARGV[4]) else redis.call("DEL", KEYS[3]) end ' +
        'return 1',
      3,
      KEYS.job(streamId),
      KEYS.chunks(streamId),
      KEYS.runSteps(streamId),
      expectedCreatedAt != null ? String(expectedCreatedAt) : '',
      String(this.ttl.completed),
      String(this.ttl.chunksAfterComplete),
      String(this.ttl.runStepsAfterComplete),
    )) as number;
    if (cleared === 1 && expectedCreatedAt != null) {
      const member = terminalHostActionMember(streamId, expectedCreatedAt);
      await this.reconcileJobMembership(streamId, { previousJob });
      await Promise.all([
        this.redis.srem(KEYS.terminalHostActionJobs, member).catch(() => undefined),
        this.redis
          .srem(KEYS.detachedAgentEventTerminalHostActionJobsV1, member)
          .catch(() => undefined),
      ]);
    }
  }

  async cleanup(): Promise<number> {
    const now = Date.now();
    const streamIds = await this.redis.smembers(KEYS.runningJobs);
    let cleaned = 0;

    // Clean up stale local graph cache entries (WeakRefs that were collected)
    for (const [streamId, graphEntry] of this.localGraphCache) {
      if (!graphEntry.value.deref()) {
        this.deleteLocalEntry(this.localGraphCache, streamId, undefined, graphEntry);
      }
    }

    // Process in batches of 50 to avoid sequential per-job round-trips
    const BATCH_SIZE = 50;
    for (let i = 0; i < streamIds.length; i += BATCH_SIZE) {
      const batch = streamIds.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (streamId) => {
          const job = await this.getJob(streamId);

          // Job no longer exists (TTL expired) - remove from set
          if (!job) {
            const currentJob = await this.reconcileJobMembership(streamId, {
              initialJob: null,
            });
            this.clearLocalStateUnlessActive(streamId, currentJob);
            return 1;
          }

          if (job.status === 'requires_action') {
            const currentJob = await this.reconcileJobMembership(streamId, {
              initialJob: job,
            });
            if (
              currentJob !== undefined &&
              (!currentJob || currentJob.createdAt === job.createdAt)
            ) {
              this.clearLocalState(streamId, job.createdAt);
            }
            return 1;
          }

          // Job completed but still in running set (shouldn't happen, but handle it)
          // Only remove from tracking sets — do NOT delete the job hash, which has
          // its own completedTtl so clients can still poll for final status.
          if (job.status !== 'running') {
            const currentJob = await this.reconcileJobMembership(streamId, {
              initialJob: job,
              previousJob: job,
            });
            if (
              currentJob !== undefined &&
              (!currentJob || currentJob.createdAt === job.createdAt)
            ) {
              this.clearLocalStateUnlessActive(streamId, currentJob, job.createdAt);
            }
            return 1;
          }

          // Stale running job (failsafe - running for > configured TTL).
          // Keys off `lastActiveAt` when present so a just-resumed approval
          // isn't reaped on the basis of its original creation time.
          const liveSince = job.lastActiveAt ?? job.createdAt;
          if (now - liveSince > this.ttl.running * 1000) {
            logger.warn(`[RedisJobStore] Cleaning up stale job: ${streamId}`);
            // Re-check liveness + epoch, park queued steers, and delete same-slot
            // state in one script. A replacement cannot land in the old
            // park-then-unconditional-delete gap.
            return (await this.deleteStaleRunningJob(streamId, job, now)) ? 1 : 0;
          }

          return 0;
        }),
      );
      for (const result of results) {
        if (result.status === 'fulfilled') {
          cleaned += result.value;
        } else {
          logger.warn(`[RedisJobStore] Cleanup failed for a job:`, result.reason);
        }
      }
    }

    cleaned += await this.cleanupRequiresActionIndex();

    if (cleaned > 0) {
      logger.debug(`[RedisJobStore] Cleaned up ${cleaned} jobs`);
    }

    return cleaned;
  }

  private async cleanupRequiresActionIndex(): Promise<number> {
    const streamIds = await this.redis.smembers(KEYS.requiresActionJobs);
    let cleaned = 0;
    const now = Date.now();

    const BATCH_SIZE = 50;
    for (let i = 0; i < streamIds.length; i += BATCH_SIZE) {
      const batch = streamIds.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (streamId) => {
          const job = await this.getJob(streamId);

          if (!job) {
            const currentJob = await this.reconcileJobMembership(streamId, {
              initialJob: null,
            });
            this.clearLocalStateUnlessActive(streamId, currentJob);
            return 1;
          }

          if (job.status !== 'requires_action') {
            await this.reconcileJobMembership(streamId, {
              initialJob: job,
              previousJob: job,
            });
            return 1;
          }

          if (job.terminalPersistencePending === true) {
            const startedAt = job.terminalPersistenceStartedAt ?? job.createdAt;
            if (now - startedAt < PAUSE_PERSISTENCE_TIMEOUT_MS) {
              // The pause owner is still within its response-write lease.
              return 0;
            }

            if (job.pendingActionId == null) {
              logger.error(
                `[RedisJobStore] Refusing stale pause-persistence cleanup without an action fence: ${streamId}`,
              );
              return 0;
            }
            const failed = await this.transitionStatusAndDrainSteers(streamId, {
              from: 'requires_action',
              to: 'error',
              expectActionId: job.pendingActionId,
              expectCreatedAt: job.createdAt,
              patch: {
                completedAt: now,
                error: PAUSE_PERSISTENCE_TIMEOUT_ERROR,
                ...(job.agentEventDeliveryKey != null && {
                  terminalHostActionPending: true,
                }),
              },
              clear: [
                'pendingAction',
                'pendingActionId',
                'terminalPersistencePending',
                'terminalPersistenceStartedAt',
              ],
            });
            if (failed == null) {
              return 0;
            }
            logger.error(`[RedisJobStore] Pause persistence timed out: ${streamId}`);
            return 1;
          }

          // Stale approval (expired, or missing/malformed pendingAction):
          // finalize it (aborted) so it stops occupying the slot and its stream
          // contents are reclaimed, mirroring ApprovalLifecycle.expire().
          // transitionStatus atomically applies the terminal state and same-slot
          // content cleanup. Cross-slot membership indexes self-heal on read or
          // during the next cleanup pass.
          const exceededNoExpiryBackstop =
            job.pendingAction?.expiresAt == null &&
            now - (job.lastActiveAt ?? job.createdAt) > this.ttl.requiresAction * 1000;
          if (isPendingActionStale(job) || exceededNoExpiryBackstop) {
            const expired = await this.transitionStatus(streamId, {
              from: 'requires_action',
              to: 'aborted',
              clear: ['pendingAction', 'pendingActionId'],
              patch: {
                error: 'Approval expired before a decision was made',
                completedAt: Date.now(),
                // Store-won expiry: mark the host action pending (and extend retention via
                // the TTL rule above) so the manager relay still runs its lifecycle hook on
                // a replica that owns the runtime; cleared once that hook acknowledges.
                terminalHostActionPending: true,
              },
              // Scope the CAS to the action we observed as stale: if the user resolved it
              // and the run re-paused on a fresh action between the read and here, the
              // pendingActionId no longer matches and this no-ops instead of aborting the
              // valid new pause. (Undefined for a missing/malformed pendingAction — nothing
              // to protect — so it falls back to the status-only check.)
              expectActionId: job.pendingAction?.actionId,
              expectCreatedAt: job.createdAt,
            });
            return expired ? 1 : 0;
          }

          return 0;
        }),
      );

      for (const result of results) {
        if (result.status === 'fulfilled') {
          cleaned += result.value;
        } else {
          logger.warn(`[RedisJobStore] requires_action cleanup failed for a job:`, result.reason);
        }
      }
    }

    return cleaned;
  }

  async getJobCount(): Promise<number> {
    const [runningCount, requiresActionCount] = await Promise.all([
      this.countJobsInStatusSet(KEYS.runningJobs, 'running'),
      this.countJobsInStatusSet(KEYS.requiresActionJobs, 'requires_action'),
    ]);
    return runningCount + requiresActionCount;
  }

  async getJobCountByStatus(status: JobStatus): Promise<number> {
    if (status === 'running') {
      return this.countJobsInStatusSet(KEYS.runningJobs, status);
    }

    if (status === 'requires_action') {
      return this.countJobsInStatusSet(KEYS.requiresActionJobs, status);
    }

    return 0;
  }

  private async countJobsInStatusSet(setKey: string, status: JobStatus): Promise<number> {
    const streamIds = await this.redis.smembers(setKey);
    if (streamIds.length === 0) {
      return 0;
    }

    let count = 0;
    for (const streamId of streamIds) {
      const job = await this.getJob(streamId);
      if (job?.status === status) {
        count++;
      } else {
        const currentJob = await this.reconcileJobMembership(streamId, {
          initialJob: job,
          previousJob: job,
        });
        if (currentJob?.status === status) {
          count++;
        }
      }
    }

    return count;
  }

  /**
   * Get active job IDs for a user.
   * Returns conversation IDs of running jobs belonging to the user.
   * Also performs self-healing cleanup: removes stale entries for jobs that no longer exist.
   *
   * @param userId - The user ID to query
   * @returns Array of conversation IDs with active jobs
   */
  async getActiveJobIdsByUser(userId: string, tenantId?: string): Promise<string[]> {
    return this.getJobIdsByUser(userId, tenantId, false);
  }

  async getCleanupBlockingJobIdsByUser(userId: string, tenantId?: string): Promise<string[]> {
    return this.getJobIdsByUser(userId, tenantId, true);
  }

  async getCleanupJobIdsByUser(userId: string, tenantId?: string): Promise<string[]> {
    await this.ensureCleanupMembership();
    return this.getJobIdsByUser(userId, tenantId, true);
  }

  async getRetainedJobIdsByUser(userId: string, tenantId?: string): Promise<string[]> {
    const ownerKeys = tenantId
      ? [KEYS.userJobs(userId, tenantId), KEYS.userJobs(userId)]
      : [KEYS.userJobs(userId)];
    const tracked = await Promise.all(ownerKeys.map((key) => this.redis.smembers(key)));
    const streamIds = [...new Set(tracked.flat())];
    const jobs = await Promise.all(streamIds.map((streamId) => this.getJob(streamId)));
    return streamIds.filter((_, index) => {
      const job = jobs[index];
      return job?.userId === userId && (job.tenantId == null || job.tenantId === tenantId);
    });
  }

  private async getJobIdsByUser(
    userId: string,
    tenantId: string | undefined,
    includeUndrained: boolean,
  ): Promise<string[]> {
    const userJobsKey = KEYS.userJobs(userId, tenantId);
    const trackedIds = await this.redis.smembers(userJobsKey);

    if (trackedIds.length === 0) {
      return [];
    }

    const activeIds: string[] = [];
    let healed = 0;

    for (const streamId of trackedIds) {
      const job = await this.getJob(streamId);
      // Include running jobs and jobs paused for human review (e.g. tool approval).
      // A pending-approval job still occupies the user's conversation slot — but
      // only while its prompt is live: a past-`expiresAt` approval no longer
      // counts as active (cleanup/expiry will finalize it), so the client stops
      // polling and can complete.
      const belongsToUser =
        job?.userId === userId && (job.tenantId ?? undefined) === (tenantId ?? undefined);
      if (
        belongsToUser &&
        job &&
        (job.status === 'running' ||
          job.status === 'requires_action' ||
          (includeUndrained &&
            (job.providerDrained === false ||
              job.terminalPersistencePending === true ||
              job.terminalHostActionPending === true)))
      ) {
        if (
          job.status === 'requires_action' &&
          isPendingActionStale(job) &&
          !(
            includeUndrained &&
            (job.providerDrained === false ||
              job.terminalPersistencePending === true ||
              job.terminalHostActionPending === true)
          )
        ) {
          continue;
        }
        activeIds.push(streamId);
      } else {
        // Self-heal from durable state instead of a raw SREM, which could remove
        // a replacement's membership after the read.
        const currentJob = await this.reconcileJobMembership(streamId, {
          initialJob: job,
          previousJob: job,
          previousUserKeys: [userJobsKey],
        });
        if (includeUndrained && currentJob === undefined)
          throw new Error(`Cannot verify owner job membership: ${streamId}`);
        const currentBelongsToUser =
          currentJob?.userId === userId &&
          (currentJob.tenantId ?? undefined) === (tenantId ?? undefined);
        if (
          currentBelongsToUser &&
          currentJob &&
          (currentJob.status === 'running' ||
            currentJob.status === 'requires_action' ||
            (includeUndrained &&
              (currentJob.providerDrained === false ||
                currentJob.terminalPersistencePending === true ||
                currentJob.terminalHostActionPending === true))) &&
          !(
            currentJob.status === 'requires_action' &&
            isPendingActionStale(currentJob) &&
            !(
              includeUndrained &&
              (currentJob.providerDrained === false ||
                currentJob.terminalPersistencePending === true ||
                currentJob.terminalHostActionPending === true)
            )
          )
        ) {
          activeIds.push(streamId);
        }
        healed++;
      }
    }

    if (healed > 0) {
      logger.debug(`[RedisJobStore] Self-healed ${healed} stale job entries for user ${userId}`);
    }

    return activeIds;
  }

  async destroy(): Promise<void> {
    await this.cleanupMembershipReady?.catch(() => undefined);
    this.cleanupMembershipReady = undefined;
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    /** Shutdown terminals flushed per stream already; whatever remains did not
     * commit, and resolving false lets the owning fence continuations settle. */
    for (const [streamId, pending] of this.pendingAppends) {
      this.pendingAppends.delete(streamId);
      if (pending.timer != null) {
        clearTimeout(pending.timer);
        pending.timer = null;
      }
      for (const settler of pending.settlers) {
        settler.resolve(false);
      }
    }
    // Clear local caches
    this.localGraphCache.clear();
    this.localContentParts.clear();
    this.localCollectedUsageCache.clear();
    // Don't close the Redis connection - it's shared
    logger.info('[RedisJobStore] Destroyed');
  }

  // ===== Content State Methods =====
  // For Redis, content is primarily reconstructed from chunks.
  // However, we keep a LOCAL graph cache for fast same-instance reconnects.

  /**
   * Store graph reference in local cache.
   * This enables fast reconnects when client returns to the same instance.
   * Falls back to Redis chunk reconstruction for cross-instance reconnects.
   *
   * @param streamId - The stream identifier
   * @param graph - The graph instance (stored as WeakRef)
   */
  setGraph(streamId: string, graph: StandardGraph, expectedCreatedAt?: number): void {
    this.setLocalEntry(this.localGraphCache, streamId, {
      createdAt: expectedCreatedAt,
      value: new WeakRef(graph),
    });
  }

  /** Splice-inserts host-authored parts (steers from `on_steer_applied`,
   *  activity labels from `on_activity_label` chunks) into an SDK-graph
   *  content view, ascending by recorded index so each host-view position
   *  lands exactly where live clients saw it. Label events fire twice per
   *  slot (placeholder, then filled); chronological last-wins keeps the
   *  resolved label. */
  private async overlayHostSteerParts(
    streamId: string,
    parts: Agents.MessageContentComplex[],
    expectedCreatedAt?: number,
  ): Promise<Agents.MessageContentComplex[]> {
    const chunks = await this.getChunks(streamId, expectedCreatedAt);
    if (chunks.length === 0) {
      return parts;
    }
    const steersByIndex = new Map<number, Agents.MessageContentComplex>();
    const labelsByIndex = new Map<number, Agents.MessageContentComplex>();
    const reasoningStepsByIndex = new Map<number, string>();
    const reasoningAttemptsByIndex = new Map<number, ReasoningAttemptOverlay>();
    const reasoningLabelsByIndex = new Map<number, ReasoningLabelOverlay>();
    let reasoningAttemptHighWater = 0;
    for (const chunk of chunks) {
      const event = chunk as { event?: string; data?: unknown };
      if (event.event === 'on_run_step') {
        const step = event.data as {
          id?: string;
          index?: number;
          stepDetails?: { message_creation?: { content_type?: string } };
        };
        if (
          typeof step.id === 'string' &&
          typeof step.index === 'number' &&
          step.stepDetails?.message_creation?.content_type === ContentTypes.THINK
        ) {
          reasoningStepsByIndex.set(step.index, step.id);
        }
        continue;
      }
      if (event.event === 'on_steer_applied') {
        const steerData = event.data as {
          index?: number;
          part?: Agents.MessageContentComplex;
        };
        if (typeof steerData.index === 'number' && steerData.part != null) {
          steersByIndex.set(steerData.index, steerData.part);
        }
        continue;
      }
      if (event.event === 'on_activity_label') {
        const labelData = event.data as {
          index?: number;
          part?: Agents.MessageContentComplex;
        };
        if (typeof labelData.index === 'number' && labelData.part != null) {
          labelsByIndex.set(labelData.index, labelData.part);
        }
        continue;
      }
      if (event.event === 'on_reasoning_label_attempt') {
        const attempt = event.data as {
          index?: number;
          stepId?: string;
          attempts?: number;
          submittedChars?: number;
        };
        if (
          typeof attempt.index === 'number' &&
          typeof attempt.stepId === 'string' &&
          typeof attempt.attempts === 'number'
        ) {
          reasoningAttemptsByIndex.set(attempt.index, {
            stepId: attempt.stepId,
            attempts: attempt.attempts,
            ...(typeof attempt.submittedChars === 'number' && {
              submittedChars: attempt.submittedChars,
            }),
          });
          reasoningAttemptHighWater = Math.max(reasoningAttemptHighWater, attempt.attempts);
        }
        continue;
      }
      if (event.event === 'on_reasoning_label') {
        const labelData = event.data as {
          index?: number;
          stepId?: string;
          revision?: number;
          label?: string;
          status?: 'streaming' | 'complete';
        };
        if (
          typeof labelData.index === 'number' &&
          typeof labelData.stepId === 'string' &&
          typeof labelData.revision === 'number' &&
          typeof labelData.label === 'string'
        ) {
          reasoningLabelsByIndex.set(labelData.index, {
            stepId: labelData.stepId,
            revision: labelData.revision,
            label: labelData.label,
            status: labelData.status === 'complete' ? 'complete' : 'streaming',
          });
        }
        continue;
      }
    }
    if (
      steersByIndex.size === 0 &&
      labelsByIndex.size === 0 &&
      reasoningStepsByIndex.size === 0 &&
      reasoningAttemptHighWater === 0 &&
      reasoningLabelsByIndex.size === 0
    ) {
      return parts;
    }
    const inserts = [
      ...[...steersByIndex.entries()].map(([index, part]) => ({ index, part })),
      ...[...labelsByIndex.entries()].map(([index, part]) => ({ index, part })),
    ];
    inserts.sort((a, b) => a.index - b.index);
    const merged = [...parts];
    for (const insert of inserts) {
      merged.splice(Math.min(insert.index, merged.length), 0, insert.part);
    }
    const reasoningIndices = new Set([
      ...reasoningStepsByIndex.keys(),
      ...reasoningAttemptsByIndex.keys(),
      ...reasoningLabelsByIndex.keys(),
    ]);
    for (const index of reasoningIndices) {
      const part = merged[index] as ReasoningContentPart | undefined;
      if (part?.type !== ContentTypes.THINK) {
        continue;
      }
      const attempt = reasoningAttemptsByIndex.get(index);
      const label = reasoningLabelsByIndex.get(index);
      const stepId = reasoningStepsByIndex.get(index) ?? attempt?.stepId ?? label?.stepId;
      if (stepId == null) {
        continue;
      }
      const updated: ReasoningContentPart = { ...part };
      if (updated.reasoning_label_step_id != null && updated.reasoning_label_step_id !== stepId) {
        delete updated.reasoning_label;
        delete updated.reasoning_label_revision;
        delete updated.reasoning_label_status;
        delete updated.reasoning_label_submitted_chars;
      }
      updated.reasoning_label_step_id = stepId;
      if (reasoningAttemptHighWater > 0) {
        updated.reasoning_label_attempts = Math.max(
          updated.reasoning_label_attempts ?? 0,
          reasoningAttemptHighWater,
        );
      }
      if (attempt?.stepId === stepId && attempt.submittedChars != null) {
        updated.reasoning_label_submitted_chars = attempt.submittedChars;
      }
      if (label?.stepId === stepId) {
        updated.reasoning_label = label.label;
        updated.reasoning_label_revision = label.revision;
        updated.reasoning_label_status = label.status;
      }
      merged[index] = updated;
    }
    return merged;
  }

  /**
   * Cache the HOST-authored content array (WeakRef; owned by the run closure).
   * This is the authoritative same-instance view: host-only parts (steers)
   * live here but never inside the SDK graph, so preferring it over the graph
   * cache keeps same-instance reconnect/abort/status reads steer-complete.
   */
  setContentParts(
    streamId: string,
    contentParts: Agents.MessageContentComplex[],
    expectedCreatedAt?: number,
  ): void {
    this.setLocalEntry(this.localContentParts, streamId, {
      createdAt: expectedCreatedAt,
      value: new WeakRef(contentParts),
    });
  }

  /**
   * Store collectedUsage reference in local cache.
   * This is used for abort handling to spend tokens for all models.
   * Note: Only available on the generating instance; cross-replica abort uses fallback.
   */
  setCollectedUsage(
    streamId: string,
    collectedUsage: UsageMetadata[],
    expectedCreatedAt?: number,
  ): void {
    this.setLocalEntry(this.localCollectedUsageCache, streamId, {
      createdAt: expectedCreatedAt,
      value: collectedUsage,
    });
  }

  /**
   * Get collected usage for a job.
   * Only available if this is the generating instance.
   */
  getCollectedUsage(streamId: string, expectedCreatedAt?: number): UsageMetadata[] {
    return (
      this.getLocalEntry(this.localCollectedUsageCache, streamId, expectedCreatedAt)?.value ?? []
    );
  }

  /**
   * Get aggregated content - tries local cache first, falls back to Redis reconstruction.
   *
   * Optimization: If this instance has the live graph (same-instance reconnect),
   * we return the content directly without Redis round-trip.
   * For cross-instance reconnects, we reconstruct from Redis Streams.
   *
   * @param streamId - The stream identifier
   * @returns Content parts array or null if not found
   */
  /**
   * Read from a cached {@link StandardGraph}, tolerating one disposed after a HITL
   * pause. When a paused turn's client is disposed, `disposeClient`
   * (api/server/cleanup.js `graphPropsToClean`) NULLS the graph's internal arrays
   * (`messages`, `contentData`) for GC — but this store still holds a WeakRef to
   * that object. Calling `getContentParts()` (`this.messages.slice()`) or
   * `getRunSteps()` (`[...this.contentData]`) on it then throws
   * ("Cannot read properties of null (reading 'slice')" / "not iterable"), which
   * aborts the resume (#14247). Swallow it, drop the stale entry, and let the
   * caller fall back to durable chunk reconstruction. (The SDK-side null guard in
   * `StandardGraph` is a separate agents fix.)
   */
  private readCachedGraph<T>(
    streamId: string,
    entry: LocalCacheEntry<WeakRef<StandardGraph>>,
    graph: StandardGraph,
    read: (graph: StandardGraph) => T,
  ): T | null {
    try {
      return read(graph);
    } catch (err) {
      logger.debug(
        `[RedisJobStore] Cached graph for ${streamId} is unusable (likely disposed); falling back to reconstruction:`,
        err instanceof Error ? err.message : err,
      );
      this.deleteLocalEntry(this.localGraphCache, streamId, undefined, entry);
      return null;
    }
  }

  async getContentParts(
    streamId: string,
    expectedCreatedAt?: number,
    options?: { durableOnly?: boolean },
  ): Promise<{
    content: Agents.MessageContentComplex[];
    reconstructedEventCount?: number;
    durableEventCount?: number;
  } | null> {
    // 1. Prefer the HOST content array (same-instance fast path): it already
    // contains host-authored steer parts the SDK graph never sees.
    const hostEntry = options?.durableOnly
      ? undefined
      : this.getLocalEntry(this.localContentParts, streamId, expectedCreatedAt);
    if (hostEntry) {
      const hostParts = hostEntry.value.deref();
      if (hostParts && hostParts.length > 0) {
        return { content: hostParts };
      }
      if (!hostParts) {
        this.deleteLocalEntry(this.localContentParts, streamId, undefined, hostEntry);
      }
    }

    // 2. Local graph cache (runs wired before setContentParts): the SDK view
    // lacks host-authored steer parts, so overlay them from the chunk log —
    // insert (not assign): the graph array is UNSHIFTED, while recorded steer
    // indices are host-view positions that already account for prior steers.
    const graphEntry = options?.durableOnly
      ? undefined
      : this.getLocalEntry(this.localGraphCache, streamId, expectedCreatedAt);
    if (graphEntry) {
      const graph = graphEntry.value.deref();
      if (graph) {
        const localParts = this.readCachedGraph(streamId, graphEntry, graph, (g) =>
          g.getContentParts(),
        );
        if (localParts && localParts.length > 0) {
          return {
            content: await this.overlayHostSteerParts(streamId, localParts, expectedCreatedAt),
          };
        }
      } else {
        // WeakRef was collected, remove from cache
        this.deleteLocalEntry(this.localGraphCache, streamId, undefined, graphEntry);
      }
    }

    // 2. Fall back to Redis chunk reconstruction (cross-instance reconnect)
    const chunkSnapshot = await this.getChunkSnapshot(
      streamId,
      expectedCreatedAt,
      options?.durableOnly === true,
    );
    const { chunks } = chunkSnapshot;
    if (chunkSnapshot.durableEventCount === 0) {
      return null;
    }

    // Use the same content aggregator as live streaming
    const { contentParts, aggregateContent } = createContentAggregator();

    // Step ID -> content index, rebuilt from the replayed `on_run_step`
    // payloads. Those carry the index the offset wrappers shifted, whereas a
    // closure event was stored unshifted (the wrappers clone only
    // `ON_RUN_STEP`/`ON_AGENT_UPDATE`), so a closure must be resolved by ID
    // rather than by its own index — otherwise a run containing a steer or
    // HITL resume stamps the status onto the wrong slot.
    const replayedStepIndices = new Map<string, number>();
    const reasoningStepsByIndex = new Map<number, string>();
    const reasoningAttemptsByIndex = new Map<number, ReasoningAttemptOverlay>();
    const reasoningLabelsByIndex = new Map<number, ReasoningLabelOverlay>();
    let reasoningAttemptHighWater = 0;

    // Valid event types for content aggregation
    const validEvents = new Set([
      'on_run_step',
      'on_message_delta',
      'on_reasoning_delta',
      'on_run_step_delta',
      'on_run_step_completed',
      'on_agent_update',
    ]);

    for (const chunk of chunks) {
      const event = chunk as { event?: string; data?: unknown };
      if (!event.event || !event.data) {
        continue;
      }

      // Steer parts are host-authored (the SDK aggregator doesn't know the
      // event), so splice them at their recorded index — SDK events after the
      // injection were emitted with already-shifted indices, so both sources
      // land disjoint.
      if (event.event === 'on_steer_applied') {
        const steerData = event.data as {
          index?: number;
          part?: Agents.MessageContentComplex;
        };
        if (typeof steerData.index === 'number' && steerData.part != null) {
          contentParts[steerData.index] = steerData.part;
        }
        continue;
      }

      // Activity-label parts are host-authored like steers and claimed at a
      // fixed index. The event fires twice per slot (counts placeholder,
      // then resolved label); chronological replay makes the last write win.
      if (event.event === 'on_activity_label') {
        const labelData = event.data as {
          index?: number;
          part?: Agents.MessageContentComplex;
        };
        if (typeof labelData.index === 'number' && labelData.part != null) {
          contentParts[labelData.index] = labelData.part;
        }
        continue;
      }

      // Attempt reservations are durable but intentionally non-rendering.
      // Overlay their run-cumulative high-water mark after replay so later
      // deltas cannot erase the cost cap before a HITL resume.
      if (event.event === 'on_reasoning_label_attempt') {
        const attempt = event.data as {
          index?: number;
          stepId?: string;
          attempts?: number;
          submittedChars?: number;
        };
        if (
          typeof attempt.index === 'number' &&
          typeof attempt.stepId === 'string' &&
          typeof attempt.attempts === 'number'
        ) {
          reasoningAttemptsByIndex.set(attempt.index, {
            stepId: attempt.stepId,
            attempts: attempt.attempts,
            ...(typeof attempt.submittedChars === 'number' && {
              submittedChars: attempt.submittedChars,
            }),
          });
          reasoningAttemptHighWater = Math.max(reasoningAttemptHighWater, attempt.attempts);
        }
        continue;
      }

      // Reasoning labels patch an existing THINK part and never shift indices.
      // Retain the latest update until replay is complete: a later reasoning
      // delta rebuilds the THINK object and would otherwise erase metadata
      // from an earlier label event.
      if (event.event === 'on_reasoning_label') {
        const labelData = event.data as {
          index?: number;
          stepId?: string;
          revision?: number;
          label?: string;
          status?: 'streaming' | 'complete';
        };
        if (
          typeof labelData.index === 'number' &&
          typeof labelData.stepId === 'string' &&
          typeof labelData.revision === 'number' &&
          typeof labelData.label === 'string'
        ) {
          reasoningLabelsByIndex.set(labelData.index, {
            stepId: labelData.stepId,
            revision: labelData.revision,
            label: labelData.label,
            status: labelData.status === 'complete' ? 'complete' : 'streaming',
          });
        }
        continue;
      }

      // Step closures are host-authored like steers and labels: the SDK
      // aggregator has no notion of the event, so the terminal status is
      // stamped onto the part the replayed steps already rebuilt. Resolved by
      // step ID against the replayed indices, never by the closure's own
      // index — see `replayedStepIndices`. Chronology guarantees the step's
      // `on_run_step` was replayed first.
      if (event.event === 'on_run_step_closed') {
        const closed = event.data as {
          id?: string;
          status?: Agents.RunStepClosedStatus;
          created_at?: number;
          closed_at?: number;
        };
        const index = closed.id != null ? replayedStepIndices.get(closed.id) : undefined;
        const part = index != null ? contentParts[index] : undefined;
        if (closed.status && part?.type === ContentTypes.TOOL_CALL && part.tool_call) {
          part.tool_call.runStepStatus = closed.status;
          const durationMs = getRunStepDurationMs(closed);
          if (durationMs != null) {
            part.tool_call.runStepDurationMs = durationMs;
          }
        }
        continue;
      }

      if (!validEvents.has(event.event)) {
        continue;
      }

      if (event.event === 'on_run_step') {
        const step = event.data as {
          id?: string;
          index?: number;
          stepDetails?: { message_creation?: { content_type?: string } };
        };
        if (step.id != null && typeof step.index === 'number') {
          replayedStepIndices.set(step.id, step.index);
          if (step.stepDetails?.message_creation?.content_type === ContentTypes.THINK) {
            reasoningStepsByIndex.set(step.index, step.id);
          }
        }
      }

      // Pass event string directly - GraphEvents values are lowercase strings
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      aggregateContent({ event: event.event as any, data: event.data as any });
    }

    const reasoningIndices = new Set([
      ...reasoningStepsByIndex.keys(),
      ...reasoningAttemptsByIndex.keys(),
      ...reasoningLabelsByIndex.keys(),
    ]);
    for (const index of reasoningIndices) {
      const part = contentParts[index] as ReasoningContentPart | undefined;
      if (part?.type !== ContentTypes.THINK) {
        continue;
      }
      const attempt = reasoningAttemptsByIndex.get(index);
      const label = reasoningLabelsByIndex.get(index);
      const stepId = reasoningStepsByIndex.get(index) ?? attempt?.stepId ?? label?.stepId;
      if (stepId == null) {
        continue;
      }
      if (part.reasoning_label_step_id != null && part.reasoning_label_step_id !== stepId) {
        delete part.reasoning_label;
        delete part.reasoning_label_revision;
        delete part.reasoning_label_status;
        delete part.reasoning_label_submitted_chars;
      }
      part.reasoning_label_step_id = stepId;
      if (reasoningAttemptHighWater > 0) {
        part.reasoning_label_attempts = Math.max(
          part.reasoning_label_attempts ?? 0,
          reasoningAttemptHighWater,
        );
      }
      if (attempt?.stepId === stepId && attempt.submittedChars != null) {
        part.reasoning_label_submitted_chars = attempt.submittedChars;
      }
      if (label?.stepId === stepId) {
        part.reasoning_label = label.label;
        part.reasoning_label_revision = label.revision;
        part.reasoning_label_status = label.status;
      }
    }

    // Filter out undefined entries
    const filtered: Agents.MessageContentComplex[] = [];
    for (const part of contentParts) {
      if (part !== undefined) {
        filtered.push(part);
      }
    }

    return {
      content: filtered,
      ...(options?.durableOnly === true && {
        reconstructedEventCount: chunks.length,
        durableEventCount: chunkSnapshot.durableEventCount,
      }),
    };
  }

  /**
   * Get run steps - tries local cache first, falls back to Redis.
   *
   * Optimization: If this instance has the live graph, we get run steps
   * directly without Redis round-trip.
   *
   * @param streamId - The stream identifier
   * @returns Run steps array
   */
  async getRunSteps(streamId: string, expectedCreatedAt?: number): Promise<Agents.RunStep[]> {
    // 1. Try local graph cache first (fast path for same-instance reconnect)
    const graphEntry = this.getLocalEntry(this.localGraphCache, streamId, expectedCreatedAt);
    if (graphEntry) {
      const graph = graphEntry.value.deref();
      if (graph) {
        const localSteps = this.readCachedGraph(streamId, graphEntry, graph, (g) =>
          g.getRunSteps(),
        );
        if (localSteps && localSteps.length > 0) {
          return toWireRunSteps(localSteps);
        }
      }
      // Note: Don't delete from cache here - graph may still be valid
      // but just not have run steps yet
    }

    // 2. Fall back to Redis (cross-instance reconnect)
    const data = await this.getRunStepsData(streamId, expectedCreatedAt);
    if (!data) {
      return [];
    }
    try {
      return JSON.parse(data);
    } catch {
      return [];
    }
  }

  private async getRunStepsData(
    streamId: string,
    expectedCreatedAt?: number,
  ): Promise<string | null> {
    if (expectedCreatedAt == null) {
      return this.redis.get(KEYS.runSteps(streamId));
    }
    const data = await this.redis.eval(
      RUNSTEPS_READ_LUA,
      2,
      KEYS.job(streamId),
      KEYS.runSteps(streamId),
      String(expectedCreatedAt),
    );
    return typeof data === 'string' ? data : null;
  }

  /**
   * Clear content state for a job.
   * Removes both local cache and Redis data.
   */
  clearContentState(streamId: string, expectedCreatedAt?: number): void {
    // Clear local caches immediately
    this.clearLocalState(streamId, expectedCreatedAt);

    // Fire and forget - async cleanup for Redis
    this.clearContentStateAsync(streamId, expectedCreatedAt).catch((err) => {
      logger.error(`[RedisJobStore] Failed to clear content state for ${streamId}:`, err);
    });
  }

  /**
   * Clear content state async.
   */
  private async clearContentStateAsync(
    streamId: string,
    expectedCreatedAt?: number,
  ): Promise<void> {
    await this.redis.eval(
      CONTENT_CLEAR_LUA,
      3,
      KEYS.chunks(streamId),
      KEYS.runSteps(streamId),
      KEYS.job(streamId),
      expectedCreatedAt != null ? String(expectedCreatedAt) : '',
    );
  }

  // ===== Steering Queue Methods =====

  async enqueueSteer(
    streamId: string,
    item: SteerQueueItem,
    expectedCreatedAt?: number,
  ): Promise<number> {
    const result = await this.redis.eval(
      STEER_ENQUEUE_LUA,
      2,
      KEYS.job(streamId),
      KEYS.steers(streamId),
      JSON.stringify(item),
      String(this.runningStorageTtlSeconds()),
      String(STEER_QUEUE_MAX_DEPTH),
      expectedCreatedAt != null ? String(expectedCreatedAt) : '',
    );
    if (typeof result !== 'number') {
      return STEER_ENQUEUE_NOT_RUNNING;
    }
    return result;
  }

  async enqueueSteerVersioned(
    streamId: string,
    item: SteerQueueItem,
    wantsPreempt: boolean,
    expectedCreatedAt?: number,
  ): Promise<SteerEnqueueVersionedResult> {
    const result = await this.redis.eval(
      STEER_ENQUEUE_VERSIONED_LUA,
      2,
      KEYS.job(streamId),
      KEYS.steers(streamId),
      JSON.stringify(item),
      String(this.runningStorageTtlSeconds()),
      String(STEER_QUEUE_MAX_DEPTH),
      expectedCreatedAt != null ? String(expectedCreatedAt) : '',
      wantsPreempt ? '1' : '0',
    );
    if (typeof result === 'number') {
      return result;
    }
    if (typeof result !== 'string') {
      return STEER_ENQUEUE_NOT_RUNNING;
    }
    try {
      return JSON.parse(result) as Exclude<SteerEnqueueVersionedResult, number>;
    } catch {
      logger.warn(`[RedisJobStore] Malformed atomic steer enqueue result for ${streamId}`);
      return STEER_ENQUEUE_NOT_RUNNING;
    }
  }

  async getSteerReceipt(streamId: string, clientSteerId: string): Promise<SteerReceipt | null> {
    const raw = await this.redis.eval(
      STEER_RECEIPT_GET_LUA,
      3,
      KEYS.steerReceipts(streamId),
      KEYS.job(streamId),
      KEYS.steers(streamId),
      clientSteerId,
    );
    if (typeof raw !== 'string') {
      return null;
    }
    try {
      return JSON.parse(raw) as SteerReceipt;
    } catch {
      logger.warn(`[RedisJobStore] Dropping malformed steer receipt for ${streamId}`);
      await this.redis.hdel(KEYS.steerReceipts(streamId), clientSteerId);
      return null;
    }
  }

  async enqueueSteerWithReceipt(
    streamId: string,
    item: SteerQueueItem,
    receipt: SteerReceiptInput,
    wantsPreempt: boolean,
    expectedCreatedAt?: number,
  ): Promise<SteerEnqueueReceiptResult> {
    const result = await this.redis.eval(
      STEER_ENQUEUE_RECEIPT_LUA,
      4,
      KEYS.job(streamId),
      KEYS.steers(streamId),
      KEYS.steerReceipts(streamId),
      KEYS.steerReceiptOrder(streamId),
      JSON.stringify(item),
      String(this.runningStorageTtlSeconds()),
      String(STEER_QUEUE_MAX_DEPTH),
      expectedCreatedAt != null ? String(expectedCreatedAt) : '',
      receipt.clientSteerId,
      JSON.stringify(receipt),
      wantsPreempt ? '1' : '0',
      String(this.runningStorageTtlSeconds()),
      String(STEER_RECEIPT_MAX_PER_STREAM),
    );
    if (typeof result === 'number') {
      return result;
    }
    if (typeof result !== 'string') {
      return STEER_ENQUEUE_NOT_RUNNING;
    }
    try {
      return JSON.parse(result) as Exclude<SteerEnqueueReceiptResult, number>;
    } catch {
      logger.warn(`[RedisJobStore] Malformed atomic steer receipt for ${streamId}`);
      return STEER_ENQUEUE_NOT_RUNNING;
    }
  }

  async drainSteers(streamId: string, expectedCreatedAt?: number): Promise<SteerQueueItem[]> {
    const raw = await this.redis.eval(
      STEER_DRAIN_LUA,
      5,
      KEYS.job(streamId),
      KEYS.steers(streamId),
      KEYS.claimedSteers(streamId),
      KEYS.steerReceipts(streamId),
      KEYS.steerReceiptOrder(streamId),
      expectedCreatedAt != null ? String(expectedCreatedAt) : '',
      String(this.runningStorageTtlSeconds()),
    );
    return this.parseSteerItems(raw);
  }

  async admitTerminalSteers(
    streamId: string,
    policy: TerminalSteerAdmissionPolicy,
    expectedCreatedAt?: number,
  ): Promise<TerminalSteerAdmissionResult> {
    const raw = await this.redis.eval(
      STEER_TERMINAL_ADMISSION_LUA,
      5,
      KEYS.job(streamId),
      KEYS.steers(streamId),
      KEYS.claimedSteers(streamId),
      KEYS.steerReceipts(streamId),
      KEYS.steerReceiptOrder(streamId),
      expectedCreatedAt != null ? String(expectedCreatedAt) : '',
      String(this.runningStorageTtlSeconds()),
      policy.allowClaim ? '1' : '0',
      policy.keepOpenWhenEmpty ? '1' : '0',
    );
    if (!Array.isArray(raw) || typeof raw[0] !== 'string') {
      return { outcome: 'unavailable' };
    }
    if (raw[0] !== 'claimed') {
      return {
        outcome: raw[0] === 'sealed' || raw[0] === 'open' ? raw[0] : 'unavailable',
      };
    }
    return { outcome: 'claimed', items: this.parseSteerItems(raw.slice(1)) };
  }

  async restoreClaimedSteers(
    streamId: string,
    items: SteerQueueItem[],
    expectedCreatedAt?: number,
  ): Promise<boolean> {
    if (items.length === 0) {
      return true;
    }
    const restored = await this.redis.eval(
      STEER_RESTORE_CLAIMED_LUA,
      4,
      KEYS.job(streamId),
      KEYS.steers(streamId),
      KEYS.claimedSteers(streamId),
      KEYS.steerReceipts(streamId),
      expectedCreatedAt != null ? String(expectedCreatedAt) : '',
      JSON.stringify(items),
      String(this.runningStorageTtlSeconds()),
    );
    return restored === 1;
  }

  async closeAndDrainSteers(
    streamId: string,
    expectedCreatedAt?: number,
  ): Promise<SteerQueueItem[]> {
    const raw = await this.redis.eval(
      STEER_CLOSE_DRAIN_LUA,
      6,
      KEYS.job(streamId),
      KEYS.steers(streamId),
      KEYS.claimedSteers(streamId),
      KEYS.steerReceipts(streamId),
      KEYS.steerReceiptOrder(streamId),
      KEYS.parkedSteers(streamId),
      expectedCreatedAt != null ? String(expectedCreatedAt) : '',
      String(this.ttl.completed > 0 ? this.ttl.completed : PARKED_RECOVERY_TTL_S),
    );
    if (raw === 'recovery_corrupt') {
      throw new Error('Generation recovery state is corrupt or belongs to another owner');
    }
    return this.parseSteerItems(raw);
  }

  async peekSteers(streamId: string, expectedCreatedAt?: number): Promise<SteerQueueItem[]> {
    const raw =
      expectedCreatedAt == null
        ? await this.redis.lrange(KEYS.steers(streamId), 0, -1)
        : await this.redis.eval(
            STEER_PEEK_LUA,
            2,
            KEYS.job(streamId),
            KEYS.steers(streamId),
            String(expectedCreatedAt),
          );
    return this.parseSteerItems(raw);
  }

  async peekClaimedSteers(streamId: string, expectedCreatedAt?: number): Promise<SteerQueueItem[]> {
    const raw = await this.redis.eval(
      STEER_PEEK_CLAIMED_LUA,
      2,
      KEYS.job(streamId),
      KEYS.claimedSteers(streamId),
      expectedCreatedAt != null ? String(expectedCreatedAt) : '',
    );
    return this.parseSteerItems(raw);
  }

  async clearSteers(streamId: string): Promise<void> {
    await this.redis.del(KEYS.steers(streamId), KEYS.claimedSteers(streamId));
  }

  async removeSteer(
    streamId: string,
    steerId: string,
    expectedCreatedAt?: number,
  ): Promise<boolean> {
    const removed = (await this.redis.eval(
      STEER_REMOVE_LUA,
      3,
      KEYS.job(streamId),
      KEYS.steers(streamId),
      KEYS.steerReceipts(streamId),
      steerId,
      expectedCreatedAt != null ? String(expectedCreatedAt) : '',
    )) as number;
    return removed === 1;
  }

  async armSteer(
    streamId: string,
    steerId: string,
    expectedCreatedAt?: number,
  ): Promise<SteerArmOutcome> {
    return (await this.armSteerVersioned(streamId, steerId, expectedCreatedAt)).outcome;
  }

  async armSteerVersioned(
    streamId: string,
    steerId: string,
    expectedCreatedAt?: number,
  ): Promise<SteerArmResult> {
    const result = await this.redis.eval(
      STEER_ARM_LUA,
      3,
      KEYS.job(streamId),
      KEYS.steers(streamId),
      KEYS.steerReceipts(streamId),
      steerId,
      expectedCreatedAt != null ? String(expectedCreatedAt) : '',
    );
    if (typeof result === 'string') {
      try {
        const item = JSON.parse(result) as SteerQueueItem;
        return { outcome: 'armed', revision: item.preemptRevision, item };
      } catch {
        return { outcome: 'missing' };
      }
    }
    return { outcome: result === -1 ? 'incapable' : 'missing' };
  }

  async downgradeSteerPreempts(
    streamId: string,
    expectedCreatedAt?: number,
  ): Promise<SteerQueueItem[] | null> {
    const changed = await this.redis.eval(
      STEER_DOWNGRADE_PREEMPTS_LUA,
      3,
      KEYS.job(streamId),
      KEYS.steers(streamId),
      KEYS.steerReceipts(streamId),
      expectedCreatedAt != null ? String(expectedCreatedAt) : '',
    );
    if (changed === -1) {
      return null;
    }
    return this.parseSteerItems(changed);
  }

  async parkSteers(streamId: string, payload: string, expectedCreatedAt?: number): Promise<void> {
    const ttl = this.ttl.completed > 0 ? this.ttl.completed : PARKED_RECOVERY_TTL_S;
    await this.redis.eval(
      PARK_STEERS_LUA,
      2,
      KEYS.job(streamId),
      KEYS.parkedSteers(streamId),
      expectedCreatedAt != null ? String(expectedCreatedAt) : '',
      payload,
      String(ttl),
    );
  }

  async claimParkedSteers(
    streamId: string,
    ownerUserId: string,
    ownerTenantId?: string,
  ): Promise<string | undefined> {
    return (await this.claimParkedSteersDetailed(streamId, ownerUserId, ownerTenantId, 2))?.payload;
  }

  async claimParkedSteersDetailed(
    streamId: string,
    ownerUserId: string,
    ownerTenantId?: string,
    requestedProtocolVersion: 1 | 2 = 1,
  ): Promise<ParkedSteerClaim | undefined> {
    const claimed = await this.redis.eval(
      CLAIM_PARKED_LUA,
      2,
      KEYS.parkedSteers(streamId),
      KEYS.job(streamId),
      ownerUserId,
      ownerTenantId ?? '',
      String(requestedProtocolVersion),
    );
    if (
      !Array.isArray(claimed) ||
      typeof claimed[0] !== 'string' ||
      (String(claimed[1]) !== '1' && String(claimed[1]) !== '2')
    ) {
      // '' is the non-owner/malformed sentinel (payload left in place).
      return undefined;
    }
    return {
      payload: claimed[0],
      generationProtocolVersion: String(claimed[1]) === '2' ? 2 : 1,
    };
  }

  async consumeParkedSteer(
    streamId: string,
    steerId: string,
    ownerUserId: string,
    ownerTenantId: string | undefined,
    expectedCreatedAt: number,
  ): Promise<boolean> {
    const consumed = await this.redis.eval(
      CONSUME_PARKED_STEER_LUA,
      3,
      KEYS.job(streamId),
      KEYS.parkedSteers(streamId),
      KEYS.steerReceipts(streamId),
      String(expectedCreatedAt),
      steerId,
      ownerUserId,
      ownerTenantId ?? '',
    );
    return consumed === 1;
  }

  async discardSteerLeftover(
    streamId: string,
    clientSteerId: string,
    steerId: string,
    ownerUserId: string,
    ownerTenantId?: string,
    expectedGenerationCreatedAt?: number,
  ): Promise<boolean> {
    const discarded = await this.redis.eval(
      DISCARD_STEER_LEFTOVER_LUA,
      3,
      KEYS.steerReceipts(streamId),
      KEYS.parkedSteers(streamId),
      KEYS.job(streamId),
      clientSteerId,
      steerId,
      ownerUserId,
      ownerTenantId ?? '',
      expectedGenerationCreatedAt != null ? String(expectedGenerationCreatedAt) : '',
    );
    return discarded === 1;
  }

  /** A malformed entry is dropped (logged) rather than poisoning the drain. */
  private parseSteerItems(raw: unknown): SteerQueueItem[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    const items: SteerQueueItem[] = [];
    for (const entry of raw) {
      if (typeof entry !== 'string') {
        continue;
      }
      try {
        items.push(JSON.parse(entry) as SteerQueueItem);
      } catch {
        logger.warn('[RedisJobStore] Dropping malformed steer queue entry');
      }
    }
    return items;
  }

  /**
   * Append a streaming chunk to Redis Stream.
   * Uses XADD for efficient append-only storage.
   * Sets TTL on first chunk to ensure cleanup if job crashes.
   */
  async appendChunk(
    streamId: string,
    event: unknown,
    expectedCreatedAt?: number,
    deliveredSteer?: SteerQueueItem,
    options?: { coalesce?: boolean },
  ): Promise<boolean> {
    if (options?.coalesce === true && deliveredSteer == null && this.coalesceWindowMs > 0) {
      return this.enqueueCoalescedAppend(streamId, event, expectedCreatedAt);
    }
    /** The chunk log is replayed in XADD order, so a per-event append (durable
     * control events, steer receipts) is a barrier: pending coalesced deltas
     * must be issued first. Same connection, so issue order is land order. */
    if (this.pendingAppends.has(streamId)) {
      void this.flushCoalescedAppends(streamId);
    }
    const key = KEYS.chunks(streamId);
    const jobKey = KEYS.job(streamId);
    // XADD + derive-and-extend-only EXPIRE in a single atomic eval. Refreshing the TTL on
    // every chunk (vs only once) keeps the key alive through long streams, but it must
    // NEVER shrink an already-longer TTL — a paused (requires_action) job needs this key
    // to live for the whole approval window, and the on_pending_action append (or any
    // chunk that lands after the pause) would otherwise reset it to the short running TTL.
    // The script reads the paused window from the job key, so it bumps to the approval TTL
    // even when the pause's own EXPIRE no-op'd because this key didn't exist yet, while a
    // normally-running run still settles on the short running TTL. Both keys share the
    // {streamId} hash tag, so the multi-key eval stays on one slot under Redis Cluster.
    const appended = await this.redis.eval(
      CHUNK_APPEND_LUA,
      8,
      key,
      jobKey,
      KEYS.steerReceipts(streamId),
      KEYS.steerReceiptOrder(streamId),
      KEYS.claimedSteers(streamId),
      KEYS.steers(streamId),
      KEYS.parkedSteers(streamId),
      KEYS.generationEpoch(streamId),
      JSON.stringify(event),
      String(this.runningStorageTtlSeconds()),
      expectedCreatedAt != null ? String(expectedCreatedAt) : '',
      deliveredSteer?.clientSteerId ?? '',
      deliveredSteer != null ? JSON.stringify(deliveredSteer) : '',
      String(Date.now()),
      String(this.parkedRecoveryTtlSeconds()),
      String(GENERATION_EPOCH_GRACE_TTL_S),
    );
    return appended === 1;
  }

  /**
   * Buffer a coalescable durable append for the current window. The whole batch
   * settles together: `true` on commit, `false` under the generation/status
   * fence, and a rejection on operational failure — mirroring the per-event
   * appendChunk contract each caller's fence continuation already handles.
   */
  private enqueueCoalescedAppend(
    streamId: string,
    event: unknown,
    expectedCreatedAt?: number,
  ): Promise<boolean> {
    let pending = this.pendingAppends.get(streamId);
    if (pending && pending.expectedCreatedAt !== expectedCreatedAt) {
      void this.flushCoalescedAppends(streamId);
      pending = undefined;
    }
    if (!pending) {
      pending = {
        expectedCreatedAt,
        events: [],
        settlers: [],
        bytes: 0,
        timer: null,
      };
      this.pendingAppends.set(streamId, pending);
    }

    const batch = pending;
    const encoded = JSON.stringify(event);
    batch.events.push(encoded);
    batch.bytes += encoded.length;
    const settled = new Promise<boolean>((resolve, reject) => {
      batch.settlers.push({ resolve, reject });
    });

    if (batch.events.length >= MAX_COALESCED_EVENTS || batch.bytes >= MAX_COALESCED_BYTES) {
      void this.flushCoalescedAppends(streamId);
    } else if (batch.timer == null) {
      batch.timer = setTimeout(() => {
        void this.flushCoalescedAppends(streamId);
      }, this.coalesceWindowMs);
    }
    return settled;
  }

  private flushCoalescedAppends(streamId: string): Promise<void> {
    const pending = this.pendingAppends.get(streamId);
    if (!pending) {
      return Promise.resolve();
    }
    this.pendingAppends.delete(streamId);
    if (pending.timer != null) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }

    const { expectedCreatedAt, events, settlers } = pending;
    return this.redis
      .eval(
        CHUNK_APPEND_BATCH_LUA,
        8,
        KEYS.chunks(streamId),
        KEYS.job(streamId),
        KEYS.steerReceipts(streamId),
        KEYS.steerReceiptOrder(streamId),
        KEYS.claimedSteers(streamId),
        KEYS.steers(streamId),
        KEYS.parkedSteers(streamId),
        KEYS.generationEpoch(streamId),
        String(this.runningStorageTtlSeconds()),
        expectedCreatedAt != null ? String(expectedCreatedAt) : '',
        String(Date.now()),
        String(this.parkedRecoveryTtlSeconds()),
        String(GENERATION_EPOCH_GRACE_TTL_S),
        ...events,
      )
      .then(
        (appended) => {
          const committed = appended === 1;
          for (const settler of settlers) {
            settler.resolve(committed);
          }
        },
        (err) => {
          for (const settler of settlers) {
            settler.reject(err);
          }
        },
      );
  }

  /** Persist a stream's pending coalesced appends now (pre-transition barrier). */
  async flushPendingAppends(streamId: string): Promise<void> {
    await this.flushCoalescedAppends(streamId);
  }

  /**
   * Get all chunks from Redis Stream.
   */
  private async getChunks(streamId: string, expectedCreatedAt?: number): Promise<unknown[]> {
    return (await this.getChunkSnapshot(streamId, expectedCreatedAt)).chunks;
  }

  private async getChunkSnapshot(
    streamId: string,
    expectedCreatedAt?: number,
    includeDurableEventCount = false,
  ): Promise<{ chunks: unknown[]; durableEventCount: number }> {
    /** A same-replica snapshot read must observe the appends this process has
     * already accepted, or a resume during an active window reconstructs
     * without the buffered tail. Cross-replica readers keep today's contract:
     * the log may trail live emission by up to one window. */
    await this.flushCoalescedAppends(streamId);
    let rawEntries: unknown;
    let rawDurableEventCount: unknown;
    if (includeDurableEventCount) {
      const rawSnapshot = await this.redis.eval(
        CHUNKS_RECOVERY_READ_LUA,
        2,
        KEYS.job(streamId),
        KEYS.chunks(streamId),
        expectedCreatedAt != null ? String(expectedCreatedAt) : '',
      );
      [rawEntries, rawDurableEventCount] = Array.isArray(rawSnapshot) ? rawSnapshot : [];
    } else {
      rawEntries =
        expectedCreatedAt == null
          ? await this.redis.xrange(KEYS.chunks(streamId), '-', '+')
          : await this.redis.eval(
              CHUNKS_READ_LUA,
              2,
              KEYS.job(streamId),
              KEYS.chunks(streamId),
              String(expectedCreatedAt),
            );
    }
    const entries = Array.isArray(rawEntries) ? (rawEntries as Array<[string, string[]]>) : [];

    const chunks = entries
      .map(([, fields]) => {
        const eventIdx = fields.indexOf('event');
        if (eventIdx >= 0 && eventIdx + 1 < fields.length) {
          try {
            return JSON.parse(fields[eventIdx + 1]);
          } catch {
            return null;
          }
        }
        return null;
      })
      .filter(Boolean);
    const parsedDurableEventCount =
      typeof rawDurableEventCount === 'string' || typeof rawDurableEventCount === 'number'
        ? Number(rawDurableEventCount)
        : Number.NaN;
    return {
      chunks,
      durableEventCount: Number.isFinite(parsedDurableEventCount)
        ? parsedDurableEventCount
        : entries.length,
    };
  }

  /**
   * Save run steps for resume state. Uses the paused-window TTL script so a run-step save
   * landing at/after a HITL pause extends to the approval window instead of resetting the
   * key to the short running TTL (which would drop the tool timeline on a reload of a
   * still-live approval — mirrors the chunk-stream no-shrink behavior).
   */
  async saveRunSteps(
    streamId: string,
    runSteps: Agents.RunStep[],
    expectedCreatedAt?: number,
  ): Promise<void> {
    await this.redis.eval(
      RUNSTEPS_SAVE_LUA,
      2,
      KEYS.runSteps(streamId),
      KEYS.job(streamId),
      JSON.stringify(runSteps),
      String(this.runningStorageTtlSeconds()),
      expectedCreatedAt != null ? String(expectedCreatedAt) : '',
    );
  }

  // ===== Consumer Group Methods =====
  // These enable tracking which chunks each client has seen.
  // Based on https://upstash.com/blog/resumable-llm-streams

  /**
   * Create a consumer group for a stream.
   * Used to track which chunks a client has already received.
   *
   * @param streamId - The stream identifier
   * @param groupName - Unique name for the consumer group (e.g., session ID)
   * @param startFrom - Where to start reading ('0' = from beginning, '$' = only new)
   */
  async createConsumerGroup(
    streamId: string,
    groupName: string,
    startFrom: '0' | '$' = '0',
  ): Promise<void> {
    const key = KEYS.chunks(streamId);
    try {
      await this.redis.xgroup('CREATE', key, groupName, startFrom, 'MKSTREAM');
      logger.debug(`[RedisJobStore] Created consumer group ${groupName} for ${streamId}`);
    } catch (err) {
      // BUSYGROUP error means group already exists - that's fine
      const error = err as Error;
      if (!error.message?.includes('BUSYGROUP')) {
        throw err;
      }
    }
  }

  /**
   * Read chunks from a consumer group (only unseen chunks).
   * This is the key to the resumable stream pattern.
   *
   * @param streamId - The stream identifier
   * @param groupName - Consumer group name
   * @param consumerName - Name of the consumer within the group
   * @param count - Maximum number of chunks to read (default: all available)
   * @returns Array of { id, event } where id is the Redis stream entry ID
   */
  async readChunksFromGroup(
    streamId: string,
    groupName: string,
    consumerName: string = 'consumer-1',
    count?: number,
  ): Promise<Array<{ id: string; event: unknown }>> {
    const key = KEYS.chunks(streamId);

    try {
      // XREADGROUP GROUP groupName consumerName [COUNT count] STREAMS key >
      // The '>' means only read new messages not yet delivered to this consumer
      let result;
      if (count) {
        result = await this.redis.xreadgroup(
          'GROUP',
          groupName,
          consumerName,
          'COUNT',
          count,
          'STREAMS',
          key,
          '>',
        );
      } else {
        result = await this.redis.xreadgroup('GROUP', groupName, consumerName, 'STREAMS', key, '>');
      }

      if (!result || result.length === 0) {
        return [];
      }

      // Result format: [[streamKey, [[id, [field, value, ...]], ...]]]
      const [, messages] = result[0] as [string, Array<[string, string[]]>];
      const chunks: Array<{ id: string; event: unknown }> = [];

      for (const [id, fields] of messages) {
        const eventIdx = fields.indexOf('event');
        if (eventIdx >= 0 && eventIdx + 1 < fields.length) {
          try {
            chunks.push({
              id,
              event: JSON.parse(fields[eventIdx + 1]),
            });
          } catch {
            // Skip malformed entries
          }
        }
      }

      return chunks;
    } catch (err) {
      const error = err as Error;
      // NOGROUP error means the group doesn't exist yet
      if (error.message?.includes('NOGROUP')) {
        return [];
      }
      throw err;
    }
  }

  /**
   * Acknowledge that chunks have been processed.
   * This tells Redis we've successfully delivered these chunks to the client.
   *
   * @param streamId - The stream identifier
   * @param groupName - Consumer group name
   * @param messageIds - Array of Redis stream entry IDs to acknowledge
   */
  async acknowledgeChunks(
    streamId: string,
    groupName: string,
    messageIds: string[],
  ): Promise<void> {
    if (messageIds.length === 0) {
      return;
    }

    const key = KEYS.chunks(streamId);
    await this.redis.xack(key, groupName, ...messageIds);
  }

  /**
   * Delete a consumer group.
   * Called when a client disconnects and won't reconnect.
   *
   * @param streamId - The stream identifier
   * @param groupName - Consumer group name to delete
   */
  async deleteConsumerGroup(streamId: string, groupName: string): Promise<void> {
    const key = KEYS.chunks(streamId);
    try {
      await this.redis.xgroup('DESTROY', key, groupName);
      logger.debug(`[RedisJobStore] Deleted consumer group ${groupName} for ${streamId}`);
    } catch {
      // Ignore errors - group may not exist
    }
  }

  /**
   * Get pending chunks for a consumer (chunks delivered but not acknowledged).
   * Useful for recovering from crashes.
   *
   * @param streamId - The stream identifier
   * @param groupName - Consumer group name
   * @param consumerName - Consumer name
   */
  async getPendingChunks(
    streamId: string,
    groupName: string,
    consumerName: string = 'consumer-1',
  ): Promise<Array<{ id: string; event: unknown }>> {
    const key = KEYS.chunks(streamId);

    try {
      // Read pending messages (delivered but not acked) by using '0' instead of '>'
      const result = await this.redis.xreadgroup(
        'GROUP',
        groupName,
        consumerName,
        'STREAMS',
        key,
        '0',
      );

      if (!result || result.length === 0) {
        return [];
      }

      const [, messages] = result[0] as [string, Array<[string, string[]]>];
      const chunks: Array<{ id: string; event: unknown }> = [];

      for (const [id, fields] of messages) {
        const eventIdx = fields.indexOf('event');
        if (eventIdx >= 0 && eventIdx + 1 < fields.length) {
          try {
            chunks.push({
              id,
              event: JSON.parse(fields[eventIdx + 1]),
            });
          } catch {
            // Skip malformed entries
          }
        }
      }

      return chunks;
    } catch {
      return [];
    }
  }

  /**
   * Serialize job data for Redis hash storage.
   * Converts complex types to strings.
   */
  private serializeJob(job: Partial<SerializableJobData>): Record<string, string> {
    const result: Record<string, string> = {};

    for (const [key, value] of Object.entries(job)) {
      if (value === undefined) {
        continue;
      }

      if (typeof value === 'object') {
        result[key] = JSON.stringify(value);
      } else if (typeof value === 'boolean') {
        result[key] = value ? '1' : '0';
      } else {
        result[key] = String(value);
      }
    }

    return result;
  }

  /**
   * Deserialize job data from Redis hash.
   */
  private deserializeJob(data: Record<string, string>): SerializableJobData {
    const detachedAgentEventTerminalStatus =
      data.detachedAgentEventTerminalStatus === 'complete' ||
      data.detachedAgentEventTerminalStatus === 'aborted' ||
      data.detachedAgentEventTerminalStatus === 'error'
        ? data.detachedAgentEventTerminalStatus
        : undefined;
    const job: CreatedJobData = {
      streamId: data.streamId,
      userId: data.userId,
      tenantId: data.tenantId || undefined,
      status: detachedAgentEventTerminalStatus ?? (data.status as JobStatus),
      createdAt: parseInt(data.createdAt, 10),
      generationProtocolVersion: data.generationProtocolVersion === '2' ? 2 : 1,
      checkpointNamespace: data.checkpointNamespace || undefined,
      completedAt: data.completedAt ? parseInt(data.completedAt, 10) : undefined,
      conversationId: data.conversationId || undefined,
      error: data.error || undefined,
      earlyBufferOverflow: data.earlyBufferOverflow
        ? (JSON.parse(data.earlyBufferOverflow) as EarlyBufferOverflowState)
        : undefined,
      firstSubscriberAttachedAt: data.firstSubscriberAttachedAt
        ? parseInt(data.firstSubscriberAttachedAt, 10)
        : undefined,
      durableEventCount: data.durableEventCount ? parseInt(data.durableEventCount, 10) : undefined,
      idempotencyClientRequestId: data.idempotencyClientRequestId || undefined,
      recoveredSteerId: data.recoveredSteerId || undefined,
      userMessage: data.userMessage ? JSON.parse(data.userMessage) : undefined,
      responseMessageId: data.responseMessageId || undefined,
      isRegenerate: data.isRegenerate != null ? data.isRegenerate === '1' : undefined,
      mcpRequestBody: data.mcpRequestBody ? JSON.parse(data.mcpRequestBody) : undefined,
      userSubmittedPaths: data.userSubmittedPaths ? JSON.parse(data.userSubmittedPaths) : undefined,
      userSubmittedMessageFieldPaths: data.userSubmittedMessageFieldPaths
        ? JSON.parse(data.userSubmittedMessageFieldPaths)
        : undefined,
      createdEventEmitted: data.createdEventEmitted === '1',
      sender: data.sender || undefined,
      syncSent: data.syncSent === '1',
      finalEvent: data.finalEvent || undefined,
      terminalPersistencePending:
        data.terminalPersistencePending != null
          ? data.terminalPersistencePending === '1'
          : undefined,
      terminalPersistenceStartedAt: data.terminalPersistenceStartedAt
        ? parseInt(data.terminalPersistenceStartedAt, 10)
        : undefined,
      endpoint: data.endpoint || undefined,
      iconURL: data.iconURL || undefined,
      model: data.model || undefined,
      promptTokens: data.promptTokens ? parseInt(data.promptTokens, 10) : undefined,
      agent_id: data.agent_id || undefined,
      isTemporary: data.isTemporary != null ? data.isTemporary === '1' : undefined,
      retentionExpiresAt: data.retentionExpiresAt || undefined,
      agentEventDeliveryKey: data.agentEventDeliveryKey || undefined,
      agentEventInvocationKey: data.agentEventInvocationKey || undefined,
      agentEventInvocationGenerationCreatedAt: data.agentEventInvocationGenerationCreatedAt
        ? parseInt(data.agentEventInvocationGenerationCreatedAt, 10)
        : undefined,
      agentEventDetachedActionProducerRequired:
        data.agentEventDetachedActionProducerRequired != null
          ? data.agentEventDetachedActionProducerRequired === '1'
          : undefined,
      agentEventDetachedTerminalEvidence: data.agentEventDetachedTerminalEvidence
        ? JSON.parse(data.agentEventDetachedTerminalEvidence)
        : undefined,
      agentEventBindingId: data.agentEventBindingId || undefined,
      agentEventExpectedAction: data.agentEventExpectedAction
        ? JSON.parse(data.agentEventExpectedAction)
        : undefined,
      agentEventSuspension: data.agentEventSuspension
        ? JSON.parse(data.agentEventSuspension)
        : undefined,
      agentEventLegacyTurnToken: data.agentEventLegacyTurnToken || undefined,
      scheduleId: data.scheduleId || undefined,
      scheduledFor: data.scheduledFor || undefined,
      scheduleConfigRevision: data.scheduleConfigRevision
        ? parseInt(data.scheduleConfigRevision, 10)
        : undefined,
      scheduleManual: data.scheduleManual != null ? data.scheduleManual === '1' : undefined,
      scheduleOutcome:
        data.scheduleOutcome === 'success' ||
        data.scheduleOutcome === 'error' ||
        data.scheduleOutcome === 'interrupted' ||
        data.scheduleOutcome === 'skipped_balance'
          ? data.scheduleOutcome
          : undefined,
      scheduleOutcomeError: data.scheduleOutcomeError || undefined,
      preserveForScheduleReconcile:
        data.preserveForScheduleReconcile != null
          ? data.preserveForScheduleReconcile === '1'
          : undefined,
      terminalHostActionPending:
        data.terminalHostActionPending === '1' ||
        data.detachedAgentEventTerminalHostActionPending === '1'
          ? true
          : undefined,
      detachedAgentEventTerminalHostActionPending:
        data.detachedAgentEventTerminalHostActionPending != null
          ? data.detachedAgentEventTerminalHostActionPending === '1'
          : undefined,
      detachedAgentEventTerminalStatus,
      // Deferred tools discovered before a HITL pause; replayed into createRun on resume.
      discoveredTools: data.discoveredTools ? JSON.parse(data.discoveredTools) : undefined,
      activityPhaseSnapshot: data.activityPhaseSnapshot
        ? JSON.parse(data.activityPhaseSnapshot)
        : undefined,
      compactionSemanticIndex: data.compactionSemanticIndex
        ? JSON.parse(data.compactionSemanticIndex)
        : undefined,
      /** Calibration and fading state captured at a HITL pause; without this line
       *  every Redis deployment would resume with no tier to seed. */
      contextMeta: data.contextMeta ? JSON.parse(data.contextMeta) : undefined,
      /** The owning replica's seal capability. `serializeJob` writes every
       *  boolean generically, but this mapper is explicit — omitting it here
       *  drops the flag on every read, so the steer route would compute
       *  `preemptArmed: false` and silently degrade interrupt-steer to
       *  tool-boundary steering in EVERY Redis deployment. */
      preemptCapable: data.preemptCapable != null ? data.preemptCapable === '1' : undefined,
      /** Same explicit-mapper trap as `preemptCapable`: without this line every
       *  Redis read reports the owner quote-incapable, so admission would drop
       *  all steer quotes (and their echo) in EVERY Redis deployment. */
      steerQuotesExecutionId: data.steerQuotesExecutionId || undefined,
      providerAbortReady:
        data.providerAbortReady != null ? data.providerAbortReady === '1' : undefined,
      providerExecutionId: data.providerExecutionId || undefined,
      providerExecutionStartedId: data.providerExecutionStartedId || undefined,
      providerDrained: data.providerDrained != null ? data.providerDrained === '1' : undefined,
      titleEvent: data.titleEvent || undefined,
      replayEvents: data.replayEvents || undefined,
      contextUsage: data.contextUsage || undefined,
      tokenUsage: data.tokenUsage || undefined,
      pendingAction: this.parsePendingAction(data.pendingAction),
      resolvedAskUserQuestions: this.parseResolvedAskUserQuestions(data.resolvedAskUserQuestions),
      pendingActionId: data.pendingActionId || undefined,
      lastActiveAt: data.lastActiveAt ? parseInt(data.lastActiveAt, 10) : undefined,
      /** `markActivityLabels` persists this, so it has to be read back:
       *  without it every Redis reload leaves the flag undefined and resume
       *  skips activity-label gap reconciliation, silently dropping a label
       *  that resolved between the snapshot and subscriber attach. */
      activityLabels: data.activityLabels != null ? data.activityLabels === '1' : undefined,
    };

    if (data.__creationAttemptId) {
      Object.defineProperty(job, 'creationAttemptId', {
        value: data.__creationAttemptId,
        enumerable: false,
        configurable: true,
      });
    }

    let replacedJobs: ReplacedGeneration[] = [];
    const validReplacementStatuses = new Set([
      'running',
      'requires_action',
      'complete',
      'error',
      'aborted',
    ]);
    const scalarEpochRaw = data.__replacedCreatedAt;
    const scalarStatus = data.__replacedStatus;
    if ((scalarEpochRaw != null) !== (scalarStatus != null)) {
      throw new Error('Invalid generation replacement receipt');
    }
    if (data.__replacedGenerations) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.__replacedGenerations);
      } catch {
        throw new Error('Invalid generation replacement receipt');
      }
      if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 32) {
        throw new Error('Invalid generation replacement receipt');
      }
      const seen = new Set<number>();
      let previousEpoch = -1;
      for (const value of parsed) {
        if (value == null || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('Invalid generation replacement receipt');
        }
        const candidate = value as Record<string, unknown>;
        if (
          !Number.isSafeInteger(candidate.createdAt) ||
          (candidate.createdAt as number) < 0 ||
          (candidate.createdAt as number) <= previousEpoch ||
          (candidate.createdAt as number) >= job.createdAt ||
          !validReplacementStatuses.has(candidate.status as string) ||
          (candidate.conversationId != null && typeof candidate.conversationId !== 'string') ||
          (candidate.providerAbortReady != null &&
            typeof candidate.providerAbortReady !== 'boolean') ||
          (candidate.providerExecutionId != null &&
            (typeof candidate.providerExecutionId !== 'string' ||
              candidate.providerExecutionId.length === 0 ||
              candidate.providerExecutionId.length > 128)) ||
          (candidate.providerDrained != null && typeof candidate.providerDrained !== 'boolean') ||
          (candidate.providerExecutionId != null) !== (candidate.providerDrained != null) ||
          seen.has(candidate.createdAt as number)
        ) {
          throw new Error('Invalid generation replacement receipt');
        }
        seen.add(candidate.createdAt as number);
        previousEpoch = candidate.createdAt as number;
        const receipt: ReplacedGeneration = {
          createdAt: candidate.createdAt as number,
          status: candidate.status as JobStatus,
          ...(candidate.conversationId != null && {
            conversationId: candidate.conversationId as string,
          }),
        };
        if (candidate.providerAbortReady != null) {
          Object.defineProperty(receipt, 'providerAbortReady', {
            value: candidate.providerAbortReady,
            enumerable: false,
          });
        }
        if (candidate.providerExecutionId != null) {
          Object.defineProperty(receipt, 'providerExecutionId', {
            value: candidate.providerExecutionId,
            enumerable: false,
          });
          Object.defineProperty(receipt, 'providerDrained', {
            value: candidate.providerDrained,
            enumerable: false,
          });
        }
        replacedJobs.push(receipt);
      }
      const scalarEpoch = scalarEpochRaw != null ? Number(scalarEpochRaw) : undefined;
      const latest = replacedJobs[replacedJobs.length - 1];
      if (
        !Number.isSafeInteger(scalarEpoch) ||
        scalarEpoch !== latest.createdAt ||
        scalarStatus !== latest.status ||
        (data.__replacedConversationId || undefined) !== latest.conversationId
      ) {
        throw new Error('Invalid generation replacement receipt');
      }
    } else {
      const replacedCreatedAt = scalarEpochRaw != null ? Number(scalarEpochRaw) : undefined;
      const replacedStatus = scalarStatus as JobStatus | undefined;
      if (replacedCreatedAt != null || replacedStatus != null) {
        if (
          replacedCreatedAt == null ||
          replacedStatus == null ||
          !Number.isSafeInteger(replacedCreatedAt) ||
          replacedCreatedAt < 0 ||
          replacedCreatedAt >= job.createdAt ||
          !validReplacementStatuses.has(replacedStatus)
        ) {
          throw new Error('Invalid generation replacement receipt');
        }
        replacedJobs = [
          {
            createdAt: replacedCreatedAt,
            status: replacedStatus,
            ...(data.__replacedConversationId && {
              conversationId: data.__replacedConversationId,
            }),
          },
        ];
      }
    }
    if (replacedJobs.length > 0) {
      Object.defineProperty(job, 'replacedJobs', {
        value: replacedJobs,
        enumerable: false,
        configurable: true,
      });
      Object.defineProperty(job, 'replacedJob', {
        value: replacedJobs[replacedJobs.length - 1],
        enumerable: false,
        configurable: true,
      });
    }
    return job;
  }

  /**
   * Parse a persisted `pendingAction`, defending the cold-resume path against
   * malformed or stale records: a corrupt JSON blob or a payload whose shape
   * predates the current SDK contract is dropped (logged) rather than crashing
   * the resume or feeding a bad record to an approval route. Returns undefined
   * when absent/invalid.
   */
  private parsePendingAction(raw: string | undefined): Agents.PendingAction | undefined {
    if (!raw) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(raw) as Agents.PendingAction;
      const typeOk =
        typeof parsed?.actionId === 'string' &&
        KNOWN_INTERRUPT_TYPES.has(parsed?.payload?.type as string);
      if (!typeOk) {
        logger.warn('[RedisJobStore] Dropping malformed pendingAction record');
        return undefined;
      }
      return parsed;
    } catch {
      logger.warn('[RedisJobStore] Dropping unparseable pendingAction record');
      return undefined;
    }
  }

  /** Parse the accepted ask answer retained across resume ownership transfer. */
  private parseResolvedAskUserQuestions(
    raw: string | undefined,
  ): ResolvedAskUserQuestion[] | undefined {
    if (!raw) {
      return undefined;
    }
    try {
      const value = JSON.parse(raw) as unknown;
      if (!Array.isArray(value)) {
        logger.warn('[RedisJobStore] Dropping malformed resolvedAskUserQuestions record');
        return undefined;
      }
      const parsed = value as ResolvedAskUserQuestion[];
      const valid = parsed.every((answer) => {
        if (answer == null || typeof answer !== 'object' || Array.isArray(answer)) {
          return false;
        }
        const request = answer.request;
        const requestOk =
          typeof request === 'string' ||
          (request != null &&
            typeof request === 'object' &&
            (typeof (request as Agents.AskUserQuestionRequest).question === 'string' ||
              Array.isArray((request as Agents.AskUserQuestionsRequest).questions)));
        return (
          requestOk &&
          typeof answer.output === 'string' &&
          (answer.toolCallId == null || typeof answer.toolCallId === 'string') &&
          (answer.contentIndex == null ||
            (Number.isSafeInteger(answer.contentIndex) && answer.contentIndex >= 0)) &&
          (answer.contentMissing == null || answer.contentMissing === true)
        );
      });
      if (!valid || parsed.length === 0) {
        logger.warn('[RedisJobStore] Dropping malformed resolvedAskUserQuestions record');
        return undefined;
      }
      return parsed;
    } catch {
      logger.warn('[RedisJobStore] Dropping unparseable resolvedAskUserQuestions record');
      return undefined;
    }
  }
}
