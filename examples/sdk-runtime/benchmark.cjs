const { performance } = require('node:perf_hooks');
const { randomUUID } = require('node:crypto');
const {
  GraphEvents,
  Providers,
  ProviderTextAdmission,
  createHostProviderTextService,
} = require('@librechat/agents');
const { HumanMessage } = require('@librechat/agents/langchain/messages');
const { createRemoteSdkRun } = require('@librechat/api/sdk');
const { createExampleRun } = require('./agent.cjs');

const protectedOutput = process.env.SDK_BENCHMARK_PROTECTION === 'true';
const admission = new ProviderTextAdmission({
  maxConcurrentInspections: 4,
  maxBufferedBytes: 4194304,
});
// A deterministic pass-through policy measures bridge cost, not production PII detection.
const policy = {
  version: 1,
  timeoutMs: 10000,
  maxAttemptBytes: 1048576,
  maxBufferedBytes: 4194304,
  classify: () => 'prose',
  inspect: ({ content }) => ({
    version: 1,
    ok: true,
    value: { content, replacements: 0, categories: [] },
  }),
};

async function measure(remote) {
  const identity = {
    runtimeId: process.env.SDK_RUNTIME_ID || 'remote-example',
    agentId: process.env.SDK_BENCHMARK_AGENT_ID || 'benchmark',
    runId: randomUUID(),
    conversationId: randomUUID(),
    userId: 'benchmark',
  };
  let firstEventMs;
  const started = performance.now();
  const config = {
    runId: identity.runId,
    ...(protectedOutput && { providerTextProtection: policy }),
    returnContent: true,
    tokenCounter: () => 1,
    customHandlers: {
      [GraphEvents.ON_MESSAGE_DELTA]: {
        handle: async () => {
          firstEventMs ??= performance.now() - started;
        },
      },
    },
    graphConfig: {
      type: 'standard',
      llmConfig: { provider: Providers.OPENAI },
      agentId: identity.agentId,
    },
  };
  const run = remote
    ? await createRemoteSdkRun({
        config,
        identity,
        ...(protectedOutput && {
          hostServices: {
            providerText: createHostProviderTextService({
              identity,
              policy,
              admission,
              inspectionTimeoutMs: 5000,
            }),
          },
        }),
        remote: {
          url: process.env.SDK_RUNTIME_URL || 'ws://127.0.0.1:8804/sdk',
          secret: process.env.SDK_RUNTIME_SECRET || '',
          ...(process.env.SDK_RUNTIME_RECOVERY === 'true' && {
            recovery: { maxDisconnectMs: 15000, retryDelayMs: 250, maxJournalBytes: 67108864 },
          }),
        },
      })
    : await createExampleRun({
        config,
        identity,
        compileOptions: {},
        signal: new AbortController().signal,
        agent: { id: identity.agentId },
      });
  await run.processStream(
    { messages: [new HumanMessage('Inspect and review the fixture.')] },
    {
      version: 'v2',
      configurable: { thread_id: identity.conversationId },
    },
  );
  return { firstEventMs, completedMs: performance.now() - started };
}
async function main() {
  await measure(false);
  await measure(true);
  const local = [],
    remote = [];
  for (let i = 0; i < 5; i++) {
    local.push(await measure(false));
    remote.push(await measure(true));
  }
  const median = (samples, key) => samples.map((item) => item[key]).sort((a, b) => a - b)[2];
  console.log(
    JSON.stringify(
      {
        mode: 'deterministic custom graph, five warm samples',
        protectedOutput,
        local,
        remote,
        median: {
          localFirstEventMs: median(local, 'firstEventMs'),
          remoteFirstEventMs: median(remote, 'firstEventMs'),
          localCompletedMs: median(local, 'completedMs'),
          remoteCompletedMs: median(remote, 'completedMs'),
        },
      },
      null,
      2,
    ),
  );
}
main().catch((error) => {
  console.error('Benchmark failed', { name: error.name });
  process.exitCode = 1;
});
