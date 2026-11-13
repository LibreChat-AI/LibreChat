const assert = require('node:assert/strict');
const { test } = require('node:test');
const { HumanMessage } = require('@langchain/core/messages');
const fakeModelHook = require('./fake-model');

function setup(prompt = 'E2E_REPLY: callbacks') {
  const events = [];
  const shared = {
    handleLLMEnd() {
      events.push('shared:end');
    },
  };
  const callback = (agentId) => ({
    handleChatModelStart() {
      events.push(`${agentId}:start`);
    },
    handleLLMEnd(output) {
      events.push(`${agentId}:end`);
      const usage = output.generations[0][0].message.usage_metadata;
      if (usage) {
        assert.ok(usage.input_tokens > 0);
        assert.ok(usage.output_tokens > 0);
      }
    },
    handleLLMError() {
      events.push(`${agentId}:error`);
    },
  });
  const graph = {
    overrideTestModel() {},
    agentContexts: new Map(
      ['a', 'b'].map((agentId) => [
        agentId,
        { clientOptions: { callbacks: [shared, callback(agentId)] } },
      ]),
    ),
  };
  fakeModelHook(
    { Graph: graph },
    { messages: [new HumanMessage(prompt)], modelCallbacks: [shared], agents: [] },
  );
  return { model: graph.overrideModel, events };
}

async function consume(model, agentId) {
  const chunks = [];
  for await (const chunk of await model.stream([new HumanMessage('hello')], {
    metadata: { agentId },
  })) {
    chunks.push(chunk);
  }
  return chunks;
}

test('parallel fake streams preserve only the active agent callbacks and emit usage', async () => {
  const { model, events } = setup();
  const results = await Promise.all([consume(model, 'a'), consume(model, 'b')]);
  assert.deepEqual(events.sort(), [
    'a:end',
    'a:start',
    'b:end',
    'b:start',
    'shared:end',
    'shared:end',
  ]);
  for (const chunks of results) {
    assert.ok(chunks.at(-1).usage_metadata.total_tokens > 0);
  }
});

test('nonstreaming fake calls preserve the active agent callbacks once', async () => {
  const { model, events } = setup();
  await model.invoke([new HumanMessage('hello')], { metadata: { agentId: 'b' } });
  assert.deepEqual(events.sort(), ['b:end', 'b:start', 'shared:end']);
});

test('failed fake streams keep the active agent error callback', async () => {
  const { model, events } = setup('E2E_FORCED_ERROR: callbacks');
  await assert.rejects(consume(model, 'a'), /E2E forced stream error/);
  assert.deepEqual(events, ['a:start', 'a:error']);
});
