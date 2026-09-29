/**
 * Full-wiring HITL checkpoint lifecycle e2e.
 *
 * Every HITL-specific component here is REAL: the `@librechat/agents` Run (driven by the
 * SDK's FakeChatModel scripted to call a gated tool), the PreToolUse approval hook +
 * `humanInTheLoop` wiring, the LazyMongoSaver over mongodb-memory-server, the
 * GenerationJobManager (in-memory services), and the `/agents/chat/resume` controller via
 * supertest. Only LibreChat's persistence adapters (`~/models`), request cleanup, and the
 * concurrency gate are mocked. This is the cross-layer seam none of the unit suites cover:
 * pause → durable checkpoint → HTTP approval → rebuilt-run resume → finalize prune.
 */
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { z } = require('zod');
const { tool } = require('@langchain/core/tools');
const { HumanMessage } = require('@langchain/core/messages');
const { Run, Providers, FakeChatModel } = require('@librechat/agents');

const mockLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: mockLogger,
}));

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  checkAndIncrementPendingRequest: jest.fn(async () => ({ allowed: true })),
  decrementPendingRequest: jest.fn(async () => {}),
}));

jest.mock('~/models', () => ({
  saveMessage: jest.fn(async (req, message) => message),
  getConvo: jest.fn(async () => null),
  getMessages: jest.fn(async () => []),
}));

jest.mock('~/server/cleanup', () => ({
  disposeClient: jest.fn(),
}));

jest.mock('~/server/services/MCPRequestContext', () => ({
  getMCPRequestContext: jest.fn(() => null),
  cleanupMCPRequestContextForReq: jest.fn(),
}));

// Import after mocks — these are the REAL implementations.
const {
  GenerationJobManager,
  createStreamServices,
  buildPendingAction,
  getAgentCheckpointer,
  deleteAgentCheckpoint,
  buildHITLRunWiring,
  resolveToolApprovalPolicy,
  LIBRECHAT_CHECKPOINT_NAMESPACE_KEY,
  __resetCheckpointerForTests,
} = require('@librechat/api');
const ResumeAgentController = require('~/server/controllers/agents/resume');

const USER_ID = 'hitl-e2e-user';
const MONGO_CFG = { type: 'mongo', ttl: 3600 };
const GATED_TOOL = 'guarded_echo';

/** Side-effect counter: proves the gated tool runs exactly once across pause+resume. */
let toolExecutions = 0;
const guardedTool = tool(async ({ text }) => `echo:${text}`, {
  name: GATED_TOOL,
  description: 'Echoes text back, but requires human approval first.',
  schema: z.object({ text: z.string() }),
});
guardedTool.func = async ({ text }) => {
  toolExecutions += 1;
  return `echo:${text}`;
};

/** Build a REAL run with the HITL wiring + durable checkpointer attached (mirrors createRun). */
async function buildHitlRun({ saver, conversationId, responses, toolCalls, runId }) {
  const hitl = buildHITLRunWiring(
    resolveToolApprovalPolicy({ endpoint: { enabled: true, ask: [GATED_TOOL] } }),
    { userId: USER_ID, conversationId, appConfig: {} },
  );
  const run = await Run.create({
    runId,
    graphConfig: {
      type: 'standard',
      llmConfig: {
        provider: Providers.OPENAI,
        model: 'gpt-4o-mini',
        streaming: true,
        streamUsage: false,
      },
      instructions: 'You are a helpful assistant.',
      tools: [guardedTool],
      compileOptions: { checkpointer: saver },
    },
    returnContent: true,
    customHandlers: {},
    tokenCounter: (text) => String(text ?? '').length,
    indexTokenCountMap: {},
    ...(hitl && { humanInTheLoop: hitl.humanInTheLoop, hooks: hitl.hooks }),
  });
  run.Graph.overrideModel = new FakeChatModel({ responses, toolCalls });
  return run;
}

const runConfig = (conversationId, checkpointNamespace = '') => ({
  runName: 'AgentRun',
  configurable: {
    thread_id: conversationId,
    checkpoint_ns: '',
    [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: checkpointNamespace,
    user_id: USER_ID,
  },
  streamMode: 'values',
  version: 'v2',
});

/** Poll until `predicate` returns true (the resume continuation is fire-and-forget). */
async function waitFor(predicate, { timeoutMs = 10_000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('waitFor: condition not met within timeout');
}

async function checkpointCounts(conversationId) {
  const db = mongoose.connection.db;
  return {
    checkpoints: await db
      .collection('agent_checkpoints')
      .countDocuments({ thread_id: conversationId }),
    writes: await db
      .collection('agent_checkpoint_writes')
      .countDocuments({ thread_id: conversationId }),
  };
}

let mongoServer;
let saver;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  __resetCheckpointerForTests();
  saver = await getAgentCheckpointer(MONGO_CFG);

  GenerationJobManager.configure({ ...createStreamServices(), cleanupOnComplete: false });
  GenerationJobManager.initialize();
}, 60000);

afterAll(async () => {
  await GenerationJobManager.destroy();
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(() => {
  toolExecutions = 0;
  jest.clearAllMocks();
});

describe('HITL checkpoint lifecycle (full wiring)', () => {
  jest.setTimeout(30000);

  test('a clean turn (no tool gating triggered) persists NOTHING durable', async () => {
    const conversationId = `e2e-clean-${Date.now()}`;
    const run = await buildHitlRun({
      saver,
      conversationId,
      responses: ['Hello there!'],
      runId: 'resp-clean',
    });
    await run.processStream({ messages: [new HumanMessage('hi')] }, runConfig(conversationId));

    expect(run.getInterrupt?.()).toBeFalsy();
    expect(await checkpointCounts(conversationId)).toEqual({ checkpoints: 0, writes: 0 });
  });

  test('a turn that ERRORS before pausing persists NOTHING durable', async () => {
    const conversationId = `e2e-error-${Date.now()}`;
    const run = await buildHitlRun({
      saver,
      conversationId,
      responses: ['unused'],
      runId: 'resp-error',
    });
    class BoomModel extends FakeChatModel {
      // eslint-disable-next-line require-yield
      async *_streamResponseChunks() {
        throw new Error('model boom');
      }
    }
    run.Graph.overrideModel = new BoomModel({ responses: ['unused'] });

    await expect(
      run.processStream({ messages: [new HumanMessage('hi')] }, runConfig(conversationId)),
    ).rejects.toThrow('model boom');

    expect(await checkpointCounts(conversationId)).toEqual({ checkpoints: 0, writes: 0 });
  });

  test('pause → approve over the REAL /resume controller → tool runs once → checkpoint pruned', async () => {
    const conversationId = `e2e-resume-${Date.now()}`;
    const responseMessageId = 'resp-pause-1';
    // Production creates the v2 generation before compiling/running the graph,
    // then scopes every checkpoint operation to that immutable generation.
    const job = await GenerationJobManager.createJob(conversationId, USER_ID, conversationId, {
      initialMetadata: { generationProtocolVersion: 2 },
    });
    const checkpointNamespace = job.metadata.checkpointNamespace;
    expect(checkpointNamespace).toEqual(expect.any(String));
    expect(checkpointNamespace).not.toBe(String(job.createdAt));

    // --- Turn 1: the model calls the gated tool → PreToolUse 'ask' → interrupt. ---
    const run = await buildHitlRun({
      saver,
      conversationId,
      responses: ['Let me run that.'],
      toolCalls: [{ name: GATED_TOOL, args: { text: 'hi' }, id: 'tc_1', type: 'tool_call' }],
      runId: responseMessageId,
    });
    await run.processStream(
      { messages: [new HumanMessage('run the guarded tool')] },
      runConfig(conversationId, checkpointNamespace),
    );

    const interrupt = run.getInterrupt();
    expect(interrupt?.payload?.type).toBe('tool_approval');
    expect(toolExecutions).toBe(0); // gated — must NOT have run pre-approval
    const paused = await checkpointCounts(conversationId);
    expect(paused.checkpoints).toBeGreaterThan(0); // the interrupt checkpoint is durable

    // --- Pause bookkeeping (mirrors AgentClient.handleRunInterrupt). ---
    await GenerationJobManager.updateMetadata(conversationId, {
      endpoint: 'agents',
      agent_id: 'agent-e2e',
      responseMessageId,
    });
    const pendingAction = buildPendingAction(interrupt.payload, {
      streamId: conversationId,
      conversationId,
      runId: responseMessageId,
      responseMessageId,
      ttlMs: 60_000,
    });
    expect(await GenerationJobManager.approvals.pause(conversationId, pendingAction)).toBe(true);

    // --- Turn 2: approve through the REAL controller; the thin client rebuilds a REAL run. ---
    const thinClient = {
      contentParts: [],
      artifactPromises: [],
      conversationId,
      responseMessageId,
      pendingApproval: null,
      async resumeCompletion({ resumeValue, abortController }) {
        const resumed = await buildHitlRun({
          saver,
          conversationId,
          responses: ['Done after approval.'],
          runId: responseMessageId,
        });
        await resumed.resume(resumeValue, {
          ...runConfig(conversationId, checkpointNamespace),
          signal: (abortController ?? new AbortController()).signal,
        });
        const reInterrupt = resumed.getInterrupt?.();
        if (reInterrupt?.payload) {
          this.pendingApproval = reInterrupt.payload;
        }
        this.contentParts.push({ type: 'text', text: 'Done after approval.' });
        return resumed;
      },
    };
    const initializeClient = jest.fn(async () => ({ client: thinClient }));
    const addTitle = jest.fn();

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: USER_ID };
      req.config = { endpoints: { agents: { checkpointer: MONGO_CFG } }, interfaceConfig: {} };
      next();
    });
    app.post('/api/agents/chat/resume', (req, res, next) =>
      ResumeAgentController(req, res, next, initializeClient, addTitle),
    );

    const response = await request(app)
      .post('/api/agents/chat/resume')
      .send({
        conversationId,
        actionId: pendingAction.actionId,
        agent_id: 'agent-e2e',
        endpoint: 'agents',
        decisions: [{ tool_call_id: 'tc_1', decision: 'approve' }],
      });

    // The controller ACKs immediately ({ status: 'resuming' }) and drives the resumed run
    // asynchronously — wait for the terminal side effects before asserting.
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('resuming');
    await waitFor(async () => {
      const liveJob = await GenerationJobManager.getJob(conversationId);
      return liveJob?.status !== 'requires_action' && liveJob?.status !== 'running';
    });

    expect(initializeClient).toHaveBeenCalledTimes(1);
    expect(toolExecutions).toBe(1); // approved tool ran exactly ONCE across pause+resume

    // Terminal state: the checkpoint was pruned by the REAL finalize path.
    await waitFor(async () => (await checkpointCounts(conversationId)).checkpoints === 0);
    expect(await checkpointCounts(conversationId)).toEqual({ checkpoints: 0, writes: 0 });

    expect(job).toBeDefined();
  });

  test('an abandoned pause expires without deleting a replacement-scoped checkpoint', async () => {
    const conversationId = `e2e-expiry-${Date.now()}`;
    const run = await buildHitlRun({
      saver,
      conversationId,
      responses: ['Let me run that.'],
      toolCalls: [{ name: GATED_TOOL, args: { text: 'x' }, id: 'tc_exp', type: 'tool_call' }],
      runId: 'resp-expire',
    });
    await run.processStream({ messages: [new HumanMessage('run it')] }, runConfig(conversationId));
    const interrupt = run.getInterrupt();
    expect((await checkpointCounts(conversationId)).checkpoints).toBeGreaterThan(0);

    await GenerationJobManager.createJob(conversationId, USER_ID, conversationId);
    const pendingAction = buildPendingAction(interrupt.payload, {
      streamId: conversationId,
      conversationId,
      runId: 'resp-expire',
      responseMessageId: 'resp-expire',
      ttlMs: 60_000,
    });
    await GenerationJobManager.approvals.pause(conversationId, pendingAction);

    // Expiry finalizes the stream, while checkpoint cleanup remains TTL-scoped. A
    // thread-wide eager delete can race a replacement run on the same conversation.
    expect(await GenerationJobManager.expireApproval(conversationId, pendingAction.actionId)).toBe(
      true,
    );

    expect(await GenerationJobManager.getJobStatus(conversationId)).toBe('aborted');
    expect((await checkpointCounts(conversationId)).checkpoints).toBeGreaterThan(0);
    await deleteAgentCheckpoint(conversationId, MONGO_CFG);
    expect(await checkpointCounts(conversationId)).toEqual({ checkpoints: 0, writes: 0 });
  });
});
