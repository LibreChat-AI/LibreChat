/** Resource protection for ephemeral replay, independent of durable job persistence. */
export interface ReplayLimits {
  items: number;
  bytes: number;
  ttlMs: number;
}

/** Sequence allocation, retention and publication share a cluster slot and one round trip.
 * Payloads are spliced without cjson so empty arrays and numeric precision survive. */
export const PUBLISH_REPLAY_LUA = `
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
