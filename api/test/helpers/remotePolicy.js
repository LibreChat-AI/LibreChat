const { once } = require('node:events');
const { randomBytes, randomUUID } = require('node:crypto');
const { FakeChatModel } = require('@langchain/core/utils/testing');
const { AIMessage, AIMessageChunk, SystemMessage } = require('@langchain/core/messages');
const { ChatGenerationChunk } = require('@langchain/core/outputs');
const { agentsEndpointSchema } = require('librechat-data-provider');

/** Real host model and authenticated socket bridge; only the provider and storage are fake. */
async function createRemotePolicyFixture({ blocked = false, beforeProvider, usage } = {}) {
  const api = jest.requireActual('@librechat/api');
  const { Run } = jest.requireActual('@librechat/agents');
  const { createRemoteSdkServer } = jest.requireActual('@librechat/api/sdk');
  const secret = randomBytes(32).toString('hex');
  const provider = jest.fn(async (_messages) => {
    await beforeProvider?.();
    return 'Approved answer';
  });
  const factory = jest.fn(async ({ config, identity, hostModel, signal, compileOptions }) => {
    const run = await Run.create({
      ...config,
      returnContent: true,
      tokenCounter: () => 1,
      graphConfig: {
        type: 'standard',
        signal,
        compileOptions,
        agents: [
          {
            agentId: identity.agentId,
            provider: 'openAI',
            maxContextTokens: 8192,
            instructions: 'Answer briefly',
            clientOptions: { model: 'gpt-4.1-mini', streaming: true },
            tools: [],
          },
        ],
      },
    });
    run.Graph.overrideModel = hostModel;
    if (blocked) {
      const processStream = run.processStream.bind(run);
      run.processStream = (input, ...args) =>
        processStream(
          {
            ...input,
            messages: [
              new SystemMessage({ content: 'RUNTIME-PRIVATE-CANARY', id: randomUUID() }),
              ...input.messages,
            ],
          },
          ...args,
        );
    }
    return run;
  });
  const errors = [];
  const runtime = createRemoteSdkServer({
    runtimeId: 'policy-test',
    secret,
    authorize: (identity) => identity.runtimeId === 'policy-test' && identity.userId === 'user-123',
    createRun: factory,
    onError: (error) => errors.push(error),
  });
  runtime.server.listen(0, '127.0.0.1');
  await once(runtime.server, 'listening');
  const remote = {
    url: `ws://127.0.0.1:${runtime.server.address().port}/sdk`,
    secret,
    hostModel: true,
    onError: (error) => errors.push(error),
  };
  const sdkModelHost = api.createSdkModelHost(
    agentsEndpointSchema.parse({ sdkHostModels: {} }).sdkHostModels,
    ({ clientOptions }) => {
      const model = new FakeChatModel({ callbacks: clientOptions.callbacks });
      model.bindTools = () => model;
      model._generate = async (messages) => {
        const content = await provider(messages);
        return {
          generations: [
            { text: content, message: new AIMessage({ content, usage_metadata: usage }) },
          ],
        };
      };
      model._streamResponseChunks = async function* (messages) {
        const content = await provider(messages);
        yield new ChatGenerationChunk({
          text: content,
          message: new AIMessageChunk({ content, usage_metadata: usage }),
        });
      };
      return model;
    },
  );
  return {
    provider,
    factory,
    sdkModelHost,
    errors,
    configure(req) {
      req.user.role = 'USER';
      req.app = { locals: { sdkModelHost } };
      req.config.filters = {
        agentInstructions: {
          pii: {
            fields: ['instructions'],
            starterPatterns: [],
            customPatterns: [{ id: 'runtime', label: 'runtime', regex: 'RUNTIME-PRIVATE-CANARY' }],
          },
        },
      };
      req.config.endpoints.agents.sdkRuntimes = { 'policy-test': { roles: ['USER'], remote } };
      req.config.summarization = { enabled: false };
    },
    agent: {
      id: 'agent-123',
      maxContextTokens: 8192,
      provider: 'openAI',
      endpoint: 'openAI',
      model: 'gpt-4.1-mini',
      model_parameters: { model: 'gpt-4.1-mini', apiKey: 'host-only-secret' },
      tools: [],
      toolRegistry: new Map(),
      instructions: 'Safe host instructions',
      sdk_runtime: { id: 'policy-test', protocolVersion: 1 },
    },
    close: () => runtime.close(),
  };
}
module.exports = { createRemotePolicyFixture };
