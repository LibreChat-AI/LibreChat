import { createHash } from 'node:crypto';
import type {
  RuntimeJournal,
  RuntimeJournalFailure,
  RuntimeJournalResult,
  RuntimeJournalState,
} from './journal';

/** Operator-supplied client; no app singleton or credentials cross the runtime boundary. */
export interface RuntimeJournalRedis {
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
}
export interface RuntimeJournalLimits {
  prefix: string;
  retentionMs: number;
  leaseMs: number;
  maxFrames: number;
  maxBytes: number;
  maxBatchFrames: number;
  maxBatchBytes: number;
}
const SCRIPT = `
local op, scope, owner = ARGV[1], ARGV[2], ARGV[3]
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local retention, lease = tonumber(ARGV[5]), tonumber(ARGV[6])
local function touch()
  for _, key in ipairs(KEYS) do redis.call('PEXPIRE', key, retention) end
end
local function fail(code) return {0, code} end
if op == 'create' and redis.call('EXISTS', KEYS[1]) == 0 then
  redis.call('HSET', KEYS[1], 'scope', scope, 'owner', owner, 'epoch', 1,
    'until', now + lease, 'head', 0, 'ack', 0, 'bytes', 0, 'state', 'open', 'started', 0)
  touch()
  return {1, 1}
end
if redis.call('EXISTS', KEYS[1]) == 0 then return fail('missing') end
if redis.call('HGET', KEYS[1], 'scope') ~= scope then return fail('scope_mismatch') end
if op == 'purge' then redis.call('DEL', unpack(KEYS)); return {1} end
local state = redis.call('HGET', KEYS[1], 'state')
local head = tonumber(redis.call('HGET', KEYS[1], 'head'))
local ack = tonumber(redis.call('HGET', KEYS[1], 'ack'))
if op == 'read' then
  local after, count = tonumber(ARGV[10]), tonumber(ARGV[11])
  if after > head then return fail('cursor_ahead') end
  local frames = redis.call('LRANGE', KEYS[2], after, after + count - 1)
  return {1, state, redis.call('HGET', KEYS[1], 'started'), head, ack, frames}
end
if state ~= 'open' then return fail('closed') end
local currentOwner = redis.call('HGET', KEYS[1], 'owner')
local epoch = tonumber(redis.call('HGET', KEYS[1], 'epoch'))
local expires = tonumber(redis.call('HGET', KEYS[1], 'until'))
if op == 'create' then
  if currentOwner ~= owner or expires <= now then return fail('already_exists') end
  return {1, epoch}
end
if op == 'claim' then
  if currentOwner ~= owner and expires > now then return fail('fenced') end
  if expires <= now or currentOwner ~= owner then epoch = epoch + 1 end
  redis.call('HSET', KEYS[1], 'owner', owner, 'epoch', epoch, 'until', now + lease)
  touch()
  return {1, epoch, redis.call('HGET', KEYS[1], 'started')}
end
if currentOwner ~= owner or epoch ~= tonumber(ARGV[4]) or expires <= now then return fail('fenced') end
if op == 'renew' then
  redis.call('HSET', KEYS[1], 'until', now + lease)
  touch()
  return {1}
end
if op == 'start' then
  local started = redis.call('HGET', KEYS[1], 'started')
  redis.call('HSET', KEYS[1], 'started', 1)
  touch()
  return {1, started == '0' and 1 or 0}
end
if op == 'append' then
  local batch, digest = ARGV[10], ARGV[11]
  local receipt = redis.call('HGET', KEYS[3], batch)
  if receipt then
    local decoded = cjson.decode(receipt)
    if decoded[3] ~= digest then return fail('batch_conflict') end
    return {1, decoded[1], decoded[2]}
  end
  local count, bytes = #ARGV - 11, 0
  for i = 12, #ARGV do bytes = bytes + #ARGV[i] end
  if head + count > tonumber(ARGV[7]) or
     tonumber(redis.call('HGET', KEYS[1], 'bytes')) + bytes > tonumber(ARGV[8]) then return fail('limit') end
  local first = head + 1
  for i = 12, #ARGV do redis.call('RPUSH', KEYS[2], ARGV[i]) end
  head = head + count
  redis.call('HSET', KEYS[1], 'head', head)
  redis.call('HINCRBY', KEYS[1], 'bytes', bytes)
  redis.call('HSET', KEYS[3], batch, cjson.encode({first, head, digest}))
  touch()
  return {1, first, head}
end
if op == 'ack' then
  local cursor = tonumber(ARGV[10])
  if cursor > head then return fail('cursor_ahead') end
  ack = math.max(ack, cursor)
  redis.call('HSET', KEYS[1], 'ack', ack)
  touch()
  return {1, ack}
end
if op == 'finish' then
  if tonumber(ARGV[11]) ~= head then return fail('cursor_ahead') end
  redis.call('HSET', KEYS[1], 'state', ARGV[10], 'until', 0)
  touch()
  return {1}
end
return fail('closed')
`;
const failures = new Set<RuntimeJournalFailure>([
  'missing',
  'scope_mismatch',
  'fenced',
  'closed',
  'limit',
  'cursor_ahead',
  'batch_conflict',
  'already_exists',
]);
function integer(value: unknown): number {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[0-9]+$/.test(value)))
    throw new Error('Invalid runtime journal number');
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid runtime journal response');
  return n;
}
function id(value: string): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    throw new Error('Invalid runtime journal identity');
}
/** Redis persistence/AOF policy is deployment-owned; storage acknowledgement precedes publication. */
export function createRedisRuntimeJournal(
  redis: RuntimeJournalRedis,
  limits: RuntimeJournalLimits,
): RuntimeJournal {
  if (
    !/^[A-Za-z0-9:_-]{1,128}$/.test(limits.prefix) ||
    Object.entries(limits).some(
      ([key, value]) => key !== 'prefix' && (!Number.isSafeInteger(value) || Number(value) <= 0),
    ) ||
    limits.retentionMs <= limits.leaseMs ||
    limits.maxBatchFrames > limits.maxFrames ||
    limits.maxBatchBytes > limits.maxBytes
  ) {
    throw new Error('Invalid runtime journal limits');
  }
  const invoke = async <T>(
    op: string,
    session: { sessionId: string; scope: string },
    owner: string,
    epoch: number,
    args: Array<string | number>,
    map: (data: unknown[]) => T,
  ): Promise<RuntimeJournalResult<T>> => {
    id(session.sessionId);
    if (!/^[a-f0-9]{64}$/.test(session.scope)) throw new Error('Invalid runtime journal scope');
    if (op !== 'read' && op !== 'purge') id(owner);
    const key = `${limits.prefix}:{${session.sessionId}}`;
    const raw = await redis.eval(
      SCRIPT,
      3,
      `${key}:meta`,
      `${key}:frames`,
      `${key}:receipts`,
      op,
      session.scope,
      owner,
      epoch,
      limits.retentionMs,
      limits.leaseMs,
      limits.maxFrames,
      limits.maxBytes,
      0,
      ...args,
    );
    if (!Array.isArray(raw)) throw new Error('Invalid runtime journal response');
    if (raw[0] === 0 && failures.has(raw[1])) return { ok: false, error: { code: raw[1] } };
    if (raw[0] !== 1) throw new Error('Invalid runtime journal response');
    return { ok: true, value: map(raw) };
  };
  return {
    purge: (session) => invoke('purge', session, '', 0, [], () => null),
    create: (session, owner) =>
      invoke('create', session, owner, 0, [], (r) => ({ owner, epoch: integer(r[1]) })),
    claim: (session, owner) =>
      invoke('claim', session, owner, 0, [], (r) => ({
        owner,
        epoch: integer(r[1]),
        started: r[2] === '1',
      })),
    renew: (session, lease) => invoke('renew', session, lease.owner, lease.epoch, [], () => null),
    markStarted: (session, lease) =>
      invoke('start', session, lease.owner, lease.epoch, [], (r) => ({ first: r[1] === 1 })),
    append: async (session, lease, batchId, payloads) => {
      id(batchId);
      if (
        !payloads.length ||
        payloads.length > limits.maxBatchFrames ||
        payloads.some((p) => typeof p !== 'string') ||
        payloads.reduce((sum, p) => sum + Buffer.byteLength(p), 0) > limits.maxBatchBytes
      ) {
        return { ok: false, error: { code: 'limit' } };
      }
      const digest = createHash('sha256').update(JSON.stringify(payloads)).digest('hex');
      return invoke(
        'append',
        session,
        lease.owner,
        lease.epoch,
        [batchId, digest, ...payloads],
        (r) => ({ first: integer(r[1]), last: integer(r[2]) }),
      );
    },
    acknowledge: (session, lease, sequence) =>
      invoke('ack', session, lease.owner, lease.epoch, [integer(sequence)], (r) => ({
        acknowledged: integer(r[1]),
      })),
    read: (session, after, count) => {
      integer(after);
      integer(count);
      if (count === 0 || count > limits.maxBatchFrames)
        throw new Error('Invalid runtime journal page limit');
      return invoke('read', session, '', 0, [after, count], (r) => {
        if (!['open', 'completed', 'failed', 'cancelled', 'paused'].includes(String(r[1])))
          throw new Error('Invalid runtime journal state');
        if (!Array.isArray(r[5]) || r[5].some((p) => typeof p !== 'string'))
          throw new Error('Invalid runtime journal frames');
        return {
          state: r[1] as RuntimeJournalState,
          started: r[2] === '1',
          head: integer(r[3]),
          acknowledged: integer(r[4]),
          frames: r[5].map((payload: string, index: number) => ({
            sequence: after + index + 1,
            payload,
          })),
        };
      });
    },
    finish: (session, lease, state, head) => {
      if (!['completed', 'failed', 'cancelled', 'paused'].includes(state))
        throw new Error('Invalid runtime journal terminal state');
      return invoke(
        'finish',
        session,
        lease.owner,
        lease.epoch,
        [state, integer(head)],
        () => null,
      );
    },
  };
}
