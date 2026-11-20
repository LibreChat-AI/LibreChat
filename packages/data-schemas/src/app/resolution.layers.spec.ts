import { PrincipalType } from 'librechat-data-provider';
import type { DeepPartial, TCustomConfig } from 'librechat-data-provider';
import type { AppConfig, AdminConfigLayerIgnored } from '~/types';
import type { ConfigOverrideLayer } from './resolution';
import {
  resolveRawConfig,
  resolveConfigLayers,
  mergeConfigOverrides,
  getIgnoredConfigOverrides,
} from './resolution';
import { BASE_CONFIG_PRINCIPAL_ID } from '~/admin/capabilities';
import { AppService } from './service';
import logger from '~/config/winston';

type Overrides = Record<string, unknown>;

function layer(
  principalType: string,
  principalId: string,
  overrides: Overrides,
  options: { priority?: number; tombstones?: string[]; id?: string } = {},
): ConfigOverrideLayer {
  return {
    _id: options.id ?? `${principalType}-${principalId}`,
    principalType: principalType as PrincipalType,
    principalId,
    priority: options.priority ?? 10,
    overrides: overrides as Partial<TCustomConfig>,
    tombstones: options.tombstones,
  };
}

const base = (overrides: Overrides, tombstones?: string[]) =>
  layer(PrincipalType.ROLE, BASE_CONFIG_PRINCIPAL_ID, overrides, { priority: 0, tombstones });
const role = (overrides: Overrides, tombstones?: string[]) =>
  layer(PrincipalType.ROLE, 'editors', overrides, { priority: 10, tombstones });
const group = (overrides: Overrides, tombstones?: string[]) =>
  layer(PrincipalType.GROUP, 'g1', overrides, { priority: 20, tombstones });

const YAML: DeepPartial<TCustomConfig> = {
  version: '1.3.0',
  cache: true,
  interface: {
    customWelcome: 'Hello from YAML',
    schedules: false,
    theme: {
      version: 1,
      name: 'yaml-theme',
      modes: {
        light: { colors: { 'surface-primary': '255 255 255' } },
        dark: { colors: { 'surface-primary': '0 0 0' } },
      },
    },
  },
  registration: { socialLogins: ['github'] },
  endpoints: {
    custom: [
      {
        name: 'Ollama',
        apiKey: 'ollama',
        baseURL: 'http://ollama:11434/v1',
        models: { default: ['llama3'], fetch: false },
      },
      {
        name: 'Gateway',
        apiKey: '${GATEWAY_KEY}',
        baseURL: 'https://gateway.example.com/v1',
        models: { default: ['gpt-4o'] },
      },
    ],
    agents: {
      pullRequests: { provider: 'github', host: 'github.com' },
    } as never,
  },
  mcpServers: {
    docs: { type: 'streamable-http', url: 'https://docs.example.com/mcp' },
    local: { type: 'stdio', command: 'node', args: ['server.js'] },
  },
  webSearch: {
    searxngInstanceUrl: '${SEARXNG_INSTANCE_URL}',
    searxngApiKey: '${SEARXNG_API_KEY}',
  },
  filters: { messages: { pii: { action: 'audit' } } } as never,
};

const ROLE_THEME = {
  version: 1,
  name: 'role-theme',
  modes: { dark: { colors: { 'surface-primary': '10 10 10' } } },
};

let appConfig: AppConfig;

beforeAll(async () => {
  jest.spyOn(logger, 'warn').mockReturnValue(logger);
  jest.spyOn(logger, 'info').mockReturnValue(logger);
  appConfig = await AppService({ config: structuredClone(YAML) });
});

afterAll(() => {
  jest.restoreAllMocks();
});

function ignoredOf(resolution: ReturnType<typeof resolveConfigLayers>, index: number) {
  return resolution.layers[index].ignored;
}

function reasons(ignored: AdminConfigLayerIgnored[]): Array<[string, string]> {
  return ignored.map(({ path, reason }) => [path, reason]);
}

function toIgnoredTombstone(
  path: string,
  reason: AdminConfigLayerIgnored['reason'],
): AdminConfigLayerIgnored {
  return { path, segments: path.split('.'), reason, tombstone: true };
}

/** Layer sets the merge applies differently, each exercising one of its rules. */
const PARITY_CASES: Array<[string, () => ConfigOverrideLayer[]]> = [
  ['no layers', () => []],
  ['a plain section', () => [role({ interface: { customWelcome: 'Hi role' } })]],
  [
    'interface permissions, composite permission fields and runtime toggles',
    () => [
      role({
        interface: {
          customWelcome: 'Hi',
          prompts: false,
          mcpServers: { use: false, placeholder: 'Pick a server' },
          schedules: true,
        },
      }),
    ],
  ],
  ['an atomic theme', () => [role({ interface: { theme: ROLE_THEME } })]],
  [
    'custom endpoints merged by folded name',
    () => [
      base({ endpoints: { custom: [{ name: 'ollama', baseURL: 'http://other:11434/v1' }] } }),
      role({
        endpoints: {
          custom: [
            {
              name: 'Extra',
              apiKey: 'k',
              baseURL: 'https://extra.example.com',
              models: { default: ['m'] },
            },
          ],
        },
      }),
    ],
  ],
  [
    'tombstones of YAML MCP servers, including a process-backed one',
    () => [role({}, ['mcpServers.docs', 'mcpServers.local'])],
  ],
  [
    'process MCP overrides',
    () => [role({ mcpServers: { local: { args: ['other.js'] }, extra: { command: 'x' } } })],
  ],
  [
    'invalid overrides, unknown sections and base-only sections',
    () => [
      role({
        registration: { socialLogins: 'not-a-list' },
        paths: { uploads: '/tmp' },
        filters: { messages: { pii: { action: 'block' } } },
        langfuse: { enabled: true },
      }),
    ],
  ],
  [
    'web search keys whose URL another layer decides',
    () => [
      base({ webSearch: { searxngApiKey: 'base-key' } }),
      role({ webSearch: { searxngInstanceUrl: 'https://search.example.com' } }),
    ],
  ],
  ['a runtime stop', () => [role({ interface: { schedules: true } })]],
  [
    'base-only fields',
    () => [
      role({ endpoints: { agents: { pullRequests: { host: 'evil.example.com' } } } }),
      group({}, ['endpoints.agents.pullRequests.provider']),
    ],
  ],
  [
    'tombstones above base-only fields and a runtime stop',
    () => [
      role({}, ['endpoints.agents.pullRequests']),
      group({ interface: { customWelcome: 'Hi group' } }, ['interface.schedules']),
    ],
  ],
  [
    'Azure groups, valid and not',
    () => [
      base({
        endpoints: {
          azureOpenAI: {
            groups: [
              {
                group: 'east',
                apiKey: 'k',
                instanceName: 'east',
                version: '2024-02-01',
                models: { 'gpt-4o': { deploymentName: 'gpt-4o' } },
              },
            ],
          },
        },
      }),
      role({
        endpoints: {
          azureOpenAI: { groups: [{ group: 'west', apiKey: 'k', models: { 'gpt-4o': true } }] },
        },
      }),
    ],
  ],
  [
    'precedence: Base first whatever its priority',
    () => [
      role({ interface: { customWelcome: 'role' } }),
      layer(
        PrincipalType.ROLE,
        BASE_CONFIG_PRINCIPAL_ID,
        { interface: { customWelcome: 'base' } },
        { priority: 999 },
      ),
    ],
  ],
];

describe('resolveConfigLayers', () => {
  it.each(PARITY_CASES)('merges exactly as mergeConfigOverrides: %s', (_name, build) => {
    const configs = build();
    expect(resolveConfigLayers(appConfig, configs).merged).toEqual(
      mergeConfigOverrides(appConfig, configs),
    );
  });

  it('returns librechat.yaml in its own shape when no layer applies', () => {
    const { resolved, layers } = resolveConfigLayers(appConfig, []);
    expect(resolved).toEqual(YAML);
    expect(layers).toEqual([]);
  });

  it('lists layers in merge order, Base first whatever its priority', () => {
    const configs = PARITY_CASES.find(([name]) => name.startsWith('precedence'))![1]();
    const { layers, resolved } = resolveConfigLayers(appConfig, configs);
    expect(layers.map(({ layer: l }) => l.principalId)).toEqual([
      BASE_CONFIG_PRINCIPAL_ID,
      'editors',
    ]);
    expect(layers[0].layer).toBe(configs[1]);
    expect(resolved.interface?.customWelcome).toBe('role');
  });

  it('resolves in librechat.yaml keys, never the AppConfig names', () => {
    const { resolved } = resolveConfigLayers(appConfig, [
      role({ interface: { customWelcome: 'Hi' }, mcpServers: { extra: { url: 'https://x/mcp' } } }),
    ]);
    expect(resolved).not.toHaveProperty('interfaceConfig');
    expect(resolved).not.toHaveProperty('mcpConfig');
    expect(resolved.interface?.customWelcome).toBe('Hi');
    expect(Object.keys(resolved.mcpServers ?? {})).toEqual(['docs', 'local', 'extra']);
  });

  it('drops interface permissions as the merge does, and reports each', () => {
    const configs = PARITY_CASES[2][1]();
    const resolution = resolveConfigLayers(appConfig, configs);
    expect(resolution.resolved.interface).toMatchObject({
      customWelcome: 'Hi',
      mcpServers: { placeholder: 'Pick a server' },
    });
    expect(resolution.resolved.interface).not.toHaveProperty('prompts');
    expect(reasons(ignoredOf(resolution, 0))).toEqual(
      expect.arrayContaining([
        ['interface.prompts', 'interface_permission'],
        ['interface.mcpServers.use', 'interface_permission'],
      ]),
    );
  });

  it('replaces a theme whole, as the merge does', () => {
    const { resolved } = resolveConfigLayers(appConfig, PARITY_CASES[3][1]());
    expect(resolved.interface?.theme).toEqual(ROLE_THEME);
  });

  it('merges custom endpoints by the name the runtime folds, keeping the YAML spelling', () => {
    const { resolved } = resolveConfigLayers(appConfig, PARITY_CASES[4][1]());
    const custom = resolved.endpoints?.custom ?? [];
    expect(custom.map((endpoint) => endpoint.name)).toEqual(['Ollama', 'Gateway', 'Extra']);
    expect(custom[0]).toMatchObject({ apiKey: 'ollama', baseURL: 'http://other:11434/v1' });
  });

  it('hides a tombstoned YAML MCP server but keeps a process-backed one, as the merge does', () => {
    const resolution = resolveConfigLayers(appConfig, PARITY_CASES[5][1]());
    expect(Object.keys(resolution.resolved.mcpServers ?? {})).toEqual(['local']);
    expect(Object.keys(resolution.merged.mcpConfig ?? {})).toEqual(['local']);
  });

  it('reports process-backed MCP overrides and leaves the YAML server as written', () => {
    const resolution = resolveConfigLayers(appConfig, PARITY_CASES[6][1]());
    expect(resolution.resolved.mcpServers?.local).toEqual(YAML.mcpServers?.local);
    expect(resolution.resolved.mcpServers).not.toHaveProperty('extra');
    expect(reasons(ignoredOf(resolution, 0))).toEqual([
      ['mcpServers.local', 'process_mcp_server'],
      ['mcpServers.extra', 'process_mcp_server'],
    ]);
  });

  it('reports invalid overrides, unknown, base-only and Base-only sections, and applies none', () => {
    const resolution = resolveConfigLayers(appConfig, PARITY_CASES[7][1]());
    expect(resolution.resolved.registration).toEqual(YAML.registration);
    expect(resolution.resolved.filters).toEqual(YAML.filters);
    expect(resolution.resolved).not.toHaveProperty('paths');
    expect(resolution.resolved).not.toHaveProperty('langfuse');
    const ignored = ignoredOf(resolution, 0);
    expect(reasons(ignored)).toEqual(
      expect.arrayContaining([
        ['paths', 'unknown_section'],
        ['registration.socialLogins', 'invalid_override'],
        ['filters', 'base_only_section'],
        ['langfuse', 'base_principal_section'],
      ]),
    );
    expect(ignored.find(({ reason }) => reason === 'invalid_override')?.code).toBeTruthy();
  });

  it('withholds a web search key from the URL another layer decides, on the URL writer', () => {
    const resolution = resolveConfigLayers(appConfig, PARITY_CASES[8][1]());
    expect(resolution.resolved.webSearch).toEqual({
      searxngInstanceUrl: 'https://search.example.com',
    });
    expect(resolution.merged.webSearch).not.toHaveProperty('searxngApiKey');
    expect(reasons(ignoredOf(resolution, 1))).toEqual([
      ['webSearch.searxngApiKey', 'secret_rebinding'],
    ]);
    expect(ignoredOf(resolution, 0)).toEqual([]);
  });

  it('keeps an interface feature librechat.yaml turns off, off', () => {
    const resolution = resolveConfigLayers(appConfig, PARITY_CASES[9][1]());
    expect(resolution.resolved.interface?.schedules).toBe(false);
    expect(reasons(ignoredOf(resolution, 0))).toEqual([['interface.schedules', 'runtime_stop']]);
  });

  it('keeps base-only fields at their librechat.yaml value, for writes and tombstones', () => {
    const resolution = resolveConfigLayers(appConfig, PARITY_CASES[10][1]());
    expect(resolution.resolved.endpoints?.agents).toEqual(YAML.endpoints?.agents);
    expect(ignoredOf(resolution, 0)).toEqual([
      expect.objectContaining({
        path: 'endpoints.agents.pullRequests.host',
        reason: 'base_only_path',
      }),
    ]);
    expect(ignoredOf(resolution, 1)).toEqual([
      expect.objectContaining({
        path: 'endpoints.agents.pullRequests.provider',
        reason: 'base_only_path',
        tombstone: true,
      }),
    ]);
  });

  it('keeps what librechat.yaml holds under a tombstone above it, and reports each kept field', () => {
    const configs = PARITY_CASES.find(([name]) => name.startsWith('tombstones above'))![1]();
    const resolution = resolveConfigLayers(appConfig, configs);
    expect(resolution.merged.endpoints?.agents?.pullRequests).toMatchObject({
      provider: 'github',
      host: 'github.com',
    });
    expect(resolution.resolved.endpoints?.agents).toEqual(YAML.endpoints?.agents);
    expect(resolution.merged.interfaceConfig?.schedules).toBe(false);
    expect(resolution.resolved.interface).toMatchObject({
      customWelcome: 'Hi group',
      schedules: false,
    });
    expect(ignoredOf(resolution, 0)).toEqual([
      toIgnoredTombstone('endpoints.agents.pullRequests.provider', 'base_only_path'),
      toIgnoredTombstone('endpoints.agents.pullRequests.host', 'base_only_path'),
    ]);
    expect(ignoredOf(resolution, 1)).toEqual([
      toIgnoredTombstone('interface.schedules', 'runtime_stop'),
    ]);
  });

  it('reports a tombstone above base-only fields only for those librechat.yaml sets', () => {
    const resolution = resolveConfigLayers(appConfig, [role({}, ['endpoints.agents'])]);
    expect(resolution.resolved.endpoints?.agents).toEqual(YAML.endpoints?.agents);
    expect(reasons(ignoredOf(resolution, 0))).toEqual([
      ['endpoints.agents.pullRequests.provider', 'base_only_path'],
      ['endpoints.agents.pullRequests.host', 'base_only_path'],
    ]);
  });

  it('keeps deployment-only fields at their librechat.yaml value, for writes and tombstones', () => {
    const configs = [
      role({ cache: false, rateLimits: { fileUploads: { ipMax: 1 } } }),
      group({ interface: { customWelcome: 'Hi group' } }, ['cache']),
    ];
    const resolution = resolveConfigLayers(appConfig, configs);
    expect(resolution.merged).toEqual(mergeConfigOverrides(appConfig, configs));
    expect(resolution.resolved.cache).toBe(true);
    expect(resolution.resolved).not.toHaveProperty('rateLimits');
    expect(resolution.resolved.interface?.customWelcome).toBe('Hi group');
    expect(reasons(ignoredOf(resolution, 0))).toEqual([
      ['rateLimits', 'deployment_only_path'],
      ['cache', 'deployment_only_path'],
    ]);
    expect(ignoredOf(resolution, 1)).toEqual([toIgnoredTombstone('cache', 'deployment_only_path')]);
  });

  it('keeps Azure groups as written and reports groups that do not resolve over the groups below', () => {
    const configs = PARITY_CASES.find(([name]) => name.startsWith('Azure groups'))![1]();
    const resolution = resolveConfigLayers(appConfig, configs, { rederiveEndpoints: true });
    const azure = resolution.resolved.endpoints?.azureOpenAI;
    expect(azure?.groups?.map((entry) => entry.group)).toEqual(['east']);
    expect(azure).not.toHaveProperty('groupMap');
    expect(Object.keys(resolution.merged.endpoints?.azureOpenAI?.groupMap ?? {})).toEqual(['east']);
    expect(ignoredOf(resolution, 1)).toEqual([
      {
        path: 'endpoints.azureOpenAI.groups',
        segments: ['endpoints', 'azureOpenAI', 'groups'],
        reason: 'invalid_override',
        code: 'invalid_azure_groups',
      },
    ]);
  });

  it("reports a layer's groups as inert where the deployment does not resolve them", () => {
    const configs = PARITY_CASES.find(([name]) => name.startsWith('Azure groups'))![1]();
    const resolution = resolveConfigLayers(appConfig, configs);
    const served = resolution.merged.endpoints?.azureOpenAI;
    expect(served?.groupMap).toEqual({});
    expect(served?.modelNames).toEqual([]);
    expect(resolution.resolved.endpoints?.azureOpenAI?.groups?.map((entry) => entry.group)).toEqual(
      ['east'],
    );
    expect(ignoredOf(resolution, 0)).toEqual([
      {
        path: 'endpoints.azureOpenAI.groups',
        segments: ['endpoints', 'azureOpenAI', 'groups'],
        reason: 'endpoint_rederive_off',
      },
    ]);
    expect(reasons(ignoredOf(resolution, 1))).toEqual([
      ['endpoints.azureOpenAI.groups', 'invalid_override'],
    ]);
  });

  it('matches the validation floor where the merge applies a layer as written', () => {
    const configs = [
      base({ registration: { socialLogins: ['google'] } }),
      role(
        {
          endpoints: { custom: [{ name: 'Gateway', models: { default: ['gpt-4.1'] } }] },
          mcpServers: { docs: { timeout: 5000 } },
        },
        ['webSearch.searxngApiKey'],
      ),
    ];
    const yaml = appConfig.config as Partial<TCustomConfig>;
    expect(resolveConfigLayers(appConfig, configs).resolved).toEqual(
      resolveRawConfig(yaml, configs),
    );
  });

  it('never changes the documents it reads', () => {
    const configs = PARITY_CASES.flatMap(([, build]) => build());
    const before = structuredClone(configs);
    resolveConfigLayers(appConfig, configs);
    expect(configs).toEqual(before);
  });
});

describe('Azure groups the merge does not resolve, as each layer and a write report them', () => {
  const azureGroup = (name: string, model: string) => ({
    group: name,
    apiKey: `${name}-key`,
    instanceName: name,
    version: '2024-10-21',
    deploymentName: model,
    models: { [model]: true },
  });
  const yaml = {
    endpoints: {
      azureOpenAI: { groups: [azureGroup('east', 'gpt-4o'), azureGroup('north', 'o3')] },
    },
  };
  const groupsPath = 'endpoints.azureOpenAI.groups';
  const groupsSegments = groupsPath.split('.');
  let azureConfig: AppConfig;

  beforeAll(async () => {
    azureConfig = await AppService({ config: structuredClone(yaml) as DeepPartial<TCustomConfig> });
  });

  const servedGroups = (merged: AppConfig) =>
    Object.keys(merged.endpoints?.azureOpenAI?.groupMap ?? {});

  it('lists the groups and the tombstones of them a layer stores, without CONFIG_REDERIVE_ENDPOINTS', () => {
    const writer = role({ endpoints: { azureOpenAI: { groups: [azureGroup('west', 'gpt-5')] } } }, [
      'endpoints.azureOpenAI.groups["east"]',
      'endpoints.azureOpenAI.groups["north"].models.o3',
    ]);
    const replacer = group({}, [groupsPath]);

    const resolution = resolveConfigLayers(azureConfig, [writer, replacer]);

    expect(servedGroups(resolution.merged)).toEqual(['east', 'north']);
    expect(ignoredOf(resolution, 0)).toEqual([
      {
        path: 'endpoints.azureOpenAI.groups["east"]',
        segments: [...groupsSegments, 'east'],
        reason: 'endpoint_rederive_off',
        tombstone: true,
      },
      {
        path: 'endpoints.azureOpenAI.groups["north"].models.o3',
        segments: [...groupsSegments, 'north', 'models', 'o3'],
        reason: 'endpoint_rederive_off',
        tombstone: true,
      },
      { path: groupsPath, segments: groupsSegments, reason: 'endpoint_rederive_off' },
    ]);
    expect(ignoredOf(resolution, 1)).toEqual([
      {
        path: groupsPath,
        segments: groupsSegments,
        reason: 'endpoint_rederive_off',
        tombstone: true,
      },
    ]);
    expect(getIgnoredConfigOverrides(yaml as Partial<TCustomConfig>, writer)).toEqual([
      {
        path: 'endpoints.azureOpenAI.groups["east"]',
        segments: [...groupsSegments, 'east'],
        reason: 'endpoint_rederive_off',
        kind: 'tombstone',
      },
      {
        path: 'endpoints.azureOpenAI.groups["north"].models.o3',
        segments: [...groupsSegments, 'north', 'models', 'o3'],
        reason: 'endpoint_rederive_off',
        kind: 'tombstone',
      },
      {
        path: groupsPath,
        segments: groupsSegments,
        reason: 'endpoint_rederive_off',
        kind: 'override',
      },
    ]);

    const applied = resolveConfigLayers(azureConfig, [writer, replacer], {
      rederiveEndpoints: true,
    });
    expect(servedGroups(applied.merged)).toEqual([]);
    expect(applied.layers.map(({ ignored }) => ignored)).toEqual([[], []]);
  });

  it('lists a tombstone that leaves its group unable to resolve, which is no longer served', () => {
    const tombstone = 'endpoints.azureOpenAI.groups["north"].instanceName';
    const hider = role({}, [tombstone]);
    const unresolved = {
      path: tombstone,
      segments: [...groupsSegments, 'north', 'instanceName'],
      reason: 'azure_groups_unresolved' as const,
    };

    const resolution = resolveConfigLayers(azureConfig, [hider], { rederiveEndpoints: true });

    expect(servedGroups(resolution.merged)).toEqual(['east']);
    expect(resolution.merged.endpoints?.azureOpenAI?.modelNames).toEqual(['gpt-4o']);
    expect(ignoredOf(resolution, 0)).toEqual([{ ...unresolved, tombstone: true }]);
    expect(
      getIgnoredConfigOverrides(yaml as Partial<TCustomConfig>, hider, [], undefined, {
        rederiveEndpoints: true,
      }),
    ).toEqual([{ ...unresolved, kind: 'tombstone' }]);

    const kept = role({}, ['endpoints.azureOpenAI.groups["north"].models.o3']);
    expect(
      ignoredOf(resolveConfigLayers(azureConfig, [kept], { rederiveEndpoints: true }), 0),
    ).toEqual([]);
  });
});
