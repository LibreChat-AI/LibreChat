import { resolveSharedForkSelection } from './fork';

const agent = { name: 'agent', preset: { agent_id: 'agent_viewer' } };
const provider = { name: 'provider', preset: { endpoint: 'custom-endpoint', model: 'custom' } };
const assistant = {
  name: 'assistant',
  default: true,
  preset: { endpoint: 'assistants', assistant_id: 'asst_thread_required' },
};
const hidden = { ...provider, name: 'hidden', default: true, showInMenu: false };

function defaults() {
  return {
    getDefaultEndpoint: jest.fn(async () => ({ endpoint: 'openAI', model: 'gpt-test' })),
    getDefaultModel: jest.fn(async () => 'runtime-default'),
  };
}

it('restores the viewer spec agent ID and infers its endpoint without loading models', async () => {
  const deps = defaults();
  await expect(
    resolveSharedForkSelection({ ...deps, modelSpecs: { list: [agent] }, spec: agent.name }),
  ).resolves.toMatchObject({
    endpoint: 'agents',
    preset: { spec: 'agent', agent_id: 'agent_viewer' },
  });
  expect(deps.getDefaultModel).not.toHaveBeenCalled();
  expect(deps.getDefaultEndpoint).not.toHaveBeenCalled();
});

it('uses the soft default when hard defaults are hidden or require an existing provider thread', async () => {
  await expect(
    resolveSharedForkSelection({
      ...defaults(),
      modelSpecs: {
        enforce: true,
        list: [hidden, assistant, provider, { ...agent, softDefault: true }],
      },
      spec: assistant.name,
    }),
  ).resolves.toMatchObject({ endpoint: 'agents', preset: { spec: 'agent' } });
});

it('uses the first usable canonical spec and resolves a missing model on its endpoint', async () => {
  const deps = defaults();
  await expect(
    resolveSharedForkSelection({
      ...deps,
      modelSpecs: {
        enforce: true,
        list: [
          assistant,
          { ...provider, name: assistant.name, default: true },
          { ...provider, preset: { endpoint: 'custom-endpoint' } },
        ],
      },
    }),
  ).resolves.toEqual({
    endpoint: 'custom-endpoint',
    model: 'runtime-default',
    preset: { spec: 'provider' },
  });
  expect(deps.getDefaultModel).toHaveBeenCalledWith('custom-endpoint');
  expect(deps.getDefaultEndpoint).not.toHaveBeenCalled();
});

it('keeps the ordinary endpoint fallback when no spec matches and enforcement is off', async () => {
  await expect(
    resolveSharedForkSelection({ ...defaults(), modelSpecs: { list: [provider] }, spec: 'gone' }),
  ).resolves.toEqual({ endpoint: 'openAI', model: 'gpt-test', preset: {} });
});

it('does not create an unusable fork when no enforced spec can be selected', async () => {
  await expect(
    resolveSharedForkSelection({
      ...defaults(),
      modelSpecs: { enforce: true, list: [hidden, assistant] },
    }),
  ).rejects.toMatchObject({ code: 'invalid_request', statusCode: 422 });
});
