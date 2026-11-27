import { Constants, FileSources } from 'librechat-data-provider';
import type { Agent, TConversation, TModelSpec } from 'librechat-data-provider';
import type { LoadAddedAgentDeps } from '../added';
import { loadAddedAgent, resolveAddedModel } from '../added';

type AddedRequest = Parameters<typeof loadAddedAgent>[0]['req'];

const deps: LoadAddedAgentDeps = {
  getAgent: async ({ id }) => ({ id, provider: 'openAI', model: 'gpt-4o' }) as Agent,
  getMCPServerTools: jest.fn(),
};

const specA = {
  name: 'spec-a',
  label: 'Model A',
  preset: { endpoint: 'MyEndpoint', model: 'model-a', promptPrefix: 'You are model A.' },
} as TModelSpec;

const specB = {
  name: 'spec-b',
  label: 'Model B',
  preset: {
    endpoint: 'MyEndpoint',
    model: 'model-b',
    temperature: 0.3,
    promptPrefix: 'You are model B.',
  },
} as TModelSpec;

const agentSpec = {
  name: 'spec-agent',
  label: 'Agent',
  preset: { endpoint: 'agents', agent_id: 'agent_spec' },
} as TModelSpec;

const myEndpoint = {
  name: 'MyEndpoint',
  apiKey: 'test-key',
  baseURL: 'http://localhost:1/v1',
  models: { default: ['model-a', 'model-b'] },
};

const createReq = ({
  enforce = false,
  list = [specA, specB, agentSpec],
  custom = [myEndpoint],
}: {
  enforce?: boolean;
  list?: TModelSpec[];
  custom?: Array<Record<string, unknown>>;
} = {}): AddedRequest => ({
  user: { id: 'user123' },
  body: {},
  config: {
    config: {},
    fileStrategy: FileSources.local,
    imageOutputType: 'png',
    endpoints: { custom },
    modelSpecs: { enforce, list },
  },
});

/** What the client sends for a pane on spec B: the public preset, never its prompt. */
const paneB = {
  endpoint: 'MyEndpoint',
  endpointType: 'custom',
  model: 'model-b',
  spec: 'spec-b',
  temperature: 0.3,
} as unknown as TConversation;

const ephemeralPrimary = {
  id: Constants.EPHEMERAL_AGENT_ID as string,
  tools: [],
} as unknown as Agent;

describe('loadAddedAgent model spec preset', () => {
  test.each([
    ['an ephemeral primary', ephemeralPrimary],
    ['a saved primary agent', undefined],
  ])("applies the pane's own spec prompt beside %s", async (_label, primaryAgent) => {
    const result = await loadAddedAgent(
      { req: createReq(), conversation: paneB, primaryAgent },
      deps,
    );

    expect(result?.instructions).toBe('You are model B.');
    expect(result?.model).toBe('model-b');
    expect(result?.model_parameters).toEqual({ temperature: 0.3 });
  });

  test.each([
    ['an ephemeral primary', ephemeralPrimary],
    ['a saved primary agent', undefined],
  ])('keeps the provider settings the pane carries beside %s', async (_label, primaryAgent) => {
    const conversation = {
      ...paneB,
      reasoning_effort: 'high',
      useResponsesApi: true,
      maxContextTokens: 4000,
    } as TConversation;

    const result = await loadAddedAgent({ req: createReq(), conversation, primaryAgent }, deps);

    expect(result?.model_parameters).toEqual({
      temperature: 0.3,
      reasoning_effort: 'high',
      useResponsesApi: true,
      maxContextTokens: 4000,
    });
  });

  test("keeps the pane's own prompt over its spec's without enforcement", async () => {
    const result = await loadAddedAgent(
      {
        req: createReq(),
        conversation: { ...paneB, promptPrefix: 'My own prompt.' } as TConversation,
        primaryAgent: ephemeralPrimary,
      },
      deps,
    );

    expect(result?.instructions).toBe('My own prompt.');
  });

  test("lets an enforced spec's preset replace what the pane sends", async () => {
    const result = await loadAddedAgent(
      {
        req: createReq({ enforce: true }),
        conversation: {
          ...paneB,
          model: 'model-a',
          temperature: 0.9,
          promptPrefix: 'My own prompt.',
        } as TConversation,
        primaryAgent: ephemeralPrimary,
      },
      deps,
    );

    expect(result?.instructions).toBe('You are model B.');
    expect(result?.model).toBe('model-b');
    expect(result?.model_parameters).toEqual({ temperature: 0.3 });
  });

  test.each([
    ['enforced', true, 'model-b'],
    ['not enforced', false, 'model-a'],
  ])('predicts the model it runs when specs are %s', async (_label, enforce, expected) => {
    const conversation = { ...paneB, model: 'model-a' } as TConversation;
    const modelSpecs = { enforce, list: [specA, specB, agentSpec] };

    const result = await loadAddedAgent(
      { req: createReq({ enforce }), conversation, primaryAgent: ephemeralPrimary },
      deps,
    );

    expect(result?.model).toBe(expected);
    expect(resolveAddedModel(conversation, modelSpecs)).toBe(expected);
  });

  test('parses a pane stored without its endpoint type as its custom endpoint', async () => {
    const { endpointType: _endpointType, ...stored } = paneB;

    const result = await loadAddedAgent(
      { req: createReq(), conversation: stored as TConversation, primaryAgent: ephemeralPrimary },
      deps,
    );

    expect(result?.instructions).toBe('You are model B.');
    expect(result?.model_parameters).toEqual({ temperature: 0.3 });
  });

  test('parses a custom endpoint with the parameters of its provider', async () => {
    const conversation = {
      ...paneB,
      thinking: true,
      thinkingBudget: 2000,
      maxOutputTokens: 900,
      reasoning_effort: 'high',
    } as TConversation;

    const result = await loadAddedAgent(
      {
        req: createReq({ custom: [{ ...myEndpoint, provider: 'anthropic' }] }),
        conversation,
        primaryAgent: ephemeralPrimary,
      },
      deps,
    );

    expect(result?.model_parameters).toEqual({
      temperature: 0.3,
      thinking: true,
      thinkingBudget: 2000,
      maxOutputTokens: 900,
    });
  });

  test('leaves a pane with an unknown spec without one when specs are not enforced', async () => {
    const result = await loadAddedAgent(
      {
        req: createReq(),
        conversation: { ...paneB, spec: 'retired-spec' } as TConversation,
        primaryAgent: ephemeralPrimary,
      },
      deps,
    );

    expect(result?.instructions).toBe('');
    expect(result?.model).toBe('model-b');
  });

  test.each([
    ['a spec for another endpoint', false, { ...paneB, spec: 'spec-agent' }],
    ['a spec for another endpoint when enforced', true, { ...paneB, spec: 'spec-agent' }],
    ['no spec when enforced', true, { ...paneB, spec: null }],
    ['an unknown spec when enforced', true, { ...paneB, spec: 'retired-spec' }],
  ])('refuses %s', async (_label, enforce, conversation) => {
    const result = await loadAddedAgent(
      {
        req: createReq({ enforce }),
        conversation: conversation as TConversation,
        primaryAgent: ephemeralPrimary,
      },
      deps,
    );

    expect(result).toBeNull();
  });

  test.each([
    ['the agent its spec presets', 'spec-agent', 'agent_spec', 'agent_spec____1'],
    ['another agent than its spec presets', 'spec-agent', 'agent_other', undefined],
    ['no spec', undefined, 'agent_spec', undefined],
  ])('under enforcement, loads an agent pane naming %s', async (_label, spec, agentId, id) => {
    const result = await loadAddedAgent(
      {
        req: createReq({ enforce: true }),
        conversation: { endpoint: 'agents', agent_id: agentId, spec } as TConversation,
      },
      deps,
    );

    expect(result?.id).toBe(id);
  });
});
