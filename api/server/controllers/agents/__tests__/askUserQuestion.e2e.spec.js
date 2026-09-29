/**
 * Full-wiring ask_user_question lifecycle e2e.
 *
 * Companion to `hitlCheckpoint.e2e.spec.js`, same REAL components: the
 * `@librechat/agents` Run (FakeChatModel scripted to call the ask tool), the
 * LazyMongoSaver over mongodb-memory-server, the GenerationJobManager, and the
 * `/agents/chat/resume` controller via supertest. The seam under test here is
 * different, though: the interrupt is raised INSIDE a tool body (the tool's
 * func calls the SDK's `askUserQuestion()` helper, which wraps LangGraph
 * `interrupt()`), not by the PreToolUse approval gate — and the run carries a
 * checkpointer but NO `humanInTheLoop` switch and NO hooks, proving the
 * question flow works with the approval policy fully disabled.
 */
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { z } = require('zod');
const { tool } = require('@langchain/core/tools');
const { HumanMessage } = require('@langchain/core/messages');
const { Run, Providers, FakeChatModel, askUserQuestion } = require('@librechat/agents');

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
  LIBRECHAT_CHECKPOINT_NAMESPACE_KEY,
  __resetCheckpointerForTests,
} = require('@librechat/api');
const ResumeAgentController = require('~/server/controllers/agents/resume');

const USER_ID = 'ask-e2e-user';
const MONGO_CFG = { type: 'mongo', ttl: 3600 };
const ASK_TOOL = 'ask_user_question';

/**
 * Body-run counter + captured resolution. The body executes TWICE per answered
 * question by LangGraph contract (pass 1 runs until `interrupt()` throws; the
 * resume pass re-runs the body from the top and `askUserQuestion()` returns the
 * host's answer), so `bodyRuns` proves the re-entry semantics and
 * `resolvedAnswers` proves the answer round-trip.
 */
let bodyRuns = 0;
let resolvedAnswers = [];
const askTool = tool(
  async (input) => {
    bodyRuns += 1;
    const { answer } = askUserQuestion(input);
    resolvedAnswers.push(answer);
    return answer;
  },
  {
    name: ASK_TOOL,
    description: 'Ask the user a clarifying question and wait for their answer.',
    schema: z.object({
      question: z.string(),
      description: z.string().optional(),
      options: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
    }),
  },
);

/**
 * Build a REAL run shaped like production `createRun` for the ask-only case:
 * durable checkpointer attached, `eagerEventToolExecution` on with the ask
 * tool excluded (mirrors the planned run.ts wiring) — and, deliberately, NO
 * `humanInTheLoop` and NO hooks.
 */
async function buildAskRun({ saver, responses, toolCalls, runId }) {
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
      tools: [askTool],
      compileOptions: { checkpointer: saver },
    },
    returnContent: true,
    customHandlers: {},
    tokenCounter: (text) => String(text ?? '').length,
    indexTokenCountMap: {},
    eagerEventToolExecution: { enabled: true, excludeToolNames: [ASK_TOOL] },
  });
  run.Graph.overrideModel = new FakeChatModel({ responses, toolCalls });
  return run;
}

/**
 * Build a REAL run in the PRODUCTION shape: the agents endpoint loads tools
 * definitions-only, so the run is EVENT-DRIVEN (`toolDefinitions` non-empty flips
 * the SDK ToolNode to event dispatch) and the ask tool rides `graphTools` — the
 * SDK's in-graph direct-tool seam (agents#289, > 3.2.57) — because an event-
 * dispatched tool body executes in the host handler outside the Pregel task
 * frame, where `interrupt()` throws instead of pausing. This is the mode
 * `createRun` produces via `buildAgentInput`; the traditional-mode harness above
 * covers runs with zero toolDefinitions.
 */
async function buildAskRunEventMode({ saver, responses, toolCalls, runId }) {
  const run = await Run.create({
    runId,
    graphConfig: {
      type: 'standard',
      agents: [
        {
          agentId: 'agent-ask-event',
          provider: Providers.OPENAI,
          clientOptions: { model: 'gpt-4o-mini', streaming: true, streamUsage: false },
          instructions: 'You are a helpful assistant.',
          maxContextTokens: 8000,
          toolDefinitions: [{ name: 'dummy_event_tool', description: 'host-executed event tool' }],
          graphTools: [askTool],
        },
      ],
      compileOptions: { checkpointer: saver },
    },
    returnContent: true,
    customHandlers: {},
    tokenCounter: (text) => String(text ?? '').length,
    indexTokenCountMap: {},
    eagerEventToolExecution: { enabled: true, excludeToolNames: [ASK_TOOL] },
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
  bodyRuns = 0;
  resolvedAnswers = [];
  jest.clearAllMocks();
});

describe('ask_user_question lifecycle (full wiring, approval policy disabled)', () => {
  jest.setTimeout(30000);

  test('a tool-body interrupt pauses durably and the REAL /resume controller delivers the answer as the tool result', async () => {
    const conversationId = `ask-e2e-resume-${Date.now()}`;
    const responseMessageId = 'resp-ask-1';
    const job = await GenerationJobManager.createJob(conversationId, USER_ID, conversationId, {
      initialMetadata: { generationProtocolVersion: 2 },
    });
    const checkpointNamespace = job.metadata.checkpointNamespace;
    expect(checkpointNamespace).toEqual(expect.any(String));
    expect(checkpointNamespace).not.toBe(String(job.createdAt));

    // --- Turn 1: the model calls the ask tool → interrupt() from inside the tool body. ---
    const run = await buildAskRun({
      saver,
      responses: ['Let me check with you.'],
      toolCalls: [
        {
          name: ASK_TOOL,
          args: {
            question: 'Which environment should I deploy to?',
            options: [
              { label: 'Staging', value: 'staging' },
              { label: 'Production', value: 'production' },
            ],
          },
          id: 'tc_ask_1',
          type: 'tool_call',
        },
      ],
      runId: responseMessageId,
    });
    await run.processStream(
      { messages: [new HumanMessage('deploy the app')] },
      runConfig(conversationId, checkpointNamespace),
    );

    const interrupt = run.getInterrupt();
    expect(interrupt?.payload?.type).toBe('ask_user_question');
    expect(interrupt.payload.question).toEqual({
      question: 'Which environment should I deploy to?',
      options: [
        { label: 'Staging', value: 'staging' },
        { label: 'Production', value: 'production' },
      ],
    });
    expect(bodyRuns).toBe(1); // body entered once; interrupt() threw before any answer
    expect(resolvedAnswers).toEqual([]);
    const paused = await checkpointCounts(conversationId);
    expect(paused.checkpoints).toBeGreaterThan(0); // the interrupt checkpoint is durable

    // --- Pause bookkeeping (mirrors AgentClient.handleRunInterrupt). ---
    await GenerationJobManager.updateMetadata(conversationId, {
      endpoint: 'agents',
      agent_id: 'agent-ask-e2e',
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

    // --- Turn 2: answer through the REAL controller; the thin client rebuilds a REAL run. ---
    const thinClient = {
      contentParts: [],
      artifactPromises: [],
      conversationId,
      responseMessageId,
      pendingApproval: null,
      async resumeCompletion({ resumeValue, abortController }) {
        const resumed = await buildAskRun({
          saver,
          responses: ['Deploying to staging.'],
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
        this.contentParts.push({ type: 'text', text: 'Deploying to staging.' });
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

    const response = await request(app).post('/api/agents/chat/resume').send({
      conversationId,
      actionId: pendingAction.actionId,
      agent_id: 'agent-ask-e2e',
      endpoint: 'agents',
      answer: 'staging',
    });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('resuming');
    await waitFor(async () => {
      const liveJob = await GenerationJobManager.getJob(conversationId);
      return liveJob?.status !== 'requires_action' && liveJob?.status !== 'running';
    });

    expect(initializeClient).toHaveBeenCalledTimes(1);
    // Resume pass re-ran the body from the top; askUserQuestion() returned the answer.
    expect(bodyRuns).toBe(2);
    expect(resolvedAnswers).toEqual(['staging']);
    expect(thinClient.pendingApproval).toBeNull(); // no second question — turn completed

    // Terminal state: the checkpoint was pruned by the REAL finalize path.
    await waitFor(async () => (await checkpointCounts(conversationId)).checkpoints === 0);
    expect(await checkpointCounts(conversationId)).toEqual({ checkpoints: 0, writes: 0 });
  });

  test('EVENT-DRIVEN mode (production shape): the graphTools ask tool pauses and resumes over the REAL /resume controller', async () => {
    const conversationId = `ask-e2e-event-${Date.now()}`;
    const responseMessageId = 'resp-ask-event-1';
    const job = await GenerationJobManager.createJob(conversationId, USER_ID, conversationId, {
      initialMetadata: { generationProtocolVersion: 2 },
    });
    const checkpointNamespace = job.metadata.checkpointNamespace;
    expect(checkpointNamespace).toEqual(expect.any(String));
    expect(checkpointNamespace).not.toBe(String(job.createdAt));

    const run = await buildAskRunEventMode({
      saver,
      responses: ['Let me check with you.'],
      toolCalls: [
        {
          name: ASK_TOOL,
          args: { question: 'Proceed with the migration?' },
          id: 'tc_ask_ev1',
          type: 'tool_call',
        },
      ],
      runId: responseMessageId,
    });
    await run.processStream(
      { messages: [new HumanMessage('run the migration')] },
      runConfig(conversationId, checkpointNamespace),
    );

    const interrupt = run.getInterrupt();
    expect(interrupt?.payload?.type).toBe('ask_user_question');
    expect(interrupt.payload.question).toEqual({ question: 'Proceed with the migration?' });
    expect(bodyRuns).toBe(1);
    expect((await checkpointCounts(conversationId)).checkpoints).toBeGreaterThan(0);

    await GenerationJobManager.updateMetadata(conversationId, {
      endpoint: 'agents',
      agent_id: 'agent-ask-e2e',
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

    const thinClient = {
      contentParts: [],
      artifactPromises: [],
      conversationId,
      responseMessageId,
      pendingApproval: null,
      async resumeCompletion({ resumeValue, abortController }) {
        const resumed = await buildAskRunEventMode({
          saver,
          responses: ['Migration underway.'],
          runId: responseMessageId,
        });
        await resumed.resume(resumeValue, {
          ...runConfig(conversationId, checkpointNamespace),
          signal: (abortController ?? new AbortController()).signal,
        });
        this.contentParts.push({ type: 'text', text: 'Migration underway.' });
        return resumed;
      },
    };
    const initializeClient = jest.fn(async () => ({ client: thinClient }));

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: USER_ID };
      req.config = { endpoints: { agents: { checkpointer: MONGO_CFG } }, interfaceConfig: {} };
      next();
    });
    app.post('/api/agents/chat/resume', (req, res, next) =>
      ResumeAgentController(req, res, next, initializeClient, jest.fn()),
    );

    const response = await request(app).post('/api/agents/chat/resume').send({
      conversationId,
      actionId: pendingAction.actionId,
      agent_id: 'agent-ask-e2e',
      endpoint: 'agents',
      answer: 'yes, proceed',
    });

    expect(response.status).toBe(200);
    await waitFor(async () => {
      const liveJob = await GenerationJobManager.getJob(conversationId);
      return liveJob?.status !== 'requires_action' && liveJob?.status !== 'running';
    });

    expect(bodyRuns).toBe(2);
    expect(resolvedAnswers).toEqual(['yes, proceed']);
    await waitFor(async () => (await checkpointCounts(conversationId)).checkpoints === 0);
  });

  test('a second question raised after resume re-pauses with a fresh ask_user_question interrupt', async () => {
    const conversationId = `ask-e2e-seq-${Date.now()}`;

    const run = await buildAskRun({
      saver,
      responses: ['First question coming.'],
      toolCalls: [
        {
          name: ASK_TOOL,
          args: { question: 'Pick a color?' },
          id: 'tc_ask_q1',
          type: 'tool_call',
        },
      ],
      runId: 'resp-ask-seq',
    });
    await run.processStream({ messages: [new HumanMessage('start')] }, runConfig(conversationId));
    expect(run.getInterrupt()?.payload?.type).toBe('ask_user_question');
    expect(bodyRuns).toBe(1);

    // Resume with the first answer; the NEXT model turn asks a second question.
    const resumed = await buildAskRun({
      saver,
      responses: ['And one more thing.'],
      toolCalls: [
        {
          name: ASK_TOOL,
          args: { question: 'Pick a size?' },
          id: 'tc_ask_q2',
          type: 'tool_call',
        },
      ],
      runId: 'resp-ask-seq',
    });
    await resumed.resume({ answer: 'blue' }, runConfig(conversationId));

    expect(resolvedAnswers).toEqual(['blue']);
    const second = resumed.getInterrupt();
    expect(second?.payload?.type).toBe('ask_user_question');
    expect(second.payload.question).toEqual({ question: 'Pick a size?' });
    // q1 body ran twice (pass + resume); q2 body entered once and interrupted.
    expect(bodyRuns).toBe(3);

    await deleteAgentCheckpoint(conversationId, MONGO_CFG);
  });
});
