import { logger } from '@librechat/data-schemas';
import { createHash, randomUUID } from 'node:crypto';
import type {
  SubagentTaskClaim,
  SubagentTaskControlCommand,
  SubagentTaskControlResult,
  SubagentTaskSnapshot,
} from '@librechat/agents';
import type { Cluster, Redis } from 'ioredis';
import type { ActivitySnapshot } from './digest';
import { snapshotActivity, snapshotActivitySummary } from './digest';
import { createConcurrencyLimiter } from '~/utils/promise';

const PROTOCOL_VERSION = 1;
const DEFAULT_REQUEST_TIMEOUT_MS = 2_000;
const DEFAULT_RETRY_DELAY_MS = 500;
const DEFAULT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_REGISTRATION_HEARTBEAT_MS = 10_000;
const MAX_PENDING_REQUESTS = 1_000;
/** A consumed claim is retained apart from control replays so unrelated command
 * traffic cannot displace it while its caller retries. Retention is a fast path, not
 * the guarantee: the terminal result is recoverable from its durable child message. */
const MAX_CLAIM_REPLAY_ENTRIES = 2_000;
const MAX_CLAIM_REPLAY_BYTES = 16 * 1024 * 1024;
const MAX_CONTROL_REPLAY_ENTRIES = 2_000;
const MAX_CONTROL_REPLAY_BYTES = 4 * 1024 * 1024;
const RESPONSE_CACHE_TTL_MS = 5 * 60_000;
/** Absorbs ordinary clock drift between replicas when honouring a request deadline. */
const REQUEST_CLOCK_SKEW_MS = 30_000;
const MAX_SCOPE_ID_CHARS = 4_096;
const MAX_TASK_ID_CHARS = 256;
const MAX_CONTROL_MESSAGE_CHARS = 64 * 1_024;
const MAX_RESULT_CHARS = 100_000;
const MAX_ERROR_CHARS = 4 * 1_024;
const MAX_THREAD_ID_CHARS = 256;
const MAX_SUBAGENT_TYPE_CHARS = 256;
const MAX_PROGRESS_LABEL_CHARS = 1_024;
/** Bounds the model-facing task list, per owner reply and across the merged result. */
export const MAX_TASK_SNAPSHOTS = 200;
const MAX_CANCEL_THREAD_IDS = 200;
const MAX_REMOVED_CONVERSATION_IDS = MAX_CANCEL_THREAD_IDS + 1;
/** Matches the deletion drain so bounded fan-out stays well inside the lease TTL. */
const ROUTING_FANOUT_CONCURRENCY = 32;
/** Contains every bounded response even when JSON escapes each retained character. */
const MAX_ROUTED_MESSAGE_CHARS = 8 * 1_024 * 1_024;

const REGISTER_TASK_SCRIPT =
  "local now = redis.call('TIME'); " +
  'local ttl = tonumber(ARGV[3]); ' +
  'local expiresAt = (tonumber(now[1]) * 1000) + math.floor(tonumber(now[2]) / 1000) + ttl; ' +
  "redis.call('HSET', KEYS[1], ARGV[1], tostring(expiresAt) .. '|' .. ARGV[2]); " +
  "local directoryTtl = redis.call('PTTL', KEYS[1]); " +
  "if directoryTtl < ttl then redis.call('PEXPIRE', KEYS[1], ttl); end; " +
  'return 1';

const READ_ACTIVE_REGISTRATIONS_SCRIPT =
  "local now = redis.call('TIME'); " +
  'local nowMs = (tonumber(now[1]) * 1000) + math.floor(tonumber(now[2]) / 1000); ' +
  "local entries = redis.call('HGETALL', KEYS[1]); " +
  'local active = {}; ' +
  'for i = 1, #entries, 2 do ' +
  'local value = entries[i + 1]; ' +
  "local separator = string.find(value, '|', 1, true); " +
  'local expiresAt = separator and tonumber(string.sub(value, 1, separator - 1)); ' +
  'if expiresAt and expiresAt > nowMs then ' +
  'table.insert(active, entries[i]); ' +
  'table.insert(active, string.sub(value, separator + 1)); ' +
  "else redis.call('HDEL', KEYS[1], entries[i]); end; " +
  'end; ' +
  'return active';

const READ_TASK_OWNER_SCRIPT =
  "local value = redis.call('HGET', KEYS[1], ARGV[1]); " +
  'if not value then return nil; end; ' +
  "local separator = string.find(value, '|', 1, true); " +
  'local expiresAt = separator and tonumber(string.sub(value, 1, separator - 1)); ' +
  "local now = redis.call('TIME'); " +
  'local nowMs = (tonumber(now[1]) * 1000) + math.floor(tonumber(now[2]) / 1000); ' +
  "if not expiresAt or expiresAt <= nowMs then redis.call('HDEL', KEYS[1], ARGV[1]); return nil; end; " +
  'return string.sub(value, separator + 1)';

type RedisClient = Redis | Cluster;
interface RoutedRequestBase {
  version: typeof PROTOCOL_VERSION;
  kind: 'request';
  requestId: string;
  requesterId: string;
  scopeId: string;
  /** Epoch milliseconds after which the requester has stopped waiting. */
  expiresAt: number;
}

type RoutedRequest = RoutedRequestBase &
  (
    | { operation: 'claim'; taskId: string }
    | {
        operation: 'control';
        taskId: string;
        command: SubagentTaskControlCommand;
        invocationId: string;
      }
    | { operation: 'list' }
    | {
        operation: 'cancel';
        threadIds: string[] | null;
        /** Rows already committed as deleted by the requester. Owners must drop
         * receipt retry work for these exact conversations after cancellation. */
        removedConversationIds?: string[];
      }
  );

type RoutedRequestPayload =
  | { operation: 'claim'; scopeId: string; taskId: string }
  | {
      operation: 'control';
      scopeId: string;
      taskId: string;
      command: SubagentTaskControlCommand;
      invocationId: string;
    }
  | { operation: 'list'; scopeId: string }
  | {
      operation: 'cancel';
      scopeId: string;
      threadIds: string[] | null;
      removedConversationIds?: string[];
    };

interface RoutedResponse {
  version: typeof PROTOCOL_VERSION;
  kind: 'response';
  requestId: string;
  ok: boolean;
  result?: unknown;
}

/** Tells the owner a consumed result reached a caller and no longer needs retaining. */
interface RoutedAck {
  version: typeof PROTOCOL_VERSION;
  kind: 'ack';
  scopeId: string;
  taskId: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  retry: ReturnType<typeof setTimeout>;
  timeout: ReturnType<typeof setTimeout>;
}

interface CachedResponse {
  value: string;
  bytes: number;
  expiresAt: number;
  /** Content this response answered, so one id cannot replay a different command. */
  fingerprint?: string;
}

interface ReplayCache {
  entries: Map<string, CachedResponse>;
  bytes: number;
  maxEntries: number;
  maxBytes: number;
}

interface RoutedTaskList {
  snapshots: SubagentTaskSnapshot[];
  truncated: boolean;
}

interface RoutedCancelResult {
  cancelled: number;
}

interface OwnedTaskRegistration {
  scopeId: string;
  taskId: string;
  ttlMs: number;
}

export interface SubagentTaskControlHandler {
  claim(scopeId: string, taskId: string): SubagentTaskClaim;
  control(
    scopeId: string,
    taskId: string,
    command: SubagentTaskControlCommand,
    invocationId: string,
  ): Promise<SubagentTaskControlResult> | SubagentTaskControlResult;
  list(scopeId: string): SubagentTaskSnapshot[];
  /** Receipt retry work can outlive the SDK task/result buckets. Keep its owner
   * addressable so deletion can revoke work whose durable target was removed. */
  retainsTaskOwnership(scopeId: string, taskId: string): boolean;
  cancelScope(
    scopeId: string,
    threadIds: string[] | null,
    removedConversationIds?: string[],
  ): number;
}

/** Optional host transport for reaching the process that owns a live child task. */
export interface SubagentTaskControlTransport {
  bind(handler: SubagentTaskControlHandler): Promise<void>;
  registerTask(scopeId: string, taskId: string, ttlMs: number): Promise<void>;
  hasTasks(scopeId: string): Promise<boolean>;
  claim(scopeId: string, taskId: string): Promise<SubagentTaskClaim | undefined>;
  control(
    scopeId: string,
    taskId: string,
    command: SubagentTaskControlCommand,
    invocationId: string,
  ): Promise<SubagentTaskControlResult | undefined>;
  list(scopeId: string): Promise<SubagentTaskSnapshot[]>;
  cancelScope(
    scopeId: string,
    threadIds: string[] | null,
    removedConversationIds?: string[],
  ): Promise<number>;
  destroy(): Promise<void>;
}

export class SubagentTaskOwnerUnavailableError extends Error {
  constructor() {
    super('The process running this subagent task is temporarily unavailable.');
  }
}

export interface RedisSubagentTaskControlTransportOptions {
  /** Separates pub/sub channels for deployments sharing one Redis service. */
  namespace?: string;
  instanceId?: string;
  requestTimeoutMs?: number;
  retryDelayMs?: number;
  registrationHeartbeatMs?: number;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value != null && value > 0 ? value : fallback;
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('base64url').slice(0, 24);
}

function isBoundedString(value: unknown, maxChars: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxChars;
}

function isStringWithin(value: unknown, maxChars: number): value is string {
  return typeof value === 'string' && value.length <= maxChars;
}

function truncateMiddle(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const marker = '\n…[truncated]…\n';
  const available = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(available / 2);
  return `${value.slice(0, head)}${marker}${value.slice(value.length - (available - head))}`;
}

/** Progress decorations are re-validated on every hop, so a peer cannot widen them. */
function boundedSnapshot(snapshot: SubagentTaskSnapshot): ActivitySnapshot {
  const activity = snapshotActivity(snapshot);
  const activitySummary = snapshotActivitySummary(snapshot);
  return {
    ...(activity == null ? {} : { activity }),
    ...(activitySummary == null ? {} : { activitySummary }),
    taskId: truncateMiddle(snapshot.taskId, MAX_TASK_ID_CHARS),
    ...(snapshot.threadId == null
      ? {}
      : { threadId: truncateMiddle(snapshot.threadId, MAX_THREAD_ID_CHARS) }),
    subagentType: truncateMiddle(snapshot.subagentType, MAX_SUBAGENT_TYPE_CHARS),
    status: snapshot.status,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    resultAvailable: snapshot.resultAvailable,
    resultClaimed: snapshot.resultClaimed,
    pendingControls: snapshot.pendingControls,
    ...(snapshot.progress == null
      ? {}
      : {
          progress: {
            ...snapshot.progress,
            ...(snapshot.progress.label == null
              ? {}
              : { label: truncateMiddle(snapshot.progress.label, MAX_PROGRESS_LABEL_CHARS) }),
          },
        }),
    ...(snapshot.error == null ? {} : { error: truncateMiddle(snapshot.error, MAX_ERROR_CHARS) }),
  };
}

/**
 * Bounds a model-facing task list, keeping what a caller can still act on: running
 * children first, then the most recent settled results. A plain oldest-first slice
 * would drop the newest tasks, hiding a child that just started from the only tool
 * able to poll it.
 */
export function boundedTaskList(tasks: SubagentTaskSnapshot[]): SubagentTaskSnapshot[] {
  const byCreatedAt = (left: SubagentTaskSnapshot, right: SubagentTaskSnapshot): number =>
    left.createdAt - right.createdAt;
  if (tasks.length <= MAX_TASK_SNAPSHOTS) {
    return tasks.sort(byCreatedAt);
  }
  const running: SubagentTaskSnapshot[] = [];
  const settled: SubagentTaskSnapshot[] = [];
  for (const task of tasks) {
    (task.status === 'running' ? running : settled).push(task);
  }
  running.sort(byCreatedAt);
  const keptRunning = running.slice(-MAX_TASK_SNAPSHOTS);
  const remaining = MAX_TASK_SNAPSHOTS - keptRunning.length;
  if (remaining <= 0) {
    return keptRunning;
  }
  settled.sort(byCreatedAt);
  return [...keptRunning, ...settled.slice(-remaining)].sort(byCreatedAt);
}

/** Applies the shared model-facing bound to a durable child result. */
export function boundedSubagentTaskResult(result: string): string {
  return truncateMiddle(result, MAX_RESULT_CHARS);
}

/** Applies the routed result and snapshot bounds to a claim from any source. */
export function boundedClaim(claim: SubagentTaskClaim): SubagentTaskClaim {
  if (claim.status === 'not_found') {
    return claim;
  }
  const task = boundedSnapshot(claim.task);
  if (claim.status === 'completed') {
    return { status: 'completed', task, result: boundedSubagentTaskResult(claim.result) };
  }
  if (claim.status === 'error' || claim.status === 'cancelled') {
    return { status: claim.status, task, error: truncateMiddle(claim.error, MAX_ERROR_CHARS) };
  }
  return { status: claim.status, task };
}

function boundedControlResult(result: SubagentTaskControlResult): SubagentTaskControlResult {
  if (result.status === 'not_found') {
    return result;
  }
  if (result.status === 'invalid') {
    return { status: 'invalid', message: truncateMiddle(result.message, MAX_ERROR_CHARS) };
  }
  return {
    status: result.status,
    task: boundedSnapshot(result.task),
    ...(result.status === 'accepted' && result.controlId != null
      ? { controlId: truncateMiddle(result.controlId, MAX_TASK_ID_CHARS) }
      : {}),
  };
}

async function waitForRedisConnectionReady(client: RedisClient): Promise<void> {
  if (client.status == null || client.status === 'ready') {
    return;
  }
  if (client.status === 'end') {
    throw new SubagentTaskOwnerUnavailableError();
  }
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      client.off('ready', onReady);
      client.off('end', onEnd);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onEnd = () => {
      cleanup();
      reject(new SubagentTaskOwnerUnavailableError());
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new SubagentTaskOwnerUnavailableError());
    }, DEFAULT_READY_TIMEOUT_MS);
    timeout.unref?.();
    client.once('ready', onReady);
    client.once('end', onEnd);
    /** Close the status-check/listener-registration race: ioredis may become ready
     * synchronously between the check above and installing these listeners. */
    if (client.status === 'ready') {
      onReady();
    } else if (client.status === 'end') {
      onEnd();
    } else if (client.status === 'wait') {
      client.connect().catch(onEnd);
    }
  });
}

async function waitForRedisReady(
  client: RedisClient,
  options: { eagerClusterMasters?: boolean } = {},
): Promise<void> {
  await waitForRedisConnectionReady(client);
  if (options.eagerClusterMasters !== true || !client.isCluster) {
    return;
  }
  /** A ready Cluster has a slot map but its per-master connections are lazy. The
   * fail-fast publisher cannot admit requests until every possible write target is
   * connected; otherwise the first command to a cold shard would be rejected. */
  await Promise.all(
    (client as Cluster).nodes('master').map((node) => waitForRedisConnectionReady(node)),
  );
}

function isSnapshot(value: unknown): value is SubagentTaskSnapshot {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<SubagentTaskSnapshot>;
  return (
    isBoundedString(candidate.taskId, MAX_TASK_ID_CHARS) &&
    typeof candidate.subagentType === 'string' &&
    ['running', 'completed', 'error', 'cancelled'].includes(candidate.status ?? '') &&
    typeof candidate.createdAt === 'number' &&
    typeof candidate.updatedAt === 'number' &&
    typeof candidate.resultAvailable === 'boolean' &&
    typeof candidate.resultClaimed === 'boolean' &&
    typeof candidate.pendingControls === 'number'
  );
}

function isClaim(value: unknown): value is SubagentTaskClaim {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<SubagentTaskClaim>;
  if (candidate.status === 'not_found') {
    return true;
  }
  if (!('task' in candidate) || !isSnapshot(candidate.task)) {
    return false;
  }
  if (candidate.status === 'completed') {
    return 'result' in candidate && typeof candidate.result === 'string';
  }
  if (candidate.status === 'error' || candidate.status === 'cancelled') {
    return 'error' in candidate && typeof candidate.error === 'string';
  }
  return candidate.status === 'running' || candidate.status === 'claimed';
}

function isControlResult(value: unknown): value is SubagentTaskControlResult {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<SubagentTaskControlResult>;
  if (candidate.status === 'not_found') {
    return true;
  }
  if (candidate.status === 'invalid') {
    return typeof candidate.message === 'string';
  }
  return (
    ['accepted', 'cancelled', 'not_running', 'control_not_found'].includes(
      candidate.status ?? '',
    ) &&
    'task' in candidate &&
    isSnapshot(candidate.task)
  );
}

function isCancelThreadIds(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_CANCEL_THREAD_IDS &&
    value.every((threadId) => isBoundedString(threadId, MAX_THREAD_ID_CHARS))
  );
}

function isCancelResult(value: unknown): value is RoutedCancelResult {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const { cancelled } = value as Partial<RoutedCancelResult>;
  return Number.isSafeInteger(cancelled) && (cancelled as number) >= 0;
}

function controlContent(command: SubagentTaskControlCommand): string {
  if (command.action === 'cancel') {
    return 'cancel';
  }
  if (command.action === 'cancel_message') {
    return `cancel_message\u0000${command.controlId}`;
  }
  return `${command.action}\u0000${command.message}`;
}

/**
 * Canonical identity of one control's content. Property order cannot vary it, so the
 * transport and the owning task store agree on when two commands are the same, and it
 * is hashed so retaining one costs a fixed few bytes rather than a whole message.
 */
export function controlFingerprint(command: SubagentTaskControlCommand): string {
  return createHash('sha256').update(controlContent(command)).digest('base64url');
}

/** True once a claim has consumed the task's one-shot terminal result. */
function consumesResult(result: SubagentTaskClaim): boolean {
  return (
    result.status === 'completed' || result.status === 'error' || result.status === 'cancelled'
  );
}

function isRoutedTaskList(value: unknown): value is RoutedTaskList {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<RoutedTaskList>;
  return (
    Array.isArray(candidate.snapshots) &&
    candidate.snapshots.every(isSnapshot) &&
    typeof candidate.truncated === 'boolean'
  );
}

function parseControlCommand(value: unknown): SubagentTaskControlCommand | undefined {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as { action?: unknown; message?: unknown; controlId?: unknown };
  if (candidate.action === 'cancel') {
    return { action: 'cancel' };
  }
  if (candidate.action === 'cancel_message') {
    return isStringWithin(candidate.controlId, MAX_TASK_ID_CHARS)
      ? { action: 'cancel_message', controlId: candidate.controlId }
      : undefined;
  }
  if (
    (candidate.action === 'steer' ||
      candidate.action === 'queue' ||
      candidate.action === 'interrupt') &&
    isStringWithin(candidate.message, MAX_CONTROL_MESSAGE_CHARS)
  ) {
    return { action: candidate.action, message: candidate.message };
  }
  return undefined;
}

function failureResponse(requestId: string): string {
  const response: RoutedResponse = {
    version: PROTOCOL_VERSION,
    kind: 'response',
    requestId,
    ok: false,
  };
  return JSON.stringify(response);
}

function successResponse(requestId: string, result: string): string {
  return `{"version":${PROTOCOL_VERSION},"kind":"response","requestId":${JSON.stringify(
    requestId,
  )},"ok":true,"result":${result}}`;
}

function parseRequest(value: unknown): RoutedRequest | undefined {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as {
    version?: unknown;
    kind?: unknown;
    requestId?: unknown;
    requesterId?: unknown;
    operation?: unknown;
    scopeId?: unknown;
    taskId?: unknown;
    command?: unknown;
    threadIds?: unknown;
    removedConversationIds?: unknown;
    invocationId?: unknown;
    expiresAt?: unknown;
  };
  if (
    candidate.version !== PROTOCOL_VERSION ||
    candidate.kind !== 'request' ||
    !isBoundedString(candidate.requestId, 128) ||
    !isBoundedString(candidate.requesterId, 128) ||
    !['claim', 'control', 'list', 'cancel'].includes(
      typeof candidate.operation === 'string' ? candidate.operation : '',
    ) ||
    !isBoundedString(candidate.scopeId, MAX_SCOPE_ID_CHARS) ||
    !Number.isSafeInteger(candidate.expiresAt)
  ) {
    return undefined;
  }
  const expiresAt = candidate.expiresAt as number;
  if (candidate.operation === 'list') {
    return {
      version: PROTOCOL_VERSION,
      kind: 'request',
      requestId: candidate.requestId,
      requesterId: candidate.requesterId,
      expiresAt,
      operation: 'list',
      scopeId: candidate.scopeId,
    };
  }
  if (candidate.operation === 'cancel') {
    if (candidate.threadIds !== null && !isCancelThreadIds(candidate.threadIds)) {
      return undefined;
    }
    if (
      candidate.removedConversationIds !== undefined &&
      (!Array.isArray(candidate.removedConversationIds) ||
        candidate.removedConversationIds.length > MAX_REMOVED_CONVERSATION_IDS ||
        !candidate.removedConversationIds.every((id) => isBoundedString(id, MAX_THREAD_ID_CHARS)))
    ) {
      return undefined;
    }
    return {
      version: PROTOCOL_VERSION,
      kind: 'request',
      requestId: candidate.requestId,
      requesterId: candidate.requesterId,
      expiresAt,
      operation: 'cancel',
      scopeId: candidate.scopeId,
      threadIds: candidate.threadIds,
      ...(candidate.removedConversationIds === undefined
        ? {}
        : { removedConversationIds: candidate.removedConversationIds }),
    };
  }
  if (!isBoundedString(candidate.taskId, MAX_TASK_ID_CHARS)) {
    return undefined;
  }
  if (candidate.operation === 'claim') {
    return {
      version: PROTOCOL_VERSION,
      kind: 'request',
      requestId: candidate.requestId,
      requesterId: candidate.requesterId,
      expiresAt,
      operation: 'claim',
      scopeId: candidate.scopeId,
      taskId: candidate.taskId,
    };
  }
  const command = parseControlCommand(candidate.command);
  if (command == null || !isBoundedString(candidate.invocationId, 128)) {
    return undefined;
  }
  return {
    version: PROTOCOL_VERSION,
    kind: 'request',
    requestId: candidate.requestId,
    requesterId: candidate.requesterId,
    expiresAt,
    operation: 'control',
    scopeId: candidate.scopeId,
    taskId: candidate.taskId,
    command,
    invocationId: candidate.invocationId,
  };
}

function createReplayCache(maxEntries: number, maxBytes: number): ReplayCache {
  return { entries: new Map(), bytes: 0, maxEntries, maxBytes };
}

function parseAck(value: unknown): RoutedAck | undefined {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Partial<RoutedAck>;
  if (
    candidate.version !== PROTOCOL_VERSION ||
    candidate.kind !== 'ack' ||
    !isBoundedString(candidate.scopeId, MAX_SCOPE_ID_CHARS) ||
    !isBoundedString(candidate.taskId, MAX_TASK_ID_CHARS)
  ) {
    return undefined;
  }
  return {
    version: PROTOCOL_VERSION,
    kind: 'ack',
    scopeId: candidate.scopeId,
    taskId: candidate.taskId,
  };
}

function parseResponse(value: unknown): RoutedResponse | undefined {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Partial<RoutedResponse>;
  if (
    candidate.version !== PROTOCOL_VERSION ||
    candidate.kind !== 'response' ||
    !isBoundedString(candidate.requestId, 128) ||
    typeof candidate.ok !== 'boolean'
  ) {
    return undefined;
  }
  return candidate as RoutedResponse;
}

/**
 * Routes bounded live-task operations to their owning API replica. Redis keeps
 * only an expiring owner directory and request/reply envelopes; the executor,
 * transcript, and checkpoint never move between processes.
 */
export class RedisSubagentTaskControlTransport implements SubagentTaskControlTransport {
  private readonly instanceId: string;
  private readonly namespaceHash: string;
  private readonly requestTimeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly registrationHeartbeatMs: number;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly claimReplays = createReplayCache(
    MAX_CLAIM_REPLAY_ENTRIES,
    MAX_CLAIM_REPLAY_BYTES,
  );

  private readonly controlReplays = createReplayCache(
    MAX_CONTROL_REPLAY_ENTRIES,
    MAX_CONTROL_REPLAY_BYTES,
  );

  private readonly ownedTasks = new Map<string, OwnedTaskRegistration>();
  private handler?: SubagentTaskControlHandler;
  private ready?: Promise<void>;
  private registrationHeartbeat?: ReturnType<typeof setInterval>;
  private registrationRefresh?: Promise<void>;
  private destroyed = false;

  constructor(
    private readonly publisher: RedisClient,
    private readonly subscriber: RedisClient,
    options: RedisSubagentTaskControlTransportOptions = {},
  ) {
    this.instanceId = options.instanceId?.trim() || randomUUID();
    this.namespaceHash = shortHash(options.namespace?.trim() || 'default');
    this.requestTimeoutMs = positiveInteger(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    this.retryDelayMs = Math.min(
      positiveInteger(options.retryDelayMs, DEFAULT_RETRY_DELAY_MS),
      Math.max(1, Math.floor(this.requestTimeoutMs / 2)),
    );
    this.registrationHeartbeatMs = positiveInteger(
      options.registrationHeartbeatMs,
      DEFAULT_REGISTRATION_HEARTBEAT_MS,
    );
  }

  async bind(handler: SubagentTaskControlHandler): Promise<void> {
    if (this.destroyed) {
      throw new Error('Subagent task control transport is closed.');
    }
    if (this.handler != null) {
      throw new Error('Subagent task control transport is already bound.');
    }
    this.handler = handler;
    /** The publisher fails fast instead of queueing commands, so opening HTTP
     * admission before it is ready would turn healthy startup lag into false
     * `unavailable` results. Both dedicated connections are part of readiness. */
    await Promise.all([
      waitForRedisReady(this.publisher, { eagerClusterMasters: true }),
      waitForRedisReady(this.subscriber),
    ]);
    this.subscriber.on('message', this.onMessage);
    this.ready = this.subscriber.subscribe(this.channel(this.instanceId)).then(() => undefined);
    await this.ready;
  }

  async registerTask(scopeId: string, taskId: string, ttlMs: number): Promise<void> {
    this.assertTaskAddress(scopeId, taskId);
    const registration = {
      scopeId,
      taskId,
      ttlMs: positiveInteger(ttlMs, 1),
    };
    this.ownedTasks.set(this.registrationKey(scopeId, taskId), registration);
    this.ensureRegistrationHeartbeat();
    await this.publishRegistration(registration);
  }

  async hasTasks(scopeId: string): Promise<boolean> {
    this.assertScope(scopeId);
    await this.requireReady();
    try {
      return Object.keys(await this.readActiveRegistrations(scopeId)).length > 0;
    } catch (error) {
      logger.warn('[subagentTaskRouting] Failed to inspect the task owner directory', error);
      throw new SubagentTaskOwnerUnavailableError();
    }
  }

  async claim(scopeId: string, taskId: string): Promise<SubagentTaskClaim | undefined> {
    const routed = await this.requestTaskOwner(scopeId, taskId, 'claim');
    if (routed == null) {
      return undefined;
    }
    const { ownerId, result } = routed;
    if (!isClaim(result)) {
      throw new SubagentTaskOwnerUnavailableError();
    }
    if (result.status === 'not_found') {
      await this.removeRegistrations(scopeId, [taskId]);
      return undefined;
    }
    if (consumesResult(result)) {
      /** Frees the owner's retained copy immediately. An acknowledgement that cannot
       * be confirmed only leaves that copy to expire, so the caller still keeps the
       * result it is holding rather than trading it for a retry. */
      await this.acknowledgeClaim(ownerId, scopeId, taskId);
    }
    return result;
  }

  async control(
    scopeId: string,
    taskId: string,
    command: SubagentTaskControlCommand,
    invocationId: string,
  ): Promise<SubagentTaskControlResult | undefined> {
    const routed = await this.requestTaskOwner(scopeId, taskId, 'control', command, invocationId);
    if (routed == null) {
      return undefined;
    }
    const { result } = routed;
    if (!isControlResult(result)) {
      throw new SubagentTaskOwnerUnavailableError();
    }
    if (result.status === 'not_found') {
      await this.removeRegistrations(scopeId, [taskId]);
      return undefined;
    }
    return result;
  }

  async list(scopeId: string): Promise<SubagentTaskSnapshot[]> {
    this.assertScope(scopeId);
    await this.requireReady();
    let ownersByTask: Record<string, string>;
    try {
      ownersByTask = await this.readActiveRegistrations(scopeId);
    } catch (error) {
      logger.warn('[subagentTaskRouting] Failed to read the task owner directory', error);
      throw new SubagentTaskOwnerUnavailableError();
    }
    const owners = new Set(Object.values(ownersByTask));
    owners.delete(this.instanceId);
    if (owners.size === 0) {
      return [];
    }
    const ownerIds = [...owners];
    const results = await Promise.all(
      ownerIds.map((ownerId) => this.sendRequest(ownerId, { operation: 'list', scopeId })),
    );
    const snapshots: SubagentTaskSnapshot[] = [];
    const staleTaskIds: string[] = [];
    for (const [index, value] of results.entries()) {
      if (!isRoutedTaskList(value)) {
        throw new SubagentTaskOwnerUnavailableError();
      }
      const ownerId = ownerIds[index];
      const reportedTaskIds = new Set(value.snapshots.map((snapshot) => snapshot.taskId));
      for (const snapshot of value.snapshots) {
        if (ownersByTask[snapshot.taskId] === ownerId) {
          snapshots.push(snapshot);
        }
      }
      if (!value.truncated) {
        for (const [taskId, registeredOwnerId] of Object.entries(ownersByTask)) {
          if (registeredOwnerId === ownerId && !reportedTaskIds.has(taskId)) {
            staleTaskIds.push(taskId);
          }
        }
      }
    }
    if (staleTaskIds.length > 0) {
      await this.removeRegistrations(scopeId, staleTaskIds);
    }
    /** Each owner bounds its own reply, so without an aggregate cap this grows with the
     * number of replicas holding the scope. Bounding after the loop rather than during
     * it keeps the sweep above reading every owner's reply, and lets the cap choose by
     * status instead of by whichever owner answered first. */
    return boundedTaskList(snapshots);
  }

  /**
   * Cancels live children on every other owner of this scope. The owner applies the
   * predicate to its complete local task set, so deletion never depends on the
   * bounded model-facing list and cannot miss a task beyond that cap.
   */
  async cancelScope(
    scopeId: string,
    threadIds: string[] | null,
    removedConversationIds: string[] = [],
  ): Promise<number> {
    this.assertScope(scopeId);
    if (threadIds != null && threadIds.length === 0) {
      return 0;
    }
    await this.requireReady();
    let ownersByTask: Record<string, string>;
    try {
      ownersByTask = await this.readActiveRegistrations(scopeId);
    } catch (error) {
      logger.warn('[subagentTaskRouting] Failed to read the task owner directory', error);
      throw new SubagentTaskOwnerUnavailableError();
    }
    const owners = new Set(Object.values(ownersByTask));
    owners.delete(this.instanceId);
    if (owners.size === 0) {
      return 0;
    }
    const batches: Array<string[] | null> = [];
    if (threadIds == null) {
      batches.push(null);
    } else {
      for (let index = 0; index < threadIds.length; index += MAX_CANCEL_THREAD_IDS) {
        batches.push(threadIds.slice(index, index + MAX_CANCEL_THREAD_IDS));
      }
    }
    const cancelSlot = createConcurrencyLimiter(ROUTING_FANOUT_CONCURRENCY);
    const requests: Array<Promise<unknown>> = [];
    const allTargetThreadIds = threadIds == null ? null : new Set(threadIds);
    for (const ownerId of owners) {
      for (const batch of batches) {
        const batchThreadIds = batch == null ? null : new Set(batch);
        const removedForBatch = removedConversationIds.filter(
          (conversationId) =>
            allTargetThreadIds == null ||
            !allTargetThreadIds.has(conversationId) ||
            batchThreadIds?.has(conversationId) === true,
        );
        requests.push(
          cancelSlot(() =>
            this.sendRequest(ownerId, {
              operation: 'cancel',
              scopeId,
              threadIds: batch,
              ...(removedForBatch.length === 0 ? {} : { removedConversationIds: removedForBatch }),
            }),
          ),
        );
      }
    }
    let cancelled = 0;
    for (const value of await Promise.all(requests)) {
      if (!isCancelResult(value)) {
        throw new SubagentTaskOwnerUnavailableError();
      }
      cancelled += value.cancelled;
    }
    return cancelled;
  }

  async destroy(): Promise<void> {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.retry);
      clearTimeout(pending.timeout);
      pending.reject(new SubagentTaskOwnerUnavailableError());
    }
    this.pending.clear();
    for (const cache of [this.claimReplays, this.controlReplays]) {
      cache.entries.clear();
      cache.bytes = 0;
    }
    this.ownedTasks.clear();
    if (this.registrationHeartbeat != null) {
      clearInterval(this.registrationHeartbeat);
      this.registrationHeartbeat = undefined;
    }
    this.subscriber.off('message', this.onMessage);
    await this.subscriber.unsubscribe(this.channel(this.instanceId)).catch(() => undefined);
    this.subscriber.disconnect();
  }

  private readonly onMessage = (channel: string, message: string): void => {
    if (channel !== this.channel(this.instanceId) || message.length > MAX_ROUTED_MESSAGE_CHARS) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(message) as unknown;
    } catch {
      return;
    }
    const response = parseResponse(parsed);
    if (response != null) {
      this.handleResponse(response);
      return;
    }
    const ack = parseAck(parsed);
    if (ack != null) {
      this.releaseClaimReplay(ack.scopeId, ack.taskId);
      return;
    }
    const request = parseRequest(parsed);
    if (request != null) {
      void this.handleRequest(request).catch((error) => {
        logger.warn('[subagentTaskRouting] Failed to answer a routed command', error);
      });
    }
  };

  private handleResponse(response: RoutedResponse): void {
    const pending = this.pending.get(response.requestId);
    if (pending == null) {
      return;
    }
    this.pending.delete(response.requestId);
    clearTimeout(pending.retry);
    clearTimeout(pending.timeout);
    if (!response.ok) {
      pending.reject(new SubagentTaskOwnerUnavailableError());
      return;
    }
    pending.resolve(response.result);
  }

  private async handleRequest(request: RoutedRequest): Promise<void> {
    if (Date.now() > request.expiresAt + REQUEST_CLOCK_SKEW_MS) {
      /** The caller stopped waiting for this long ago and has been told it was
       * unavailable, so applying it now would steer a child it believes untouched. */
      logger.warn('[subagentTaskRouting] Dropped a routed command past its deadline');
      return;
    }
    const replay = this.replayFor(request);
    const cached = replay?.cache.entries.get(replay.key);
    /** A retransmission replays; the same id carrying different content is a caller
     * error, so it reaches the owner, which refuses it, rather than being answered
     * from the earlier command's response. */
    if (
      cached != null &&
      cached.expiresAt > Date.now() &&
      cached.fingerprint === replay?.fingerprint
    ) {
      await this.publish(
        this.channel(request.requesterId),
        successResponse(request.requestId, cached.value),
      );
      return;
    }
    const handler = this.handler;
    if (handler == null) {
      return;
    }
    let serialized: string;
    try {
      let result:
        | SubagentTaskClaim
        | SubagentTaskControlResult
        | RoutedTaskList
        | RoutedCancelResult;
      /** A claim that consumed nothing stays uncached so a later poll still observes
       * the task's live status. */
      let replayable = replay != null;
      if (request.operation === 'list') {
        const tasks = handler.list(request.scopeId);
        /** Bounded the same way the requester bounds the merge: a positional slice here
         * would drop this owner's running children before they ever reached it. */
        const bounded = boundedTaskList(tasks);
        result = {
          snapshots: bounded.map(boundedSnapshot),
          truncated: tasks.length > bounded.length,
        };
      } else if (request.operation === 'cancel') {
        result = {
          cancelled: handler.cancelScope(
            request.scopeId,
            request.threadIds,
            request.removedConversationIds,
          ),
        };
      } else if (request.operation === 'claim') {
        const claim = boundedClaim(handler.claim(request.scopeId, request.taskId));
        replayable = consumesResult(claim);
        result = claim;
      } else {
        result = boundedControlResult(
          await handler.control(
            request.scopeId,
            request.taskId,
            request.command,
            request.invocationId,
          ),
        );
      }
      const serializedResult = JSON.stringify(result);
      /** Retaining the result rather than the envelope lets a later caller retry,
       * which carries its own correlation id, recover a response it never received. */
      if (replay != null && replayable) {
        this.retainReplay(replay.cache, replay.key, serializedResult, replay.fingerprint);
      }
      serialized = successResponse(request.requestId, serializedResult);
    } catch (error) {
      logger.error('[subagentTaskRouting] Owner failed to process a routed command', error);
      serialized = failureResponse(request.requestId);
    }
    await this.publish(this.channel(request.requesterId), serialized);
  }

  /**
   * Locates a destructive operation's replay slot. A claim consumes the one-shot
   * result, so it is keyed by operation—stable across callers and replicas, so a
   * later poll still resolves to the response the owner produced. Lists are
   * idempotent and recomputable, so their large bodies are never retained.
   */
  private replayFor(
    request: RoutedRequest,
  ): { cache: ReplayCache; key: string; fingerprint?: string } | undefined {
    if (request.operation === 'list') {
      return undefined;
    }
    if (request.operation === 'claim') {
      return {
        cache: this.claimReplays,
        key: this.claimReplayKey(request.scopeId, request.taskId),
      };
    }
    if (request.operation === 'cancel') {
      return { cache: this.controlReplays, key: `cancel\u0000${request.requestId}` };
    }
    /** Task-scoped: a provider tool-call id such as `call_0` repeats across runs and
     * agents, so keying on it alone would answer one task from another's snapshot. */
    return {
      cache: this.controlReplays,
      key: `control\u0000${shortHash(request.scopeId)}\u0000${request.taskId}\u0000${request.invocationId}`,
      fingerprint: controlFingerprint(request.command),
    };
  }

  private claimReplayKey(scopeId: string, taskId: string): string {
    return `claim\u0000${shortHash(scopeId)}\u0000${taskId}`;
  }

  /**
   * Releases a retained result once a caller confirms holding it, so a delivered
   * result frees its slot immediately instead of waiting out the replay window.
   */
  private releaseClaimReplay(scopeId: string, taskId: string): void {
    const key = this.claimReplayKey(scopeId, taskId);
    const cached = this.claimReplays.entries.get(key);
    if (cached == null) {
      return;
    }
    this.claimReplays.entries.delete(key);
    this.claimReplays.bytes -= cached.bytes;
  }

  /**
   * Tells the owner it may release a delivered result. Delivery to zero subscribers is
   * not an acknowledgement, so this retries inside the ordinary request window.
   */
  private async acknowledgeClaim(ownerId: string, scopeId: string, taskId: string): Promise<void> {
    const ack: RoutedAck = { version: PROTOCOL_VERSION, kind: 'ack', scopeId, taskId };
    const serialized = JSON.stringify(ack);
    const destination = this.channel(ownerId);
    const deadline = Date.now() + this.requestTimeoutMs;
    for (;;) {
      try {
        if ((await this.publish(destination, serialized)) > 0) {
          return;
        }
      } catch (error) {
        logger.warn('[subagentTaskRouting] Failed to acknowledge a claimed result', error);
      }
      if (Date.now() + this.retryDelayMs >= deadline) {
        return;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.retryDelayMs);
        timer.unref?.();
      });
    }
  }

  private async requestTaskOwner(
    scopeId: string,
    taskId: string,
    operation: 'claim' | 'control',
    command?: SubagentTaskControlCommand,
    invocationId?: string,
  ): Promise<{ ownerId: string; result: unknown } | undefined> {
    this.assertTaskAddress(scopeId, taskId);
    await this.requireReady();
    let ownerId: string | null;
    try {
      ownerId = (await this.publisher.eval(
        READ_TASK_OWNER_SCRIPT,
        1,
        this.registryKey(scopeId),
        taskId,
      )) as string | null;
    } catch (error) {
      logger.warn('[subagentTaskRouting] Failed to resolve the task owner', error);
      throw new SubagentTaskOwnerUnavailableError();
    }
    if (!isBoundedString(ownerId, 128)) {
      return undefined;
    }
    if (operation === 'claim') {
      return { ownerId, result: await this.sendRequest(ownerId, { operation, scopeId, taskId }) };
    }
    if (command == null || invocationId == null) {
      throw new Error('A routed subagent control command and invocation id are required.');
    }
    return {
      ownerId,
      result: await this.sendRequest(ownerId, {
        operation,
        scopeId,
        taskId,
        command,
        invocationId,
      }),
    };
  }

  private async sendRequest(ownerId: string, request: RoutedRequestPayload): Promise<unknown> {
    await this.requireReady();
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      throw new SubagentTaskOwnerUnavailableError();
    }
    const requestId = randomUUID();
    /** Carried so a request the caller has stopped waiting for cannot be applied
     * later: a disconnected publisher queues the envelope offline and delivers it
     * after this deadline, by which time the caller has been told `unavailable`. */
    const envelope: RoutedRequest = {
      version: PROTOCOL_VERSION,
      kind: 'request',
      requestId,
      requesterId: this.instanceId,
      expiresAt: Date.now() + this.requestTimeoutMs,
      ...request,
    };
    const serialized = JSON.stringify(envelope);
    const destination = this.channel(ownerId);
    return new Promise<unknown>((resolve, reject) => {
      const retry = setTimeout(() => {
        void this.publish(destination, serialized).catch((error) => {
          logger.warn('[subagentTaskRouting] Routed command retry failed', error);
        });
      }, this.retryDelayMs);
      retry.unref?.();
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        clearTimeout(retry);
        reject(new SubagentTaskOwnerUnavailableError());
      }, this.requestTimeoutMs);
      timeout.unref?.();
      this.pending.set(requestId, { resolve, reject, retry, timeout });
      void this.publish(destination, serialized).catch((error) => {
        logger.warn('[subagentTaskRouting] Routed command publish failed', error);
      });
    });
  }

  private pruneExpiredReplays(cache: ReplayCache): void {
    const now = Date.now();
    for (const [id, cached] of cache.entries) {
      if (cached.expiresAt != null && cached.expiresAt <= now) {
        cache.entries.delete(id);
        cache.bytes -= cached.bytes;
      }
    }
  }

  private retainReplay(cache: ReplayCache, key: string, value: string, fingerprint?: string): void {
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes > cache.maxBytes) {
      return;
    }
    this.pruneExpiredReplays(cache);
    /** Replacing a key is not an additional entry: leaving the old one counted would
     * inflate the cache's byte total permanently and evict unrelated responses. */
    const replaced = cache.entries.get(key);
    if (replaced != null) {
      cache.entries.delete(key);
      cache.bytes -= replaced.bytes;
    }
    while (cache.entries.size >= cache.maxEntries || cache.bytes + bytes > cache.maxBytes) {
      const oldest = cache.entries.keys().next().value as string | undefined;
      if (oldest == null) {
        break;
      }
      const evicted = cache.entries.get(oldest);
      cache.entries.delete(oldest);
      cache.bytes -= evicted?.bytes ?? 0;
    }
    cache.entries.set(key, {
      value,
      bytes,
      expiresAt: Date.now() + RESPONSE_CACHE_TTL_MS,
      ...(fingerprint == null ? {} : { fingerprint }),
    });
    cache.bytes += bytes;
  }

  private async publish(channel: string, value: string): Promise<number> {
    const delivered = await this.publisher.publish(channel, value);
    return typeof delivered === 'number' ? delivered : 0;
  }

  private ensureRegistrationHeartbeat(): void {
    if (this.registrationHeartbeat != null || this.destroyed) {
      return;
    }
    this.registrationHeartbeat = setInterval(() => {
      if (this.registrationRefresh != null) {
        return;
      }
      const refresh = this.refreshRegistrations()
        .catch((error) => {
          logger.warn('[subagentTaskRouting] Failed to refresh child-task owners', error);
        })
        .finally(() => {
          if (this.registrationRefresh === refresh) {
            this.registrationRefresh = undefined;
          }
        });
      this.registrationRefresh = refresh;
    }, this.registrationHeartbeatMs);
    this.registrationHeartbeat.unref?.();
  }

  private async refreshRegistrations(): Promise<void> {
    const handler = this.handler;
    if (handler == null || this.destroyed || this.ownedTasks.size === 0) {
      return;
    }
    const localTaskIdsByScope = new Map<string, Set<string>>();
    const staleTaskIdsByScope = new Map<string, string[]>();
    const retained: OwnedTaskRegistration[] = [];
    for (const registration of this.ownedTasks.values()) {
      const { scopeId, taskId } = registration;
      let localTaskIds = localTaskIdsByScope.get(scopeId);
      if (localTaskIds == null) {
        localTaskIds = new Set(handler.list(scopeId).map((task) => task.taskId));
        localTaskIdsByScope.set(scopeId, localTaskIds);
      }
      /** A retained result is only reachable while its owner stays registered, so the
       * address outlives the task itself until the result is acknowledged. */
      if (
        localTaskIds.has(taskId) ||
        this.claimReplays.entries.has(this.claimReplayKey(scopeId, taskId)) ||
        handler.retainsTaskOwnership(scopeId, taskId)
      ) {
        retained.push(registration);
        continue;
      }
      this.ownedTasks.delete(this.registrationKey(scopeId, taskId));
      const staleTaskIds = staleTaskIdsByScope.get(scopeId) ?? [];
      staleTaskIds.push(taskId);
      staleTaskIdsByScope.set(scopeId, staleTaskIds);
    }
    /** Serializing one EVAL per registration can outlast the lease TTL, so a pass
     * refreshes in bounded parallel batches and one failure cannot cancel the rest. */
    const refreshSlot = createConcurrencyLimiter(ROUTING_FANOUT_CONCURRENCY);
    await Promise.all([
      ...[...staleTaskIdsByScope].map(([scopeId, taskIds]) =>
        refreshSlot(() => this.removeRegistrations(scopeId, taskIds)),
      ),
      ...retained.map((registration) =>
        refreshSlot(() =>
          this.publishRegistration(registration).catch((error) => {
            logger.warn('[subagentTaskRouting] Failed to refresh a child-task owner', error);
          }),
        ),
      ),
    ]);
  }

  private async publishRegistration(registration: OwnedTaskRegistration): Promise<void> {
    await this.requireReady();
    await this.publisher.eval(
      REGISTER_TASK_SCRIPT,
      1,
      this.registryKey(registration.scopeId),
      registration.taskId,
      this.instanceId,
      registration.ttlMs.toString(),
    );
  }

  private async readActiveRegistrations(scopeId: string): Promise<Record<string, string>> {
    const value = (await this.publisher.eval(
      READ_ACTIVE_REGISTRATIONS_SCRIPT,
      1,
      this.registryKey(scopeId),
    )) as unknown;
    if (!Array.isArray(value) || value.length % 2 !== 0) {
      throw new SubagentTaskOwnerUnavailableError();
    }
    const registrations: Record<string, string> = {};
    for (let index = 0; index < value.length; index += 2) {
      const taskId = value[index];
      const ownerId = value[index + 1];
      if (!isBoundedString(taskId, MAX_TASK_ID_CHARS) || !isBoundedString(ownerId, 128)) {
        throw new SubagentTaskOwnerUnavailableError();
      }
      registrations[taskId] = ownerId;
    }
    return registrations;
  }

  private async removeRegistrations(scopeId: string, taskIds: string[]): Promise<void> {
    if (taskIds.length === 0) {
      return;
    }
    await this.publisher.hdel(this.registryKey(scopeId), ...taskIds).catch((error) => {
      logger.warn('[subagentTaskRouting] Failed to prune stale task owners', error);
    });
  }

  private registryKey(scopeId: string): string {
    return `subagent-task:{${shortHash(scopeId)}}:owners`;
  }

  private registrationKey(scopeId: string, taskId: string): string {
    return `${scopeId}\u0000${taskId}`;
  }

  private channel(instanceId: string): string {
    return `subagent-task-control:${this.namespaceHash}:${instanceId}`;
  }

  private assertScope(scopeId: string): void {
    if (!isBoundedString(scopeId, MAX_SCOPE_ID_CHARS)) {
      throw new Error('Invalid subagent task routing scope.');
    }
  }

  private assertTaskAddress(scopeId: string, taskId: string): void {
    this.assertScope(scopeId);
    if (!isBoundedString(taskId, MAX_TASK_ID_CHARS)) {
      throw new Error('Invalid subagent task routing identity.');
    }
  }

  private async requireReady(): Promise<void> {
    if (this.destroyed || this.ready == null) {
      throw new SubagentTaskOwnerUnavailableError();
    }
    await this.ready;
  }
}
