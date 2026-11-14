import type { TEndpoint } from 'librechat-data-provider';
import {
  touchesConfig,
  withBaseOnlyValues,
  createConfigTouches,
  recordConfigTouches,
  isVertexConfigured,
  deriveVertexEndpoint,
  getDerivedConfigIssues,
} from './derive';
import logger from '~/config/winston';

const ENDPOINTS = new Set(['endpoints', 'modelSpecs']);

/** Stands in for the expander packages/api injects: refuses a definition keyed `invalid`. */
function expandCustomEndpoint(endpoint: TEndpoint): TEndpoint {
  const params = endpoint.customParams;
  if (params == null) {
    return { ...endpoint };
  }
  if (params.paramDefinitions?.some((definition) => definition.key === 'invalid')) {
    throw new Error('invalid key');
  }
  return { ...endpoint, customParams: { ...params, defaultParamsEndpoint: 'custom' } };
}

const group = (overrides: Record<string, unknown> = {}) => ({
  group: 'east',
  apiKey: 'east-key',
  instanceName: 'east',
  version: '2024-10-21',
  deploymentName: 'gpt-4o',
  models: { 'gpt-4o': true },
  ...overrides,
});

describe('getDerivedConfigIssues', () => {
  it('reports Azure groups that do not resolve, or name an unset variable, once written', () => {
    const merged = (groups: unknown[]) => ({ endpoints: { azureOpenAI: { groups } } });
    const write = (groups: unknown[]) =>
      getDerivedConfigIssues(merged(groups), merged(groups), ENDPOINTS);

    expect(write([group()])).toEqual([]);
    expect(write([group({ deploymentName: '' })])).toEqual([
      { code: 'invalid_azure_groups', path: ['endpoints', 'azureOpenAI', 'groups'] },
    ]);
    expect(write([group(), group({ group: 'west' })])).toHaveLength(1);
    expect(write([group({ apiKey: '${AZURE_UNSET_GROUP_KEY}' })])).toHaveLength(1);
    expect(getDerivedConfigIssues({}, merged([group({ deploymentName: '' })]), ENDPOINTS)).toEqual(
      [],
    );
  });

  it('checks only the written groups for unset variables', () => {
    const yaml = group({ apiKey: '${AZURE_UNSET_YAML_KEY}' });
    const written = group({ group: 'west', models: { 'gpt-5': true } });

    expect(
      getDerivedConfigIssues(
        { endpoints: { azureOpenAI: { groups: [written] } } },
        { endpoints: { azureOpenAI: { groups: [yaml, written] } } },
        ENDPOINTS,
      ),
    ).toEqual([]);
  });

  it('reports a Vertex AI setup that does not load, unless it is off', () => {
    const vertex = (settings: Record<string, unknown>) => ({
      endpoints: { anthropic: { vertex: settings } },
    });
    const check = (settings: Record<string, unknown>) =>
      getDerivedConfigIssues(vertex(settings), vertex(settings), ENDPOINTS);

    expect(check({ projectId: 'project-1', region: 'global' })).toEqual([]);
    expect(check({ projectId: '${VERTEX_UNSET_PROJECT}' })).toEqual([
      { code: 'invalid_vertex_config', path: ['endpoints', 'anthropic', 'vertex'] },
    ]);
    expect(check({ projectId: '${VERTEX_UNSET_PROJECT}', enabled: false })).toEqual([]);
  });

  it('reports a deployment or model name that only wraps ${VAR} references', () => {
    process.env.VERTEX_DERIVE_PROJECT = 'project-1';
    const wrapped =
      '${VERTEX_DERIVE_PROJECT}/../../endpoints/5678:rawPredict#${VERTEX_DERIVE_PROJECT}';
    const vertex = (settings: Record<string, unknown>) => ({
      endpoints: { anthropic: { vertex: { projectId: '${VERTEX_DERIVE_PROJECT}', ...settings } } },
    });
    const check = (settings: Record<string, unknown>) =>
      getDerivedConfigIssues(vertex(settings), vertex(settings), ENDPOINTS);
    const invalid = [{ code: 'invalid_vertex_config', path: ['endpoints', 'anthropic', 'vertex'] }];

    try {
      expect(check({ models: { 'claude-sonnet-4-6': true } })).toEqual([]);
      expect(check({ models: { 'claude-sonnet-4-6': { deploymentName: wrapped } } })).toEqual(
        invalid,
      );
      expect(check({ models: [wrapped] })).toEqual(invalid);
    } finally {
      delete process.env.VERTEX_DERIVE_PROJECT;
    }
  });

  it('reports Vertex AI turned on where librechat.yaml configures none, but not turned off', () => {
    const vertex = (settings: Record<string, unknown>) => ({
      endpoints: { anthropic: { vertex: settings } },
    });
    const check = (settings: Record<string, unknown>, vertexConfigured?: boolean) =>
      getDerivedConfigIssues(vertex(settings), vertex(settings), ENDPOINTS, { vertexConfigured });
    const usable = { projectId: 'project-1' };

    expect(check(usable, false)).toEqual([
      { code: 'invalid_vertex_config', path: ['endpoints', 'anthropic', 'vertex'] },
    ]);
    expect(check({ ...usable, enabled: false }, false)).toEqual([]);
    expect(check(usable, true)).toEqual([]);
    expect(check(usable)).toEqual([]);
  });

  it('tells whether a librechat.yaml-shaped config configures Vertex AI, on or off', () => {
    expect(isVertexConfigured({ endpoints: { anthropic: { vertex: { enabled: false } } } })).toBe(
      true,
    );
    expect(isVertexConfigured({ endpoints: { anthropic: { models: ['claude-x'] } } })).toBe(false);
    expect(isVertexConfigured(null)).toBe(false);
  });

  it('reports parameter definitions the expander refuses, for the endpoints written', () => {
    const gateway = (paramDefinitions: unknown[]) => ({
      name: 'Gateway',
      customParams: { paramDefinitions },
    });
    const merged = {
      endpoints: { custom: [gateway([{ key: 'invalid' }]), { ...gateway([]), name: 'Other' }] },
    };

    expect(
      getDerivedConfigIssues({ endpoints: { custom: [{ name: 'Gateway' }] } }, merged, ENDPOINTS, {
        expandCustomEndpoint,
      }),
    ).toEqual([
      { code: 'invalid_param_definitions', path: ['endpoints', 'custom', '0', 'customParams'] },
    ]);
    expect(
      getDerivedConfigIssues({ endpoints: { custom: [{ name: 'Other' }] } }, merged, ENDPOINTS, {
        expandCustomEndpoint,
      }),
    ).toEqual([]);
    expect(
      getDerivedConfigIssues({ endpoints: { custom: [{ name: 'Gateway' }] } }, merged, ENDPOINTS),
    ).toEqual([]);
  });

  it('reports model specs whose endpoint is neither built in nor configured', () => {
    const spec = (endpoint: string) => ({ name: endpoint, label: endpoint, preset: { endpoint } });
    const merged = {
      endpoints: { custom: [{ name: 'Ollama' }] },
      modelSpecs: {
        list: [
          spec('openAI'),
          spec('ollama'),
          spec('Nowhere'),
          spec('custom'),
          { name: 'a', preset: { agent_id: 'agent_1' } },
        ],
      },
    };

    expect(getDerivedConfigIssues({ modelSpecs: { list: [] } }, merged, ENDPOINTS)).toEqual([
      { code: 'unknown_spec_endpoint', path: ['modelSpecs', 'list', '2', 'preset', 'endpoint'] },
      { code: 'unknown_spec_endpoint', path: ['modelSpecs', 'list', '3', 'preset', 'endpoint'] },
    ]);
    expect(getDerivedConfigIssues({ modelSpecs: { list: [] } }, merged, new Set())).toEqual([]);
  });
});

describe('config touches', () => {
  it('records written keys two levels down, tombstones and custom endpoints by identity', () => {
    const touches = createConfigTouches();
    recordConfigTouches(
      touches,
      { endpoints: { anthropic: { vertex: {} }, custom: [{ name: 'ollama' }] }, memory: {} },
      ['endpoints.azureAssistants'],
    );

    expect(touchesConfig(touches, ['endpoints', 'anthropic', 'vertex'])).toBe(true);
    expect(touchesConfig(touches, ['endpoints', 'anthropic'])).toBe(true);
    expect(touchesConfig(touches, ['endpoints', 'azureAssistants', 'version'])).toBe(true);
    expect(touchesConfig(touches, ['endpoints', 'azureOpenAI'])).toBe(false);
    expect(touchesConfig(touches, ['memory'])).toBe(true);
    expect([...touches.customEndpoints]).toEqual(['ollama']);
  });
});

describe('withBaseOnlyValues', () => {
  it("sets librechat.yaml's value at each base-only path, removing what it does not set", () => {
    const raw = {
      endpoints: {
        anthropic: { vertex: { region: 'elsewhere', serviceKeyFile: 'http://x', models: ['m'] } },
      },
    };
    const yaml = { endpoints: { anthropic: { vertex: { region: 'us-east5' } } } };

    expect(withBaseOnlyValues(raw, yaml)).toEqual({
      endpoints: { anthropic: { vertex: { region: 'us-east5', models: ['m'] } } },
    });
    expect(raw.endpoints.anthropic.vertex.region).toBe('elsewhere');
    expect(withBaseOnlyValues(yaml, yaml)).toBe(yaml);
  });
});

describe('deriveVertexEndpoint', () => {
  const yamlVertex = {
    projectId: 'yaml-project',
    region: 'us-east5',
    models: ['claude-sonnet-4-6'],
  };
  const merged = {
    endpoints: {
      anthropic: {
        titleModel: 'claude-haiku-4-5',
        vertex: yamlVertex,
        models: ['claude-sonnet-4-6'],
        vertexConfig: { enabled: true, region: 'us-east5', modelNames: ['claude-sonnet-4-6'] },
      },
    },
  };
  const derive = (raw: Record<string, unknown>, modelsOverridden = false) =>
    deriveVertexEndpoint({
      merged,
      raw,
      baseYaml: { endpoints: { anthropic: { vertex: yamlVertex } } },
      modelsOverridden,
      principal: 'role/r1',
    }).endpoints.anthropic as Record<string, unknown>;

  it('derives vertexConfig and the models it serves from the YAML-shaped config', () => {
    const anthropic = derive({
      endpoints: { anthropic: { vertex: { ...yamlVertex, models: ['claude-opus-4-6'] } } },
    });

    expect(anthropic.models).toEqual(['claude-opus-4-6']);
    expect(anthropic.vertexConfig).toMatchObject({
      projectId: 'yaml-project',
      region: 'us-east5',
      modelNames: ['claude-opus-4-6'],
    });
    expect(anthropic.titleModel).toBe('claude-haiku-4-5');
  });

  it('derives nothing where librechat.yaml configures no Vertex AI, so no layer turns it on', () => {
    const unconfigured = { endpoints: { anthropic: { titleModel: 'claude-haiku-4-5' } } };
    const result = deriveVertexEndpoint({
      merged: unconfigured,
      raw: { endpoints: { anthropic: { vertex: { projectId: 'p-1', models: ['claude-x'] } } } },
      baseYaml: {},
      modelsOverridden: false,
      principal: 'role/r1',
    });

    expect(result).toBe(unconfigured);
  });

  it('lets a layer turn on the Vertex AI librechat.yaml configures off, on its region', () => {
    const anthropic = deriveVertexEndpoint({
      merged: { endpoints: { anthropic: {} } },
      raw: { endpoints: { anthropic: { vertex: { ...yamlVertex, enabled: true } } } },
      baseYaml: { endpoints: { anthropic: { vertex: { ...yamlVertex, enabled: false } } } },
      modelsOverridden: false,
      principal: 'role/r1',
    }).endpoints.anthropic as Record<string, unknown>;

    expect(anthropic.vertexConfig).toMatchObject({ enabled: true, region: 'us-east5' });
    expect(anthropic.models).toEqual(['claude-sonnet-4-6']);
  });

  it("keeps librechat.yaml's region and key file over a layer's", () => {
    const anthropic = derive({
      endpoints: {
        anthropic: { vertex: { ...yamlVertex, region: 'evil', serviceKeyFile: 'http://x/key' } },
      },
    });

    expect(anthropic.vertexConfig).toMatchObject({ region: 'us-east5', serviceKeyFile: undefined });
  });

  it('turns Vertex AI off and serves the YAML-shaped models when it is disabled or removed', () => {
    const disabled = derive({
      endpoints: { anthropic: { vertex: { ...yamlVertex, enabled: false }, models: ['claude-3'] } },
    });
    const removed = derive({ endpoints: { anthropic: {} } });

    expect(disabled.vertexConfig).toBeUndefined();
    expect(disabled.models).toEqual(['claude-3']);
    expect(removed.vertexConfig).toBeUndefined();
    expect(removed).not.toHaveProperty('models');
  });

  it('keeps models a layer set over the ones Vertex AI serves', () => {
    const anthropic = derive(
      { endpoints: { anthropic: { vertex: { ...yamlVertex, models: ['claude-opus-4-6'] } } } },
      true,
    );

    expect(anthropic.models).toEqual(['claude-sonnet-4-6']);
    expect(anthropic.vertexConfig).toMatchObject({ modelNames: ['claude-opus-4-6'] });
  });

  describe('a setup that does not load (left only by a tombstone of one of its settings)', () => {
    /** Vertex AI off: no `vertexConfig`, the YAML-shaped models, the rest as merged. */
    const off = { titleModel: 'claude-haiku-4-5', vertex: yamlVertex, models: ['claude-direct'] };
    const deriveFrom = (vertex: Record<string, unknown>) =>
      deriveVertexEndpoint({
        merged,
        raw: { endpoints: { anthropic: { vertex, models: ['claude-direct'] } } },
        baseYaml: { endpoints: { anthropic: { vertex: yamlVertex } } },
        modelsOverridden: false,
        principal: 'role/r1',
      }).endpoints.anthropic;

    it('turns Vertex AI off, with a warning, rather than keep the vertexConfig derived below', () => {
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);

      expect(deriveFrom({ projectId: '${VERTEX_UNSET_PROJECT}' })).toEqual(off);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Turning Vertex AI off for role/r1'),
      );
      warn.mockRestore();
    });

    it('turns it off where a model name would leave its path segment', () => {
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);

      expect(
        deriveFrom({
          ...yamlVertex,
          deploymentName: 'claude-sonnet-4-6',
          models: ['../../endpoints/5678:rawPredict#'],
        }),
      ).toEqual(off);
      warn.mockRestore();
    });
  });
});
