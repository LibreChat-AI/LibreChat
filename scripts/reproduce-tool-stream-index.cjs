/**
 * Investigation harness for #16203, not a production handler implementation.
 * See reproduce-tool-stream-index.md for pinned dependencies and commands.
 * Only the external Bedrock transport and the consumer's fetch are substituted.
 * Controller closures are selected by AST and executed unchanged from each source file.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const runtime = path.join(root, '.repro/runtime/node_modules');
const ts = require(path.join(runtime, 'typescript'));
const agents = require(path.join(runtime, '@librechat/agents'));
const bedrock = require(
  path.join(runtime, '@librechat/agents/dist/cjs/llm/bedrock/utils/message_outputs.cjs'),
);
const { createOpenAICompatible } = require(path.join(runtime, '@ai-sdk/openai-compatible'));

assert.equal(require(path.join(runtime, '@librechat/agents/package.json')).version, '3.9.0');
assert.equal(
  require(path.join(runtime, '@ai-sdk/openai-compatible/package.json')).version,
  '1.0.22',
);

function parse(file) {
  return ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
}

function findOne(source, predicate, description) {
  const matches = [];
  const visit = (node) => {
    if (predicate(node)) {
      matches.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.equal(matches.length, 1, `Expected exactly one ${description}`);
  return matches[0];
}

function variable(source, name) {
  return findOne(
    source,
    (node) => ts.isVariableDeclaration(node) && node.name.getText(source) === name,
    name,
  ).getText(source);
}

function functions(source, names) {
  return names
    .map((name) =>
      findOne(source, (node) => ts.isFunctionDeclaration(node) && node.name?.text === name, name)
        .getText(source)
        .replace(/^export /, ''),
    )
    .join('\n');
}

const sharedNames = [
  'createChunk',
  'writeSSE',
  'createOpenAIStreamTracker',
  'createOpenAIContentAggregator',
  'sendFinalChunk',
];
const sharedSource = functions(
  parse(path.join(root, 'packages/api/src/agents/openai/handlers.ts')),
  sharedNames,
);
const responseSource = functions(
  parse(path.join(root, 'packages/api/src/agents/openai/service.ts')),
  ['buildNonStreamingResponse'],
);
const shared = vm.runInNewContext(
  ts.transpileModule(
    `${sharedSource}\n${responseSource}\n({${sharedNames.join(',')},buildNonStreamingResponse});`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
  ).outputText,
);

const handlerNames = ['on_message_delta', 'on_reasoning_delta', 'on_run_step', 'on_run_step_delta'];

function bridge(file, isStreaming) {
  const source = parse(file);
  const handlers = findOne(
    source,
    (node) => ts.isVariableDeclaration(node) && node.name.getText(source) === 'handlers',
    'controller handlers',
  ).initializer;
  assert.ok(ts.isObjectLiteralExpression(handlers));
  const selected = handlers.properties.filter((property) =>
    handlerNames.includes(property.name?.getText(source)),
  );
  assert.equal(selected.length, handlerNames.length);
  const wire = [];
  const context = { requestId: 'chatcmpl-repro', created: 1, model: 'agent-repro' };
  const res = { write: (text) => wire.push(text) };
  const tracker = shared.createOpenAIStreamTracker();
  const aggregator = shared.createOpenAIContentAggregator();
  const declarations = ['createHandler', 'streamText', 'streamReasoning']
    .map((name) => `const ${variable(source, name)};`)
    .join('\n');
  const callbacks = vm.runInNewContext(
    `${declarations}\n({${selected.map((node) => node.getText(source)).join(',')}});`,
    { ...shared, isStreaming, context, res, tracker, aggregator },
    { filename: file },
  );
  return {
    callbacks,
    tracker,
    aggregator,
    wire,
    finish() {
      if (isStreaming) {
        shared.sendFinalChunk({ context, res, tracker });
      }
      return shared.buildNonStreamingResponse(
        context,
        aggregator.getText(),
        aggregator.getReasoning(),
        aggregator.toolCalls,
        { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      );
    },
  };
}

function text(index, value) {
  return bedrock.handleConverseStreamContentBlockDelta({
    contentBlockIndex: index,
    delta: { text: value },
  }).message;
}

function tool(index, id, city) {
  return [
    bedrock.handleConverseStreamContentBlockStart({
      contentBlockIndex: index,
      start: { toolUse: { toolUseId: id, name: 'get_time' } },
    }).message,
    bedrock.handleConverseStreamContentBlockDelta({
      contentBlockIndex: index,
      delta: { toolUse: { input: '{"city":' } },
    }).message,
    bedrock.handleConverseStreamContentBlockDelta({
      contentBlockIndex: index,
      delta: { toolUse: { input: `${JSON.stringify(city)}}` } },
    }).message,
  ];
}

const scenarios = [
  {
    name: 'zero-index tool',
    rounds: () => [tool(0, 'call_a', 'Madrid')],
    expected: [{ id: 'call_a', city: 'Madrid' }],
  },
  {
    name: 'text then nonzero-index tool',
    rounds: () => [[text(0, 'Checking.'), ...tool(1, 'call_a', 'Madrid')]],
    expected: [{ id: 'call_a', city: 'Madrid' }],
  },
  {
    name: 'two parallel tools in one model response',
    rounds: () => [[...tool(0, 'call_a', 'Madrid'), ...tool(1, 'call_b', 'Paris')]],
    expected: [
      { id: 'call_a', city: 'Madrid' },
      { id: 'call_b', city: 'Paris' },
    ],
  },
  {
    name: 'two model responses reuse provider index zero',
    rounds: () => [tool(0, 'call_a', 'Madrid'), tool(0, 'call_b', 'Paris')],
    expected: [
      { id: 'call_a', city: 'Madrid' },
      { id: 'call_b', city: 'Paris' },
    ],
  },
  {
    name: 'reported index 2 to 1 shape after earlier model text',
    rounds: () => [
      [text(0, 'Earlier response.')],
      [text(0, 'Checking.'), ...tool(1, 'call_a', 'Madrid')],
    ],
    expected: [{ id: 'call_a', city: 'Madrid' }],
  },
];

async function consume(wire) {
  const provider = createOpenAICompatible({
    name: 'reproduction',
    baseURL: 'https://reproduction.invalid/v1',
    fetch: async () =>
      new Response(wire.join(''), { headers: { 'Content-Type': 'text/event-stream' } }),
  });
  const output = [];
  let error = null;
  try {
    const result = await provider.chatModel('agent-repro').doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Use get_time.' }] }],
    });
    for await (const part of result.stream) {
      output.push(part);
    }
  } catch (caught) {
    error = { name: caught.name, message: caught.message, data: caught.data };
  }
  return { output, error };
}

function checkCalls(calls, expected) {
  return (
    calls.length === expected.length &&
    expected.every(({ id, city }, index) => {
      const call = calls[index];
      return call.id === id && call.name === 'get_time' && call.args === JSON.stringify({ city });
    })
  );
}

async function replay(file, scenario, isStreaming) {
  const output = bridge(file, isStreaming);
  const graph = new agents.StandardGraph({
    runId: 'repro',
    agents: [{ agentId: 'repro', provider: agents.Providers.BEDROCK, model: 'fixture', tools: [] }],
  });
  graph.config = { configurable: { run_id: 'repro', thread_id: 'repro' } };
  graph.handlerRegistry = new agents.HandlerRegistry();
  const events = [];
  for (const [name, callback] of Object.entries(output.callbacks)) {
    graph.handlerRegistry.register(name, {
      handle: async (event, data, metadata, eventGraph) => {
        events.push({ event, data: JSON.parse(JSON.stringify(data)) });
        await callback.handle(event, data, metadata, eventGraph);
      },
    });
  }
  const producer = new agents.ChatModelStreamHandler();
  for (const [round, chunks] of scenario.rounds().entries()) {
    const metadata = { langgraph_node: 'agent=repro', langgraph_step: 1 + 2 * round };
    for (const chunk of chunks) {
      await producer.handle('on_chat_model_stream', { chunk }, metadata, graph);
    }
  }
  const response = output.finish();
  const consumer = isStreaming ? await consume(output.wire) : null;
  const calls = isStreaming
    ? consumer.output
        .filter((part) => part.type === 'tool-call')
        .map((part) => ({ id: part.toolCallId, name: part.toolName, args: part.input }))
    : (response.choices[0].message.tool_calls ?? []).map((call) => ({
        id: call.id,
        name: call.function.name,
        args: call.function.arguments,
      }));
  const sse = output.wire
    .filter((frame) => frame !== 'data: [DONE]\n\n')
    .map((frame) => JSON.parse(frame.slice(6)));
  return {
    scenario: scenario.name,
    mode: isStreaming ? 'stream' : 'nonstream',
    correct: !consumer?.error && checkCalls(calls, scenario.expected),
    calls,
    error: consumer?.error ?? null,
    finishReason: isStreaming
      ? sse.at(-1).choices[0].finish_reason
      : response.choices[0].finish_reason,
    tracker: [...(isStreaming ? output.tracker : output.aggregator).toolCalls],
    sse,
    events,
  };
}

async function main() {
  const versions = {
    dev: path.join(root, 'api/server/controllers/agents/openai.js'),
    pr: path.resolve(root, process.argv[2] ?? '.repro/pr-openai.js'),
  };
  const results = [];
  for (const [version, file] of Object.entries(versions)) {
    for (const scenario of scenarios) {
      for (const stream of [true, false]) {
        const result = await replay(file, scenario, stream);
        results.push({ version, ...result });
        console.log(
          `${version.padEnd(3)} ${result.mode.padEnd(9)} ${scenario.name}: ` +
            `${result.correct ? 'CORRECT' : 'BROKEN'}; calls=${JSON.stringify(result.calls)}; ` +
            `error=${result.error?.message ?? 'none'}; finish=${result.finishReason}`,
        );
      }
    }
  }
  const correctness = (version) =>
    results.filter((row) => row.version === version).map((row) => row.correct);
  assert.deepEqual(correctness('dev'), [
    false,
    false,
    true,
    true,
    false,
    false,
    false,
    false,
    false,
    false,
  ]);
  assert.deepEqual(correctness('pr'), [
    true,
    true,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
  ]);
  fs.writeFileSync(path.join(root, '.repro/results.json'), `${JSON.stringify(results, null, 2)}\n`);
  console.log(
    '\nReproduction assertions passed. Full graph events, SSE and consumer results: .repro/results.json',
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
