const { createRemoteSdkServer, createRedisRuntimeJournal } = require('@librechat/api/sdk');
const { createExampleRun } = require('./agent.cjs');
const { createMinimalRun } = require('./minimal.cjs');

const secret = process.env.SDK_RUNTIME_SECRET;
if (!secret || secret.length < 32)
  throw new Error('Set SDK_RUNTIME_SECRET to at least 32 random characters.');
const runtimeId = process.env.SDK_RUNTIME_ID || 'remote-example';
const allowedAgents = new Set((process.env.SDK_RUNTIME_AGENT_IDS || '').split(',').filter(Boolean));
// Recovery is opt-in on both the host and worker; this Redis client belongs to the worker.
const redis =
  process.env.SDK_RUNTIME_RECOVERY === 'true'
    ? new (require('ioredis'))(process.env.SDK_RUNTIME_REDIS_URI || 'redis://127.0.0.1:6379')
    : undefined;
const recovery = redis
  ? {
      journal: createRedisRuntimeJournal(redis, {
        prefix: process.env.SDK_RUNTIME_JOURNAL_PREFIX || 'SdkRuntime',
        retentionMs: 86400000,
        leaseMs: 5000,
        maxFrames: 100000,
        maxBytes: 67108864,
        maxBatchFrames: 256,
        maxBatchBytes: 4194304,
      }),
      maxDisconnectMs: 15000,
    }
  : undefined;
const runtime = createRemoteSdkServer({
  recovery,
  runtimeId,
  secret,
  // The host signs identities only after resolving an authorized saved-agent binding.
  // Set SDK_RUNTIME_AGENT_IDS to additionally pin this deployment to specific saved agent IDs.
  authorize: (identity) =>
    identity.runtimeId === runtimeId &&
    (!allowedAgents.size || allowedAgents.has(identity.agentId)),
  createRun: (input) =>
    process.env.SDK_EXAMPLE_GRAPH === 'simple'
      ? createMinimalRun(input)
      : createExampleRun(input, {
          stepDelayMs: Number(process.env.SDK_EXAMPLE_STEP_DELAY_MS || 0),
        }),
  onError: () => console.error('Remote SDK run failed'),
});
runtime.server.listen(Number(process.env.SDK_RUNTIME_PORT || 8804), '127.0.0.1', () => {
  console.log(
    `SDK runtime ${runtimeId} listening on loopback port ${runtime.server.address().port}`,
  );
});
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () => {
    void runtime
      .close()
      .then(() => redis?.quit())
      .then(() => process.exit(0));
  });
