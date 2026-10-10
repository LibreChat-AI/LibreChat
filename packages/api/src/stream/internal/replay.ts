/** Resource protection for ephemeral replay, independent of durable job persistence. */
export interface ReplayLimits {
  items: number;
  bytes: number;
  ttlMs: number;
}

/** Stable retry identity; sequenced producers fence delayed retries with their high-water mark. */
export interface ReplayPublication {
  id: string;
  sequence?: number;
}

/** Sequence allocation, retention and publication share a cluster slot and one round trip.
 * Payloads are spliced without cjson so empty arrays and numeric precision survive. */
export const PUBLISH_REPLAY_LUA = `
local previous = redis.call('HMGET', KEYS[4], 'id', 'seq', 'ordinal', 'done')
if previous[4] == '1' or (ARGV[8] ~= '' and previous[1] == ARGV[8]) or
   (ARGV[9] ~= '' and previous[3] and tonumber(ARGV[9]) <= tonumber(previous[3])) then
  return tonumber(previous[2])
end
local seq = redis.call('INCR', KEYS[1]) - 1
local payload = ARGV[2] .. string.format('%d', seq) .. ARGV[3]
local bytes = tonumber(redis.call('GET', KEYS[3]) or '0') + #payload
redis.call('RPUSH', KEYS[2], payload)
local count = redis.call('LLEN', KEYS[2])
while count > tonumber(ARGV[4]) or bytes > tonumber(ARGV[5]) do
  local removed = redis.call('LPOP', KEYS[2])
  if not removed then break end
  bytes = bytes - #removed
  count = count - 1
end
redis.call('SET', KEYS[3], bytes, 'PX', ARGV[6])
redis.call('PEXPIRE', KEYS[2], ARGV[6])
redis.call('EXPIRE', KEYS[1], ARGV[7])
redis.call('HSET', KEYS[4], 'id', ARGV[8], 'seq', seq, 'done', ARGV[10])
if ARGV[9] ~= '' then redis.call('HSET', KEYS[4], 'ordinal', ARGV[9]) end
redis.call('EXPIRE', KEYS[4], ARGV[7])
redis.call('PUBLISH', ARGV[1], payload)
return seq
`;

/** SUBSCRIBE must be acknowledged first. Every later frame is either in this atomic
 * snapshot or in the viewer's live buffer; the returned :seq frontier removes overlap. */
export const READ_REPLAY_LUA = `
local snapshot = {redis.call('GET', KEYS[1]) or '0', redis.call('LRANGE', KEYS[2], 0, -1)}
redis.call('PUBLISH', ARGV[1], ARGV[2])
return snapshot
`;
