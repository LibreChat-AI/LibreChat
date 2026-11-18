const { createRemoteSdkServer } = require('@librechat/api/sdk');
const { FakeChatModel } = require('@librechat/agents');
const {
  Annotation,
  StateGraph,
  START,
  END,
  messagesStateReducer,
} = require('@langchain/langgraph');
const { createExampleRun, createExampleModel } = require('../../examples/sdk-runtime/agent.cjs');

const runtime = createRemoteSdkServer({
  runtimeId: process.env.SDK_RUNTIME_ID,
  secret: process.env.SDK_RUNTIME_SECRET,
  authorize: (identity) => identity.runtimeId === process.env.SDK_RUNTIME_ID,
  createRun: async (input) => {
    if (!input.hostFiles || input.hostFiles.sources.length !== 1) {
      throw new Error('Expected one native attachment');
    }
    const read = async (file) => {
      const chunks = [];
      for await (const chunk of input.hostFiles.read(file, input.signal)) chunks.push(chunk);
      return Buffer.concat(chunks).toString('utf8');
    };
    const run = await createExampleRun(input, { complex: false });
    run.Graph.overrideModel = createExampleModel(true);
    const agent = run.graphRunnable;
    const state = Annotation.Root({
      messages: Annotation({ reducer: messagesStateReducer, default: () => [] }),
      runStepState: Annotation({ reducer: (_old, next) => next }),
      source: Annotation({ reducer: (_old, next) => next }),
    });
    run.graphRunnable = new StateGraph(state)
      .addNode('capture', async () => {
        const source = input.hostFiles.sources[0];
        await read(source);
        return { source };
      })
      .addNode('inspect', agent)
      .addNode('read_after_approval', async ({ source }) => {
        const content = await read(source);
        run.Graph.overrideModel = new FakeChatModel({
          responses: [`Remote attachment bytes: ${content}`],
          sleep: 10,
        });
        return {};
      })
      .addNode('reply', agent)
      .addEdge(START, 'capture')
      .addEdge('capture', 'inspect')
      .addEdge('inspect', 'read_after_approval')
      .addEdge('read_after_approval', 'reply')
      .addEdge('reply', END)
      .compile(input.compileOptions);
    return run;
  },
  onError: (error) => console.error('Remote file fixture failed', error),
});
runtime.server.listen(Number(process.env.SDK_RUNTIME_PORT), '127.0.0.1', () => {
  console.log('Remote file fixture listening on loopback');
});
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => void runtime.close().then(() => process.exit(0)));
}
