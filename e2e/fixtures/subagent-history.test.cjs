const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const test = require('node:test');
const vm = require('node:vm');
const path = require('node:path');
const { z } = require('zod');
const { tool } = require('@langchain/core/tools');
const { HumanMessage } = require('@langchain/core/messages');
const {
  Run,
  Providers,
  createTokenCounter,
  InMemorySubagentTaskStore,
} = require('@librechat/agents');
const history = require('./subagent-history.cjs');

const helpers = {
  getLatestUserText: (messages) => messages.findLast((message) => message.type === 'human').content,
  messageType: (message) => message.type,
  getContentText: (content) => content,
};
const human = (content) => ({ type: 'human', content });
const result = (call) => ({
  type: 'tool',
  tool_call_id: call.id,
  content: JSON.stringify([{ type: 'text', text: `E2E slow echo: ${call.args.text}` }]),
});

function scenario(t, childId) {
  const label = `node-${randomUUID()}`;
  const gates = history.control(label);
  t.after(() => fs.rm(gates.directory, { recursive: true, force: true }));
  const script = history.responsesForText(history.prompt(label, childId), helpers);
  return { label, gates, script };
}

async function drainHistory(script, messages) {
  const calls = [];
  for (let batch = 0; batch < history.CALL_COUNT / history.BATCH_SIZE; batch++) {
    const invocation = await script.resolveInvocation(messages);
    assert.equal(invocation.toolCalls.length, history.BATCH_SIZE);
    calls.push(...invocation.toolCalls);
    messages.push(...invocation.toolCalls.map(result));
  }
  return calls;
}

test('fixture exceeds retention, replay and output-preview limits', async (t) => {
  const { label, gates, script } = scenario(t);
  const messages = [human(history.prompt(label))];
  const calls = await drainHistory(script, messages);
  assert.equal(new Set(calls.map((call) => call.id)).size, history.CALL_COUNT);
  assert.ok(calls.length > 100);
  assert.ok(calls.length * 2 > 100, 'tool starts and ends alone overflow the event ring');
  assert.ok(Buffer.byteLength(history.output(label, 0)) > 16 * 1024);
  assert.ok(
    calls.slice(-100).reduce((bytes, call) => bytes + Buffer.byteLength(result(call).content), 0) >
      64 * 1024,
    'even the last 100 outputs exceed the replay byte budget',
  );
  assert.equal(await gates.has('ready'), false, 'readiness follows actual tool results');
});

test('normal and child scripts share retained history and gated continuation', async (t) => {
  for (const childId of ['main', 'agent_e2e_child']) {
    const { label, gates, script } = scenario(t, childId);
    const messages = [human(history.prompt(label, childId))];
    if (childId !== 'main') {
      const dispatch = await script.resolveInvocation(messages);
      assert.equal(dispatch.toolCalls[0].name, 'subagent');
      assert.equal(dispatch.toolCalls[0].args.run_in_background, true);
      assert.equal(dispatch.toolCalls[0].args.subagent_type, childId);
      const parent = await script.resolveInvocation([
        ...messages,
        { type: 'tool', tool_call_id: history.dispatchId(label), content: '{"status":"running"}' },
      ]);
      assert.equal(parent.response, `E2E history child dispatched ${label}`);
      messages.splice(0, 1, human(dispatch.toolCalls[0].args.description));
    }
    const calls = await drainHistory(script, messages);
    assert.deepEqual(
      calls.map((call) => call.id),
      Array.from({ length: history.CALL_COUNT }, (_, index) => history.callId(label, index)),
    );
    assert.ok(calls.every((call) => call.args.delay_ms === 0));
    assert.equal(calls[0].args.text, history.payload(label, 0));

    let advanced = false;
    const next = script.resolveInvocation(messages).then((value) => {
      advanced = true;
      return value;
    });
    await gates.wait('ready');
    assert.equal(advanced, false, 'browser hydration cannot race task completion');
    assert.equal(await gates.has('done'), false);
    await gates.signal('advance');
    const live = await next;
    assert.equal(live.response, history.liveText(label));
    assert.equal(live.toolCalls[0].id, history.callId(label, history.CALL_COUNT));
    messages.push(...live.toolCalls.map(result));

    let completed = false;
    const final = script.resolveInvocation(messages).then((value) => {
      completed = true;
      return value;
    });
    await gates.wait('live');
    assert.equal(completed, false, 'the new tool output is inspectable before completion');
    await gates.signal('complete');
    assert.equal((await final).response, history.completionText(label));
    assert.equal(await gates.has('done'), true);
  }
});

test('fixture refuses partial or truncated tool batches rather than reporting ready', async (t) => {
  const { label, gates, script } = scenario(t);
  const messages = [human(history.prompt(label))];
  const first = await script.resolveInvocation(messages);
  const results = first.toolCalls.map(result);
  await assert.rejects(
    script.resolveInvocation([...messages, results[0]]),
    /lost MCP results.*call 1 returned nothing/,
  );
  results[0].content = 'E2E slow echo: truncated';
  await assert.rejects(
    script.resolveInvocation([...messages, ...results]),
    /lost MCP results.*call 0 returned 24 characters without its \d+-character output/,
  );
  assert.equal(await gates.has('ready'), false);
  await assert.rejects(
    gates.wait('ready'),
    /failed before ready: .*lost MCP results.*call 0 returned 24 characters/,
    'a waiter reports why the task stopped instead of running out its own timeout',
  );
});

test('fixture gates have bounded timeouts and honor cancellation', async (t) => {
  const { gates } = scenario(t);
  await assert.rejects(gates.wait('advance', { timeoutMs: 0 }), /timed out/);
  const controller = new AbortController();
  const waiting = gates.wait('complete', { signal: controller.signal });
  controller.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  await gates.release();
  assert.equal(await gates.has('advance'), true);
  assert.equal(await gates.has('complete'), true);
});

test('fixture ignores unrelated prompts and rejects unsafe signal paths', () => {
  assert.equal(history.responsesForText('E2E_SUBAGENT_ACTIVITY:one,two:existing', helpers), null);
  assert.equal(history.responsesForText('E2E_REPLY:unchanged', helpers), null);
  assert.throws(() => history.control('../other-lane'), /Invalid.*label/);
});

test('fake-model hook routes the history marker without changing ordinary replies', async () => {
  class FakeChatModel {
    constructor(options) {
      Object.assign(this, options);
    }
  }
  const dependencies = {
    sharp: () => assert.fail('no history scenario renders an image'),
    '@librechat/agents': { FakeChatModel },
    '@langchain/core/outputs': { ChatGenerationChunk: class {} },
    '@langchain/core/messages': { AIMessageChunk: class {} },
    './model-replay': { tryBindReplay: () => false },
    './run-files-model': { runFileDeliveryResponses: () => null },
    './run-files-lifecycle-model': {
      createRunFileLifecycleResponses: () => ({
        responsesForText: () => null,
        resolveInvocation: () => null,
        isFixtureAgents: () => false,
      }),
    },
    '../fixtures/subagent-history.cjs': history,
  };
  const sandbox = {
    module: { exports: {} },
    process: { env: {} },
    require: (name) => {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected hook dependency ${name}`);
      return dependencies[name];
    },
  };
  const source = await fs.readFile(path.resolve(__dirname, '../setup/fake-model.js'), 'utf8');
  vm.runInNewContext(source, sandbox, { filename: 'fake-model.js' });
  const hook = sandbox.module.exports;
  const graph = {
    overrideTestModel() {},
    setSubagentModelOverride(model) {
      this.childModel = model;
    },
    humanInTheLoop: {},
    _subagentExecutors: [{ humanInTheLoop: {} }],
  };
  const messages = [human(history.prompt('hook-routing', 'agent_child'))];
  hook({ Graph: graph }, { messages });
  assert.equal(graph.childModel, graph.overrideModel);
  assert.equal(graph.humanInTheLoop, undefined);
  assert.equal(graph._subagentExecutors[0].humanInTheLoop, undefined);
  const dispatch = await graph.overrideModel.resolveInvocation(messages);
  assert.equal(dispatch.toolCalls[0].args.subagent_type, 'agent_child');
  const child = await graph.childModel.resolveInvocation([
    human(dispatch.toolCalls[0].args.description),
  ]);
  assert.equal(child.toolCalls.length, history.BATCH_SIZE);

  hook({ Graph: graph }, { messages: [human('E2E_REPLY:ordinary')] });
  assert.equal(graph.overrideModel.responses[0], 'E2E reply ordinary');
});

/**
 * The SDK run, graph, child graph, task store, tool node and pruner are real, and so is the
 * hook. Nothing here disposes the parent run, so its graph holds its agent context for the
 * child's whole life: the case the browser lanes only reach when the child's first call
 * returns before the host has dropped that context.
 */
test('a detached child keeps its tool results while the parent graph still holds its context', async (t) => {
  const { label, gates } = scenario(t, 'self');
  const agentId = 'agent_e2e_history';
  const runId = `run-${randomUUID()}`;
  const prompt = history.prompt(label, 'self');
  const instructions = 'Follow the deterministic end-to-end request exactly. '.repeat(40);
  const echo = tool(async ({ text }) => `E2E slow echo: ${text}`, {
    name: history.TOOL_NAME,
    description: 'Echoes text for the retained-history fixture.',
    schema: z.object({ text: z.string(), delay_ms: z.number().optional() }),
  });
  const run = await Run.create({
    runId,
    graphConfig: {
      type: 'standard',
      agents: [
        {
          agentId,
          provider: Providers.OPENAI,
          clientOptions: { model: 'mock-retained-history', apiKey: 'unused' },
          instructions,
          tools: [echo],
          maxContextTokens: 262_144,
          maxToolResultChars: 131_072,
          subagentConfigs: [
            { self: true, type: 'self', name: 'History Worker', description: 'Runs itself.' },
          ],
        },
      ],
    },
    tokenCounter: await createTokenCounter(),
    subagentTasks: { store: new InMemorySubagentTaskStore(), scopeId: `scope-${label}` },
    returnContent: true,
  });
  require('../setup/fake-model.js')(run, { messages: [new HumanMessage(prompt)] });

  /** Spies on what each stream reports, without replacing the model or its script. */
  const streams = [];
  const model = run.Graph.overrideModel;
  const stream = model._streamResponseChunks.bind(model);
  model._streamResponseChunks = async function* observed(messages, options, runManager) {
    let usage;
    for await (const chunk of stream(messages, options, runManager)) {
      usage = chunk.message?.usage_metadata ?? usage;
      yield chunk;
    }
    streams.push({
      runId: runManager.metadata.run_id,
      billed: usage.input_tokens,
      sent: Math.ceil(messages.reduce((sum, message) => sum + message.content.length, 0) / 4),
    });
  };

  await run.processStream(
    { messages: [new HumanMessage(prompt)] },
    { configurable: { thread_id: `thread-${label}` }, streamMode: 'values', version: 'v2' },
  );
  await gates.wait('ready', { timeoutMs: 30_000 });
  assert.ok(run.Graph.agentContexts.get(agentId), 'the parent graph still holds its context');

  const parent = streams.filter((entry) => entry.runId === runId);
  const child = streams.filter((entry) => entry.runId.startsWith(`${runId}:subagent-task:`));
  assert.equal(parent.length, 2, 'the SDK runs both parent calls under the graph run id');
  assert.equal(parent.length + child.length, streams.length);
  assert.ok(
    parent.every((entry) => entry.billed >= entry.sent + Math.floor(instructions.length / 4)),
    'the parent run is still billed its system prompt',
  );
  assert.equal(child.length, history.CALL_COUNT / history.BATCH_SIZE, 'one stream per batch');
  assert.deepEqual(
    child.map((entry) => entry.billed),
    child.map((entry) => entry.sent),
    'the child is billed for the messages it was sent, not for the parent prompt',
  );

  await gates.release();
  await gates.wait('done', { timeoutMs: 30_000 });
});

test('browser history worker uses an isolated endpoint with enough retained output budget', async () => {
  const config = await fs.readFile(path.resolve(__dirname, '../config/librechat.e2e.yaml'), 'utf8');
  const endpoint = config.match(/- name: 'Mock Retained History'\n(?:(?! {4}- name:).|\n)*/)?.[0];
  assert.ok(endpoint, 'history endpoint must remain available');
  const retainedChars = Number(endpoint.match(/maxToolResultChars: (\d+)/)?.[1]);
  assert.ok(retainedChars > history.output('retention-budget', 0).length);
  assert.match(endpoint, /mock-retained-history/);
  const browser = await fs.readFile(
    path.resolve(__dirname, '../specs/mock/subagent-activity.spec.ts'),
    'utf8',
  );
  assert.match(browser, /provider: tools\?\.length \? 'Mock Retained History'/);
});

test('does not demand old full model context after a tool batch was already verified', async (t) => {
  const { label, gates, script } = scenario(t);
  const messages = [human(history.prompt(label))];
  const first = await script.resolveInvocation(messages);
  messages.push(...first.toolCalls.map(result));
  const second = await script.resolveInvocation(messages);
  // Simulate provider-only pruning, not deletion of stored/public UI history.
  messages.splice(
    1,
    messages.length - 1,
    ...first.toolCalls.map((call) => ({
      type: 'tool',
      tool_call_id: call.id,
      content: 'Earlier context shortened',
    })),
    ...second.toolCalls.map(result),
  );
  const third = await script.resolveInvocation(messages);
  assert.equal(third.toolCalls[0].id, history.callId(label, 2 * history.BATCH_SIZE));
  assert.equal(await gates.has('ready'), false);
});

test('keeps a steered child on its original fixture branch instead of dispatching another child', async (t) => {
  const { label, script } = scenario(t, 'self');
  const messages = [
    human(`E2E_SUBAGENT_HISTORY_CHILD:${label}`),
    human('Additional parent guidance.'),
  ];
  const invocation = await script.resolveInvocation(messages);
  assert.equal(invocation.toolCalls.length, history.BATCH_SIZE);
  assert.equal(invocation.toolCalls[0].name, history.TOOL_NAME);
  assert.equal(invocation.toolCalls[0].id, history.callId(label, 0));
});
