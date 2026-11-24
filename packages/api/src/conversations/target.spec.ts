import { FileSources, EModelEndpoint, normalizeEndpointName } from 'librechat-data-provider';
import type { TEndpointsConfig, TModelSpec } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import { resolveSavedSpecTarget, createSavedSpecTargetResolver } from './target';

const endpoint = 'Replacement Provider';
const spec: TModelSpec = {
  name: 'research',
  label: 'Research',
  showInMenu: false,
  preset: { endpoint, model: 'default-model', promptPrefix: 'Private preset instructions' },
};
const stored = {
  conversationId: 'saved-chat',
  endpoint: EModelEndpoint.bedrock,
  endpointType: EModelEndpoint.bedrock,
  model: 'selected-model',
  spec: 'research',
  agent_id: 'bedrock__selected-model',
  messages: ['first-message'],
};
const replacement = { order: 0, type: EModelEndpoint.custom };

function dependencies() {
  return {
    getModelSpecs: jest.fn(async () => ({ enforce: false, list: [spec] })),
    getEndpoints: jest.fn(async (): Promise<TEndpointsConfig> => ({ [endpoint]: replacement })),
    getModels: jest.fn(async () => ({ [normalizeEndpointName(endpoint)]: ['selected-model'] })),
  };
}

test('loads strict effective config for the requesting user before reading endpoint catalogs', async () => {
  const config: AppConfig = {
    config: {},
    fileStrategy: FileSources.local,
    imageOutputType: 'png',
    modelSpecs: { list: [spec] },
  };
  const user = { id: 'owner', role: 'USER', tenantId: 'tenant' };
  const req: { user: typeof user; config?: AppConfig } = { user };
  const getAppConfig = jest.fn(async () => config);
  const getEndpointsConfig = jest.fn(async (request: typeof req) => {
    expect(request.config).toBe(config);
    return { [endpoint]: replacement };
  });
  const getEndpointModelsConfig = jest.fn(async () => ({ [endpoint]: [stored.model] }));
  const resolve = createSavedSpecTargetResolver({
    getAppConfig,
    getEndpointsConfig,
    getEndpointModelsConfig,
  });

  await expect(resolve(req, stored)).resolves.toMatchObject({ endpoint, model: stored.model });
  expect(getAppConfig).toHaveBeenCalledWith(
    expect.objectContaining({
      userId: user.id,
      tenantId: user.tenantId,
      failClosed: true,
      skipRuntimeAugmentation: true,
    }),
  );
  expect(getEndpointModelsConfig).toHaveBeenCalledWith(req, endpoint, { strictDiscovery: true });
});

test('recovers a hidden spec and keeps the original model when the new endpoint serves it', async () => {
  const deps = dependencies();
  const result = await resolveSavedSpecTarget(stored, deps);
  expect(result).toEqual({
    endpoint,
    model: stored.model,
    endpointType: EModelEndpoint.custom,
    agent_id: undefined,
  });
  expect(deps.getModels).toHaveBeenCalledWith(endpoint);
  expect(stored.endpoint).toBe(EModelEndpoint.bedrock);
});

test('uses the spec model when the original model is absent from the replacement catalog', async () => {
  const deps = dependencies();
  deps.getModels.mockResolvedValueOnce({ [endpoint]: ['default-model'] });
  await expect(resolveSavedSpecTarget(stored, deps)).resolves.toMatchObject({
    endpoint,
    model: 'default-model',
  });
});

test('does not infer model absence without a replacement catalog entry', async () => {
  const deps = dependencies();
  deps.getModels.mockResolvedValueOnce({});
  await expect(resolveSavedSpecTarget(stored, deps)).rejects.toThrow(
    'Replacement model catalog unavailable',
  );
});

test('uses an enforced spec model without loading the catalog', async () => {
  const deps = dependencies();
  deps.getModelSpecs.mockResolvedValueOnce({ enforce: true, list: [spec] });
  await expect(resolveSavedSpecTarget(stored, deps)).resolves.toMatchObject({
    endpoint,
    model: 'default-model',
  });
  expect(deps.getModels).not.toHaveBeenCalled();
});

test.each([
  { [EModelEndpoint.bedrock]: { order: 1 }, [endpoint]: replacement },
  {},
] as TEndpointsConfig[])('keeps the saved target when endpoints are %j', async (endpoints) => {
  const deps = dependencies();
  deps.getEndpoints.mockResolvedValueOnce(endpoints);
  await expect(resolveSavedSpecTarget(stored, deps)).resolves.toBeUndefined();
  expect(deps.getModels).not.toHaveBeenCalled();
});

test.each([{ spec: null }, { agent_id: 'agent_saved' }, { endpoint: EModelEndpoint.agents }])(
  'skips config discovery for an ineligible target %j',
  async (changes) => {
    const deps = dependencies();
    const conversation = { ...stored, ...changes };
    await expect(resolveSavedSpecTarget(conversation, deps)).resolves.toBeUndefined();
    expect(deps.getModelSpecs).not.toHaveBeenCalled();
  },
);

test('keeps the saved target when the spec is missing from effective config', async () => {
  const deps = dependencies();
  deps.getModelSpecs.mockResolvedValueOnce({ enforce: false, list: [] });
  await expect(resolveSavedSpecTarget(stored, deps)).resolves.toBeUndefined();
  expect(deps.getEndpoints).not.toHaveBeenCalled();
});
