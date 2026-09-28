import { INTERFACE_PERMISSION_FIELDS, PermissionTypes } from 'librechat-data-provider';
import type { AppConfig, IConfig } from '~/types';
import { BASE_CONFIG_PRINCIPAL_ID } from '~/admin/capabilities';
import { mergeConfigOverrides } from './resolution';

function fakeConfig(
  overrides: Record<string, unknown>,
  priority: number,
  tombstones?: string[],
  principalId = 'test',
): IConfig {
  return {
    _id: 'fake',
    principalType: 'role',
    principalId,
    principalModel: 'Role',
    priority,
    overrides,
    tombstones,
    isActive: true,
    configVersion: 1,
  } as unknown as IConfig;
}

const baseConfig = {
  interfaceConfig: { modelSelect: true, parameters: true },
  registration: { enabled: true },
  endpoints: ['openAI'],
} as unknown as AppConfig;

describe('mergeConfigOverrides', () => {
  it('returns base config when configs array is empty', () => {
    expect(mergeConfigOverrides(baseConfig, [])).toBe(baseConfig);
  });

  it('returns base config when configs is null/undefined', () => {
    expect(mergeConfigOverrides(baseConfig, null as unknown as IConfig[])).toBe(baseConfig);
    expect(mergeConfigOverrides(baseConfig, undefined as unknown as IConfig[])).toBe(baseConfig);
  });

  it('does not allow DB overrides or tombstones to weaken base-only filters', () => {
    const base = {
      filters: {
        messages: {
          pii: {
            fields: ['text'],
            starterPatterns: ['sk_prefix'],
          },
        },
      },
    } as unknown as AppConfig;
    const configs = [
      fakeConfig(
        {
          filters: {
            messages: {
              pii: {
                fields: ['quote'],
                starterPatterns: [],
              },
            },
          },
        },
        10,
        ['filters.messages.pii'],
      ),
    ];

    expect(mergeConfigOverrides(base, configs).filters).toEqual(base.filters);
  });

  it('applies tenant-wide Langfuse settings only from the base principal', () => {
    const configs = [
      fakeConfig(
        { langfuse: { enabled: true, destination: 'eu', publicKey: 'pk-base' } },
        10,
        undefined,
        BASE_CONFIG_PRINCIPAL_ID,
      ),
      fakeConfig({ langfuse: { enabled: false, publicKey: 'pk-role' } }, 100),
    ];

    const result = mergeConfigOverrides(baseConfig, configs);

    expect(result.langfuse).toMatchObject({
      enabled: true,
      destination: 'eu',
      publicKey: 'pk-base',
    });
  });

  it('ignores tenant-wide Langfuse tombstones outside the base principal', () => {
    const base = {
      ...baseConfig,
      langfuse: { enabled: true, destination: 'eu', publicKey: 'pk-base' },
    } as AppConfig;

    const result = mergeConfigOverrides(base, [fakeConfig({}, 100, ['langfuse'])]);

    expect(result.langfuse).toEqual(base.langfuse);
  });

  it('deep merges interface UI fields into interfaceConfig', () => {
    const configs = [fakeConfig({ interface: { modelSelect: false } }, 10)];
    const result = mergeConfigOverrides(baseConfig, configs) as unknown as Record<string, unknown>;
    const iface = result.interfaceConfig as Record<string, unknown>;
    expect(iface.modelSelect).toBe(false);
    expect(iface.parameters).toBe(true);
  });

  it('folds a boolean schedules override onto inherited limits (does not collapse them)', () => {
    const base = {
      interfaceConfig: {
        schedules: { use: true, maxPerUser: 50, minIntervalMinutes: 5 },
      },
    } as unknown as AppConfig;
    // Enabling the feature for a role via the natural boolean toggle must PRESERVE
    // the deployment's configured limits rather than reverting them to defaults.
    const enabled = mergeConfigOverrides(base, [
      fakeConfig({ interface: { schedules: true } }, 10),
    ]) as unknown as Record<string, unknown>;
    const iface = enabled.interfaceConfig as Record<string, Record<string, unknown>>;
    expect(iface.schedules).toEqual({ use: true, maxPerUser: 50, minIntervalMinutes: 5 });
    // A boolean-false override disables while still preserving the limit values.
    const disabled = mergeConfigOverrides(base, [
      fakeConfig({ interface: { schedules: false } }, 10),
    ]) as unknown as Record<string, unknown>;
    const dIface = disabled.interfaceConfig as Record<string, Record<string, unknown>>;
    expect(dIface.schedules).toEqual({ use: false, maxPerUser: 50, minIntervalMinutes: 5 });
  });

  it('does not let a boolean override re-enable a globally-disabled feature', () => {
    // Both values are booleans, so neither fold above applies and the plain fallback
    // used to replace the base `false`. The service reads the BASE value and keeps
    // refusing every write, so the client would render a panel whose create, edit and
    // run actions all fail. A global stop may be narrowed, never widened.
    const base = { interfaceConfig: { schedules: false } } as unknown as AppConfig;
    const merged = mergeConfigOverrides(base, [
      fakeConfig({ interface: { schedules: true } }, 10),
    ]) as unknown as Record<string, Record<string, unknown>>;
    expect(merged.interfaceConfig.schedules).toBe(false);

    // An enabled base still honours a boolean override in both directions.
    const enabledBase = { interfaceConfig: { schedules: true } } as unknown as AppConfig;
    expect(
      (
        mergeConfigOverrides(enabledBase, [
          fakeConfig({ interface: { schedules: false } }, 10),
        ]) as unknown as Record<string, Record<string, unknown>>
      ).interfaceConfig.schedules,
    ).toBe(false);
  });

  /**
   * Overrides are folded in priority order into an ACCUMULATED value, so a stop applied
   * INSIDE the merge compares against whatever the previous override left — which let a
   * low-priority `false` outrank a high-priority `true`. The base stop is the only
   * non-negotiable one; overrides still order normally among themselves.
   */
  it('lets a higher-priority override win over a lower-priority one', () => {
    const base = { interfaceConfig: { schedules: true } } as unknown as AppConfig;
    const merged = mergeConfigOverrides(base, [
      fakeConfig({ interface: { schedules: false } }, 10),
      fakeConfig({ interface: { schedules: true } }, 20),
    ]) as unknown as Record<string, Record<string, unknown>>;
    expect(merged.interfaceConfig.schedules).toBe(true);

    // And the reverse ordering still disables.
    const disabled = mergeConfigOverrides(base, [
      fakeConfig({ interface: { schedules: true } }, 10),
      fakeConfig({ interface: { schedules: false } }, 20),
    ]) as unknown as Record<string, Record<string, unknown>>;
    expect(disabled.interfaceConfig.schedules).toBe(false);
  });

  it('keeps the base stop non-negotiable even for the highest-priority override', () => {
    const base = { interfaceConfig: { schedules: false } } as unknown as AppConfig;
    const merged = mergeConfigOverrides(base, [
      fakeConfig({ interface: { schedules: true } }, 10),
      fakeConfig({ interface: { schedules: true } }, 99),
    ]) as unknown as Record<string, Record<string, unknown>>;
    expect(merged.interfaceConfig.schedules).toBe(false);
  });

  it('applies the base stop through the object form too', () => {
    const base = {
      interfaceConfig: { schedules: { use: false, maxPerUser: 5 } },
    } as unknown as AppConfig;
    const merged = mergeConfigOverrides(base, [
      fakeConfig({ interface: { schedules: { maxPerUser: 50 } } }, 10),
    ]) as unknown as Record<string, Record<string, Record<string, unknown>>>;
    // The limit tuning lands, but the stop survives it.
    expect(merged.interfaceConfig.schedules).toMatchObject({ use: false, maxPerUser: 50 });
  });

  it('folds an object schedules override onto a boolean base, inheriting the enable state', () => {
    // Enabled base, object override that only TUNES a limit (no `use`): the enable
    // state must be inherited from the boolean base, not silently dropped.
    const enabledBase = {
      interfaceConfig: { schedules: true },
    } as unknown as AppConfig;
    const tuned = mergeConfigOverrides(enabledBase, [
      fakeConfig({ interface: { schedules: { maxPerUser: 3 } } }, 10),
    ]) as unknown as Record<string, Record<string, unknown>>;
    expect(tuned.interfaceConfig.schedules).toEqual({ use: true, maxPerUser: 3 });

    // Disabled base, same object override: tuning a limit must NOT re-enable the
    // globally-disabled feature.
    const disabledBase = {
      interfaceConfig: { schedules: false },
    } as unknown as AppConfig;
    const stillOff = mergeConfigOverrides(disabledBase, [
      fakeConfig({ interface: { schedules: { maxPerUser: 3 } } }, 10),
    ]) as unknown as Record<string, Record<string, unknown>>;
    expect(stillOff.interfaceConfig.schedules).toEqual({ use: false, maxPerUser: 3 });

    // A config override cannot flip the enable state: `use` is a permission sub-key,
    // stripped from interface overrides before merge (enable is permission-managed),
    // so an override attempting `use: true` on a disabled base stays disabled.
    const cannotReEnable = mergeConfigOverrides(disabledBase, [
      fakeConfig({ interface: { schedules: { use: true, maxPerUser: 3 } } }, 10),
    ]) as unknown as Record<string, Record<string, unknown>>;
    expect(cannotReEnable.interfaceConfig.schedules).toEqual({ use: false, maxPerUser: 3 });
  });

  it('sorts by priority — higher priority wins', () => {
    const configs = [
      fakeConfig({ registration: { enabled: false } }, 100),
      fakeConfig({ registration: { enabled: true, custom: 'yes' } }, 10),
    ];
    const result = mergeConfigOverrides(baseConfig, configs) as unknown as Record<string, unknown>;
    const reg = result.registration as Record<string, unknown>;
    expect(reg.enabled).toBe(false);
    expect(reg.custom).toBe('yes');
  });

  it('replaces plain arrays (no merge key) instead of concatenating', () => {
    const base = { registration: { allowedDomains: ['base.com'] } } as unknown as AppConfig;
    const configs = [fakeConfig({ registration: { allowedDomains: ['a.com', 'b.com'] } }, 10)];
    const result = mergeConfigOverrides(base, configs) as unknown as {
      registration: { allowedDomains: string[] };
    };
    expect(result.registration.allowedDomains).toEqual(['a.com', 'b.com']);
  });

  it('merges endpoints.custom arrays by name instead of replacing', () => {
    const base = {
      endpoints: {
        custom: [
          { name: 'yaml-only', baseURL: 'https://yaml-only.com', apiKey: 'key1' },
          {
            name: 'shared',
            baseURL: 'https://original.com',
            apiKey: 'key2',
            models: { default: ['m1'] },
          },
        ],
      },
    } as unknown as AppConfig;

    const configs = [
      fakeConfig(
        {
          endpoints: {
            custom: [
              { name: 'shared', baseURL: 'https://overridden.com' },
              { name: 'db-only', baseURL: 'https://db-only.com', apiKey: 'key3' },
            ],
          },
        },
        10,
      ),
    ];

    const result = mergeConfigOverrides(base, configs) as unknown as Record<string, unknown>;
    const endpoints = result.endpoints as Record<string, unknown>;
    const custom = endpoints.custom as Array<Record<string, unknown>>;

    expect(custom).toHaveLength(3);
    // YAML-only item preserved
    expect(custom[0]).toEqual({
      name: 'yaml-only',
      baseURL: 'https://yaml-only.com',
      apiKey: 'key1',
    });
    // Shared item deep-merged: baseURL overridden, apiKey + models preserved from base
    expect(custom[1]).toEqual({
      name: 'shared',
      baseURL: 'https://overridden.com',
      apiKey: 'key2',
      models: { default: ['m1'] },
    });
    // DB-only item appended
    expect(custom[2]).toEqual({ name: 'db-only', baseURL: 'https://db-only.com', apiKey: 'key3' });
  });

  it('preserves all YAML custom endpoints when DB override is empty', () => {
    const base = {
      endpoints: {
        custom: [
          { name: 'ep1', baseURL: 'https://ep1.com' },
          { name: 'ep2', baseURL: 'https://ep2.com' },
        ],
      },
    } as unknown as AppConfig;

    const configs = [fakeConfig({ endpoints: { custom: [] } }, 10)];
    const result = mergeConfigOverrides(base, configs) as unknown as Record<string, unknown>;
    const endpoints = result.endpoints as Record<string, unknown>;
    const custom = endpoints.custom as Array<Record<string, unknown>>;

    expect(custom).toHaveLength(2);
    expect(custom[0].name).toBe('ep1');
    expect(custom[1].name).toBe('ep2');
  });

  it('deduplicates when source contains repeated endpoint names', () => {
    const base = {
      endpoints: { custom: [] },
    } as unknown as AppConfig;

    const configs = [
      fakeConfig(
        {
          endpoints: {
            custom: [
              { name: 'dup', baseURL: 'https://first.com' },
              { name: 'dup', baseURL: 'https://second.com' },
            ],
          },
        },
        10,
      ),
    ];

    const result = mergeConfigOverrides(base, configs) as unknown as Record<string, unknown>;
    const custom = (result.endpoints as Record<string, unknown>).custom as Array<
      Record<string, unknown>
    >;

    expect(custom).toHaveLength(1);
    expect(custom[0].name).toBe('dup');
    // last-write-wins: Map.set overwrites on duplicate keys
    expect(custom[0].baseURL).toBe('https://second.com');
  });

  it('silently drops source items without a name field', () => {
    const base = {
      endpoints: { custom: [{ name: 'ep1', baseURL: 'https://ep1.com' }] },
    } as unknown as AppConfig;

    const configs = [
      fakeConfig({ endpoints: { custom: [{ baseURL: 'https://nameless.com' }] } }, 10),
    ];

    const result = mergeConfigOverrides(base, configs) as unknown as Record<string, unknown>;
    const custom = (result.endpoints as Record<string, unknown>).custom as Array<
      Record<string, unknown>
    >;

    expect(custom).toHaveLength(1);
    expect(custom[0].name).toBe('ep1');
  });

  it('preserves base items without a name field', () => {
    const base = {
      endpoints: { custom: [{ baseURL: 'https://ep1.com' }] },
    } as unknown as AppConfig;

    const configs = [
      fakeConfig({ endpoints: { custom: [{ name: 'db-only', baseURL: 'https://db.com' }] } }, 10),
    ];

    const result = mergeConfigOverrides(base, configs) as unknown as Record<string, unknown>;
    const custom = (result.endpoints as Record<string, unknown>).custom as Array<
      Record<string, unknown>
    >;

    expect(custom).toHaveLength(2);
    expect(custom[0].baseURL).toBe('https://ep1.com');
    expect(custom[1].name).toBe('db-only');
  });

  it('does not mutate base custom endpoint items', () => {
    const base = {
      endpoints: { custom: [{ name: 'ep1', baseURL: 'https://ep1.com' }] },
    } as unknown as AppConfig;

    const configs = [fakeConfig({ endpoints: { custom: [] } }, 10)];
    const result = mergeConfigOverrides(base, configs) as unknown as Record<string, unknown>;
    const custom = (result.endpoints as Record<string, unknown>).custom as Array<
      Record<string, unknown>
    >;

    custom[0].baseURL = 'https://mutated.com';
    const original = (base as unknown as Record<string, unknown>).endpoints as Record<
      string,
      unknown
    >;
    expect((original.custom as Array<Record<string, unknown>>)[0].baseURL).toBe('https://ep1.com');
  });

  it('respects priority for custom endpoint merges — higher priority wins', () => {
    const base = {
      endpoints: { custom: [{ name: 'shared', baseURL: 'https://yaml.com' }] },
    } as unknown as AppConfig;

    const configs = [
      fakeConfig({ endpoints: { custom: [{ name: 'shared', baseURL: 'https://low.com' }] } }, 10),
      fakeConfig({ endpoints: { custom: [{ name: 'shared', baseURL: 'https://high.com' }] } }, 100),
    ];

    const result = mergeConfigOverrides(base, configs) as unknown as Record<string, unknown>;
    const custom = (result.endpoints as Record<string, unknown>).custom as Array<
      Record<string, unknown>
    >;

    expect(custom[0].baseURL).toBe('https://high.com');
  });

  it('does not mutate the base config', () => {
    const original = JSON.parse(JSON.stringify(baseConfig));
    const configs = [fakeConfig({ interface: { modelSelect: false } }, 10)];
    mergeConfigOverrides(baseConfig, configs);
    expect(baseConfig).toEqual(original);
  });

  it('keeps the base value under a null override the schema does not allow', () => {
    const configs = [fakeConfig({ interface: { modelSelect: null } }, 10)];
    const result = mergeConfigOverrides(baseConfig, configs) as unknown as Record<string, unknown>;
    const iface = result.interfaceConfig as Record<string, unknown>;
    expect(iface.modelSelect).toBe(true);
  });

  it('skips configs with no overrides object', () => {
    const configs = [fakeConfig(undefined as unknown as Record<string, unknown>, 10)];
    const result = mergeConfigOverrides(baseConfig, configs);
    expect(result).toEqual(baseConfig);
  });

  it('strips __proto__, constructor, and prototype keys from overrides', () => {
    const configs = [
      fakeConfig(
        {
          __proto__: { polluted: true },
          constructor: { bad: true },
          prototype: { evil: true },
          safe: 'ok',
        },
        10,
      ),
    ];
    const result = mergeConfigOverrides(baseConfig, configs) as unknown as Record<string, unknown>;
    expect(result.safe).toBe('ok');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(result, 'constructor')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(result, 'prototype')).toBe(false);
  });

  it('merges three priority levels in order', () => {
    const configs = [
      fakeConfig({ interface: { modelSelect: false } }, 0),
      fakeConfig({ interface: { modelSelect: true, parameters: false } }, 10),
      fakeConfig({ interface: { parameters: true } }, 100),
    ];
    const result = mergeConfigOverrides(baseConfig, configs) as unknown as Record<string, unknown>;
    const iface = result.interfaceConfig as Record<string, unknown>;
    expect(iface.modelSelect).toBe(true);
    expect(iface.parameters).toBe(true);
  });

  it('remaps all renamed YAML keys (exhaustiveness check)', () => {
    const base = {
      mcpConfig: null,
      interfaceConfig: { modelSelect: true },
      turnstileConfig: {},
    } as unknown as AppConfig;

    const configs = [
      fakeConfig(
        {
          mcpServers: { srv: { url: 'http://mcp' } },
          interface: { modelSelect: false },
          turnstile: { siteKey: 'key-123' },
        },
        10,
      ),
    ];
    const result = mergeConfigOverrides(base, configs) as unknown as Record<string, unknown>;

    expect(result.mcpConfig).toEqual({ srv: { url: 'http://mcp' } });
    expect((result.interfaceConfig as Record<string, unknown>).modelSelect).toBe(false);
    expect((result.turnstileConfig as Record<string, unknown>).siteKey).toBe('key-123');

    expect(result.mcpServers).toBeUndefined();
    expect(result.interface).toBeUndefined();
    expect(result.turnstile).toBeUndefined();
  });

  it('strips interface permission fields from overrides', () => {
    const base = {
      interfaceConfig: { modelSelect: true, parameters: true },
    } as unknown as AppConfig;

    const configs = [
      fakeConfig(
        {
          interface: {
            modelSelect: false,
            prompts: false,
            agents: { use: false },
            marketplace: { use: false },
          },
        },
        10,
      ),
    ];
    const result = mergeConfigOverrides(base, configs) as unknown as Record<string, unknown>;
    const iface = result.interfaceConfig as Record<string, unknown>;

    // UI field should be merged
    expect(iface.modelSelect).toBe(false);
    // Boolean permission fields should be stripped
    expect(iface.prompts).toBeUndefined();
    // Object permission fields with only permission sub-keys should be stripped
    expect(iface.agents).toBeUndefined();
    expect(iface.marketplace).toBeUndefined();
    // Untouched base field preserved
    expect(iface.parameters).toBe(true);
  });

  it('merges skillSync config sections from DB overrides', () => {
    const base = {
      skillSync: {
        github: {
          enabled: true,
          intervalMinutes: 60,
          runOnStartup: false,
          sources: [
            {
              id: 'base-source',
              owner: 'LibreChat',
              repo: 'skills',
              ref: 'main',
              paths: ['skills'],
              token: '${GITHUB_SKILLS_TOKEN}',
            },
          ],
        },
      },
      interfaceConfig: { modelSelect: true },
    } as unknown as AppConfig;

    const configs = [
      fakeConfig(
        {
          skillSync: {
            github: {
              enabled: false,
              sources: [
                {
                  id: 'override-source',
                  owner: 'other',
                  repo: 'skills',
                  paths: ['skills'],
                  token: '${OTHER_TOKEN}',
                },
              ],
            },
          },
          interface: { modelSelect: false },
        },
        10,
      ),
    ];

    const result = mergeConfigOverrides(base, configs);

    expect(result.skillSync?.github?.enabled).toBe(false);
    expect(result.skillSync?.github?.sources).toEqual([
      {
        id: 'override-source',
        owner: 'other',
        repo: 'skills',
        paths: ['skills'],
        token: '${OTHER_TOKEN}',
      },
    ]);
    expect(result.interfaceConfig?.modelSelect).toBe(false);
  });

  it('preserves UI sub-keys in composite permission fields like mcpServers', () => {
    const base = {
      interfaceConfig: {},
    } as unknown as AppConfig;

    const configs = [
      fakeConfig(
        {
          interface: {
            mcpServers: {
              use: true,
              create: false,
              share: false,
              public: false,
              placeholder: 'Search MCP servers...',
              trustCheckbox: { label: 'I trust this server' },
            },
          },
        },
        10,
      ),
    ];
    const result = mergeConfigOverrides(base, configs) as unknown as Record<string, unknown>;
    const iface = result.interfaceConfig as Record<string, unknown>;
    const mcp = iface.mcpServers as Record<string, unknown>;

    // UI sub-keys preserved
    expect(mcp.placeholder).toBe('Search MCP servers...');
    expect(mcp.trustCheckbox).toEqual({ label: 'I trust this server' });
    // Permission sub-keys stripped
    expect(mcp.use).toBeUndefined();
    expect(mcp.create).toBeUndefined();
    expect(mcp.share).toBeUndefined();
    expect(mcp.public).toBeUndefined();
  });

  it('strips peoplePicker permission sub-keys (users, groups, roles)', () => {
    const base = {
      interfaceConfig: {},
    } as unknown as AppConfig;

    const configs = [
      fakeConfig({ interface: { peoplePicker: { users: false, groups: true, roles: true } } }, 10),
    ];
    const result = mergeConfigOverrides(base, configs) as unknown as Record<string, unknown>;
    const iface = result.interfaceConfig as Record<string, unknown>;

    // All sub-keys are permission bits → entire field stripped
    expect(iface.peoplePicker).toBeUndefined();
  });

  it('drops interface entirely when only permission fields are present', () => {
    const base = {
      interfaceConfig: { modelSelect: true },
    } as unknown as AppConfig;

    const configs = [fakeConfig({ interface: { prompts: false, agents: false } }, 10)];
    const result = mergeConfigOverrides(base, configs) as unknown as Record<string, unknown>;
    const iface = result.interfaceConfig as Record<string, unknown>;

    // Base should be unchanged
    expect(iface.modelSelect).toBe(true);
    expect(iface.prompts).toBeUndefined();
    expect(iface.agents).toBeUndefined();
  });

  it('remaps YAML-level keys to AppConfig equivalents', () => {
    const configs = [
      fakeConfig(
        {
          mcpServers: { 'test-server': { type: 'streamable-http', url: 'https://example.com' } },
        },
        10,
      ),
    ];
    const result = mergeConfigOverrides(baseConfig, configs) as unknown as Record<string, unknown>;
    const mcpConfig = result.mcpConfig as Record<string, unknown>;
    expect(mcpConfig).toBeDefined();
    expect(mcpConfig['test-server']).toEqual({
      type: 'streamable-http',
      url: 'https://example.com',
    });
    expect(result.mcpServers).toBeUndefined();
  });

  it('drops process-backed MCP servers from database overrides', () => {
    const base = {
      ...baseConfig,
      mcpConfig: {
        operator: { type: 'stdio', command: 'node', args: ['trusted-server.js'] },
      },
    } as unknown as AppConfig;
    const configs = [
      fakeConfig(
        {
          mcpServers: {
            injected: { type: 'stdio', command: '/bin/sh', args: ['-c', 'id'] },
            remote: { type: 'streamable-http', url: 'https://mcp.example.com' },
          },
        },
        10,
      ),
    ];

    const result = mergeConfigOverrides(base, configs) as unknown as Record<string, unknown>;
    const mcpConfig = result.mcpConfig as Record<string, unknown>;

    expect(mcpConfig.injected).toBeUndefined();
    expect(mcpConfig.remote).toEqual({
      type: 'streamable-http',
      url: 'https://mcp.example.com',
    });
    expect(mcpConfig.operator).toEqual({
      type: 'stdio',
      command: 'node',
      args: ['trusted-server.js'],
    });
  });

  it('does not let database overrides mutate an operator-owned stdio server', () => {
    const base = {
      ...baseConfig,
      mcpConfig: {
        operator: { type: 'stdio', command: 'node', args: ['trusted-server.js'] },
      },
    } as unknown as AppConfig;
    const configs = [
      fakeConfig(
        {
          mcpServers: {
            operator: { command: '/bin/sh', args: ['-c', 'id'] },
          },
        },
        10,
      ),
    ];

    const result = mergeConfigOverrides(base, configs) as unknown as Record<string, unknown>;
    const mcpConfig = result.mcpConfig as Record<string, unknown>;

    expect(mcpConfig.operator).toEqual({
      type: 'stdio',
      command: 'node',
      args: ['trusted-server.js'],
    });
  });

  it('does not let scalar database overrides disable an operator-owned stdio server', () => {
    const base = {
      ...baseConfig,
      mcpConfig: {
        operator: { type: 'stdio', command: 'node', args: ['trusted-server.js'] },
      },
    } as unknown as AppConfig;
    const configs = [
      fakeConfig(
        {
          mcpServers: {
            operator: null,
          },
        },
        10,
      ),
    ];

    const result = mergeConfigOverrides(base, configs) as unknown as Record<string, unknown>;
    const mcpConfig = result.mcpConfig as Record<string, unknown>;

    expect(mcpConfig.operator).toEqual({
      type: 'stdio',
      command: 'node',
      args: ['trusted-server.js'],
    });
  });

  it('drops process-backed MCP servers supplied through the runtime config alias', () => {
    const configs = [
      fakeConfig(
        {
          mcpConfig: {
            injected: { command: '/bin/sh', args: ['-c', 'id'] },
          },
        },
        10,
      ),
    ];

    const result = mergeConfigOverrides(baseConfig, configs) as unknown as Record<string, unknown>;

    expect(result.mcpConfig).toEqual({});
  });

  it('applies tombstones after remapping YAML paths to AppConfig paths', () => {
    const base = {
      mcpConfig: {
        github: { type: 'streamable-http', url: 'https://github.example.com' },
        slack: { type: 'streamable-http', url: 'https://slack.example.com' },
      },
    } as unknown as AppConfig;

    const result = mergeConfigOverrides(base, [
      fakeConfig({}, 10, ['mcpServers.github']),
    ]) as unknown as Record<string, unknown>;
    const mcpConfig = result.mcpConfig as Record<string, unknown>;

    expect(mcpConfig.github).toBeUndefined();
    expect(mcpConfig.slack).toEqual({
      type: 'streamable-http',
      url: 'https://slack.example.com',
    });

    const baseMcpConfig = (base as unknown as Record<string, unknown>).mcpConfig as Record<
      string,
      unknown
    >;
    expect(baseMcpConfig.github).toEqual({
      type: 'streamable-http',
      url: 'https://github.example.com',
    });
  });

  it.each(['mcpServers.operator', 'mcpServers.operator.command'])(
    'does not let the %s tombstone alter an operator-owned stdio server',
    (tombstone) => {
      const base = {
        mcpConfig: {
          operator: { type: 'stdio', command: 'node', args: ['trusted-server.js'] },
        },
      } as unknown as AppConfig;

      const result = mergeConfigOverrides(base, [
        fakeConfig({}, 10, [tombstone]),
      ]) as unknown as Record<string, unknown>;
      const mcpConfig = result.mcpConfig as Record<string, unknown>;

      expect(mcpConfig.operator).toEqual({
        type: 'stdio',
        command: 'node',
        args: ['trusted-server.js'],
      });
    },
  );

  it('preserves operator-owned stdio servers when the MCP section is tombstoned', () => {
    const base = {
      mcpConfig: {
        operator: { type: 'stdio', command: 'node', args: ['trusted-server.js'] },
        remote: { type: 'streamable-http', url: 'https://mcp.example.com' },
      },
    } as unknown as AppConfig;

    const result = mergeConfigOverrides(base, [
      fakeConfig({}, 10, ['mcpServers']),
    ]) as unknown as Record<string, unknown>;
    const mcpConfig = result.mcpConfig as Record<string, unknown>;

    expect(mcpConfig).toEqual({
      operator: { type: 'stdio', command: 'node', args: ['trusted-server.js'] },
    });
  });

  it('lets a higher-priority override recreate a lower-priority tombstoned path', () => {
    const base = {
      mcpConfig: {
        github: { type: 'streamable-http', url: 'https://github.example.com' },
      },
    } as unknown as AppConfig;

    const result = mergeConfigOverrides(base, [
      fakeConfig({}, 10, ['mcpServers.github']),
      fakeConfig({ mcpServers: { github: { url: 'https://scoped.example.com' } } }, 100),
    ]) as unknown as Record<string, unknown>;
    const mcpConfig = result.mcpConfig as Record<string, unknown>;

    expect(mcpConfig.github).toEqual({
      url: 'https://scoped.example.com',
    });
  });

  it('lets a higher-priority tombstone suppress a lower-priority override', () => {
    const base = {
      mcpConfig: {},
    } as unknown as AppConfig;

    const result = mergeConfigOverrides(base, [
      fakeConfig({ mcpServers: { github: { url: 'https://role.example.com' } } }, 10),
      fakeConfig({}, 100, ['mcpServers.github']),
    ]) as unknown as Record<string, unknown>;
    const mcpConfig = result.mcpConfig as Record<string, unknown>;

    expect(mcpConfig.github).toBeUndefined();
  });
});

describe('mergeConfigOverrides: invalid stored overrides', () => {
  const base = {
    interfaceConfig: { contextCost: true, customWelcome: 'base' },
    registration: { oauthStateTtlMs: 600_000, allowedDomains: ['base.com'] },
    endpoints: {
      custom: [{ name: 'groq', baseURL: 'https://base', apiKey: 'k', models: { default: ['m'] } }],
    },
  } as unknown as AppConfig;

  it('keeps the base value when a stored override field fails the schema', () => {
    const merged = mergeConfigOverrides(base, [
      fakeConfig(
        {
          interface: { contextCost: 'yes', customWelcome: 'override' },
          registration: { oauthStateTtlMs: 5, allowedDomains: ['override.com'] },
        },
        10,
      ),
    ]) as unknown as Record<string, Record<string, unknown>>;

    expect(merged.interfaceConfig).toEqual({ contextCost: true, customWelcome: 'override' });
    expect(merged.registration).toEqual({
      oauthStateTtlMs: 600_000,
      allowedDomains: ['override.com'],
    });
  });

  it('drops only the invalid field of a merged array item', () => {
    const merged = mergeConfigOverrides(base, [
      fakeConfig(
        { endpoints: { custom: [{ name: 'groq', baseURL: 'https://o', models: 5 }] } },
        10,
      ),
    ]) as unknown as { endpoints: { custom: Array<Record<string, unknown>> } };

    expect(merged.endpoints.custom).toEqual([
      { name: 'groq', baseURL: 'https://o', apiKey: 'k', models: { default: ['m'] } },
    ]);
  });

  it('drops a merged array item that has no merge key', () => {
    const merged = mergeConfigOverrides({} as AppConfig, [
      fakeConfig(
        { endpoints: { custom: [{ baseURL: 'https://keyless' }, { name: 'kept', baseURL: 'x' }] } },
        10,
      ),
    ]) as unknown as { endpoints: { custom: Array<Record<string, unknown>> } };

    expect(merged.endpoints.custom).toEqual([{ name: 'kept', baseURL: 'x' }]);
  });

  it('lets a lower-priority valid override survive a higher-priority invalid one', () => {
    const merged = mergeConfigOverrides(base, [
      fakeConfig({ interface: { contextCost: false } }, 10),
      fakeConfig({ interface: { contextCost: 'no' } }, 20, undefined, 'other'),
    ]) as unknown as { interfaceConfig: Record<string, unknown> };

    expect(merged.interfaceConfig.contextCost).toBe(false);
  });

  it('leaves fields the schema does not define untouched', () => {
    const merged = mergeConfigOverrides(base, [
      fakeConfig({ registration: { enabled: false } }, 10),
    ]) as unknown as { registration: Record<string, unknown> };

    expect(merged.registration.enabled).toBe(false);
  });
});

describe('INTERFACE_PERMISSION_FIELDS', () => {
  it('contains all expected permission fields', () => {
    const expected = [
      'prompts',
      'agents',
      'bookmarks',
      'memories',
      'multiConvo',
      'temporaryChat',
      'runCode',
      'webSearch',
      'fileSearch',
      'fileCitations',
      'peoplePicker',
      'marketplace',
      'mcpServers',
      'remoteAgents',
    ];
    for (const field of expected) {
      expect(INTERFACE_PERMISSION_FIELDS.has(field)).toBe(true);
    }
  });

  it('has one entry per PermissionType — no duplicates or missing', () => {
    expect(INTERFACE_PERMISSION_FIELDS.size).toBe(Object.values(PermissionTypes).length);
  });

  it('does not contain UI-only fields', () => {
    const uiFields = ['modelSelect', 'parameters', 'presets'];
    for (const field of uiFields) {
      expect(INTERFACE_PERMISSION_FIELDS.has(field)).toBe(false);
    }
  });
});
