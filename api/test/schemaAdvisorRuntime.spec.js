const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { MemorySaver, Command } = require('@langchain/langgraph');
const { AIMessage, HumanMessage } = require('@librechat/agents/langchain/messages');
const { GraphEvents, HostModelAdmission, createHostModelService } = require('@librechat/agents');
const { createRemoteSdkRun, createRemoteSdkServer } = require('@librechat/api/sdk');
const {
  buildAdvisorGraph,
  createSchemaAdvisorRun,
} = require('../../examples/sdk-runtime/schema-advisor.cjs');
const {
  ExampleAdvisorModel,
  createAdvisorModels,
} = require('../../examples/sdk-runtime/schema-advisor-models.cjs');

function input(overrides = {}) {
  const id = randomUUID();
  return {
    identity: {
      runtimeId: 'advisor',
      agentId: 'advisor',
      userId: 'example',
      runId: id,
      conversationId: id,
    },
    config: { runId: id },
    agent: { id: 'advisor' },
    compileOptions: { checkpointer: new MemorySaver() },
    signal: new AbortController().signal,
    ...overrides,
  };
}
const message = () => ({ messages: [new HumanMessage('Investigate the reporting query.')] });
const config = (id) => ({ version: 'v2', configurable: { thread_id: id } });

it('executes SDK model nodes, revises after review, streams, and checkpoints domain state', async () => {
  const options = input();
  const deltas = [];
  options.config.customHandlers = {
    [GraphEvents.ON_MESSAGE_DELTA]: { handle: (_event, data) => deltas.push(data) },
  };
  const models = createAdvisorModels({});
  const planner = jest.spyOn(models.chat, '_generate');
  const reviewer = jest.spyOn(models.fast, '_generate');
  const run = await createSchemaAdvisorRun(options, { models });
  const content = await run.processStream(message(), config(options.identity.conversationId));
  const state = await run.graphRunnable.getState(config(options.identity.conversationId));
  expect(state.values).toMatchObject({ phase: 'reviewed', reviewAttempts: 2, compileRetries: 0 });
  expect(state.values.plan.validation).toHaveLength(1);
  expect(planner).toHaveBeenCalledTimes(3);
  expect(reviewer).toHaveBeenCalledTimes(2);
  expect(deltas.length).toBeGreaterThan(5);
  expect(JSON.stringify(content)).toContain('Reviewed example plan');
});

it('resumes a reconstructed custom graph from a host-owned checkpoint without redoing planning', async () => {
  const options = input();
  options.compileOptions.interruptBefore = ['adversarial'];
  const run = await createSchemaAdvisorRun(options, { models: createAdvisorModels({}) });
  await run.processStream(message(), config(options.identity.conversationId));
  const paused = await run.graphRunnable.getState(config(options.identity.conversationId));
  expect(paused.next).toEqual(['adversarial']);
  const models = createAdvisorModels({});
  const planner = jest.spyOn(models.chat, '_generate');
  const resumed = await createSchemaAdvisorRun(
    { ...options, compileOptions: { checkpointer: options.compileOptions.checkpointer } },
    { models },
  );
  await resumed.processStream(new Command({}), config(options.identity.conversationId));
  const state = await resumed.graphRunnable.getState(config(options.identity.conversationId));
  expect(state.values).toMatchObject({ phase: 'reviewed', reviewAttempts: 2 });
  // One revision plus final rendering; the initial planner node was restored, not replayed.
  expect(planner).toHaveBeenCalledTimes(2);
});

it('ends with unresolved review status when the revision budget is exhausted', async () => {
  const options = input();
  const models = createAdvisorModels({});
  models.fast._generate = async () => ({
    generations: [
      {
        text: '',
        message: new AIMessage(
          JSON.stringify({
            issues: [{ severity: 'critical', message: 'The proposal is still unsafe.' }],
          }),
        ),
      },
    ],
  });
  const run = await createSchemaAdvisorRun(options, { models, maxReviewAttempts: 2 });
  const content = await run.processStream(message(), config(options.identity.conversationId));
  const state = await run.graphRunnable.getState(config(options.identity.conversationId));
  expect(state.values).toMatchObject({ phase: 'needs_human_review', reviewAttempts: 2 });
  expect(JSON.stringify(content)).toContain('needs_human_review');
  expect(JSON.stringify(content)).toContain('The proposal is still unsafe.');
});

it('bounds malformed-plan retries and never treats a malformed review as approval', async () => {
  const controller = new AbortController();
  const bad = jest.fn(async () => ({ messages: [new AIMessage('not JSON')] }));
  const graph = buildAdvisorGraph({ signal: controller.signal, callAgent: bad });
  await expect(graph.invoke(message())).rejects.toThrow('Example plan did not match its contract');
  expect(bad).toHaveBeenCalledTimes(2);
  const options = input();
  const models = createAdvisorModels({});
  models.fast._generate = async () => ({
    generations: [{ text: '', message: new AIMessage('{}') }],
  });
  const run = await createSchemaAdvisorRun(options, { models });
  await expect(
    run.processStream(message(), config(options.identity.conversationId)),
  ).rejects.toThrow('Example review did not match its contract');
});

it('propagates cancellation through the custom node and model config', async () => {
  const controller = new AbortController();
  const options = input({ signal: controller.signal });
  const models = createAdvisorModels({});
  const called = [];
  const stream = models.chat._streamResponseChunks.bind(models.chat);
  models.chat._streamResponseChunks = async function* (messages, modelOptions) {
    called.push(modelOptions.signal);
    controller.abort(new Error('example cancelled'));
    yield* stream(messages, modelOptions);
  };
  const run = await createSchemaAdvisorRun(options, { models });
  await expect(
    run.processStream(message(), config(options.identity.conversationId)),
  ).rejects.toThrow();
  expect(called).toHaveLength(1);
  expect(called[0].aborted).toBe(true);
});

it('uses the authenticated host model over the real socket without falling back to worker models', async () => {
  const options = input();
  const secret = randomUUID() + randomUUID();
  const workerFallback = new ExampleAdvisorModel({});
  const fallback = jest.spyOn(workerFallback, '_generate');
  const server = createRemoteSdkServer({
    runtimeId: 'advisor',
    secret,
    authorize: (identity) => identity.userId === 'example' && identity.agentId === 'advisor',
    createRun: (request) =>
      createSchemaAdvisorRun(request, { models: { chat: workerFallback, fast: workerFallback } }),
  });
  server.server.listen(0, '127.0.0.1');
  await once(server.server, 'listening');
  const model = new ExampleAdvisorModel({});
  const generated = jest.spyOn(model, '_generate');
  const admission = new HostModelAdmission({ maxConcurrentCalls: 2, maxRequestBytes: 4194304 });
  try {
    const run = await createRemoteSdkRun({
      identity: options.identity,
      config: {
        ...options.config,
        returnContent: true,
        graphConfig: { type: 'standard', llmConfig: { provider: 'anthropic' } },
      },
      remote: { url: `ws://127.0.0.1:${server.server.address().port}/sdk`, secret },
      hostServices: {
        model: createHostModelService({
          identity: options.identity,
          model,
          admission,
          descriptor: {
            version: 1,
            reference: 'primary',
            provider: 'anthropic',
            model: 'example',
            streaming: true,
            tools: [],
          },
          limits: { timeoutMs: 10000, maxRequestBytes: 1048576, maxResponseBytes: 4194304 },
        }),
      },
    });
    const content = await run.processStream(message(), config(options.identity.conversationId));
    expect(JSON.stringify(content)).toContain('Reviewed example plan');
    expect(generated).toHaveBeenCalledTimes(5);
    expect(fallback).not.toHaveBeenCalled();
    expect(admission.snapshot().calls).toBe(0);
  } finally {
    await server.close();
  }
});

it('constructs the same native model classes with distinct primary/fast model names', () => {
  const { ChatAnthropic } = require('@langchain/anthropic');
  const { ChatBedrockConverse } = require('@langchain/aws');
  for (const [provider, Model] of [
    ['anthropic', ChatAnthropic],
    ['bedrock', ChatBedrockConverse],
  ]) {
    const models = createAdvisorModels({
      SDK_ADVISOR_PROVIDER: provider,
      SDK_ADVISOR_PRIMARY_MODEL: 'primary',
      SDK_ADVISOR_FAST_MODEL: 'fast',
      ANTHROPIC_API_KEY: 'test-only',
      AWS_REGION: 'us-east-2',
    });
    expect(models.chat).toBeInstanceOf(Model);
    expect(models.fast).toBeInstanceOf(Model);
    expect(models.chat.model).toBe('primary');
    expect(models.fast.model).toBe('fast');
  }
});
