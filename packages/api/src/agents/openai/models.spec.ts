import { EModelEndpoint, Tools } from 'librechat-data-provider';
import type { TEndpointsConfig, TModelsConfig } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { RemoteModelContext } from './models';
import type { LoadAgentDeps } from '../load';
import {
  toOpenAIModel,
  isRemoteModelContinuationAllowed,
  toRemoteModelConversation,
  stripCallerToggles,
  isListedRemoteModel,
  remoteModelEndpoints,
  createRemoteModelService,
  listRemoteModels,
  resolveRemoteModel,
  buildRemoteModelAgent,
  isRemoteModelAccessEnabled,
} from './models';

const endpointsConfig = {
  [EModelEndpoint.openAI]: { order: 0 },
  [EModelEndpoint.agents]: { order: 1 },
  openrouter: { order: 2, type: EModelEndpoint.custom },
  byok: { order: 3, type: EModelEndpoint.custom, userProvide: true },
} as unknown as TEndpointsConfig;

const modelsConfig: TModelsConfig = {
  [EModelEndpoint.openAI]: ['gpt-4o', 'gpt-4o-mini'],
  openrouter: ['anthropic/claude-sonnet-4'],
  byok: ['secret-model'],
};

const specs = [
  {
    name: 'gpt-concise',
    label: 'GPT (concise)',
    description: 'Short answers',
    preset: {
      endpoint: EModelEndpoint.openAI,
      model: 'gpt-4o',
      temperature: 0.2,
      promptPrefix: 'Answer in one sentence.',
    },
  },
  {
    name: 'researcher',
    label: 'Researcher',
    webSearch: true,
    preset: { endpoint: EModelEndpoint.openAI, model: 'gpt-4o' },
  },
  {
    name: 'hidden-spec',
    label: 'Hidden',
    showInMenu: false,
    preset: { endpoint: EModelEndpoint.openAI, model: 'gpt-4o-mini' },
  },
  {
    name: 'saved-agent-spec',
    label: 'Agent',
    preset: { endpoint: EModelEndpoint.agents, agent_id: 'agent_x' },
  },
  {
    name: 'byok-spec',
    label: 'Bring your own key',
    preset: { endpoint: 'byok', model: 'secret-model' },
  },
];

function context(
  overrides: {
    enabled?: boolean;
    enforce?: boolean;
    modelSelect?: boolean;
  } = {},
): RemoteModelContext {
  const { enabled = true, enforce = false, modelSelect = true } = overrides;
  const appConfig = {
    endpoints: { [EModelEndpoint.agents]: { remoteApi: { models: { enabled } } } },
    modelSpecs: { enforce, list: specs },
    interfaceConfig: { modelSelect },
  } as unknown as AppConfig;
  return { appConfig, endpointsConfig, modelsConfig };
}

describe('isRemoteModelAccessEnabled', () => {
  it('is on by default and off only when remoteApi.models.enabled is false', () => {
    expect(isRemoteModelAccessEnabled(undefined)).toBe(true);
    expect(isRemoteModelAccessEnabled({} as AppConfig)).toBe(true);
    expect(
      isRemoteModelAccessEnabled({
        endpoints: { [EModelEndpoint.agents]: { remoteApi: {} } },
      } as unknown as AppConfig),
    ).toBe(true);
    expect(isRemoteModelAccessEnabled(context().appConfig)).toBe(true);
    expect(isRemoteModelAccessEnabled(context({ enabled: false }).appConfig)).toBe(false);
  });
});

describe('listRemoteModels', () => {
  it('lists nothing while the feature is off', () => {
    expect(listRemoteModels(context({ enabled: false }))).toEqual([]);
  });

  it('lists visible specs on runnable endpoints, then endpoint/model pairs', () => {
    const ids = listRemoteModels(context()).map((t) => t.id);
    expect(ids).toEqual([
      'gpt-concise',
      'researcher',
      'openAI/gpt-4o',
      'openAI/gpt-4o-mini',
      'openrouter/anthropic/claude-sonnet-4',
    ]);
  });

  it('never lists hidden specs, agent specs, or user-provided-key endpoints', () => {
    const ids = listRemoteModels(context()).map((t) => t.id);
    expect(ids).not.toContain('hidden-spec');
    expect(ids).not.toContain('saved-agent-spec');
    expect(ids).not.toContain('byok-spec');
    expect(ids.some((id) => id.startsWith('byok/'))).toBe(false);
    expect(ids.some((id) => id.startsWith('agents/'))).toBe(false);
  });

  it('lists only specs when modelSpecs.enforce is on', () => {
    const ids = listRemoteModels(context({ enforce: true })).map((t) => t.id);
    expect(ids).toEqual(['gpt-concise', 'researcher']);
  });

  it('lists only specs when model selection is disabled in the interface', () => {
    const ids = listRemoteModels(context({ modelSelect: false })).map((t) => t.id);
    expect(ids).toEqual(['gpt-concise', 'researcher']);
  });

  it('omits endpoints missing from the user endpoints config', () => {
    const ctx = context();
    const ids = listRemoteModels({
      ...ctx,
      endpointsConfig: { openrouter: { order: 2, type: EModelEndpoint.custom } } as never,
    }).map((t) => t.id);
    expect(ids).toEqual(['openrouter/anthropic/claude-sonnet-4']);
  });
});

describe('resolveRemoteModel', () => {
  it('resolves nothing while the feature is off', () => {
    expect(resolveRemoteModel('gpt-concise', context({ enabled: false }))).toBeNull();
  });

  it('resolves a spec by name, including a hidden one', () => {
    expect(resolveRemoteModel('gpt-concise', context())).toMatchObject({
      kind: 'model_spec',
      endpoint: EModelEndpoint.openAI,
    });
    expect(resolveRemoteModel('hidden-spec', context())).toMatchObject({ kind: 'model_spec' });
  });

  it('refuses specs on agent or user-provided-key endpoints', () => {
    expect(resolveRemoteModel('saved-agent-spec', context())).toBeNull();
    expect(resolveRemoteModel('byok-spec', context())).toBeNull();
  });

  it('resolves endpoint/model only for listed models, splitting at the first slash', () => {
    expect(resolveRemoteModel('openAI/gpt-4o', context())).toMatchObject({
      kind: 'endpoint_model',
      endpoint: EModelEndpoint.openAI,
      model: 'gpt-4o',
    });
    expect(resolveRemoteModel('openrouter/anthropic/claude-sonnet-4', context())).toMatchObject({
      endpoint: 'openrouter',
      endpointType: EModelEndpoint.custom,
      model: 'anthropic/claude-sonnet-4',
    });
    expect(resolveRemoteModel('openAI/gpt-unlisted', context())).toBeNull();
    expect(resolveRemoteModel('byok/secret-model', context())).toBeNull();
    expect(resolveRemoteModel('agents/agent_x', context())).toBeNull();
  });

  it('refuses endpoint/model when specs are enforced or model selection is off', () => {
    expect(resolveRemoteModel('openAI/gpt-4o', context({ enforce: true }))).toBeNull();
    expect(resolveRemoteModel('openAI/gpt-4o', context({ modelSelect: false }))).toBeNull();
    expect(resolveRemoteModel('gpt-concise', context({ enforce: true }))).not.toBeNull();
  });

  it('refuses malformed ids', () => {
    for (const bad of [undefined, 42, '', '/gpt-4o', 'openAI/', 'x'.repeat(513)]) {
      expect(resolveRemoteModel(bad, context())).toBeNull();
    }
  });
});

describe('buildRemoteModelAgent', () => {
  const deps: LoadAgentDeps = {
    getAgent: jest.fn(),
    getMCPServerTools: jest.fn(async () => null),
    getAccessibleMCPServers: jest.fn(async () => ({})),
  };

  it("runs a spec as the chat UI's ephemeral agent, with the spec's preset", async () => {
    const ctx = context();
    const target = resolveRemoteModel('gpt-concise', ctx)!;
    const agent = await buildRemoteModelAgent(
      { req: { user: { id: 'u1', role: 'USER' }, config: ctx.appConfig }, target, endpointsConfig },
      deps,
    );
    expect(agent).toMatchObject({
      provider: EModelEndpoint.openAI,
      model: 'gpt-4o',
      instructions: 'Answer in one sentence.',
    });
    expect(agent?.model_parameters).toMatchObject({ temperature: 0.2 });
    expect(deps.getAgent).not.toHaveBeenCalled();
  });

  it("gives a spec exactly the spec's tools", async () => {
    const ctx = context();
    const agent = await buildRemoteModelAgent(
      {
        req: { user: { id: 'u1' }, config: ctx.appConfig },
        target: resolveRemoteModel('researcher', ctx)!,
        endpointsConfig,
      },
      deps,
    );
    expect(agent?.tools).toContain(Tools.web_search);
    expect(agent?.tools).not.toContain(Tools.execute_code);
  });

  it('ignores tool toggles a caller smuggles in on the request', async () => {
    const ctx = context();
    const req = {
      user: { id: 'u1' },
      config: ctx.appConfig,
      body: { ephemeralAgent: { execute_code: true, web_search: true, mcp: ['srv'] } },
    };
    const agent = await buildRemoteModelAgent(
      { req, target: resolveRemoteModel('gpt-concise', ctx)!, endpointsConfig },
      deps,
    );
    expect(agent?.tools ?? []).toEqual([]);
    expect(deps.getAccessibleMCPServers).not.toHaveBeenCalledWith('u1', expect.anything());
  });

  it('runs endpoint/model with that model and no spec', async () => {
    const ctx = context();
    const agent = await buildRemoteModelAgent(
      {
        req: { user: { id: 'u1' }, config: ctx.appConfig },
        target: resolveRemoteModel('openrouter/anthropic/claude-sonnet-4', ctx)!,
        endpointsConfig,
      },
      deps,
    );
    expect(agent).toMatchObject({ provider: 'openrouter', model: 'anthropic/claude-sonnet-4' });
  });
});

describe('toOpenAIModel', () => {
  it('describes a target in the /v1/models shape with a LibreChat type marker', () => {
    const ctx = context();
    expect(toOpenAIModel(resolveRemoteModel('gpt-concise', ctx)!)).toMatchObject({
      id: 'gpt-concise',
      object: 'model',
      owned_by: 'librechat',
      name: 'GPT (concise)',
      description: 'Short answers',
      provider: EModelEndpoint.openAI,
      librechat: { type: 'model_spec' },
    });
    expect(toOpenAIModel(resolveRemoteModel('openAI/gpt-4o', ctx)!)).toMatchObject({
      id: 'openAI/gpt-4o',
      name: 'gpt-4o',
      librechat: { type: 'endpoint_model' },
    });
  });
});

describe('model allow-list and endpoint rules', () => {
  it("refuses a spec whose model is not in the user's models for its endpoint", () => {
    const ctx = context();
    const narrowed = {
      ...ctx,
      modelsConfig: { ...modelsConfig, [EModelEndpoint.openAI]: ['gpt-4o-mini'] },
    };
    expect(resolveRemoteModel('gpt-concise', narrowed)).toBeNull();
    expect(listRemoteModels(narrowed).map((t) => t.id)).not.toContain('gpt-concise');
    expect(resolveRemoteModel('hidden-spec', narrowed)).not.toBeNull();
  });

  it('refuses endpoints running on any user-supplied credential (e.g. Bedrock keys)', () => {
    const ctx = context();
    const withBedrock = {
      ...ctx,
      endpointsConfig: {
        ...endpointsConfig,
        [EModelEndpoint.bedrock]: { order: 4, userProvideAccessKeyId: true },
      } as unknown as TEndpointsConfig,
      modelsConfig: { ...modelsConfig, [EModelEndpoint.bedrock]: ['anthropic.claude'] },
    };
    expect(resolveRemoteModel('bedrock/anthropic.claude', withBedrock)).toBeNull();
    expect(listRemoteModels(withBedrock).some((t) => t.endpoint === EModelEndpoint.bedrock)).toBe(
      false,
    );
  });

  it('limits endpoint/model to modelSpecs.addedEndpoints when that list is set', () => {
    const ctx = context();
    const appConfig = {
      ...ctx.appConfig,
      modelSpecs: { enforce: false, list: specs, addedEndpoints: ['openrouter'] },
    } as unknown as AppConfig;
    const added = { ...ctx, appConfig };
    expect(resolveRemoteModel('openAI/gpt-4o', added)).toBeNull();
    expect(resolveRemoteModel('openrouter/anthropic/claude-sonnet-4', added)).not.toBeNull();
    expect(
      listRemoteModels(added)
        .filter((t) => t.kind === 'endpoint_model')
        .map((t) => t.id),
    ).toEqual(['openrouter/anthropic/claude-sonnet-4']);
  });

  it('does not list an endpoint/model id that a spec is named after', () => {
    const ctx = context();
    const shadow = {
      name: 'openAI/gpt-4o-mini',
      label: 'Shadow',
      showInMenu: false,
      preset: { endpoint: EModelEndpoint.openAI, model: 'gpt-4o' },
    };
    const appConfig = {
      ...ctx.appConfig,
      modelSpecs: { enforce: false, list: [...specs, shadow] },
    } as unknown as AppConfig;
    const shadowed = { ...ctx, appConfig };
    expect(listRemoteModels(shadowed).map((t) => t.id)).not.toContain('openAI/gpt-4o-mini');
    expect(resolveRemoteModel('openAI/gpt-4o-mini', shadowed)).toMatchObject({
      kind: 'model_spec',
    });
  });

  it('lists exactly the spec that a duplicated name would run', () => {
    const ctx = context();
    const hiddenFirst = {
      name: 'dup',
      label: 'Hidden first',
      showInMenu: false,
      preset: { endpoint: EModelEndpoint.openAI, model: 'gpt-4o' },
    };
    const visibleSecond = {
      name: 'dup',
      label: 'Visible second',
      preset: { endpoint: 'openrouter', model: 'anthropic/claude-sonnet-4' },
    };
    const appConfig = {
      ...ctx.appConfig,
      modelSpecs: { enforce: false, list: [...specs, hiddenFirst, visibleSecond] },
    } as unknown as AppConfig;
    const dup = { ...ctx, appConfig };
    expect(listRemoteModels(dup).map((t) => t.id)).not.toContain('dup');
    expect(resolveRemoteModel('dup', dup)).toMatchObject({ endpoint: EModelEndpoint.openAI });
  });

  it('treats hidden specs as callable but not listed', () => {
    const ctx = context();
    expect(isListedRemoteModel(resolveRemoteModel('hidden-spec', ctx)!)).toBe(false);
    expect(isListedRemoteModel(resolveRemoteModel('gpt-concise', ctx)!)).toBe(true);
    expect(isListedRemoteModel(resolveRemoteModel('openAI/gpt-4o', ctx)!)).toBe(true);
  });
});

describe('remoteModelEndpoints', () => {
  it('names only the endpoint a model needs, and none for junk', () => {
    const ctx = context();
    expect(remoteModelEndpoints('gpt-concise', ctx)).toEqual([EModelEndpoint.openAI]);
    expect(remoteModelEndpoints('openrouter/anthropic/claude-sonnet-4', ctx)).toEqual([
      'openrouter',
    ]);
    expect(remoteModelEndpoints('no-such-model', ctx)).toEqual([]);
    expect(remoteModelEndpoints('byok/secret-model', ctx)).toEqual([]);
    expect(remoteModelEndpoints('x'.repeat(513), ctx)).toEqual([]);
  });

  it('names every listable endpoint when listing', () => {
    expect(remoteModelEndpoints(undefined, context()).sort()).toEqual(
      [EModelEndpoint.openAI, 'openrouter'].sort(),
    );
    expect(remoteModelEndpoints(undefined, context({ enforce: true }))).toEqual([
      EModelEndpoint.openAI,
    ]);
  });
});

describe('stripCallerToggles', () => {
  it('removes the request fields that would widen tools, MCP or skills', () => {
    const body = {
      model: 'gpt-concise',
      messages: [],
      ephemeralAgent: { execute_code: true, skills: true },
      manualSkills: ['secret-skill'],
    };
    stripCallerToggles(body);
    expect(body).toEqual({ model: 'gpt-concise', messages: [] });
    expect(() => stripCallerToggles(undefined)).not.toThrow();
  });
});

describe('createRemoteModelService', () => {
  function service() {
    const deps = {
      getAgent: jest.fn(),
      getMCPServerTools: jest.fn(async () => null),
      getAccessibleMCPServers: jest.fn(async () => ({})),
      getEndpointsConfig: jest.fn(async () => endpointsConfig),
      getEndpointModels: jest.fn(async (_req: unknown, endpoint: string) => ({
        [endpoint]: modelsConfig[endpoint] ?? [],
      })),
      onListError: jest.fn(),
    };
    return { deps, svc: createRemoteModelService(deps) };
  }
  const req = (overrides = {}) => ({ user: { id: 'u1' }, config: context(overrides).appConfig });

  it("loads only the named model's endpoint, once per request", async () => {
    const { deps, svc } = service();
    const r = req();
    const target = await svc.resolve(r, 'gpt-concise');
    const agent = await svc.buildAgent(r, target!);
    await svc.resolve(r, 'gpt-concise');
    expect(agent).toMatchObject({ model: 'gpt-4o' });
    expect(deps.getEndpointsConfig).toHaveBeenCalledTimes(1);
    expect(deps.getEndpointModels).toHaveBeenCalledTimes(1);
    expect(deps.getEndpointModels).toHaveBeenCalledWith(r, EModelEndpoint.openAI);
  });

  it('loads no model catalog for an unknown or malformed model', async () => {
    const { deps, svc } = service();
    expect(await svc.resolve(req(), 'no-such-model')).toBeNull();
    expect(await svc.resolve(req(), 'x'.repeat(513))).toBeNull();
    expect(await svc.resolve(req(), 42)).toBeNull();
    expect(deps.getEndpointModels).not.toHaveBeenCalled();
  });

  it('reads nothing and offers nothing when the admin opts out', async () => {
    const { deps, svc } = service();
    const r = req({ enabled: false });
    expect(await svc.resolve(r, 'gpt-concise')).toBeNull();
    expect(await svc.list(r)).toEqual([]);
    expect(deps.getEndpointsConfig).not.toHaveBeenCalled();
    expect(deps.getEndpointModels).not.toHaveBeenCalled();
  });

  it('lists /v1/models entries', async () => {
    const { svc } = service();
    const ids = (await svc.list(req())).map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining(['gpt-concise', 'researcher', 'openAI/gpt-4o']));
    expect(ids).not.toContain('hidden-spec');
  });

  it('describes listed models but not hidden specs', async () => {
    const { svc } = service();
    expect(await svc.describe(req(), 'gpt-concise')).toMatchObject({ id: 'gpt-concise' });
    expect(await svc.describe(req(), 'hidden-spec')).toBeNull();
    expect(await svc.resolve(req(), 'hidden-spec')).not.toBeNull();
  });

  it('lists agents only, and reports it, when a catalog fails to load', async () => {
    const { deps, svc } = service();
    deps.getEndpointModels.mockRejectedValueOnce(new Error('models unavailable'));
    expect(await svc.list(req())).toEqual([]);
    expect(deps.onListError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('lets a catalog failure reach the caller when resolving a run', async () => {
    const { deps, svc } = service();
    deps.getEndpointModels.mockRejectedValueOnce(new Error('models unavailable'));
    await expect(svc.resolve(req(), 'gpt-concise')).rejects.toThrow('models unavailable');
  });
});

describe('toRemoteModelConversation', () => {
  it('records a spec with its endpoint, model and name, and a pair with its model', () => {
    const ctx = context();
    expect(toRemoteModelConversation(resolveRemoteModel('gpt-concise', ctx)!)).toEqual({
      endpoint: EModelEndpoint.openAI,
      spec: 'gpt-concise',
      model: 'gpt-4o',
    });
    expect(
      toRemoteModelConversation(resolveRemoteModel('openrouter/anthropic/claude-sonnet-4', ctx)!),
    ).toEqual({
      endpoint: 'openrouter',
      endpointType: EModelEndpoint.custom,
      model: 'anthropic/claude-sonnet-4',
    });
  });
});

describe('isRemoteModelContinuationAllowed', () => {
  it('binds an enforced spec to conversations recorded under that same spec', () => {
    const enforced = context({ enforce: true });
    const spec = resolveRemoteModel('gpt-concise', enforced)!;
    expect(
      isRemoteModelContinuationAllowed(spec, { spec: 'gpt-concise' }, enforced.appConfig),
    ).toBe(true);
    expect(isRemoteModelContinuationAllowed(spec, { spec: 'researcher' }, enforced.appConfig)).toBe(
      false,
    );
    expect(isRemoteModelContinuationAllowed(spec, {}, enforced.appConfig)).toBe(false);
    expect(isRemoteModelContinuationAllowed(spec, null, enforced.appConfig)).toBe(true);
  });

  it('leaves unenforced specs and endpoint/model free to continue', () => {
    const open = context();
    expect(
      isRemoteModelContinuationAllowed(
        resolveRemoteModel('gpt-concise', open)!,
        {},
        open.appConfig,
      ),
    ).toBe(true);
    expect(
      isRemoteModelContinuationAllowed(
        resolveRemoteModel('openAI/gpt-4o', open)!,
        {},
        open.appConfig,
      ),
    ).toBe(true);
  });
});
