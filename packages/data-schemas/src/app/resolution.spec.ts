import { z } from 'zod';
import {
  OptionTypes,
  PermissionTypes,
  SearchProviders,
  AgentCapabilities,
  INTERFACE_PERMISSION_FIELDS,
  DEPLOYMENT_ONLY_CONFIG_PATHS,
} from 'librechat-data-provider';
import type {
  TEndpoint,
  DeepPartial,
  TCustomConfig,
  TWebSearchConfigInput,
} from 'librechat-data-provider';
import type { AppConfig, IConfig } from '~/types';
import {
  resolveRawConfig,
  isConfigRecordPath,
  getConfigMergeRules,
  mergeConfigOverrides,
  isConfigArrayItemPath,
  isAcceptedOverrideSection,
  getConfigFieldIssues,
  applyConfigTombstones,
  getConfigChangeIssues,
  getDottedSectionIssues,
  getConfigOverrideIssues,
  combineFoldedConfigItems,
  getIndexedMergeKeyIssues,
  getConfigIssueParams,
  getIgnoredConfigOverrides,
  isConfigEntryArrayItemPath,
} from './resolution';
import { foldConfigMergeKey, getConfigArrayMergeKey } from './collections';
import { BASE_CONFIG_PRINCIPAL_ID } from '~/admin/capabilities';
import { toConfigOverrideState } from './mutations';
import { applyConfigChanges } from './changes';
import { loadWebSearchConfig } from './web';
import { formatKeyedPath } from './paths';
import { AppService } from './service';
import logger from '~/config/winston';

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

  it('replaces an inline interface theme whole instead of merging two definitions', () => {
    const base = {
      interfaceConfig: {
        theme: {
          version: 1,
          name: 'base',
          modes: {
            light: { colors: { 'rgb-surface-primary': '255 255 255' } },
            dark: { colors: { 'rgb-surface-primary': '0 0 0' } },
          },
          brands: { 'provider-openai': '#19C37D' },
        },
      },
    } as unknown as AppConfig;
    const override = {
      version: 1,
      name: 'principal',
      modes: { light: { colors: { 'rgb-surface-primary': '240 240 240' } } },
    };

    const result = mergeConfigOverrides(base, [fakeConfig({ interface: { theme: override } }, 10)]);

    expect(result.interfaceConfig?.theme).toEqual(override);
  });

  it('lets a bundled theme name override an inline base theme', () => {
    const base = {
      interfaceConfig: { theme: { version: 1, name: 'base', modes: {} } },
    } as unknown as AppConfig;

    const result = mergeConfigOverrides(base, [
      fakeConfig({ interface: { theme: 'clickhouse' } }, 10),
    ]);

    expect(result.interfaceConfig?.theme).toBe('clickhouse');
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

  it('keeps MCP App sandbox limits at deployment scope', () => {
    const base = {
      mcpAppSandbox: {
        url: 'https://mcp-sandbox.example.com/api/mcp/sandbox',
        maxSourcesPerDirective: 64,
        maxSerializedLength: 8192,
        maxAdmissionRequestsPerMinute: 480,
        maxPersistedMessageBytes: 123456,
      },
    } as unknown as AppConfig;
    const configs = [
      fakeConfig(
        {
          mcpAppSandbox: {
            url: 'https://user-sandbox.example.com/api/mcp/sandbox',
            maxSourcesPerDirective: 128,
            maxSerializedLength: 16384,
            maxAdmissionRequestsPerMinute: 960,
            maxPersistedMessageBytes: 200000,
          },
        },
        10,
        ['mcpAppSandbox.url', 'mcpAppSandbox.maxAdmissionRequestsPerMinute'],
      ),
    ];

    expect(mergeConfigOverrides(base, configs).mcpAppSandbox).toEqual(base.mcpAppSandbox);
  });

  it('keeps Turnstile on librechat.yaml whatever Base or a role stores or tombstones', () => {
    const base = { turnstileConfig: { siteKey: 'yaml-site-key' } } as unknown as AppConfig;
    const configs = [
      fakeConfig(
        { turnstile: { siteKey: 'base-site-key' } },
        0,
        ['turnstile.options'],
        BASE_CONFIG_PRINCIPAL_ID,
      ),
      fakeConfig({ turnstile: { siteKey: 'role-site-key' } }, 10, ['turnstile.siteKey']),
    ];

    expect(mergeConfigOverrides(base, configs).turnstileConfig).toEqual({
      siteKey: 'yaml-site-key',
    });
  });

  it('keeps Turnstile on librechat.yaml when a document names it by its AppConfig key', () => {
    const base = { turnstileConfig: { siteKey: 'yaml-site-key' } } as unknown as AppConfig;
    const aliased = (overrides: Record<string, unknown>, tombstones?: string[]) =>
      fakeConfig(overrides, 0, tombstones, BASE_CONFIG_PRINCIPAL_ID);

    expect(
      mergeConfigOverrides(base, [aliased({ turnstileConfig: { siteKey: 'stored-key' } })])
        .turnstileConfig,
    ).toEqual({ siteKey: 'yaml-site-key' });
    expect(
      mergeConfigOverrides(base, [aliased({}, ['turnstileConfig', 'turnstileConfig.siteKey'])])
        .turnstileConfig,
    ).toEqual({ siteKey: 'yaml-site-key' });
  });

  it('keeps the admin catalog model-list lifetime on librechat.yaml', () => {
    const base = { endpoints: { catalogModelsTtlMs: 600_000 } } as unknown as AppConfig;
    const read = (configs: IConfig[]) => mergeConfigOverrides(base, configs).endpoints;

    expect(read([fakeConfig({ endpoints: { catalogModelsTtlMs: 0 } }, 10)])).toEqual({
      catalogModelsTtlMs: 600_000,
    });
    expect(
      read([fakeConfig({}, 0, ['endpoints.catalogModelsTtlMs'], BASE_CONFIG_PRINCIPAL_ID)]),
    ).toEqual({ catalogModelsTtlMs: 600_000 });
  });

  it('keeps the pull request host from the base config whatever an override does', () => {
    const pullRequests = { host: 'ghe.example.com', allowedRepositories: ['acme/*'] };
    const base = { endpoints: { agents: { pullRequests } } } as unknown as AppConfig;
    const read = (configs: IConfig[]) =>
      (
        mergeConfigOverrides(base, configs) as unknown as {
          endpoints: { agents: { pullRequests: Record<string, unknown> } };
        }
      ).endpoints.agents.pullRequests;

    const changed = read([
      fakeConfig(
        {
          endpoints: {
            agents: { pullRequests: { host: 'evil.example.com', cacheTtlSeconds: 60 } },
          },
        },
        10,
      ),
    ]);
    expect(changed).toMatchObject({ host: 'ghe.example.com', cacheTtlSeconds: 60 });

    const provider = read([
      fakeConfig({ endpoints: { agents: { pullRequests: { provider: 'gitlab' } } } }, 10),
    ]);
    expect(provider.provider).toBeUndefined();

    const slots = read([
      fakeConfig({ endpoints: { agents: { pullRequests: { sharedCacheSlots: 64 } } } }, 10),
    ]);
    expect(slots.sharedCacheSlots).toBeUndefined();

    const oauth = read([
      fakeConfig(
        {
          endpoints: {
            agents: {
              pullRequests: { oauth: { clientId: 'x', clientSecret: '${OTHER_SECRET}' } },
            },
          },
        },
        10,
      ),
    ]);
    expect(oauth.oauth).toBeUndefined();

    const removed = read([fakeConfig({}, 10, ['endpoints.agents.pullRequests.host'])]);
    expect(removed.host).toBe('ghe.example.com');

    for (const ancestor of ['endpoints', 'endpoints.agents', 'endpoints.agents.pullRequests']) {
      expect(read([fakeConfig({}, 10, [ancestor])])).toEqual({ host: 'ghe.example.com' });
    }

    const unset = { endpoints: { agents: { pullRequests: {} } } } as unknown as AppConfig;
    const added = mergeConfigOverrides(unset, [
      fakeConfig({ endpoints: { agents: { pullRequests: { host: 'evil.example.com' } } } }, 10),
    ]) as unknown as { endpoints: { agents: { pullRequests: Record<string, unknown> } } };
    expect(added.endpoints.agents.pullRequests.host).toBeUndefined();
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
          registration: { enabled: false },
        },
        10,
      ),
    ];
    const result = mergeConfigOverrides(baseConfig, configs) as unknown as Record<string, unknown>;
    expect(result.registration).toEqual({ enabled: false });
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

  it('remaps all renamed YAML keys that overrides may set (exhaustiveness check)', () => {
    const base = {
      mcpConfig: null,
      interfaceConfig: { modelSelect: true },
    } as unknown as AppConfig;

    const configs = [
      fakeConfig(
        {
          mcpServers: { srv: { url: 'http://mcp' } },
          interface: { modelSelect: false },
        },
        10,
      ),
    ];
    const result = mergeConfigOverrides(base, configs) as unknown as Record<string, unknown>;

    expect(result.mcpConfig).toEqual({ srv: { url: 'http://mcp' } });
    expect((result.interfaceConfig as Record<string, unknown>).modelSelect).toBe(false);

    expect(result.mcpServers).toBeUndefined();
    expect(result.interface).toBeUndefined();
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

  it('ignores servers supplied through the runtime config alias, process-backed or not', () => {
    const base = {
      mcpConfig: { github: { type: 'streamable-http', url: 'https://github.example.com' } },
    } as unknown as AppConfig;
    const configs = [
      fakeConfig(
        {
          mcpConfig: {
            injected: { command: '/bin/sh', args: ['-c', 'id'] },
            remote: { type: 'streamable-http', url: 'https://attacker.example.com' },
          },
        },
        10,
      ),
    ];

    const result = mergeConfigOverrides(base, configs) as unknown as Record<string, unknown>;

    expect(result.mcpConfig).toEqual({
      github: { type: 'streamable-http', url: 'https://github.example.com' },
    });
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

/**
 * Record-key tombstones are how a profile removes one inherited key from an MCP server's record
 * maps without replacing the whole map: deep merge cannot drop a lower layer's key, and atomic
 * record merging would change what every stored partial map means.
 */
describe('mergeConfigOverrides: removing inherited MCP record keys', () => {
  const github = {
    type: 'streamable-http',
    url: 'https://github.example.com/mcp',
    headers: { Authorization: 'Bearer {{PAT}}', 'X-Team': 'core' },
    oauth_headers: { 'X-Client': 'librechat', 'X-Keep': 'yes' },
    requestHeaders: { 'X-Conversation': '{{LIBRECHAT_BODY_CONVERSATIONID}}', 'X-Static': 'on' },
    customUserVars: {
      PAT: { title: 'Token', description: 'Personal access token' },
      ORG: { title: 'Org', description: 'Organization' },
    },
  };
  const base = { mcpConfig: { github } } as unknown as AppConfig;

  function mergedGithub(configs: IConfig[]): Record<string, unknown> {
    const merged = mergeConfigOverrides(base, configs) as unknown as {
      mcpConfig: Record<string, Record<string, unknown>>;
    };
    return merged.mcpConfig.github;
  }

  it.each([
    ['headers', 'Authorization', { 'X-Team': 'core' }],
    ['oauth_headers', 'X-Client', { 'X-Keep': 'yes' }],
    ['requestHeaders', 'X-Conversation', { 'X-Static': 'on' }],
    ['customUserVars', 'PAT', { ORG: github.customUserVars.ORG }],
  ])('removes only the tombstoned %s key %s', (record, key, remaining) => {
    const server = mergedGithub([fakeConfig({}, 10, [`mcpServers.github.${record}.${key}`])]);

    expect(server[record]).toEqual(remaining);
    expect(server.url).toBe(github.url);
    expect(base.mcpConfig?.github).toEqual(github);
  });

  it('keeps the tombstone when the same profile writes a sibling key', () => {
    const server = mergedGithub([
      fakeConfig({ mcpServers: { github: { headers: { 'X-Extra': 'added' } } } }, 10, [
        'mcpServers.github.headers.Authorization',
      ]),
    ]);

    expect(server.headers).toEqual({ 'X-Team': 'core', 'X-Extra': 'added' });
  });

  it('lets a higher-priority profile supply the removed key again', () => {
    const server = mergedGithub([
      fakeConfig({}, 10, ['mcpServers.github.headers.Authorization']),
      fakeConfig(
        { mcpServers: { github: { headers: { Authorization: 'Bearer {{SCOPED}}' } } } },
        20,
        undefined,
        'other',
      ),
    ]);

    expect(server.headers).toEqual({ Authorization: 'Bearer {{SCOPED}}', 'X-Team': 'core' });
  });

  it('removes the whole record when the record itself is tombstoned', () => {
    const server = mergedGithub([fakeConfig({}, 10, ['mcpServers.github.headers'])]);

    expect(server).not.toHaveProperty('headers');
    expect(server.oauth_headers).toEqual(github.oauth_headers);
  });

  it('ignores a key tombstone on a process-backed server', () => {
    const local = {
      type: 'stdio',
      command: 'node',
      args: ['x.js'],
      env: { DEBUG: '1', KEEP: '2' },
    };
    const merged = mergeConfigOverrides({ mcpConfig: { local } } as unknown as AppConfig, [
      fakeConfig({}, 10, ['mcpServers.local.env.DEBUG']),
    ]) as unknown as { mcpConfig: Record<string, unknown> };

    expect(merged.mcpConfig.local).toEqual(local);
  });

  it('validates writes on the same base the merge produces', () => {
    const yaml = { mcpServers: { github } } as unknown as Partial<TCustomConfig>;
    const tombstoned = applyConfigTombstones(yaml, ['mcpServers.github.headers.Authorization']);

    expect(
      (tombstoned.mcpServers as Record<string, { headers?: Record<string, string> }>).github
        .headers,
    ).toEqual({ 'X-Team': 'core' });
    expect(
      getConfigOverrideIssues(
        { mcpServers: { github: { headers: { 'X-Extra': 'added' } } } } as Partial<TCustomConfig>,
        tombstoned,
      ),
    ).toEqual([]);
  });
});

describe('mergeConfigOverrides: filtered MCP servers', () => {
  it('does not let a filtered process-backed server shape a later partial', () => {
    const merged = mergeConfigOverrides({} as AppConfig, [
      fakeConfig({ mcpServers: { injected: { type: 'stdio', command: 'node', args: ['x'] } } }, 10),
      fakeConfig({ mcpServers: { injected: { title: 'Injected' } } }, 20, undefined, 'other'),
    ]) as unknown as { mcpConfig?: Record<string, unknown> };

    expect(merged.mcpConfig?.injected).toEqual({ title: 'Injected' });
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

  it('ignores a stored dotted key at a fixed-shape position and merges dotted record keys', () => {
    const profile = 'us.anthropic.claude-sonnet-4-6';
    const arn = 'arn:aws:bedrock:us-east-1:1:inference-profile/x';
    const merged = mergeConfigOverrides(base, [
      fakeConfig(
        {
          'registration.allowedDomains': ['dotted.com'],
          registration: { 'oauthStateTtlMs.x': 1, allowedDomains: ['override.com'] },
          endpoints: { bedrock: { inferenceProfiles: { [profile]: arn } } },
        },
        10,
      ),
    ]) as unknown as Record<string, Record<string, unknown>>;

    expect(merged['registration.allowedDomains']).toBeUndefined();
    expect(merged.registration).toEqual({
      oauthStateTtlMs: 600_000,
      allowedDomains: ['override.com'],
    });
    expect(merged.endpoints.bedrock).toEqual({ inferenceProfiles: { [profile]: arn } });
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

  it('reports an earlier merged array item that repeats a merge key', () => {
    const custom = [
      { name: 'x', models: { default: ['m'] } },
      { name: 'x', baseURL: 5 },
    ];
    expect(getConfigOverrideIssues({ endpoints: { custom } })).toEqual([
      {
        path: 'endpoints.custom.0',
        segments: ['endpoints', 'custom', '0'],
        code: 'duplicate_merge_key',
      },
      {
        path: 'endpoints.custom.1.baseURL',
        segments: ['endpoints', 'custom', '1', 'baseURL'],
        code: 'invalid_type',
        params: { expected: 'string', received: 'number' },
      },
    ]);

    const merged = mergeConfigOverrides({} as AppConfig, [
      fakeConfig({ endpoints: { custom } }, 10),
    ]) as unknown as { endpoints: { custom: unknown[] } };
    expect(merged.endpoints.custom).toEqual([{ name: 'x' }]);
  });

  it('drops a key the accepted union option does not define, keeping the rest', () => {
    const merged = mergeConfigOverrides({} as AppConfig, [
      fakeConfig(
        { memory: { agent: { enabled: true, id: 5, provider: 'openAI', model: 'gpt-4o' } } },
        10,
      ),
    ]) as unknown as { memory: { agent: Record<string, unknown> } };

    expect(merged.memory.agent).toEqual({ enabled: true, provider: 'openAI', model: 'gpt-4o' });
  });

  it('drops a merged array item that is not an object', () => {
    const merged = mergeConfigOverrides({} as AppConfig, [
      fakeConfig({ endpoints: { custom: [null, 'bad', { name: 'kept', baseURL: 'x' }] } }, 10),
    ]) as unknown as { endpoints: { custom: unknown[] } };

    expect(merged.endpoints.custom).toEqual([{ name: 'kept', baseURL: 'x' }]);
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

  it('strips an invalid field under a record key that contains a dot', () => {
    const merged = mergeConfigOverrides(
      {
        config: { mcpServers: { 'team.prod': { url: 'https://mcp', timeout: 1000 } } },
        mcpConfig: { 'team.prod': { url: 'https://mcp', timeout: 1000 } },
      } as unknown as AppConfig,
      [fakeConfig({ mcpServers: { 'team.prod': { timeout: 'x', initTimeout: 500 } } }, 10)],
    ) as unknown as { mcpConfig: Record<string, Record<string, unknown>> };

    expect(merged.mcpConfig['team.prod']).toEqual({
      url: 'https://mcp',
      timeout: 1000,
      initTimeout: 500,
    });
  });

  it('ignores a stored overrides document that is not an object', () => {
    const merged = mergeConfigOverrides(base, [
      fakeConfig(['stray'] as unknown as Record<string, unknown>, 10),
    ]) as unknown as Record<string, unknown>;

    expect(merged).toEqual(base);
    expect(merged).not.toHaveProperty('0');
  });

  it('drops a replaced-array item that fails a refinement, keeping its valid siblings', () => {
    const merged = mergeConfigOverrides({} as AppConfig, [
      fakeConfig(
        {
          messageFilter: {
            pii: {
              customPatterns: [
                { id: 'bad', label: 'Bad', regex: '(unclosed' },
                { id: 'ok', label: 'Ok', regex: 'x+' },
              ],
            },
          },
        },
        10,
      ),
    ]) as unknown as { messageFilter: { pii: { customPatterns: Array<{ id: string }> } } };

    expect(merged.messageFilter.pii.customPatterns.map((pattern) => pattern.id)).toEqual(['ok']);
  });

  it('drops a replaced array item left incomplete by a repair and keeps other sections', () => {
    const merged = mergeConfigOverrides(baseConfig, [
      fakeConfig(
        {
          interface: { customWelcome: 'kept' },
          endpoints: {
            azureOpenAI: {
              groups: [{ group: 'g', apiKey: 'k', instanceName: 'i', version: 'v', models: 5 }],
            },
          },
        },
        10,
      ),
    ]) as unknown as {
      interfaceConfig: Record<string, unknown>;
      endpoints: unknown;
    };

    expect(merged.interfaceConfig.customWelcome).toBe('kept');
    expect(merged.endpoints).toEqual(baseConfig.endpoints);
  });

  it('keeps a lower layer that relies on a higher layer for a required field', () => {
    const layers = [
      fakeConfig(
        {
          cloudfront: {
            imageSigning: 'cookies',
            cookieDomain: '.example.com',
            requireSignedAccess: true,
          },
        },
        10,
      ),
      fakeConfig({ cloudfront: { domain: 'https://cdn.example.com' } }, 20, undefined, 'other'),
    ];

    expect(resolveRawConfig({}, layers).cloudfront).toEqual({
      imageSigning: 'cookies',
      cookieDomain: '.example.com',
      requireSignedAccess: true,
      domain: 'https://cdn.example.com',
    });
    /** `cloudfront` is deployment-only: the served config keeps librechat.yaml's (none here). */
    const merged = mergeConfigOverrides({} as AppConfig, layers) as { cloudfront?: unknown };
    expect(merged.cloudfront).toBeUndefined();
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

describe('mergeConfigOverrides: web search keys follow the layer that set their URL', () => {
  type WebSearch = Record<string, string | number | undefined>;
  const yaml = {
    searchProvider: SearchProviders.KEENABLE,
    keenableApiUrl: 'https://keenable.operator.example.com',
    keenableApiKey: 'kn-yaml-literal-0001',
  } satisfies TWebSearchConfigInput;
  const base = {
    config: { webSearch: yaml },
    webSearch: loadWebSearchConfig(yaml),
  } as unknown as AppConfig;

  function baseProfile(webSearch: WebSearch, tombstones?: string[]): IConfig {
    return fakeConfig({ webSearch }, 0, tombstones, BASE_CONFIG_PRINCIPAL_ID);
  }

  function roleProfile(webSearch: WebSearch, tombstones?: string[]): IConfig {
    return fakeConfig({ webSearch }, 10, tombstones, 'ADMIN');
  }

  function mergedWebSearch(...configs: IConfig[]): WebSearch {
    return mergeConfigOverrides(base, configs).webSearch as WebSearch;
  }

  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('drops a key stored in the base profile when a role profile sets only its URL', () => {
    const webSearch = mergedWebSearch(
      baseProfile({
        searxngInstanceUrl: 'https://searx.operator.example.com',
        searxngApiKey: 'sx-base-secret-0001',
      }),
      roleProfile({ searxngInstanceUrl: 'https://capture.example.com' }),
    );

    expect(webSearch.searxngInstanceUrl).toBe('https://capture.example.com');
    expect(webSearch).not.toHaveProperty('searxngApiKey');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        `webSearch.searxngApiKey from role/${BASE_CONFIG_PRINCIPAL_ID}: webSearch.searxngInstanceUrl is set by role/ADMIN`,
      ),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('sx-base-secret-0001');
  });

  it('drops a librechat.yaml key when an override sets its URL', () => {
    const webSearch = mergedWebSearch(
      baseProfile({ keenableApiUrl: 'https://capture.example.com' }),
    );

    expect(webSearch.keenableApiUrl).toBe('https://capture.example.com');
    expect(webSearch).not.toHaveProperty('keenableApiKey');
  });

  it('drops a key a layer stores for a URL it inherits', () => {
    const webSearch = mergedWebSearch(roleProfile({ keenableApiKey: 'kn-role-0001' }));

    expect(webSearch.keenableApiUrl).toBe(yaml.keenableApiUrl);
    expect(webSearch).not.toHaveProperty('keenableApiKey');
  });

  it('keeps a key stored in the same layer as its URL', () => {
    expect(mergedWebSearch(roleProfile({ safeSearch: 0 }))).toMatchObject({
      keenableApiUrl: yaml.keenableApiUrl,
      keenableApiKey: yaml.keenableApiKey,
    });
    expect(
      mergedWebSearch(
        baseProfile({
          searxngInstanceUrl: 'https://searx.operator.example.com',
          searxngApiKey: 'sx-base-secret-0001',
        }),
        roleProfile({
          keenableApiUrl: 'https://keenable.role.example.com',
          keenableApiKey: 'kn-role-0001',
        }),
      ),
    ).toMatchObject({
      searxngInstanceUrl: 'https://searx.operator.example.com',
      searxngApiKey: 'sx-base-secret-0001',
      keenableApiUrl: 'https://keenable.role.example.com',
      keenableApiKey: 'kn-role-0001',
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'points it at an environment variable', url: '${OTHER_SERVICE_URL}' },
    { name: 'blanks it', url: '' },
  ])('drops a base profile key when a role profile $name', ({ url }) => {
    const webSearch = mergedWebSearch(
      baseProfile({
        searxngInstanceUrl: 'https://searx.operator.example.com',
        searxngApiKey: 'sx-base-secret-0001',
      }),
      roleProfile({ searxngInstanceUrl: url }),
    );

    expect(webSearch.searxngInstanceUrl).toBe(url);
    expect(webSearch).not.toHaveProperty('searxngApiKey');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('webSearch.searxngInstanceUrl is set by role/ADMIN'),
    );
  });

  it('drops a librechat.yaml key when an override points its URL at the environment', () => {
    const webSearch = mergedWebSearch(
      baseProfile({ keenableApiUrl: '${KEENABLE_API_URL}' }),
      roleProfile({ firecrawlApiUrl: 'https://firecrawl.role.example.com' }),
    );

    expect(webSearch.keenableApiUrl).toBe('${KEENABLE_API_URL}');
    expect(webSearch).not.toHaveProperty('keenableApiKey');
    expect(webSearch.searxngApiKey).toBe('${SEARXNG_API_KEY}');
  });

  it('drops the key when a later layer tombstones its URL', () => {
    const webSearch = mergedWebSearch(roleProfile({}, ['webSearch.keenableApiUrl']));

    expect(webSearch).not.toHaveProperty('keenableApiUrl');
    expect(webSearch).not.toHaveProperty('keenableApiKey');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'webSearch.keenableApiKey from the base config: webSearch.keenableApiUrl is removed by role/ADMIN',
      ),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(yaml.keenableApiKey);
  });

  it('keeps a key a profile stores over an environment URL it inherits', () => {
    expect(
      mergedWebSearch(
        baseProfile({ firecrawlApiKey: 'fc-base-0001' }),
        roleProfile({ safeSearch: 0 }),
      ),
    ).toMatchObject({ firecrawlApiUrl: '${FIRECRAWL_API_URL}', firecrawlApiKey: 'fc-base-0001' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps a key the same profile stores beside its own tombstone of the URL', () => {
    const webSearch = mergedWebSearch(
      roleProfile({ keenableApiKey: 'kn-role-0001' }, ['webSearch.keenableApiUrl']),
    );

    expect(webSearch).not.toHaveProperty('keenableApiUrl');
    expect(webSearch.keenableApiKey).toBe('kn-role-0001');
  });

  it('keeps a key a later profile stores with the URL a lower profile removed', () => {
    const webSearch = mergedWebSearch(
      baseProfile({}, ['webSearch']),
      roleProfile({
        keenableApiUrl: 'https://keenable.role.example.com',
        keenableApiKey: 'kn-role-0001',
      }),
    );

    expect(webSearch).toMatchObject({
      keenableApiUrl: 'https://keenable.role.example.com',
      keenableApiKey: 'kn-role-0001',
    });
    expect(warn).not.toHaveBeenCalled();
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

describe('getConfigOverrideIssues', () => {
  const paths = (issues: Array<{ path: string }>) => issues.map((issue) => issue.path);

  it('accepts a partial section whose supplied fields are valid', () => {
    expect(
      getConfigOverrideIssues({
        registration: { allowedDomains: ['a.com'] },
        interface: { schedules: { maxPerUser: 2 } },
        mcpServers: { github: { timeout: 5000 } },
      }),
    ).toEqual([]);
  });

  it('reports each invalid supplied field by its dot-path', () => {
    expect(
      paths(
        getConfigOverrideIssues({
          registration: { oauthStateTtlMs: 5 },
          balance: { enabled: 'yes' },
          interface: { contextCost: null },
        }),
      ),
    ).toEqual(['registration.oauthStateTtlMs', 'balance.enabled', 'interface.contextCost']);
  });

  it('judges a union by the branch the value was written for', () => {
    expect(paths(getConfigOverrideIssues({ memory: { agent: { id: 5 } } }))).toEqual([
      'memory.agent.id',
    ]);
    expect(
      paths(getConfigOverrideIssues({ memory: { agent: { id: 5, provider: 'openAI' } } })),
    ).toEqual(['memory.agent.id']);
    expect(getConfigOverrideIssues({ memory: { agent: { id: 'agent_1' } } })).toEqual([]);
    expect(
      paths(getConfigOverrideIssues({ interface: { schedules: { maxPerUser: 'x' } } })),
    ).toEqual(['interface.schedules.maxPerUser']);
  });

  it('applies refinements to the values an override supplies', () => {
    expect(
      paths(
        getConfigOverrideIssues({
          messageFilter: {
            pii: { customPatterns: [{ id: 'p1', label: 'Bad', regex: '(unclosed' }] },
          },
        }),
      ),
    ).toEqual(['messageFilter.pii.customPatterns.0.regex']);
    expect(
      paths(
        getConfigOverrideIssues({
          cloudfront: {
            domain: 'https://cdn.example.com',
            imageSigning: 'none',
            requireSignedAccess: true,
          },
        }),
      ),
    ).toEqual(['cloudfront.requireSignedAccess']);
  });

  it('leaves a write that relies on the base for related or required fields to the merge', () => {
    const base = {
      cloudfront: {
        domain: 'https://cdn.example.com',
        imageSigning: 'cookies',
        cookieDomain: '.example.com',
      },
    } as Partial<TCustomConfig>;
    expect(getConfigOverrideIssues({ cloudfront: { requireSignedAccess: true } }, base)).toEqual(
      [],
    );
    expect(getConfigOverrideIssues({ endpoints: { azureOpenAI: { assistants: true } } })).toEqual(
      [],
    );
  });

  it('reports a key another union option defines when the accepted option drops it', () => {
    const agent = { enabled: true, id: 5, provider: 'openAI', model: 'gpt-4o' };
    expect(getConfigOverrideIssues({ memory: { agent } })).toEqual([
      { path: 'memory.agent.id', segments: ['memory', 'agent', 'id'], code: 'union_dropped_key' },
    ]);
    expect(
      getConfigOverrideIssues({ memory: { agent: { provider: 'openAI', model: 'gpt-4o' } } }),
    ).toEqual([]);
    expect(
      getConfigOverrideIssues({ memory: { agent: { id: 'a', provider: 'openAI', unknown: 1 } } }),
    ).toEqual([
      {
        path: 'memory.agent.provider',
        segments: ['memory', 'agent', 'provider'],
        code: 'union_dropped_key',
      },
    ]);
  });

  it('requires the merge key on custom endpoint items and maps merged items back by it', () => {
    expect(getConfigOverrideIssues({ endpoints: { custom: [{ baseURL: 'https://a' }] } })).toEqual([
      {
        path: 'endpoints.custom.0',
        segments: ['endpoints', 'custom', '0'],
        code: 'missing_merge_key',
      },
    ]);
    const base = {
      endpoints: {
        custom: [
          { name: 'a', apiKey: 'k', baseURL: 'https://a', models: { default: ['m'] } },
          { name: 'b', apiKey: 'k', baseURL: 'https://b', models: { default: ['m'] } },
        ],
      },
    } as Partial<TCustomConfig>;
    expect(
      paths(getConfigOverrideIssues({ endpoints: { custom: [{ name: 'b', models: 5 }] } }, base)),
    ).toEqual(['endpoints.custom.0.models']);
  });

  it('keeps a record key that contains a dot as one segment', () => {
    expect(
      getConfigOverrideIssues({ mcpServers: { 'team.prod': { timeout: 'x' } } }, {
        mcpServers: { 'team.prod': { url: 'https://mcp' } },
      } as Partial<TCustomConfig>),
    ).toEqual([expect.objectContaining({ segments: ['mcpServers', 'team.prod', 'timeout'] })]);
  });

  it('reports a dotted key where the schema has a fixed shape', () => {
    const issues = getConfigOverrideIssues({
      'webSearch.serperApiKey': 'x',
      registration: { 'socialLogins.0': 'github' },
      interface: { theme: { 'modes.light': { colors: {} } } },
      endpoints: {
        azureOpenAI: {
          groups: [{ group: 'g', apiKey: 'k', models: { 'gpt-4.1': true }, 'models.x': {} }],
        },
      },
    });
    expect(issues.filter((issue) => issue.code === 'dotted_key')).toEqual([
      { path: 'webSearch.serperApiKey', segments: ['webSearch.serperApiKey'], code: 'dotted_key' },
      {
        path: 'registration.socialLogins.0',
        segments: ['registration', 'socialLogins.0'],
        code: 'dotted_key',
      },
      {
        path: 'interface.theme.modes.light',
        segments: ['interface', 'theme', 'modes.light'],
        code: 'dotted_key',
      },
      {
        path: 'endpoints.azureOpenAI.groups.0.models.x',
        segments: ['endpoints', 'azureOpenAI', 'groups', '0', 'models.x'],
        code: 'dotted_key',
      },
    ]);
  });

  it('keeps dotted keys where the schema has a record', () => {
    expect(
      getConfigOverrideIssues({
        endpoints: {
          bedrock: {
            inferenceProfiles: {
              'us.anthropic.claude-sonnet-4-6': 'arn:aws:bedrock:us-east-1:1:inference-profile/x',
            },
          },
          azureOpenAI: {
            groups: [
              {
                group: 'eastus',
                apiKey: 'azure-key',
                instanceName: 'east',
                deploymentName: 'gpt-41',
                version: '2024-10-21',
                models: { 'gpt-4.1': true, 'gpt-4.1-mini': { deploymentName: 'mini' } },
                addParams: { 'reasoning.effort': 'high' },
              },
            ],
          },
          custom: [
            {
              name: 'gateway',
              apiKey: 'k',
              baseURL: 'https://gw',
              models: { default: ['gpt-4.1'] },
              headers: { 'x-portkey.config': 'cfg' },
              tokenConfig: { 'gpt-4.1': { prompt: 1, completion: 2, context: 1000 } },
            },
          ],
        },
        fileConfig: {
          defaultLLMDeliveryPath: {
            overrides: {
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'text',
            },
          },
        },
        mcpServers: { 'team.prod': { url: 'https://mcp.example.com', headers: { 'X-A.B': 'v' } } },
      }),
    ).toEqual([]);
  });

  it('accepts keys the schema does not define inside a known section, and stored secret shapes', () => {
    expect(getConfigOverrideIssues({ registration: { enabled: false, futureOption: 5 } })).toEqual(
      [],
    );
    expect(
      getConfigOverrideIssues({
        endpoints: {
          custom: [
            {
              name: 'x',
              apiKey: 'v3:enc',
              apiKeyPreview: 'sk-...',
              baseURL: 'https://x',
              models: { default: ['m'] },
            },
          ],
        },
        ocr: { apiKey: '' },
      }),
    ).toEqual([]);
  });

  it('rejects an overrides document that is not an object', () => {
    expect(getConfigOverrideIssues(['stray'])).toEqual([
      { path: '', segments: [], code: 'invalid_document' },
    ]);
  });
});

describe('endpoints.custom: names the runtime folds together', () => {
  type CustomItem = Record<string, unknown>;
  const customOf = (config: AppConfig): CustomItem[] =>
    (config as unknown as { endpoints: { custom: CustomItem[] } }).endpoints.custom;
  const yamlOllama = {
    name: 'Ollama',
    apiKey: 'ollama',
    baseURL: 'http://yaml-host:11434/v1',
    models: { default: ['llama3'], fetch: true },
    modelDisplayLabel: 'Ollama (YAML)',
  };
  const base = { endpoints: { custom: [yamlOllama] } } as unknown as AppConfig;

  it('merges an override `ollama` into the YAML `Ollama`, which keeps its name', () => {
    const merged = mergeConfigOverrides(base, [
      fakeConfig(
        { endpoints: { custom: [{ name: 'ollama', baseURL: 'http://override:11434/v1' }] } },
        10,
      ),
    ]);

    expect(customOf(merged)).toEqual([{ ...yamlOllama, baseURL: 'http://override:11434/v1' }]);
  });

  it('folds every layer onto one entry, the highest priority winning', () => {
    const merged = mergeConfigOverrides(base, [
      fakeConfig({ endpoints: { custom: [{ name: 'OLLAMA', modelDisplayLabel: 'Low' }] } }, 10),
      fakeConfig({ endpoints: { custom: [{ name: 'ollama', modelDisplayLabel: 'High' }] } }, 20),
    ]);

    expect(customOf(merged)).toEqual([{ ...yamlOllama, modelDisplayLabel: 'High' }]);
  });

  it('folds custom endpoint merge keys only, and only the names the runtime folds', () => {
    expect(foldConfigMergeKey('endpoints.custom', 'OLLAMA')).toBe('ollama');
    expect(foldConfigMergeKey('endpoints.custom', 'Ollama')).toBe('ollama');
    expect(foldConfigMergeKey('endpoints.custom', 'OpenRouter')).toBe('OpenRouter');
    expect(foldConfigMergeKey('endpoints.custom', ' Ollama ')).toBe(' Ollama ');
    expect(foldConfigMergeKey('mcpServers', 'Ollama')).toBe('Ollama');
  });

  it('keeps the spelling of the layer that first defined the entry', () => {
    const merged = mergeConfigOverrides({ endpoints: { custom: [] } } as unknown as AppConfig, [
      fakeConfig({ endpoints: { custom: [{ name: 'OLLAMA', baseURL: 'http://low/v1' }] } }, 10),
      fakeConfig({ endpoints: { custom: [{ name: 'ollama', baseURL: 'http://high/v1' }] } }, 20),
    ]);

    expect(customOf(merged)).toEqual([{ name: 'OLLAMA', baseURL: 'http://high/v1' }]);
  });

  it('applies an override to every YAML spelling when YAML itself holds both', () => {
    const merged = mergeConfigOverrides(
      {
        endpoints: { custom: [yamlOllama, { ...yamlOllama, name: 'ollama', baseURL: 'http://b' }] },
      } as unknown as AppConfig,
      [fakeConfig({ endpoints: { custom: [{ name: 'OLLAMA', modelDisplayLabel: 'Both' }] } }, 10)],
    );

    expect(customOf(merged)).toEqual([
      { ...yamlOllama, modelDisplayLabel: 'Both' },
      { ...yamlOllama, name: 'ollama', baseURL: 'http://b', modelDisplayLabel: 'Both' },
    ]);
  });

  it('keeps every other custom endpoint name case-sensitive', () => {
    const openRouter = { name: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1' };
    const merged = mergeConfigOverrides(
      { endpoints: { custom: [openRouter] } } as unknown as AppConfig,
      [fakeConfig({ endpoints: { custom: [{ name: 'openrouter', baseURL: 'https://o' }] } }, 10)],
    );

    expect(customOf(merged).map((item) => item.name)).toEqual(['OpenRouter', 'openrouter']);
  });

  it('rejects a write that names one entry in two spellings, reporting the earlier item', () => {
    const custom = [
      { name: 'Ollama', modelDisplayLabel: 'First' },
      { name: 'ollama', modelDisplayLabel: 'Second' },
    ];

    expect(getConfigOverrideIssues({ endpoints: { custom } })).toEqual([
      {
        path: 'endpoints.custom.0',
        segments: ['endpoints', 'custom', '0'],
        code: 'duplicate_merge_key',
      },
    ]);
  });

  describe('a stored document that names one entry in two spellings', () => {
    /** Stored before names were folded: requests used the first item's host and key. */
    const legacy = [
      {
        name: 'Ollama',
        baseURL: 'http://override-first/v1',
        apiKey: 'v3:first-key',
        modelDisplayLabel: 'legacy-first',
      },
      { name: 'ollama', modelDisplayLabel: 'legacy-second' },
    ];
    let warn: jest.SpyInstance;

    beforeEach(() => {
      warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    });

    afterEach(() => {
      warn.mockRestore();
    });

    it('combines the items in document order onto the YAML entry, keeping the first host and key', () => {
      const merged = mergeConfigOverrides(base, [
        fakeConfig({ endpoints: { custom: legacy } }, 10, undefined, 'legacy-doc'),
      ]);

      expect(customOf(merged)).toEqual([
        {
          ...yamlOllama,
          baseURL: 'http://override-first/v1',
          apiKey: 'v3:first-key',
          modelDisplayLabel: 'legacy-second',
        },
      ]);
      const messages = warn.mock.calls.map(([message]) => String(message));
      expect(messages).toEqual([expect.stringContaining('Combining "endpoints.custom" items')]);
      expect(messages[0]).toContain('legacy-doc');
    });

    it('lets the later item win the fields both set', () => {
      const merged = mergeConfigOverrides(base, [
        fakeConfig(
          {
            endpoints: {
              custom: [legacy[0], { name: 'OLLAMA', baseURL: 'http://override-second/v1' }],
            },
          },
          10,
        ),
      ]);

      expect(customOf(merged)).toEqual([
        {
          ...yamlOllama,
          baseURL: 'http://override-second/v1',
          apiKey: 'v3:first-key',
          modelDisplayLabel: 'legacy-first',
        },
      ]);
    });

    it('appends the combined entry where the first item stood when YAML has no such entry', () => {
      const merged = mergeConfigOverrides({ endpoints: { custom: [] } } as unknown as AppConfig, [
        fakeConfig({ endpoints: { custom: [...legacy, { name: 'Other', apiKey: 'k' }] } }, 10),
      ]);

      expect(customOf(merged)).toEqual([
        {
          name: 'ollama',
          baseURL: 'http://override-first/v1',
          apiKey: 'v3:first-key',
          modelDisplayLabel: 'legacy-second',
        },
        { name: 'Other', apiKey: 'k' },
      ]);
    });
  });

  it('keeps the existing rule for a stored repeat of one spelling: the last item applies', () => {
    const merged = mergeConfigOverrides(base, [
      fakeConfig(
        {
          endpoints: {
            custom: [
              { name: 'ollama', baseURL: 'http://first/v1' },
              { name: 'ollama', modelDisplayLabel: 'Second' },
            ],
          },
        },
        10,
      ),
    ]);

    expect(customOf(merged)).toEqual([{ ...yamlOllama, modelDisplayLabel: 'Second' }]);
  });

  it('attributes an issue on the merged entry to the override item that folds onto it', () => {
    const yamlBase = { endpoints: { custom: [yamlOllama] } } as Partial<TCustomConfig>;

    expect(
      getConfigOverrideIssues({ endpoints: { custom: [{ name: 'OLLAMA', models: 5 }] } }, yamlBase),
    ).toEqual([
      {
        path: 'endpoints.custom.0.models',
        segments: ['endpoints', 'custom', '0', 'models'],
        code: 'invalid_type',
        params: { expected: 'object', received: 'number' },
      },
    ]);
    expect(
      getConfigOverrideIssues(
        { endpoints: { custom: [{ name: 'ollama', modelDisplayLabel: 'Local' }] } },
        yamlBase,
      ),
    ).toEqual([]);
  });

  it('strips an invalid field of a folded override and keeps the YAML value beneath it', () => {
    const merged = mergeConfigOverrides(base, [
      fakeConfig({ endpoints: { custom: [{ name: 'ollama', models: 5, iconURL: 'i.png' }] } }, 10),
    ]);

    expect(customOf(merged)).toEqual([{ ...yamlOllama, iconURL: 'i.png' }]);
  });
});

describe('combineFoldedConfigItems', () => {
  it('returns the same array when no entry is named in two spellings', () => {
    const items = [{ name: 'ollama' }, { name: 'ollama', a: 1 }, { name: 'Other' }, 'loose', {}];

    expect(combineFoldedConfigItems('endpoints.custom', items)).toBe(items);
  });

  it('combines every item of a two-spelling group in order, at the first position', () => {
    const items = [
      { name: 'A' },
      { name: 'Ollama', baseURL: 'one', headers: { x: '1' } },
      { name: 'ollama', headers: { y: '2' } },
      { name: 'B' },
      { name: 'OLLAMA', baseURL: 'three' },
    ];

    expect(combineFoldedConfigItems('endpoints.custom', items)).toEqual([
      { name: 'A' },
      { name: 'OLLAMA', baseURL: 'three', headers: { x: '1', y: '2' } },
      { name: 'B' },
    ]);
  });

  it('leaves arrays whose keys are not folded alone', () => {
    const items = [{ name: 'Ollama' }, { name: 'ollama' }];

    expect(combineFoldedConfigItems('modelSpecs.list', items)).toBe(items);
  });
});

describe('getDottedSectionIssues', () => {
  it('reports only top-level keys holding a dot', () => {
    expect(getDottedSectionIssues({ 'filters.x': 1, registration: { 'a.b': 1 } })).toEqual([
      { path: 'filters.x', segments: ['filters.x'], code: 'dotted_key' },
    ]);
    expect(getDottedSectionIssues(['stray'])).toEqual([]);
  });
});

describe('getConfigMergeRules', () => {
  it('names merge paths by their override (YAML) keys', () => {
    expect(getConfigMergeRules()).toEqual({
      arrayMergeKeys: { 'endpoints.custom': 'name', 'endpoints.azureOpenAI.groups': 'group' },
      atomicMergePaths: ['interface.theme'],
      overrideKeyMap: {
        mcpServers: 'mcpConfig',
        interface: 'interfaceConfig',
        turnstile: 'turnstileConfig',
      },
      derivedPaths: ['endpoints.anthropic.vertexConfig'],
    });
  });
});

describe('getConfigOverrideIssues: items addressed by id', () => {
  it('attributes a refinement that names an array item by its id to that item', () => {
    const environment = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      name: id,
      type: 'managed',
      baseURL: 'https://code.example.com',
      ...extra,
    });
    const issues = getConfigOverrideIssues({
      endpoints: {
        agents: {
          statefulCodeSessions: {
            allowedEnvironments: ['user'],
            environments: [
              environment('worker-a'),
              environment('worker-b', { pairing: { workerId: 'w1', tokenEnv: 'TOKEN' } }),
            ],
          },
        },
      },
    });

    expect(issues).toContainEqual(
      expect.objectContaining({
        path: 'endpoints.agents.statefulCodeSessions.environments.1.pairing',
        code: 'custom',
      }),
    );
  });
});

describe('policy links in overrides', () => {
  const scriptUrl = 'javascript:alert(document.domain)';
  /** Script URLs behind Unicode white space, which a client's `trim()` strips before rendering. */
  const trimmedScriptUrls = ['\u00a0', '\ufeff', '\u2028', '\u3000'].map(
    (space) => `${space}${scriptUrl}`,
  );

  it('rejects a whole-document write whose policy link would run script', () => {
    const issues = getConfigOverrideIssues({
      interface: {
        customWelcome: 'Hi',
        privacyPolicy: { externalUrl: scriptUrl, openNewTab: true },
        termsOfService: { externalUrl: 'data:text/html,<script>alert(1)</script>' },
      },
    });

    expect(issues.map(({ path, code }) => ({ path, code }))).toEqual([
      { path: 'interface.privacyPolicy.externalUrl', code: 'custom' },
      { path: 'interface.termsOfService.externalUrl', code: 'custom' },
    ]);
  });

  it.each(trimmedScriptUrls)('rejects %j in a document write and a field write', (url) => {
    expect(
      getConfigOverrideIssues({ interface: { privacyPolicy: { externalUrl: url } } }).map(
        ({ path, code }) => ({ path, code }),
      ),
    ).toEqual([{ path: 'interface.privacyPolicy.externalUrl', code: 'custom' }]);
    expect(
      getConfigFieldIssues({ 'interface.termsOfService.externalUrl': url }).map(({ path }) => path),
    ).toEqual(['interface.termsOfService.externalUrl']);
  });

  it('accepts http(s), mailto:, relative and blank policy links', () => {
    expect(
      getConfigOverrideIssues({
        interface: {
          privacyPolicy: { externalUrl: 'mailto:privacy@example.com' },
          termsOfService: { externalUrl: 'https://example.com/terms' },
        },
      }),
    ).toEqual([]);
    expect(
      getConfigOverrideIssues({
        interface: {
          privacyPolicy: { externalUrl: 'https://example.com/privacy' },
          termsOfService: { externalUrl: '/terms', modalAcceptance: true },
        },
      }),
    ).toEqual([]);
    expect(getConfigOverrideIssues({ interface: { privacyPolicy: { externalUrl: '' } } })).toEqual(
      [],
    );
  });

  it('rejects a field write of a script URL, as a value or inside its object', () => {
    expect(
      getConfigFieldIssues({ 'interface.privacyPolicy.externalUrl': scriptUrl }).map(
        ({ path }) => path,
      ),
    ).toEqual(['interface.privacyPolicy.externalUrl']);
    expect(
      getConfigFieldIssues({ 'interface.termsOfService': { externalUrl: scriptUrl } }).map(
        ({ path }) => path,
      ),
    ).toEqual(['interface.termsOfService.externalUrl']);
  });

  it.each([scriptUrl, ...trimmedScriptUrls])(
    'drops %j stored before validation, keeping the rest of the document',
    (storedUrl) => {
      const base = {
        interfaceConfig: { privacyPolicy: { externalUrl: 'https://yaml.example/privacy' } },
      } as unknown as AppConfig;

      const merged = mergeConfigOverrides(base, [
        fakeConfig(
          {
            interface: {
              customWelcome: 'Hi',
              privacyPolicy: { externalUrl: storedUrl, openNewTab: true },
            },
          },
          0,
          undefined,
          BASE_CONFIG_PRINCIPAL_ID,
        ),
      ]);

      expect(merged.interfaceConfig).toEqual({
        customWelcome: 'Hi',
        privacyPolicy: { externalUrl: 'https://yaml.example/privacy', openNewTab: true },
      });
    },
  );
});

describe('applyConfigTombstones', () => {
  it('removes tombstoned base paths except the ones a write clears', () => {
    const base = {
      cloudfront: { domain: 'https://cdn.example.com', imageSigning: 'cookies' },
    } as Partial<TCustomConfig>;
    const tombstones = ['cloudfront.imageSigning'];
    expect(applyConfigTombstones(base, tombstones)).toEqual({
      cloudfront: { domain: 'https://cdn.example.com' },
    });
    expect(applyConfigTombstones(base, tombstones, new Set(tombstones))).toEqual(base);
    expect(
      getConfigOverrideIssues(
        { cloudfront: { requireSignedAccess: true } },
        applyConfigTombstones(base, tombstones),
      ).map((issue) => issue.path),
    ).toEqual(['cloudfront.requireSignedAccess']);
  });
});

describe('getConfigFieldIssues', () => {
  it('checks each written path the way the stored override would hold it', () => {
    expect(getConfigFieldIssues({ 'registration.oauthStateTtlMs': 120_000 })).toEqual([]);
    expect(
      getConfigFieldIssues({ 'registration.oauthStateTtlMs': 5 }).map((issue) => issue.path),
    ).toEqual(['registration.oauthStateTtlMs']);
  });

  it('checks segment writes, which address keys that contain dots', () => {
    const profile = ['endpoints', 'bedrock', 'inferenceProfiles', 'us.anthropic.claude-sonnet-4-5'];
    const stored = {
      overrides: { endpoints: { bedrock: { inferenceProfiles: { 'eu.x': 'a' } } } },
    };

    expect(getConfigFieldIssues([{ segments: profile, value: 'arn:aws:x' }], {}, stored)).toEqual(
      [],
    );
    expect(getConfigFieldIssues([{ segments: profile, value: 5 }], {}, stored)).toEqual([
      expect.objectContaining({ segments: profile }),
    ]);
  });

  it('applies a record refinement to a single written key', () => {
    const base = {
      endpoints: {
        azureOpenAI: {
          groups: [
            {
              group: 'g',
              apiKey: 'k',
              instanceName: 'i',
              version: '2024-02-01',
              models: { 'gpt-4o': { deploymentName: 'gpt-4o' } },
            },
          ],
        },
      },
    } as Partial<TCustomConfig>;
    expect(
      getConfigFieldIssues(
        { 'endpoints.azureOpenAI.groups': base.endpoints?.azureOpenAI?.groups },
        base,
      ),
    ).toEqual([]);
    expect(
      getConfigFieldIssues(
        {
          'endpoints.azureOpenAI.groups': [
            { ...base.endpoints?.azureOpenAI?.groups?.[0], addParams: { web_search: 'yes' } },
          ],
        },
        base,
      ).map((issue) => issue.path),
    ).toEqual(['endpoints.azureOpenAI.groups.0.addParams.web_search']);
  });

  it('judges a write together with the fields the principal already overrides', () => {
    const cloudfront = {
      domain: 'https://cdn.example.com',
      imageSigning: 'cookies',
      cookieDomain: '.example.com',
    };
    expect(
      getConfigFieldIssues(
        { 'cloudfront.requireSignedAccess': true },
        {},
        {
          overrides: { cloudfront },
        },
      ),
    ).toEqual([]);
    expect(
      getConfigFieldIssues(
        { 'cloudfront.requireSignedAccess': true },
        {},
        {
          overrides: { cloudfront: { ...cloudfront, imageSigning: 'none' } },
        },
      ).map((issue) => issue.path),
    ).toEqual(['cloudfront.requireSignedAccess']);
    expect(
      getConfigFieldIssues(
        { 'interface.customWelcome': 'hi' },
        {},
        {
          overrides: { interface: { contextCost: 'yes' } },
        },
      ),
    ).toEqual([]);
  });

  it('reports a stored related field the write makes invalid', () => {
    expect(
      getConfigFieldIssues(
        { 'cloudfront.imageSigning': 'none' },
        {},
        {
          overrides: {
            cloudfront: {
              domain: 'https://cdn.example.com',
              imageSigning: 'cookies',
              cookieDomain: '.example.com',
              requireSignedAccess: true,
            },
          },
        },
      ).map((issue) => issue.path),
    ).toEqual(['cloudfront.requireSignedAccess']);
  });

  it('validates on a base with the remaining tombstones of the principal applied', () => {
    const base = {
      cloudfront: {
        domain: 'https://cdn.example.com',
        imageSigning: 'cookies',
        cookieDomain: '.example.com',
      },
    } as Partial<TCustomConfig>;
    expect(getConfigFieldIssues({ 'cloudfront.requireSignedAccess': true }, base)).toEqual([]);
    expect(
      getConfigFieldIssues({ 'cloudfront.requireSignedAccess': true }, base, {
        overrides: {},
        tombstones: ['cloudfront.imageSigning'],
      }).map((issue) => issue.path),
    ).toEqual(['cloudfront.requireSignedAccess']);
    expect(
      getConfigFieldIssues({ 'cloudfront.imageSigning': 'cookies' }, base, {
        overrides: { cloudfront: { requireSignedAccess: true } },
        tombstones: ['cloudfront.imageSigning'],
      }),
    ).toEqual([]);
  });

  it('rejects a path past a field that holds a value', () => {
    expect(
      getConfigFieldIssues({ 'interface.contextCost.foo': true }).map((issue) => issue.path),
    ).toEqual(['interface.contextCost']);
    expect(getConfigFieldIssues({ 'registration.unknownField.foo': 1 })).toEqual([]);
  });

  it('refuses an index past the end of a stored array before building anything', () => {
    const stored = { overrides: { endpoints: { agents: { capabilities: ['tools'] } } } };
    const started = performance.now();

    expect(() =>
      getConfigFieldIssues({ 'endpoints.agents.capabilities.10000000': 'tools' }, {}, stored),
    ).toThrow(expect.objectContaining({ code: 'CONFIG_PATH_INVALID', reason: 'array_index' }));
    expect(() =>
      getConfigFieldIssues(
        [{ segments: ['endpoints', 'agents', 'capabilities', '1'.repeat(400)], value: 'x' }],
        {},
        stored,
      ),
    ).toThrow(expect.objectContaining({ reason: 'array_index' }));
    expect(performance.now() - started).toBeLessThan(1000);
    expect(
      getConfigFieldIssues({ 'endpoints.agents.capabilities.1': 'actions' }, {}, stored),
    ).toEqual([]);
  });

  it('rejects an indexed write into a merged-by-name array', () => {
    expect(
      getConfigFieldIssues({ 'endpoints.custom.0.models': { default: ['m'] } }).map(
        (issue) => issue.path,
      ),
    ).toEqual(['endpoints.custom']);
  });

  it('rejects an indexed write into a stored merged-by-name array', () => {
    const base = {
      endpoints: {
        custom: [{ name: 'a', apiKey: 'k', baseURL: 'https://a', models: { default: ['m'] } }],
      },
    } as unknown as Partial<TCustomConfig>;
    const stored = { overrides: { endpoints: { custom: [{ name: 'a', baseURL: 'https://o' }] } } };

    expect(getConfigFieldIssues({ 'endpoints.custom.0.name': 'b' }, base, stored)).toEqual([
      {
        path: 'endpoints.custom',
        segments: ['endpoints', 'custom'],
        code: 'indexed_merge_key_write',
      },
    ]);
    expect(
      getConfigFieldIssues(
        { 'endpoints.custom': [{ name: 'a', baseURL: 'https://p' }] },
        base,
        stored,
      ),
    ).toEqual([]);
  });
});

describe('mergeConfigOverrides: afterLayer', () => {
  const base = {
    config: { ocr: { baseURL: 'https://yaml.example' } },
    ocr: { baseURL: 'https://yaml.example', mistralModel: 'base' },
    mcpConfig: { tools: { url: 'https://tools.example/mcp' } },
  } as unknown as AppConfig;

  it('sees each layer in precedence order: what it inherited, contributed and produced', () => {
    const steps: Array<{ principalId: string; below: unknown; applied: unknown; merged: unknown }> =
      [];
    mergeConfigOverrides(
      base,
      [
        fakeConfig({ ocr: { mistralModel: 'role' } }, 20, undefined, 'role'),
        fakeConfig({ mcpServers: { tools: { title: 'Tools' } } }, 0, undefined, 'base'),
      ],
      {
        afterLayer: ({ layer, below, applied, merged }) => {
          steps.push({
            principalId: layer.principalId.toString(),
            below: below.ocr,
            applied,
            merged: merged.ocr,
          });
          return merged;
        },
      },
    );

    expect(steps).toEqual([
      {
        principalId: 'base',
        below: base.ocr,
        /** Under the AppConfig section name the merge applies it to. */
        applied: { mcpConfig: { tools: { title: 'Tools' } } },
        merged: base.ocr,
      },
      {
        principalId: 'role',
        below: base.ocr,
        applied: { ocr: { mistralModel: 'role' } },
        merged: { baseURL: 'https://yaml.example', mistralModel: 'role' },
      },
    ]);
  });

  it('merges the next layer onto the config the hook returns', () => {
    const merged = mergeConfigOverrides(
      base,
      [
        fakeConfig({ ocr: { mistralModel: 'low' } }, 10, undefined, 'low'),
        fakeConfig({ ocr: { strategy: 'mistral_ocr' } }, 20, undefined, 'high'),
      ],
      {
        afterLayer: ({ layer, merged: next }) =>
          layer.principalId.toString() === 'low'
            ? ({ ...next, ocr: { ...next.ocr, baseURL: '' } } as AppConfig)
            : next,
      },
    );

    expect(merged.ocr).toEqual({ baseURL: '', mistralModel: 'low', strategy: 'mistral_ocr' });
  });

  it('shows each layer alone over the base config, after its own tombstones only', () => {
    const alone: Record<string, unknown> = {};
    let calls = 0;
    mergeConfigOverrides(
      base,
      [
        fakeConfig({ ocr: { mistralModel: 'low' } }, 10, ['ocr.mistralModel'], 'low'),
        fakeConfig(
          { ocr: { apiKey: 'own' }, mcpServers: { tools: { title: 'Tools' } } },
          20,
          ['ocr.baseURL'],
          'high',
        ),
      ],
      {
        afterLayer: (step) => {
          if (step.layer.principalId.toString() === 'high') {
            calls++;
            const first = step.alone();
            expect(step.alone()).toBe(first);
            alone.ocr = first.ocr;
            alone.mcpConfig = first.mcpConfig;
          }
          return step.merged;
        },
      },
    );

    expect(calls).toBe(1);
    /** Not the lower layer's model, and without the base URL this layer tombstones. */
    expect(alone.ocr).toEqual({ mistralModel: 'base', apiKey: 'own' });
    expect(alone.mcpConfig).toEqual({
      tools: { url: 'https://tools.example/mcp', title: 'Tools' },
    });
    expect(base.ocr).toEqual({ baseURL: 'https://yaml.example', mistralModel: 'base' });
  });

  it('shows every layer the base config the merge started from', () => {
    const bases: unknown[] = [];
    mergeConfigOverrides(
      base,
      [
        fakeConfig({ ocr: { mistralModel: 'low' } }, 10, undefined, 'low'),
        fakeConfig({ ocr: { mistralModel: 'high' } }, 20, undefined, 'high'),
      ],
      {
        afterLayer: (step) => {
          bases.push(step.base);
          return step.merged;
        },
      },
    );

    expect(bases).toEqual([base, base]);
    expect(bases[1]).toBe(base);
  });

  it('runs for a layer that only tombstones, with nothing applied', () => {
    const applied: unknown[] = [];
    const merged = mergeConfigOverrides(base, [fakeConfig({}, 10, ['ocr.baseURL'])], {
      afterLayer: (step) => {
        applied.push(step.applied);
        return step.merged;
      },
    });

    expect(applied).toEqual([{}]);
    expect(merged.ocr).toEqual({ mistralModel: 'base' });
  });
});

/** The merge as `CONFIG_REDERIVE_ENDPOINTS` runs it: a layer's Azure groups resolved. */
function mergeWithGroups(
  ...[baseConfig, configs, options]: Parameters<typeof mergeConfigOverrides>
) {
  return mergeConfigOverrides(baseConfig, configs, { rederiveEndpoints: true, ...options });
}

describe('mergeConfigOverrides: Azure groups an override writes', () => {
  const yamlGroup = {
    group: 'east',
    apiKey: '${AZURE_EAST_KEY}',
    instanceName: 'east',
    version: '2024-10-21',
    deploymentName: 'gpt-4o',
    models: { 'gpt-4o': true },
  };
  const base = {
    config: { endpoints: { azureOpenAI: { groups: [yamlGroup] } } },
    endpoints: {
      azureOpenAI: {
        titleModel: 'gpt-4o',
        groupMap: { east: { ...yamlGroup } },
        modelGroupMap: { 'gpt-4o': { group: 'east' } },
        modelNames: ['gpt-4o'],
        assistantModels: [],
        assistantGroups: [],
      },
    },
  } as unknown as AppConfig;
  const west = {
    group: 'west',
    apiKey: 'v3:stored-west-key',
    instanceName: 'west',
    version: '2024-10-21',
    deploymentName: 'gpt-5',
    assistants: true,
    models: { 'gpt-5': true, 'o3-mini': { deploymentName: 'o3' } },
  };

  it('merges them by group over the groups below and resolves them into the fields the Azure clients read', () => {
    const merged = mergeWithGroups(base, [
      fakeConfig({ endpoints: { azureOpenAI: { groups: [west] } } }, 10),
    ]);

    const azure = merged.endpoints?.azureOpenAI;
    expect(azure?.groupMap).toEqual({
      east: base.endpoints?.azureOpenAI?.groupMap?.east,
      west: expect.objectContaining({ apiKey: 'v3:stored-west-key', instanceName: 'west' }),
    });
    expect(azure?.groupMap?.east).toBe(base.endpoints?.azureOpenAI?.groupMap?.east);
    expect(azure?.modelGroupMap).toEqual({
      'gpt-4o': { group: 'east' },
      'gpt-5': { group: 'west' },
      'o3-mini': { group: 'west' },
    });
    expect(azure?.modelNames).toEqual(['gpt-4o', 'gpt-5', 'o3-mini']);
    expect(azure?.assistantModels).toEqual(['gpt-5', 'o3-mini']);
    expect(azure?.assistantGroups).toEqual(['west']);
    expect(azure?.titleModel).toBe('gpt-4o');
    expect(base.endpoints?.azureOpenAI?.modelNames).toEqual(['gpt-4o']);
  });

  it("merges a groupMap the same layer writes over its own groups', and a later layer's over them", () => {
    const merged = mergeWithGroups(base, [
      fakeConfig(
        { endpoints: { azureOpenAI: { groups: [west], groupMap: { west: { version: 'v2' } } } } },
        10,
      ),
      fakeConfig({ endpoints: { azureOpenAI: { groupMap: { west: { baseURL: 'b' } } } } }, 20),
    ]);

    expect(merged.endpoints?.azureOpenAI?.groupMap?.west).toMatchObject({
      apiKey: 'v3:stored-west-key',
      version: 'v2',
      baseURL: 'b',
    });
  });

  it("shows the layer alone with its groups merged over librechat.yaml's", () => {
    let aloneGroups: unknown;
    mergeWithGroups(base, [fakeConfig({ endpoints: { azureOpenAI: { groups: [west] } } }, 10)], {
      afterLayer: (step) => {
        aloneGroups = Object.keys(step.alone().endpoints?.azureOpenAI?.groupMap ?? {});
        return step.merged;
      },
    });

    expect(aloneGroups).toEqual(['east', 'west']);
  });

  it('leaves them and a tombstone of them inert without CONFIG_REDERIVE_ENDPOINTS', () => {
    const layers = [
      fakeConfig({ endpoints: { azureOpenAI: { groups: [west] } } }, 10),
      fakeConfig({}, 20, ['endpoints.azureOpenAI.groups'], 't20'),
    ];
    const written = mergeConfigOverrides(base, [layers[0]]);
    const tombstoned = mergeConfigOverrides(base, [layers[1]]);
    /** The served Azure endpoint without the stray `groups` the clients never read. */
    const resolved = (merged: AppConfig): Record<string, unknown> => {
      const { groups: _groups, ...azure } = (merged.endpoints?.azureOpenAI ?? {}) as Record<
        string,
        unknown
      >;
      return azure;
    };

    expect(resolved(written)).toEqual(base.endpoints?.azureOpenAI);
    expect(resolved(tombstoned)).toEqual(base.endpoints?.azureOpenAI);
    expect(resolved(mergeConfigOverrides(base, layers))).toEqual(base.endpoints?.azureOpenAI);
    expect(resolved(mergeWithGroups(base, [layers[0]])).modelNames).toEqual([
      'gpt-4o',
      'gpt-5',
      'o3-mini',
    ]);
  });

  describe('a tombstone of the groups', () => {
    const tombstone = (priority = 10) =>
      fakeConfig({}, priority, ['endpoints.azureOpenAI.groups'], `t${priority}`);

    it('resolves the groups to none, so no Azure model or group is served', () => {
      const merged = mergeWithGroups(base, [tombstone()]);

      expect(merged.endpoints?.azureOpenAI).toEqual({
        titleModel: 'gpt-4o',
        groupMap: {},
        modelGroupMap: {},
        modelNames: [],
        assistantModels: [],
        assistantGroups: [],
      });
      expect(base.endpoints?.azureOpenAI?.groupMap).toHaveProperty('east');
    });

    it('creates no Azure endpoint where none is configured', () => {
      const merged = mergeWithGroups({ config: {}, endpoints: {} } as AppConfig, [tombstone()]);

      expect(merged.endpoints).toEqual({});
    });

    it("lets the same layer's groups, or a later layer's, resolve in their place", () => {
      const same = mergeWithGroups(base, [
        fakeConfig({ endpoints: { azureOpenAI: { groups: [west] } } }, 10, [
          'endpoints.azureOpenAI.groups',
        ]),
      ]);
      const later = mergeWithGroups(base, [
        tombstone(10),
        fakeConfig({ endpoints: { azureOpenAI: { groups: [west] } } }, 20),
      ]);

      for (const merged of [same, later]) {
        expect(Object.keys(merged.endpoints?.azureOpenAI?.groupMap ?? {})).toEqual(['west']);
        expect(merged.endpoints?.azureOpenAI?.modelNames).toEqual(['gpt-5', 'o3-mini']);
      }
    });

    it('shows the layer alone without the groups, and removes them from the YAML floor', () => {
      let alone: unknown;
      mergeWithGroups(base, [tombstone()], {
        afterLayer: (step) => {
          alone = step.alone().endpoints?.azureOpenAI;
          return step.merged;
        },
      });

      expect(alone).toEqual({ titleModel: 'gpt-4o' });
      expect(
        applyConfigTombstones(
          {
            endpoints: { azureOpenAI: { groups: [yamlGroup], groupMap: { east: yamlGroup } } },
          } as Partial<TCustomConfig>,
          ['endpoints.azureOpenAI.groups'],
        ),
      ).toEqual({ endpoints: { azureOpenAI: {} } });
    });
  });

  it('leaves groups that do not resolve unread, with a warning', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const merged = mergeWithGroups(base, [
      fakeConfig({ endpoints: { azureOpenAI: { groups: [west, { ...west, group: 'w2' }] } } }, 10),
    ]);

    expect(merged.endpoints?.azureOpenAI?.groupMap).toEqual(base.endpoints?.azureOpenAI?.groupMap);
    expect(merged.endpoints?.azureOpenAI?.modelNames).toEqual(['gpt-4o']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('endpoints.azureOpenAI.groups'));
    warn.mockRestore();
  });

  describe('with Azure assistants on', () => {
    /** As AppService resolves librechat.yaml's `assistants: true` over a group that serves them. */
    const assistantsBase = {
      ...base,
      config: { endpoints: { azureOpenAI: { groups: [{ ...yamlGroup, assistants: true }] } } },
      endpoints: {
        azureOpenAI: {
          ...base.endpoints?.azureOpenAI,
          groupMap: { east: { ...yamlGroup, assistants: true } },
          assistants: true,
          assistantModels: ['gpt-4o'],
          assistantGroups: ['east'],
        },
      },
    } as unknown as AppConfig;
    const plain = {
      group: 'plain',
      apiKey: 'v3:stored-plain-key',
      instanceName: 'plain',
      version: '2024-10-21',
      deploymentName: 'gpt-5-mini',
      models: { 'gpt-5-mini': true },
    };

    it('turns them off for groups none of whose models supports them, with a warning', () => {
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
      const merged = mergeWithGroups(assistantsBase, [
        fakeConfig({ endpoints: { azureOpenAI: { groups: [plain] } } }, 10, [
          'endpoints.azureOpenAI.groups',
        ]),
      ]);

      const azure = merged.endpoints?.azureOpenAI;
      expect(azure?.modelNames).toEqual(['gpt-5-mini']);
      expect(azure?.assistantModels).toEqual([]);
      expect(azure?.assistants).toBe(false);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Turning off endpoints.azureOpenAI.assistants for role/'),
      );
      expect(assistantsBase.endpoints?.azureOpenAI?.assistants).toBe(true);
      warn.mockRestore();
    });

    it("keeps them on when the groups serve them, or a later layer's groups serve them again", () => {
      const own = mergeWithGroups(assistantsBase, [
        fakeConfig({ endpoints: { azureOpenAI: { groups: [west] } } }, 10),
      ]);
      const later = mergeWithGroups(assistantsBase, [
        fakeConfig({ endpoints: { azureOpenAI: { groups: [plain] } } }, 10, [
          'endpoints.azureOpenAI.groups',
        ]),
        fakeConfig({ endpoints: { azureOpenAI: { groups: [west] } } }, 20),
      ]);

      expect(own.endpoints?.azureOpenAI?.assistants).toBe(true);
      expect(own.endpoints?.azureOpenAI?.assistantModels).toEqual(['gpt-4o', 'gpt-5', 'o3-mini']);
      expect(later.endpoints?.azureOpenAI?.assistants).toBe(true);
      expect(later.endpoints?.azureOpenAI?.assistantModels).toEqual(['gpt-5', 'o3-mini']);
    });

    it('turns off a layer that turns them on over models none of which supports them', () => {
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
      const merged = mergeWithGroups(base, [
        fakeConfig({ endpoints: { azureOpenAI: { assistants: true } } }, 10),
      ]);

      expect(merged.endpoints?.azureOpenAI?.assistants).toBe(false);
      expect(merged.endpoints?.azureOpenAI?.modelNames).toEqual(['gpt-4o']);
      warn.mockRestore();
    });

    it('turns them off when the groups are tombstoned', () => {
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
      const merged = mergeWithGroups(assistantsBase, [
        fakeConfig({}, 10, ['endpoints.azureOpenAI.groups']),
      ]);

      expect(merged.endpoints?.azureOpenAI?.assistants).toBe(false);
      expect(merged.endpoints?.azureOpenAI?.assistantModels).toEqual([]);
      warn.mockRestore();
    });

    it('keeps only the assistant models an override names that a merged group serves them with', () => {
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
      const missing = mergeWithGroups(assistantsBase, [
        fakeConfig({ endpoints: { azureOpenAI: { assistantModels: ['missing'] } } }, 10),
      ]);
      const mixed = mergeWithGroups(assistantsBase, [
        fakeConfig(
          {
            endpoints: {
              azureOpenAI: {
                assistantModels: ['missing', 'gpt-4o'],
                assistantGroups: ['nowhere', 'east'],
              },
            },
          },
          10,
        ),
      ]);

      expect(missing.endpoints?.azureOpenAI).toMatchObject({
        assistants: false,
        assistantModels: [],
        assistantGroups: [],
      });
      expect(mixed.endpoints?.azureOpenAI).toMatchObject({
        assistants: true,
        assistantModels: ['gpt-4o'],
        assistantGroups: ['east'],
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'Leaving out of endpoints.azureOpenAI.assistantModels, endpoints.azureOpenAI.assistantGroups for role/',
        ),
      );
      warn.mockRestore();
    });
  });

  it('lists only the models a merged group serves, whatever an override writes to the lists', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const listed = mergeWithGroups(base, [
      fakeConfig({ endpoints: { azureOpenAI: { modelNames: ['missing', 'gpt-4o'] } } }, 10),
    ]);
    const unmapped = mergeWithGroups(base, [
      fakeConfig(
        { endpoints: { azureOpenAI: { modelGroupMap: { 'gpt-4o': { group: 'nowhere' } } } } },
        10,
      ),
    ]);
    const untouched = mergeWithGroups(base, [
      fakeConfig({ interface: { customWelcome: 'hi' } }, 10),
    ]);

    expect(listed.endpoints?.azureOpenAI?.modelNames).toEqual(['gpt-4o']);
    expect(unmapped.endpoints?.azureOpenAI?.modelNames).toEqual([]);
    expect(untouched.endpoints?.azureOpenAI).toEqual(base.endpoints?.azureOpenAI);
    warn.mockRestore();
  });
});

describe('merge precedence', () => {
  function layer(
    principalType: 'role' | 'group' | 'user',
    principalId: string,
    priority: number,
    overrides: Record<string, unknown>,
    _id: string,
    tombstones?: string[],
  ): IConfig {
    return {
      ...fakeConfig(overrides, priority, tombstones, principalId),
      principalType,
      _id,
    } as unknown as IConfig;
  }

  const welcome = (configs: IConfig[]): unknown =>
    (mergeConfigOverrides(baseConfig, configs).interfaceConfig as { customWelcome?: unknown })
      ?.customWelcome;

  it('lets a profile outrank Base even when Base has the higher priority', () => {
    const base = layer(
      'role',
      BASE_CONFIG_PRINCIPAL_ID,
      50,
      { interface: { customWelcome: 'base' } },
      '0a',
    );
    const role = layer('role', 'editor', 5, { interface: { customWelcome: 'role' } }, '0b');

    expect(welcome([base, role])).toBe('role');
    expect(welcome([role, base])).toBe('role');
  });

  it('merges tied group profiles the same way whatever order the store returned them in', () => {
    const groups = ['0c', '0a', '0e', '0b', '0d'].map((id) =>
      layer('group', `g-${id}`, 20, { interface: { customWelcome: id } }, id),
    );
    const results = new Set<unknown>();
    for (let round = 0; round < 20; round++) {
      const order = [...groups].sort(() => Math.random() - 0.5);
      results.add(welcome(order));
    }

    expect([...results]).toEqual(['0e']);
  });

  it('lets a user profile beat a group profile, and a group beat a role, at equal priority', () => {
    const role = layer('role', 'editor', 20, { interface: { customWelcome: 'role' } }, '0c');
    const group = layer('group', 'g1', 20, { interface: { customWelcome: 'group' } }, '0b');
    const user = layer('user', 'u1', 20, { interface: { customWelcome: 'user' } }, '0a');

    expect(welcome([user, group, role])).toBe('user');
    expect(welcome([group, role])).toBe('group');
  });

  it('lets a profile that writes fields of a librechat.yaml MCP server undo a Base hide of it, whatever Base priority', () => {
    const github = { type: 'streamable-http', url: 'https://github.example.com/mcp' };
    const appConfig = {
      ...baseConfig,
      mcpConfig: { github },
      config: { mcpServers: { github } },
    } as unknown as AppConfig;
    const base = layer('role', BASE_CONFIG_PRINCIPAL_ID, 50, {}, '0a', ['mcpServers.github']);
    const role = layer('role', 'editor', 5, { mcpServers: { github: { title: 'GitHub' } } }, '0b');

    expect(mergeConfigOverrides(appConfig, [base]).mcpConfig).toEqual({});
    expect(mergeConfigOverrides(appConfig, [base, role]).mcpConfig).toEqual({
      github: { title: 'GitHub' },
    });
  });
});

describe('resolveRawConfig', () => {
  const yaml = {
    memory: { agent: { id: 'agent_1' } },
    mcpServers: {
      operator: { type: 'stdio', command: 'node', args: ['trusted-server.js'] },
    },
  } as unknown as Partial<TCustomConfig>;

  /** Base's half of the memory switch: drop the YAML agent id, pick a provider and model. */
  const memorySwitch = fakeConfig(
    { memory: { agent: { provider: 'openAI', model: 'gpt-4o' } } },
    0,
    ['memory.agent.id'],
    BASE_CONFIG_PRINCIPAL_ID,
  );

  it('returns the YAML config untouched when there are no layers', () => {
    expect(resolveRawConfig(yaml, [])).toBe(yaml);
  });

  it('resolves Base tombstones and overrides over the YAML config', () => {
    expect(resolveRawConfig(yaml, [memorySwitch]).memory).toEqual({
      agent: { provider: 'openAI', model: 'gpt-4o' },
    });
  });

  it('is the floor a profile write validates on: valid there, invalid on the YAML alone', () => {
    const write = { 'memory.agent.model': 'gpt-4.1' };

    expect(getConfigFieldIssues(write, yaml).map((issue) => issue.code)).toContain(
      'union_dropped_key',
    );
    expect(getConfigFieldIssues(write, resolveRawConfig(yaml, [memorySwitch]))).toEqual([]);
  });

  it('agrees with the merge: what validates on the floor is kept, what fails there is dropped', () => {
    const appConfig = {
      ...baseConfig,
      memory: yaml.memory,
      config: yaml,
    } as unknown as AppConfig;
    const valid = fakeConfig({ memory: { agent: { model: 'gpt-4.1' } } }, 10, undefined, 'editor');
    const floor = resolveRawConfig(yaml, [memorySwitch]);

    expect(getConfigOverrideIssues(valid.overrides, floor)).toEqual([]);
    expect(
      (mergeConfigOverrides(appConfig, [memorySwitch, valid]) as unknown as { memory: unknown })
        .memory,
    ).toEqual({ agent: { provider: 'openAI', model: 'gpt-4.1' } });
  });

  it('reports a write that only fails on top of Base, which the merge would drop', () => {
    /** The reverse switch: YAML picks a provider and model, Base switches to an agent id. */
    const providerYaml = {
      memory: { agent: { provider: 'openAI', model: 'gpt-4o' } },
    } as unknown as Partial<TCustomConfig>;
    const agentIdSwitch = fakeConfig(
      { memory: { agent: { id: 'agent_9' } } },
      0,
      ['memory.agent.provider', 'memory.agent.model'],
      BASE_CONFIG_PRINCIPAL_ID,
    );
    const appConfig = {
      ...baseConfig,
      memory: providerYaml.memory,
      config: providerYaml,
    } as unknown as AppConfig;
    const write = { 'memory.agent.model': 'gpt-4.1' };
    const floor = resolveRawConfig(providerYaml, [agentIdSwitch]);

    expect(getConfigFieldIssues(write, providerYaml)).toEqual([]);
    expect(getConfigFieldIssues(write, floor)).toEqual([
      {
        path: 'memory.agent.model',
        segments: ['memory', 'agent', 'model'],
        code: 'union_dropped_key',
      },
    ]);
    const profile = fakeConfig({ memory: { agent: { model: 'gpt-4.1' } } }, 10, undefined, 'x');
    expect(
      (mergeConfigOverrides(appConfig, [agentIdSwitch, profile]) as unknown as { memory: unknown })
        .memory,
    ).toEqual({ agent: { id: 'agent_9' } });
    expect(resolveRawConfig(providerYaml, [agentIdSwitch, profile]).memory).toEqual(floor.memory);
  });

  it('strips a Base override that is invalid on the YAML config, as the merge does', () => {
    const invalidBase = fakeConfig(
      { memory: { agent: { id: 5 } }, interface: { customWelcome: 'hi' } },
      0,
      undefined,
      BASE_CONFIG_PRINCIPAL_ID,
    );

    const raw = resolveRawConfig(yaml, [invalidBase]);
    expect(raw.memory).toEqual(yaml.memory);
    expect(raw.interface).toEqual({ customWelcome: 'hi' });
  });

  it('never lets an override reach a process-backed MCP server', () => {
    const base = fakeConfig(
      {
        mcpServers: {
          operator: { command: '/bin/sh' },
          remote: { type: 'streamable-http', url: 'https://mcp.example.com' },
        },
      },
      0,
      undefined,
      BASE_CONFIG_PRINCIPAL_ID,
    );

    const raw = resolveRawConfig(yaml, [base]);
    expect(raw.mcpServers).toEqual({
      operator: { type: 'stdio', command: 'node', args: ['trusted-server.js'] },
      remote: { type: 'streamable-http', url: 'https://mcp.example.com' },
    });
  });

  it('orders layers by merge precedence, so Base lands first', () => {
    const role = fakeConfig({ interface: { customWelcome: 'role' } }, 1, undefined, 'editor');
    const base = fakeConfig(
      { interface: { customWelcome: 'base' } },
      99,
      undefined,
      BASE_CONFIG_PRINCIPAL_ID,
    );

    expect(resolveRawConfig({}, [role, base]).interface).toEqual({ customWelcome: 'role' });
  });
});

describe('top-level sections an override may hold', () => {
  /** Runtime state AppService builds that `configSchema` does not define, so no override may set it. */
  const RUNTIME_KEYS = [
    'paths',
    'config',
    'availableTools',
    'interfaceConfig',
    'turnstileConfig',
    'mcpConfig',
  ];

  const base = {
    paths: { uploads: '/srv/uploads', imageOutput: '/srv/images' },
    config: { permissions: { leaseTtlMs: 60_000 }, rateLimits: { fileUploads: { ipMax: 100 } } },
    availableTools: { calculator: { type: 'function' } },
    interfaceConfig: { modelSelect: true, prompts: true },
    turnstileConfig: { siteKey: 'site' },
    mcpConfig: { github: { type: 'streamable-http', url: 'https://github.example.com' } },
    registration: { enabled: true },
  } as unknown as AppConfig;

  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(logger, 'warn').mockReturnValue(logger);
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it('accepts exactly the sections configSchema defines', () => {
    for (const section of ['interface', 'mcpServers', 'turnstile', 'endpoints', 'filters']) {
      expect(isAcceptedOverrideSection(section)).toBe(true);
    }
    for (const key of [...RUNTIME_KEYS, '', 'toString', 'constructor', '__proto__']) {
      expect(isAcceptedOverrideSection(key)).toBe(false);
    }
  });

  it('reports every top-level key outside configSchema as unknown_section', () => {
    const overrides = Object.fromEntries([
      ...RUNTIME_KEYS.map((key) => [key, { uploads: '/tmp' }]),
      ['registration', { enabled: false }],
    ]);

    expect(getConfigOverrideIssues(overrides)).toEqual(
      RUNTIME_KEYS.map((key) => ({ path: key, segments: [key], code: 'unknown_section' })),
    );
  });

  it('reports a dotted top-level key once, as dotted_key rather than unknown_section', () => {
    expect(getConfigOverrideIssues({ 'paths.uploads': '/tmp', config: {} })).toEqual([
      { path: 'paths.uploads', segments: ['paths.uploads'], code: 'dotted_key' },
      { path: 'config', segments: ['config'], code: 'unknown_section' },
    ]);
  });

  it('still validates the known sections written next to an unknown one', () => {
    expect(
      getConfigOverrideIssues({
        paths: { uploads: '/tmp' },
        registration: { oauthStateTtlMs: 5 },
      }).map(({ path, code }) => ({ path, code })),
    ).toEqual([
      { path: 'paths', code: 'unknown_section' },
      { path: 'registration.oauthStateTtlMs', code: 'too_small' },
    ]);
  });

  it('reports a field write under an unknown section', () => {
    expect(
      getConfigFieldIssues({ 'interfaceConfig.prompts': false }).map(({ path, code }) => ({
        path,
        code,
      })),
    ).toEqual([{ path: 'interfaceConfig', code: 'unknown_section' }]);
  });

  it('does not let an unknown section stored earlier block an unrelated field write', () => {
    const stored = { overrides: { paths: { uploads: '/tmp' } }, tombstones: ['config'] };

    expect(getConfigFieldIssues({ 'registration.enabled': false }, {}, stored)).toEqual([]);
  });

  it('ignores stored overrides and tombstones outside configSchema at merge', () => {
    const merged = mergeConfigOverrides(base, [
      fakeConfig(
        {
          paths: { uploads: '/tmp/attacker' },
          config: { permissions: { leaseTtlMs: 1 }, rateLimits: {} },
          availableTools: { injected: { type: 'function' } },
          interfaceConfig: { prompts: false, modelSelect: false },
          turnstileConfig: { siteKey: 'attacker' },
          mcpConfig: { injected: { type: 'streamable-http', url: 'https://attacker.example.com' } },
          registration: { enabled: false },
        },
        10,
        ['paths', 'config.permissions', 'interfaceConfig.modelSelect', 'mcpConfig.github'],
      ),
    ]);

    expect(merged).toEqual({ ...base, registration: { enabled: false } });
  });

  it('keeps tombstones and overrides of known sections in the same document', () => {
    const merged = mergeConfigOverrides(base, [
      fakeConfig({ paths: { uploads: '/tmp' }, interface: { modelSelect: false } }, 10, [
        'paths.uploads',
        'mcpServers.github',
      ]),
    ]) as unknown as Record<string, unknown>;

    expect(merged.paths).toEqual(base.paths);
    expect(merged.interfaceConfig).toEqual({ modelSelect: false, prompts: true });
    expect(merged.mcpConfig).toEqual({});
  });

  it('warns once per document, naming the ignored sections but none of their values', () => {
    mergeConfigOverrides(base, [
      fakeConfig({ paths: { uploads: '/tmp/attacker' }, config: { secret: 'leak' } }, 10, [
        'paths.uploads',
        'interfaceConfig.prompts',
      ]),
      fakeConfig({ registration: { enabled: false } }, 20, undefined, 'clean'),
    ]);

    const messages = warn.mock.calls.map(([message]) => String(message));
    expect(messages).toEqual([
      '[mergeConfigOverrides] Ignoring unknown config sections paths, config, interfaceConfig for role/test',
    ]);
  });
});

describe('getConfigFieldIssues: tombstones a write clears', () => {
  const unionBase = {
    memory: { agent: { id: 'agent_yaml' } },
  } as unknown as Partial<TCustomConfig>;

  it('lets a write replace a hidden field with its own value, as sequential clients do', () => {
    const stored = {
      overrides: { memory: { agent: { provider: 'openAI', model: 'gpt-4o' } } },
      tombstones: ['memory.agent.id'],
    };

    expect(getConfigFieldIssues({ 'memory.agent.id': 'agent_other' }, unionBase, stored)).toEqual(
      [],
    );
  });

  it('reports stored fields that conflict with an inherited value a deeper write brings back', () => {
    const stored = {
      overrides: { memory: { agent: { provider: 'openAI', model: 'gpt-4o' } } },
      tombstones: ['memory.agent'],
    };

    expect(
      getConfigFieldIssues({ 'memory.agent.enabled': true }, unionBase, stored).map(
        (issue) => issue.path,
      ),
    ).toEqual(['memory.agent.provider', 'memory.agent.model']);
  });
});

describe('getConfigChangeIssues', () => {
  const base = {
    memory: { agent: { id: 'agent_yaml' } },
  } as unknown as Partial<TCustomConfig>;

  const paths = (issues: Array<{ path: string }>) => issues.map((issue) => issue.path);

  it('judges a batch in its end state: a tombstone plus the fields that replace it pass', () => {
    const changes = [
      { op: 'tombstone' as const, segments: ['memory', 'agent', 'id'] },
      { op: 'set' as const, segments: ['memory', 'agent', 'provider'], value: 'openAI' },
      { op: 'set' as const, segments: ['memory', 'agent', 'model'], value: 'gpt-4o' },
    ];
    const { state } = applyConfigChanges({ overrides: {}, tombstones: [] }, changes);
    const written = changes.map((change) => change.segments);

    expect(getConfigChangeIssues(state, base, null, written)).toEqual([]);

    const setsOnly = applyConfigChanges({ overrides: {}, tombstones: [] }, changes.slice(1));
    expect(paths(getConfigChangeIssues(setsOnly.state, base, null, written.slice(1)))).toEqual([
      'memory.agent.provider',
      'memory.agent.model',
    ]);
  });

  it('judges the stored document on its own tombstones, unless the change lifted them', () => {
    const stored = {
      overrides: { memory: { agent: { provider: 'openAI', model: 'gpt-4o' } } },
      tombstones: ['memory.agent.id'],
    };
    const { state } = applyConfigChanges(
      { overrides: stored.overrides, tombstones: stored.tombstones },
      [{ op: 'set', segments: ['memory', 'agent', 'id'], value: 'agent_other' }],
    );
    const written = [['memory', 'agent', 'id']];

    expect(paths(getConfigChangeIssues(state, base, stored, written))).toEqual([
      'memory.agent.provider',
      'memory.agent.model',
    ]);
    expect(getConfigChangeIssues(state, base, stored, written, ['memory.agent.id'])).toEqual([]);
  });

  it('refuses an unset that brings back an inherited value the stored fields conflict with', () => {
    const stored = {
      overrides: { memory: { agent: { provider: 'openAI', model: 'gpt-4o' } } },
      tombstones: ['memory.agent.id'],
    };
    const { state } = applyConfigChanges(
      { overrides: stored.overrides, tombstones: stored.tombstones },
      [{ op: 'unset', segments: ['memory', 'agent', 'id'] }],
    );

    expect(state.tombstones).toEqual([]);
    expect(paths(getConfigChangeIssues(state, base, stored, [['memory', 'agent', 'id']]))).toEqual([
      'memory.agent.provider',
      'memory.agent.model',
    ]);
  });

  it('leaves issues the stored document already had to merge time unless the batch touches them', () => {
    const stored = { overrides: { balance: { startBalance: 'many' }, interface: {} } };
    const candidate = {
      overrides: { balance: { startBalance: 'many' }, interface: { customWelcome: 'hi' } },
      tombstones: [],
    };

    expect(getConfigChangeIssues(candidate, {}, stored, [['interface', 'customWelcome']])).toEqual(
      [],
    );
    expect(paths(getConfigChangeIssues(candidate, {}, stored, [['balance']]))).toEqual([
      'balance.startBalance',
    ]);
  });

  it('matches existing issues of entries by key, so removing one entry does not blame the ones it shifts', () => {
    const entry = (name: string, extra: Record<string, unknown> = {}) => ({
      name,
      baseURL: `https://${name}.example.com/v1`,
      ...extra,
    });
    const stored = {
      overrides: {
        endpoints: {
          custom: [
            entry('first'),
            entry('legacy', { baseURL: 42 }),
            { baseURL: 'https://keyless.example.com' },
            entry('last'),
          ],
        },
      },
    };
    const remove = (key: string) =>
      applyConfigChanges(toConfigOverrideState(stored), [
        { op: 'removeEntry', segments: ['endpoints', 'custom'], key },
      ]).state;

    expect(paths(getConfigChangeIssues(stored, {}, null, []))).toEqual([
      'endpoints.custom.2',
      'endpoints.custom.1.baseURL',
    ]);
    expect(getConfigChangeIssues(remove('first'), {}, stored, [])).toEqual([]);
    expect(getConfigChangeIssues(remove('last'), {}, stored, [])).toEqual([]);
    expect(getConfigChangeIssues(remove('legacy'), {}, stored, [])).toEqual([]);

    const renamed = applyConfigChanges(remove('first'), [
      { op: 'rename', segments: ['endpoints', 'custom'], from: 'last', to: 'legacy-2' },
      {
        op: 'upsertEntry',
        segments: ['endpoints', 'custom'],
        entry: entry('fresh', { baseURL: 7 }),
      },
    ]).state;
    expect(paths(getConfigChangeIssues(renamed, {}, stored, []))).toEqual([
      'endpoints.custom.3.baseURL',
    ]);
  });

  it('matches an existing issue of an entry under any spelling of its folded key', () => {
    const stored = {
      overrides: {
        endpoints: {
          custom: [
            { name: 'first', baseURL: 'https://first.example.com/v1' },
            { name: 'Ollama', baseURL: 42 },
          ],
        },
      },
    };
    const respelled = {
      overrides: { endpoints: { custom: [{ name: 'ollama', baseURL: 42 }] } },
      tombstones: [],
    };
    const other = {
      overrides: { endpoints: { custom: [{ name: 'Foo', baseURL: 42 }] } },
      tombstones: [],
    };
    const otherStored = {
      overrides: { endpoints: { custom: [{ name: 'foo', baseURL: 42 }] } },
    };

    expect(getConfigChangeIssues(respelled, {}, stored, [])).toEqual([]);
    expect(paths(getConfigChangeIssues(other, {}, otherStored, []))).toEqual([
      'endpoints.custom.0.baseURL',
    ]);
  });

  it('tells apart record keys that contain dots from the nested path their dots spell', () => {
    const stored = {
      overrides: { endpoints: { bedrock: { inferenceProfiles: { 'us.a.b': 5 } } } },
    };
    const candidate = {
      overrides: {
        endpoints: { bedrock: { inferenceProfiles: { 'us.a.b': 5, 'eu.a.b': 6 } } },
      },
      tombstones: [],
    };
    const written = [['endpoints', 'bedrock', 'inferenceProfiles', 'eu.a.b']];

    expect(getConfigChangeIssues(candidate, {}, stored, written)).toEqual([
      {
        path: 'endpoints.bedrock.inferenceProfiles.eu.a.b',
        segments: ['endpoints', 'bedrock', 'inferenceProfiles', 'eu.a.b'],
        code: 'invalid_type',
        params: { expected: 'string', received: 'number' },
      },
    ]);
  });
});

describe('getIndexedMergeKeyIssues', () => {
  it('reports a write inside a merged-by-key array by position, not one of the whole array', () => {
    expect(getIndexedMergeKeyIssues([['endpoints', 'custom', '0', 'name']])).toEqual([
      {
        path: 'endpoints.custom',
        segments: ['endpoints', 'custom'],
        code: 'indexed_merge_key_write',
      },
    ]);
    expect(getIndexedMergeKeyIssues([['endpoints', 'custom']])).toEqual([]);
    expect(getIndexedMergeKeyIssues([['modelSpecs', 'list', '0', 'name']])).toEqual([]);
  });
});

describe('getConfigArrayMergeKey', () => {
  it('names the key field of merged-by-key arrays in override (YAML) paths only', () => {
    expect(getConfigArrayMergeKey(['endpoints', 'custom'])).toBe('name');
    expect(getConfigArrayMergeKey(['endpoints'])).toBeUndefined();
    expect(getConfigArrayMergeKey(['modelSpecs', 'list'])).toBeUndefined();
    expect(getConfigArrayMergeKey(['endpoints.custom'])).toBeUndefined();
    expect(getConfigArrayMergeKey([])).toBeUndefined();
  });
});

describe('isConfigRecordPath', () => {
  it('accepts records whose keys are operator-chosen names, through unions and wrappers', () => {
    expect(isConfigRecordPath(['mcpServers'])).toBe(true);
    expect(isConfigRecordPath(['mcpServers', 'github', 'headers'])).toBe(true);
    expect(isConfigRecordPath(['endpoints', 'bedrock', 'inferenceProfiles'])).toBe(true);
  });

  it('refuses fixed-shape objects, arrays, leaves and unknown sections', () => {
    expect(isConfigRecordPath(['interface'])).toBe(false);
    expect(isConfigRecordPath(['webSearch'])).toBe(false);
    expect(isConfigRecordPath(['speech', 'tts'])).toBe(false);
    expect(isConfigRecordPath(['endpoints', 'custom'])).toBe(false);
    expect(isConfigRecordPath(['mcpServers', 'github', 'url'])).toBe(false);
    expect(isConfigRecordPath(['paths'])).toBe(false);
    expect(isConfigRecordPath([])).toBe(false);
  });
});

describe('isConfigArrayItemPath', () => {
  it('names paths that continue past an array: an element, or a path inside one', () => {
    expect(isConfigArrayItemPath(['endpoints', 'custom', '0'])).toBe(true);
    expect(isConfigArrayItemPath(['endpoints', 'custom', '0', 'baseURL'])).toBe(true);
    expect(isConfigArrayItemPath(['endpoints', 'custom', 'yaml-endpoint'])).toBe(true);
    expect(isConfigArrayItemPath(['modelSpecs', 'list', '0', 'preset'])).toBe(true);
    expect(isConfigArrayItemPath(['mcpServers', 'local', 'args', '0'])).toBe(true);
  });

  it('takes an index below a field the schema cannot see into to name an array element', () => {
    expect(isConfigArrayItemPath(['interface', 'futureList', '0'])).toBe(true);
    expect(isConfigArrayItemPath(['interface', 'futureList', '0', 'name'])).toBe(true);
    expect(isConfigArrayItemPath(['endpoints', 'azureOpenAI', 'groups', '0'])).toBe(true);
    expect(isConfigArrayItemPath(['endpoints', 'azureOpenAI', 'groups', '1', 'models'])).toBe(true);
    expect(
      isConfigArrayItemPath(['webSearch', 'firecrawlOptions', 'changeTrackingOptions', 'schema']),
    ).toBe(false);
    expect(isConfigArrayItemPath(['interface', 'futureList'])).toBe(false);
    expect(isConfigArrayItemPath(['interface', 'futureMap', 'key'])).toBe(false);
    expect(isConfigArrayItemPath(['endpoints', 'azureOpenAI', 'groups'])).toBe(false);
  });

  it('accepts whole arrays, objects, records and paths the schema does not define', () => {
    expect(isConfigArrayItemPath(['endpoints', 'custom'])).toBe(false);
    expect(isConfigArrayItemPath(['modelSpecs', 'list'])).toBe(false);
    expect(isConfigArrayItemPath(['memory', 'agent', 'id'])).toBe(false);
    expect(isConfigArrayItemPath(['mcpServers', 'github', 'headers', 'X-Token'])).toBe(false);
    expect(isConfigArrayItemPath(['paths', 'uploads', '0'])).toBe(false);
    expect(isConfigArrayItemPath([])).toBe(false);
  });
});

describe('isAcceptedOverrideSection', () => {
  it('accepts exactly the top-level sections configSchema defines', () => {
    for (const section of ['interface', 'mcpServers', 'endpoints', 'memory', 'filters']) {
      expect(isAcceptedOverrideSection(section)).toBe(true);
    }
    for (const key of ['paths', 'config', 'availableTools', 'interfaceConfig', 'mcpConfig']) {
      expect(isAcceptedOverrideSection(key)).toBe(false);
    }
    for (const key of ['', 'toString', 'constructor', '__proto__']) {
      expect(isAcceptedOverrideSection(key)).toBe(false);
    }
  });
});

/** librechat.yaml as AppService resolves it at startup, the base every merge below starts from. */
function loadBase(config: DeepPartial<TCustomConfig>, expand?: (endpoint: TEndpoint) => TEndpoint) {
  return AppService({ config: structuredClone(config), expandCustomEndpoint: expand });
}

describe('Azure groups merge by group', () => {
  const east = {
    group: 'east',
    apiKey: 'east-key',
    instanceName: 'east',
    version: '2024-10-21',
    deploymentName: 'gpt-4o',
    models: { 'gpt-4o': true },
  };
  const yaml = { endpoints: { azureOpenAI: { groups: [east] } } };
  const groups = (...items: Record<string, unknown>[]) => ({
    endpoints: { azureOpenAI: { groups: items } },
  });

  it('requires a unique group on every item, and refuses a write that addresses one by index', () => {
    expect(getConfigOverrideIssues(groups({ models: {} }, east, east))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'endpoints.azureOpenAI.groups.0',
          code: 'missing_merge_key',
        }),
        expect.objectContaining({
          path: 'endpoints.azureOpenAI.groups.1',
          code: 'duplicate_merge_key',
        }),
      ]),
    );
    expect(
      getConfigFieldIssues({ 'endpoints.azureOpenAI.groups.0.instanceName': 'x' }, yaml),
    ).toEqual([
      {
        path: 'endpoints.azureOpenAI.groups',
        segments: ['endpoints', 'azureOpenAI', 'groups'],
        code: 'indexed_merge_key_write',
      },
    ]);
  });

  it('merges a partial item over the group of its name, which a write validates on', () => {
    expect(
      getConfigOverrideIssues(
        groups({ group: 'east', models: { 'gpt-4o-mini': { deploymentName: 'mini' } } }),
        yaml,
      ),
    ).toEqual([]);
  });

  it('refuses groups that do not resolve over the groups below, and leaves them out at merge', async () => {
    const duplicateModel = { ...east, group: 'west', instanceName: 'west' };
    const blankDeployment = { group: 'east', deploymentName: '' };
    const issue = [
      {
        path: 'endpoints.azureOpenAI.groups',
        segments: ['endpoints', 'azureOpenAI', 'groups'],
        code: 'invalid_azure_groups',
      },
    ];
    expect(getConfigOverrideIssues(groups(duplicateModel), yaml)).toEqual(issue);
    expect(getConfigOverrideIssues(groups(blankDeployment), yaml)).toEqual(issue);
    expect(
      getConfigOverrideIssues(groups({ ...east, apiKey: '${AZURE_UNSET_KEY_1}' }), yaml),
    ).toEqual(issue);

    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const base = await loadBase(yaml);
    const merged = mergeWithGroups(base, [fakeConfig(groups(blankDeployment), 10)]);
    expect(merged.endpoints?.azureOpenAI?.groupMap).toEqual(base.endpoints?.azureOpenAI?.groupMap);
    expect(merged.endpoints?.azureOpenAI?.modelNames).toEqual(['gpt-4o']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('invalid_azure_groups'));
    warn.mockRestore();
  });

  it('keeps groups a layer does not name, appends new ones and merges models by name', async () => {
    const base = await loadBase({
      endpoints: {
        azureOpenAI: {
          groups: [east, { ...east, group: 'north', instanceName: 'north', models: { o3: true } }],
        },
      },
    });
    const merged = mergeWithGroups(base, [
      fakeConfig(
        groups(
          { group: 'east', models: { 'gpt-4o-mini': { deploymentName: 'mini' } } },
          {
            ...east,
            group: 'west',
            instanceName: 'west',
            apiKey: 'west-key',
            models: { 'gpt-5': true },
          },
        ),
        10,
      ),
    ]);

    const azure = merged.endpoints?.azureOpenAI;
    expect(Object.keys(azure?.groupMap ?? {})).toEqual(['east', 'north', 'west']);
    expect(azure?.groupMap?.north).toBe(base.endpoints?.azureOpenAI?.groupMap?.north);
    expect(azure?.groupMap?.east).toMatchObject({
      apiKey: 'east-key',
      models: { 'gpt-4o': true, 'gpt-4o-mini': { deploymentName: 'mini' } },
    });
    expect(azure?.modelNames).toEqual(['gpt-4o', 'gpt-4o-mini', 'o3', 'gpt-5']);
    expect(azure?.modelGroupMap?.['gpt-4o-mini']).toEqual({ group: 'east' });
  });

  it('serves what keyed tombstones leave of the groups, and leaves them inert without the switch', async () => {
    const north = {
      ...east,
      group: 'north',
      instanceName: 'north',
      apiKey: 'north-key',
      models: { o3: true, 'o3-mini': true },
    };
    const base = await loadBase({ endpoints: { azureOpenAI: { groups: [east, north] } } });
    const hidden = [fakeConfig({}, 10, ['endpoints.azureOpenAI.groups["north"]'])];

    const azure = mergeWithGroups(base, hidden).endpoints?.azureOpenAI;
    expect(Object.keys(azure?.groupMap ?? {})).toEqual(['east']);
    expect(azure?.groupMap?.east).toBe(base.endpoints?.azureOpenAI?.groupMap?.east);
    expect(azure?.modelNames).toEqual(['gpt-4o']);
    expect(azure?.modelGroupMap?.o3).toBeUndefined();

    const inside = mergeWithGroups(base, [
      fakeConfig({}, 10, ['endpoints.azureOpenAI.groups["north"].models.o3-mini']),
    ]).endpoints?.azureOpenAI;
    expect(inside?.modelNames).toEqual(['gpt-4o', 'o3']);
    expect(inside?.groupMap?.north).toMatchObject({ apiKey: 'north-key', models: { o3: true } });
    expect(inside?.groupMap?.east).toBe(base.endpoints?.azureOpenAI?.groupMap?.east);

    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const unresolved = mergeWithGroups(base, [
      fakeConfig({}, 10, ['endpoints.azureOpenAI.groups["north"].instanceName']),
    ]).endpoints?.azureOpenAI;
    expect(Object.keys(unresolved?.groupMap ?? {})).toEqual(['east']);
    expect(unresolved?.modelNames).toEqual(['gpt-4o']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Serving none of the'));
    warn.mockRestore();

    const off = mergeConfigOverrides(base, hidden).endpoints?.azureOpenAI;
    expect(off?.groupMap).toEqual(base.endpoints?.azureOpenAI?.groupMap);
    expect(off?.modelNames).toEqual(base.endpoints?.azureOpenAI?.modelNames);
  });
});

describe('Vertex AI derived from overrides (rederiveEndpoints)', () => {
  const yaml = {
    endpoints: {
      anthropic: {
        models: ['claude-direct'],
        vertex: {
          projectId: 'yaml-project',
          region: 'us-east5',
          serviceKeyFile: '/keys/vertex.json',
          models: ['claude-sonnet-4-6'],
        },
      },
    },
  };
  const vertex = (settings: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    endpoints: { anthropic: { vertex: settings, ...extra } },
  });
  const merge = async (
    overrides: Record<string, unknown>,
    rederiveEndpoints = true,
    tombstones?: string[],
  ) =>
    mergeConfigOverrides(await loadBase(yaml), [fakeConfig(overrides, 10, tombstones)], {
      rederiveEndpoints,
    }).endpoints?.anthropic;

  it('leaves Vertex AI overrides inert without it', async () => {
    const anthropic = await merge(vertex({ models: ['claude-opus-4-6'] }), false);

    expect(anthropic?.models).toEqual(['claude-sonnet-4-6']);
    expect(anthropic?.vertexConfig?.modelNames).toEqual(['claude-sonnet-4-6']);
  });

  it('derives the models and vertexConfig a layer writes', async () => {
    const anthropic = await merge(
      vertex({ models: ['claude-opus-4-6'], deploymentName: 'opus-deploy' }),
    );

    expect(anthropic?.models).toEqual(['claude-opus-4-6']);
    expect(anthropic?.vertexConfig).toMatchObject({
      projectId: 'yaml-project',
      region: 'us-east5',
      serviceKeyFile: '/keys/vertex.json',
      modelNames: ['claude-opus-4-6'],
      modelDeploymentMap: { 'claude-opus-4-6': 'opus-deploy' },
    });
  });

  it("keeps librechat.yaml's region and key file whatever a layer stores", async () => {
    const anthropic = await merge(
      vertex({ region: 'attacker', serviceKeyFile: 'http://169.254.169.254/key' }),
    );

    expect(anthropic?.vertexConfig).toMatchObject({
      region: 'us-east5',
      serviceKeyFile: '/keys/vertex.json',
    });
    expect(anthropic?.vertex).toMatchObject({
      region: 'us-east5',
      serviceKeyFile: '/keys/vertex.json',
    });
  });

  it('turns Vertex AI off with enabled: false or a tombstone, serving the YAML-shaped models', async () => {
    const disabled = await merge(vertex({ enabled: false }));
    const tombstoned = await merge({}, true, ['endpoints.anthropic.vertex']);

    for (const anthropic of [disabled, tombstoned]) {
      expect(anthropic?.vertexConfig).toBeUndefined();
      expect(anthropic?.models).toEqual(['claude-direct']);
    }
  });

  it("serves the models a layer sets in endpoints.anthropic.models over Vertex AI's", async () => {
    const anthropic = await merge(
      vertex({ models: ['claude-opus-4-6'] }, { models: ['claude-x'] }),
    );

    expect(anthropic?.models).toEqual(['claude-x']);
    expect(anthropic?.vertexConfig?.modelNames).toEqual(['claude-opus-4-6']);
  });

  describe('models a later layer removes', () => {
    const MODELS = 'endpoints.anthropic.models';
    const layered = async (...layers: IConfig[]) =>
      mergeConfigOverrides(await loadBase(yaml), layers, { rederiveEndpoints: true }).endpoints
        ?.anthropic;
    const setsModels = (extra: Record<string, unknown> = {}) =>
      fakeConfig({ endpoints: { anthropic: { models: ['claude-x'], ...extra } } }, 10, [], 'low');

    it("serves Vertex AI's models again once a higher layer tombstones a lower layer's", async () => {
      const anthropic = await layered(setsModels(), fakeConfig({}, 20, [MODELS], 'high'));

      expect(anthropic?.models).toEqual(['claude-sonnet-4-6']);
      expect(anthropic?.vertexConfig?.modelNames).toEqual(['claude-sonnet-4-6']);
    });

    it('derives them from the Vertex AI setup the tombstoning layer writes', async () => {
      const anthropic = await layered(
        setsModels({ vertex: { models: ['claude-haiku-4-5'] } }),
        fakeConfig(vertex({ models: ['claude-opus-4-6'] }), 20, [MODELS], 'high'),
      );

      expect(anthropic?.models).toEqual(['claude-opus-4-6']);
      expect(anthropic?.vertexConfig?.modelNames).toEqual(['claude-opus-4-6']);
    });

    it("serves Vertex AI's models where a layer tombstones librechat.yaml's", async () => {
      const anthropic = await layered(fakeConfig({}, 10, [MODELS]));

      expect(anthropic?.models).toEqual(['claude-sonnet-4-6']);
    });

    it('keeps the models a higher layer sets over a lower tombstone of them', async () => {
      const anthropic = await layered(
        fakeConfig({}, 10, [MODELS], 'low'),
        fakeConfig(
          vertex({ models: ['claude-opus-4-6'] }, { models: ['claude-y'] }),
          20,
          [],
          'high',
        ),
      );
      const sameLayer = await layered(
        fakeConfig(vertex({ models: ['claude-opus-4-6'] }, { models: ['claude-y'] }), 10, [MODELS]),
      );

      expect(anthropic?.models).toEqual(['claude-y']);
      expect(anthropic?.vertexConfig?.modelNames).toEqual(['claude-opus-4-6']);
      expect(sameLayer?.models).toEqual(['claude-y']);
    });

    it('keeps them inert without rederiveEndpoints, as before', async () => {
      const anthropic = mergeConfigOverrides(
        await loadBase(yaml),
        [setsModels(), fakeConfig({}, 20, [MODELS], 'high')],
        { rederiveEndpoints: false },
      ).endpoints?.anthropic;

      expect(anthropic?.models).toBeUndefined();
    });
  });

  it.each([false, true])(
    "never applies a layer's own vertexConfig (rederiveEndpoints: %s)",
    async (rederiveEndpoints) => {
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
      const base = await loadBase(yaml);
      const written = mergeConfigOverrides(
        base,
        [
          fakeConfig(
            {
              endpoints: {
                anthropic: {
                  vertexConfig: {
                    serviceKeyFile: 'http://169.254.169.254/key',
                    region: 'evil.example',
                  },
                },
              },
            },
            10,
          ),
        ],
        { rederiveEndpoints },
      );
      const tombstoned = mergeConfigOverrides(
        base,
        [fakeConfig({}, 10, ['endpoints.anthropic.vertexConfig'])],
        { rederiveEndpoints },
      );

      expect(written.endpoints?.anthropic?.vertexConfig).toEqual(
        base.endpoints?.anthropic?.vertexConfig,
      );
      expect(tombstoned.endpoints?.anthropic?.vertexConfig).toEqual(
        base.endpoints?.anthropic?.vertexConfig,
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Ignoring endpoints.anthropic.vertexConfig for role/test'),
      );
      warn.mockRestore();
    },
  );

  it('refuses a setup that does not load on write, and keeps the one below at merge', async () => {
    const unset = vertex({ projectId: '${VERTEX_UNSET_PROJECT_1}' });
    expect(getConfigOverrideIssues(unset, yaml)).toEqual([
      {
        path: 'endpoints.anthropic.vertex',
        segments: ['endpoints', 'anthropic', 'vertex'],
        code: 'invalid_vertex_config',
      },
    ]);
    expect(getConfigOverrideIssues(vertex({ projectId: 'a/../b' }), yaml)).toEqual([
      expect.objectContaining({ path: 'endpoints.anthropic.vertex.projectId', code: 'custom' }),
    ]);

    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const anthropic = await merge(unset);
    expect(anthropic?.vertexConfig).toMatchObject({ projectId: 'yaml-project' });
    warn.mockRestore();
  });

  describe('where librechat.yaml configures no Vertex AI', () => {
    const direct = { endpoints: { anthropic: { models: ['claude-direct'] } } };
    const usable = vertex({ projectId: 'profile-project', models: ['claude-opus-4-6'] });

    it("refuses a write that turns it on, the deployment's default Google credentials unchosen", async () => {
      const floor = resolveRawConfig(direct, []);
      const issue = {
        path: 'endpoints.anthropic.vertex',
        segments: ['endpoints', 'anthropic', 'vertex'],
        code: 'invalid_vertex_config',
      };

      expect(getConfigOverrideIssues(usable, floor, { vertexConfigured: false })).toEqual([issue]);
      expect(
        getConfigOverrideIssues(vertex({ enabled: false }), floor, { vertexConfigured: false }),
      ).toEqual([]);
      expect(getConfigOverrideIssues(usable, yaml, { vertexConfigured: true })).toEqual([]);
    });

    it('never turns it on at merge, a Base layer included, and warns of the stored override', async () => {
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
      const base = await loadBase(direct);
      const layers = [
        fakeConfig(usable, 0, undefined, BASE_CONFIG_PRINCIPAL_ID),
        fakeConfig(vertex({ models: ['claude-x'] }), 10),
      ];
      const merged = mergeConfigOverrides(base, layers, { rederiveEndpoints: true });

      expect(merged.endpoints?.anthropic?.vertexConfig).toBeUndefined();
      expect(merged.endpoints?.anthropic?.models).toEqual(['claude-direct']);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('(invalid_vertex_config)'));
      warn.mockRestore();
    });
  });
});

describe('Azure Assistants derived from overrides (rederiveEndpoints)', () => {
  const east = {
    group: 'east',
    apiKey: 'east-key',
    instanceName: 'east',
    version: '2024-10-21',
    deploymentName: 'gpt-4o',
    assistants: true,
    models: { 'gpt-4o': true },
  };
  const yaml = { endpoints: { azureOpenAI: { groups: [east] } } };

  it('derives the Azure Assistants endpoint a layer turns on, and drops it when turned off', async () => {
    const base = await loadBase(yaml);
    const on = (rederiveEndpoints: boolean) =>
      mergeConfigOverrides(
        base,
        [fakeConfig({ endpoints: { azureOpenAI: { assistants: true } } }, 10)],
        {
          rederiveEndpoints,
        },
      );

    expect(base.endpoints?.azureAssistants).toBeUndefined();
    expect(on(false).endpoints?.azureAssistants).toBeUndefined();
    expect(on(true).endpoints?.azureAssistants).toMatchObject({
      capabilities: expect.arrayContaining(['tools', 'actions', 'code_interpreter']),
    });

    const assistantsBase = await loadBase({
      endpoints: { azureOpenAI: { ...yaml.endpoints.azureOpenAI, assistants: true } },
    });
    const off = mergeConfigOverrides(
      assistantsBase,
      [fakeConfig({ endpoints: { azureOpenAI: { assistants: false } } }, 10)],
      { rederiveEndpoints: true },
    );
    const tombstoned = mergeConfigOverrides(
      assistantsBase,
      [fakeConfig({}, 10, ['endpoints.azureOpenAI'])],
      { rederiveEndpoints: true },
    );
    expect(assistantsBase.endpoints?.azureAssistants).toBeDefined();
    expect(off.endpoints?.azureAssistants).toBeUndefined();
    expect(tombstoned.endpoints?.azureOpenAI).toBeUndefined();
    expect(tombstoned.endpoints?.azureAssistants).toBeUndefined();
  });
});

describe('custom endpoint parameters expanded for overrides', () => {
  /** Records which defaults each definition was completed from; refuses a key named `invalid`. */
  const expand = (endpoint: TEndpoint): TEndpoint => {
    const params = endpoint.customParams;
    if (params == null) {
      return endpoint.name.startsWith('OpenRouter')
        ? {
            ...endpoint,
            customParams: {
              defaultParamsEndpoint: 'openrouter',
              paramDefinitions: [
                { key: 'promptCache', default: true, optionType: OptionTypes.Custom },
              ],
            },
          }
        : { ...endpoint };
    }
    const from = params.defaultParamsEndpoint ?? 'custom';
    return {
      ...endpoint,
      customParams: {
        ...params,
        defaultParamsEndpoint: from,
        paramDefinitions: (params.paramDefinitions ?? []).map((definition) => {
          if (definition.key === 'invalid') {
            throw new Error('invalid key');
          }
          return {
            ...definition,
            label: `${from}:${definition.key}`,
            optionType: OptionTypes.Custom,
          };
        }),
      },
    };
  };
  const gateway = {
    name: 'Gateway',
    apiKey: 'gateway-key',
    baseURL: 'https://gateway.example.com/v1',
    models: { default: ['m1'] },
    customParams: {
      defaultParamsEndpoint: 'anthropic',
      paramDefinitions: [{ key: 'temperature', default: 0.2 }],
    },
  };
  const other = { ...gateway, name: 'Other' };
  const yaml = { endpoints: { custom: [gateway, other] } };
  const merge = async (custom: unknown[]) => {
    const base = await loadBase(yaml, expand);
    const merged = mergeConfigOverrides(base, [fakeConfig({ endpoints: { custom } }, 10)], {
      expandCustomEndpoint: expand,
    });
    return {
      base,
      served: (name: string) => merged.endpoints?.custom?.find((entry) => entry.name === name),
    };
  };

  it('keeps librechat.yaml as written and serves the expanded copy', async () => {
    const base = await loadBase(yaml, expand);

    expect(base.config.endpoints?.custom?.[0]).toEqual(gateway);
    expect(base.endpoints?.custom?.[0]?.customParams?.paramDefinitions).toEqual([
      { key: 'temperature', default: 0.2, label: 'anthropic:temperature', optionType: 'custom' },
    ]);
  });

  it("expands a layer's compact definitions, and leaves endpoints it does not write as they were", async () => {
    const { base, served } = await merge([
      { name: 'Gateway', customParams: { paramDefinitions: [{ key: 'top_p' }] } },
    ]);

    expect(served('Gateway')?.customParams?.paramDefinitions).toEqual([
      { key: 'top_p', label: 'anthropic:top_p', optionType: 'custom' },
    ]);
    expect(served('Other')).toEqual(base.endpoints?.custom?.[1]);
  });

  it('expands again for a defaultParamsEndpoint a layer changes, from the definitions as written', async () => {
    const { served } = await merge([
      { name: 'Gateway', customParams: { defaultParamsEndpoint: 'openAI' } },
    ]);

    expect(served('Gateway')?.customParams).toEqual({
      defaultParamsEndpoint: 'openAI',
      paramDefinitions: [
        { key: 'temperature', default: 0.2, label: 'openAI:temperature', optionType: 'custom' },
      ],
    });
  });

  it("adds defaults to an endpoint only a layer defines, and keeps librechat.yaml's for invalid ones", async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const { base, served } = await merge([
      { ...gateway, name: 'OpenRouter DB', customParams: undefined },
      { name: 'Gateway', customParams: { paramDefinitions: [{ key: 'invalid' }] } },
    ]);

    expect(served('OpenRouter DB')?.customParams?.paramDefinitions).toEqual([
      { key: 'promptCache', default: true, optionType: 'custom' },
    ]);
    expect(served('Gateway')?.customParams).toEqual(base.endpoints?.custom?.[0]?.customParams);
    expect(
      getConfigOverrideIssues(
        {
          endpoints: {
            custom: [{ name: 'Gateway', customParams: { paramDefinitions: [{ key: 'invalid' }] } }],
          },
        },
        yaml,
        { expandCustomEndpoint: expand },
      ),
    ).toEqual([
      {
        path: 'endpoints.custom.0.customParams',
        segments: ['endpoints', 'custom', '0', 'customParams'],
        code: 'invalid_param_definitions',
      },
    ]);
    warn.mockRestore();
  });
});

describe('the agents memory capability follows the merged memory config', () => {
  const capabilities = (config: AppConfig) => config.endpoints?.agents?.capabilities ?? [];

  it('offers memory to a profile that turns it on, and not to one that turns it off', async () => {
    const disabledBase = await loadBase({ memory: { disabled: true } });
    const enabledBase = await loadBase({ memory: { disabled: false, personalize: true } });

    expect(capabilities(disabledBase)).not.toContain(AgentCapabilities.memory);
    expect(capabilities(enabledBase)).toContain(AgentCapabilities.memory);
    expect(
      capabilities(
        mergeConfigOverrides(disabledBase, [fakeConfig({ memory: { disabled: false } }, 10)]),
      ),
    ).toContain(AgentCapabilities.memory);
    expect(
      capabilities(
        mergeConfigOverrides(enabledBase, [fakeConfig({ memory: { disabled: true } }, 10)]),
      ),
    ).not.toContain(AgentCapabilities.memory);
    expect(
      capabilities(
        mergeConfigOverrides(disabledBase, [
          fakeConfig(
            {
              endpoints: {
                agents: { capabilities: [AgentCapabilities.memory, AgentCapabilities.tools] },
              },
            },
            10,
          ),
        ]),
      ),
    ).toEqual([AgentCapabilities.tools]);
  });
});

describe('derived parts follow what the layers leave, set then tombstoned or the reverse', () => {
  const low = (overrides: Record<string, unknown>, tombstones: string[] = []) =>
    fakeConfig(overrides, 10, tombstones, 'low');
  const high = (overrides: Record<string, unknown>, tombstones: string[] = []) =>
    fakeConfig(overrides, 20, tombstones, 'high');
  const east = {
    group: 'east',
    apiKey: 'east-key',
    instanceName: 'east',
    version: '2024-10-21',
    deploymentName: 'gpt-4o',
    assistants: true,
    models: { 'gpt-4o': true },
  };
  const groups = (...items: Record<string, unknown>[]) => ({
    endpoints: { azureOpenAI: { groups: items } },
  });
  const GROUPS = 'endpoints.azureOpenAI.groups';

  it('the agents memory capability', async () => {
    const offBase = await loadBase({ memory: { disabled: true } });
    const onBase = await loadBase({ memory: { disabled: false, personalize: true } });
    const offers = (base: AppConfig, configs: IConfig[]) =>
      (mergeConfigOverrides(base, configs).endpoints?.agents?.capabilities ?? []).includes(
        AgentCapabilities.memory,
      );
    const on = { memory: { disabled: false } };

    expect(offers(offBase, [low(on), high({}, ['memory'])])).toBe(false);
    expect(offers(offBase, [low({}, ['memory']), high(on)])).toBe(true);
    expect(
      offers(onBase, [low({ memory: { disabled: true } }), high({}, ['memory.disabled'])]),
    ).toBe(true);
  });

  it('the Azure Assistants endpoint', async () => {
    const base = await loadBase({ endpoints: { azureOpenAI: { groups: [east] } } });
    const assistants = { endpoints: { azureOpenAI: { assistants: true } } };
    const ASSISTANTS = 'endpoints.azureOpenAI.assistants';

    expect(
      mergeWithGroups(base, [low(assistants), high({}, [ASSISTANTS])]).endpoints?.azureAssistants,
    ).toBeUndefined();
    expect(
      mergeWithGroups(base, [low({}, [ASSISTANTS]), high(assistants)]).endpoints?.azureAssistants,
    ).toBeDefined();
  });

  it('Azure groups', async () => {
    const base = await loadBase({ endpoints: { azureOpenAI: { groups: [east] } } });
    const group = (name: string, model: string) => ({
      ...east,
      group: name,
      instanceName: name,
      apiKey: `${name}-key`,
      deploymentName: model,
      models: { [model]: true },
    });
    const served = (configs: IConfig[]) => {
      const azure = mergeWithGroups(base, configs).endpoints?.azureOpenAI;
      return { groups: Object.keys(azure?.groupMap ?? {}), models: azure?.modelNames };
    };

    expect(
      served([low(groups(group('west', 'gpt-5'))), high(groups(group('north', 'o3')), [GROUPS])]),
    ).toEqual({ groups: ['north'], models: ['o3'] });
    expect(served([low({}, [GROUPS]), high(groups(group('west', 'gpt-5')))])).toEqual({
      groups: ['west'],
      models: ['gpt-5'],
    });
  });

  describe('what a layer recreates after a tombstone of an object above removed it', () => {
    const titled = { endpoints: { azureOpenAI: { titleModel: 'gpt-4o' } } };
    const noGroup = {
      titleModel: 'gpt-4o',
      groupMap: {},
      modelGroupMap: {},
      modelNames: [],
      assistantModels: [],
      assistantGroups: [],
    };

    it.each(['endpoints.azureOpenAI', 'endpoints'])(
      'serves no Azure group from an Azure endpoint recreated without groups after a tombstone of %s',
      async (tombstone) => {
        const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
        const base = await loadBase({ endpoints: { azureOpenAI: { groups: [east] } } });
        const layerings = [
          [low({}, [tombstone]), high(titled)],
          [low(titled, [tombstone])],
          [low(groups(east)), high(titled, [tombstone])],
        ];

        for (const rederiveEndpoints of [true, false]) {
          for (const layers of layerings) {
            expect(
              mergeConfigOverrides(base, layers, { rederiveEndpoints }).endpoints?.azureOpenAI,
            ).toEqual(noGroup);
          }
        }
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('Serving no Azure group for role/low, role/high'),
        );
        expect(base.endpoints?.azureOpenAI?.modelNames).toEqual(['gpt-4o']);
        warn.mockRestore();
      },
    );

    it.each(['endpoints.agents', 'endpoints'])(
      'serves the agents endpoint startup derives where a tombstone of %s left none',
      async (tombstone) => {
        const offBase = await loadBase({ memory: { disabled: true } });
        const onBase = await loadBase({ memory: { disabled: false, personalize: true } });
        const agents = (base: AppConfig, configs: IConfig[]) =>
          mergeConfigOverrides(base, configs).endpoints?.agents;

        expect(agents(offBase, [low({}, [tombstone])])).toEqual(offBase.endpoints?.agents);
        expect(agents(onBase, [low({}, [tombstone])])).toEqual(onBase.endpoints?.agents);
        expect(
          agents(offBase, [low({}, [tombstone]), high({ memory: { disabled: false } })]),
        ).toEqual(onBase.endpoints?.agents);
        expect(onBase.endpoints?.agents?.capabilities).toContain(AgentCapabilities.memory);
      },
    );
  });
});

describe('model spec endpoints', () => {
  const spec = (endpoint: string) => ({
    name: endpoint,
    label: endpoint,
    preset: { endpoint, model: 'm' },
  });

  const gateway = {
    name: 'Gateway',
    apiKey: 'k',
    baseURL: 'https://g',
    models: { default: ['m'] },
  };
  const yaml = {
    endpoints: { custom: [gateway] },
    modelSpecs: { list: [spec('Gateway'), spec('openAI')] },
  };
  const yamlBase = { config: yaml, modelSpecs: yaml.modelSpecs } as unknown as AppConfig;
  const served = (configs: IConfig[]) =>
    mergeConfigOverrides(yamlBase, configs).modelSpecs?.list?.map(({ name }) => name);

  it('refuses a spec for an endpoint that is not configured on write, and leaves only it out at merge', () => {
    expect(
      getConfigOverrideIssues({ modelSpecs: { list: [spec('Gateway'), spec('openAI')] } }, yaml),
    ).toEqual([]);
    expect(getConfigOverrideIssues({ modelSpecs: { list: [spec('Nowhere')] } }, yaml)).toEqual([
      {
        path: 'modelSpecs.list.0.preset.endpoint',
        segments: ['modelSpecs', 'list', '0', 'preset', 'endpoint'],
        code: 'unknown_spec_endpoint',
      },
    ]);

    expect(
      served([fakeConfig({ modelSpecs: { list: [spec('Nowhere'), spec('Gateway')] } }, 10)]),
    ).toEqual(['Gateway']);
  });

  it.each([['endpoints.custom'], ['endpoints']])(
    'leaves out the specs of the custom endpoints a tombstone of %s removes, until a layer defines them again',
    (path) => {
      expect(served([fakeConfig({}, 10, [path])])).toEqual(['openAI']);
      expect(
        served([fakeConfig({}, 10, [path]), fakeConfig({ endpoints: { custom: [gateway] } }, 20)]),
      ).toEqual(['Gateway', 'openAI']);
      expect(
        served([
          fakeConfig({ endpoints: { custom: [{ ...gateway, name: 'Router' }] } }, 10),
          fakeConfig({ modelSpecs: { list: [spec('Router')] } }, 20),
          fakeConfig({}, 30, [path]),
        ]),
      ).toBeUndefined();
    },
  );

  it('lets a change hide or remove the endpoint a stored spec selects, and refuses a spec it writes there', () => {
    const router = { ...gateway, name: 'Router' };
    const stored = {
      overrides: {
        endpoints: { custom: [router] },
        modelSpecs: { list: [spec('Gateway'), spec('Router')] },
      },
      tombstones: [],
    };
    const change = (changes: Parameters<typeof applyConfigChanges>[1]) => {
      const { state } = applyConfigChanges(stored, changes);
      return getConfigChangeIssues(
        state,
        yaml,
        stored,
        changes.map((step) => [...step.segments]),
      );
    };

    expect(change([{ op: 'tombstone', segments: ['endpoints', 'custom'] }])).toEqual([]);
    expect(change([{ op: 'unset', segments: ['endpoints', 'custom'] }])).toEqual([]);
    expect(
      change([
        { op: 'tombstone', segments: ['endpoints', 'custom'] },
        { op: 'set', segments: ['modelSpecs', 'list'], value: [spec('Router')] },
      ]).map(({ path, code }) => [path, code]),
    ).toEqual([['modelSpecs.list.0.preset.endpoint', 'unknown_spec_endpoint']]);
  });
});

describe('issue params', () => {
  const firstIssue = (schema: z.ZodTypeAny, value: unknown) => {
    const result = schema.safeParse(value);
    if (result.success) {
      throw new Error('expected a failure');
    }
    return result.error.issues[0];
  };

  it('carries the schema side of each failure, never the submitted value', () => {
    const issues = getConfigOverrideIssues({
      interface: { contextCost: 'no' },
      fileStrategy: 'sentinel-fs',
      githubCompare: { timeoutMs: 40_000 },
      endpoints: { agents: { recursionLimit: 0 }, allowedAddresses: ['localhost'] },
    });
    const byPath = Object.fromEntries(issues.map(({ path, params }) => [path, params]));
    expect(byPath['interface.contextCost']).toEqual({ expected: 'boolean', received: 'string' });
    expect(byPath.fileStrategy).toEqual({
      options: expect.arrayContaining(['local', 's3']),
    });
    expect(byPath['githubCompare.timeoutMs']).toEqual({
      maximum: 30_000,
      inclusive: true,
      exact: false,
      type: 'number',
    });
    expect(byPath['endpoints.agents.recursionLimit']).toEqual({
      minimum: 1,
      inclusive: true,
      exact: false,
      type: 'number',
    });
    expect(byPath['endpoints.allowedAddresses.0']).toEqual({ reason: 'missing_port' });
  });

  it('keeps record-key diagnostics at their full path inside a union', () => {
    expect(
      getConfigOverrideIssues({
        interface: {
          theme: {
            version: 1,
            name: 'Custom',
            modes: { light: { colors: { Invalid: '255 255 255' } } },
          },
        },
      }),
    ).toEqual([
      {
        path: 'interface.theme.modes.light.colors.Invalid',
        segments: ['interface', 'theme', 'modes', 'light', 'colors', 'Invalid'],
        code: 'invalid_string',
        params: { validation: 'regex' },
      },
    ]);
  });

  it('names the integer expectation of a fractional step limit', () => {
    expect(getConfigOverrideIssues({ endpoints: { agents: { maxRecursionLimit: 2.5 } } })).toEqual([
      {
        path: 'endpoints.agents.maxRecursionLimit',
        segments: ['endpoints', 'agents', 'maxRecursionLimit'],
        code: 'invalid_type',
        params: { expected: 'integer', received: 'float' },
      },
    ]);
  });

  it('keeps record keys with dots as one segment beside the params', () => {
    const [issue] = getConfigOverrideIssues({
      endpoints: { bedrock: { inferenceProfiles: { 'us.a.b': 5 } } },
    });
    expect(issue.segments).toEqual(['endpoints', 'bedrock', 'inferenceProfiles', 'us.a.b']);
    expect(issue.params).toEqual({ expected: 'string', received: 'number' });
  });

  it('leaves params off an issue attributed above the node that failed', () => {
    const issues = getConfigOverrideIssues({ modelSpecs: { list: [{ name: 'only-name' }] } });
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue.segments).toEqual(['modelSpecs', 'list', '0']);
      expect(issue.params).toBeUndefined();
    }
  });

  it('maps each zod issue code through its allowlist', () => {
    expect(getConfigIssueParams(firstIssue(z.literal('a'), 'sentinel'))).toEqual({
      expected: 'a',
    });
    expect(getConfigIssueParams(firstIssue(z.string().url(), 'sentinel'))).toEqual({
      validation: 'url',
    });
    expect(getConfigIssueParams(firstIssue(z.string().startsWith('x'), 'sentinel'))).toEqual({
      validation: 'startsWith',
    });
    expect(getConfigIssueParams(firstIssue(z.number().multipleOf(5), 7))).toEqual({
      multipleOf: 5,
    });
    expect(getConfigIssueParams(firstIssue(z.array(z.string()).min(2), ['a']))).toEqual({
      minimum: 2,
      inclusive: true,
      exact: false,
      type: 'array',
    });
    expect(
      getConfigIssueParams(firstIssue(z.date().min(new Date(1000)), new Date(5))),
    ).toMatchObject({ minimum: 1000, type: 'date' });
    const union = z.discriminatedUnion('type', [
      z.object({ type: z.literal('a') }),
      z.object({ type: z.literal('b') }),
    ]);
    expect(getConfigIssueParams(firstIssue(union, { type: 'sentinel' }))).toEqual({
      options: ['a', 'b'],
    });
    expect(
      getConfigIssueParams(
        firstIssue(
          z.string().refine(() => false, { params: { reason: 'not_allowed' } }),
          'x',
        ),
      ),
    ).toEqual({ reason: 'not_allowed' });
    expect(
      getConfigIssueParams(
        firstIssue(
          z.string().refine(() => false, { params: { reason: 'echoes sentinel value' } }),
          'x',
        ),
      ),
    ).toBeUndefined();
    expect(
      getConfigIssueParams(
        firstIssue(
          z.string().refine(() => false),
          'x',
        ),
      ),
    ).toBeUndefined();
  });

  it('drops a bigint bound, so the issue still serializes', () => {
    const params = getConfigIssueParams(firstIssue(z.bigint().min(BigInt(5)), BigInt(1)));
    expect(params).toEqual({ inclusive: true, exact: false, type: 'bigint' });
    expect(() => JSON.stringify(params)).not.toThrow();
  });

  it('never returns a sentinel written into any failing field', () => {
    const sentinel = 'sentinel_0f3a9c';
    const issues = getConfigOverrideIssues({
      interface: { contextCost: sentinel, customWelcome: 5 },
      fileStrategy: sentinel,
      endpoints: {
        allowedAddresses: [sentinel, `http://${sentinel}`, `${sentinel}:0`],
        agents: { recursionLimit: sentinel, titleMethod: sentinel },
        custom: [{ name: sentinel, baseURL: 5, titleMethod: sentinel }],
      },
      memory: { agent: { id: 5, provider: sentinel } },
      webSearch: { searchProvider: sentinel },
      githubCompare: { enabled: sentinel, timeoutMs: sentinel },
      [`${sentinel}.section`]: 1,
    });
    expect(issues.length).toBeGreaterThan(5);
    expect(issues.some((issue) => issue.params)).toBe(true);
    const leaked = issues.filter(({ code, params }) =>
      JSON.stringify({ code, params }).includes(sentinel),
    );
    expect(leaked).toEqual([]);
  });
});

describe('deployment-only paths in the merge', () => {
  const yamlValue = (path: string) => `yaml:${path}`;

  function at(target: Record<string, unknown>, path: string): unknown {
    return path
      .split('.')
      .reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], target);
  }

  function put(target: Record<string, unknown>, path: string, value: unknown) {
    const keys = path.split('.');
    let node = target;
    for (const key of keys.slice(0, -1)) {
      node[key] = (node[key] as Record<string, unknown> | undefined) ?? {};
      node = node[key] as Record<string, unknown>;
    }
    node[keys[keys.length - 1]] = value;
  }

  it('keeps librechat.yaml’s value at every deployment-only path, whatever a layer stores', () => {
    const base: Record<string, unknown> = { config: {} };
    const overrides: Record<string, unknown> = {};
    for (const path of Object.keys(DEPLOYMENT_ONLY_CONFIG_PATHS)) {
      put(base, path, yamlValue(path));
      put(overrides, path, `override:${path}`);
    }
    const merged = mergeConfigOverrides(base as unknown as AppConfig, [
      fakeConfig(overrides, 0, undefined, BASE_CONFIG_PRINCIPAL_ID),
      fakeConfig(overrides, 10, undefined, 'editor'),
    ]) as unknown as Record<string, unknown>;
    for (const path of Object.keys(DEPLOYMENT_ONLY_CONFIG_PATHS)) {
      expect([path, at(merged, path)]).toEqual([path, yamlValue(path)]);
    }
  });

  it('puts librechat.yaml’s value back below a tombstone of the parent, and hides the rest', () => {
    const base = {
      config: {},
      endpoints: { agents: { eventDriven: { idlePolling: true }, recursionLimit: 20 } },
    } as unknown as AppConfig;
    const merged = mergeConfigOverrides(base, [fakeConfig({}, 10, ['endpoints.agents'])]) as {
      endpoints?: { agents?: Record<string, unknown> };
    };
    /** The rest is the agents endpoint startup derives from what the layers leave. */
    expect(merged.endpoints?.agents?.eventDriven).toEqual({ idlePolling: true });
    expect(merged.endpoints?.agents).not.toHaveProperty('recursionLimit');
  });

  it('keeps the tool filters librechat.yaml sets, so a profile cannot gate tools', () => {
    const base = { config: {}, filteredTools: ['dalle'] } as unknown as AppConfig;
    const merged = mergeConfigOverrides(base, [
      fakeConfig({ filteredTools: ['ask_user_question'], includedTools: ['calculator'] }, 10),
    ]);
    expect(merged.filteredTools).toEqual(['dalle']);
    expect(merged.includedTools).toBeUndefined();
  });
});

describe('getIgnoredConfigOverrides', () => {
  const yaml = {
    endpoints: {
      agents: { pullRequests: { provider: 'github' }, eventDriven: { deadLetterRetentionDays: 7 } },
    },
    mcpServers: {
      local: { type: 'stdio', command: 'node', args: ['server.js'] },
      remote: { type: 'streamable-http', url: 'https://mcp.example.com' },
    },
    memory: { agent: { id: 'agent_1' } },
  } as unknown as Partial<TCustomConfig>;

  const reasons = (entries: ReturnType<typeof getIgnoredConfigOverrides>) =>
    entries.map(({ path, reason, kind }) => `${kind}:${path}:${reason}`).sort();

  it('lists every stored part the merge leaves out, by location and reason', () => {
    const layer = fakeConfig(
      {
        paths: { uploads: '/tmp' },
        filters: { x: 1 },
        langfuse: { publicKey: 'pk' },
        interface: {
          prompts: false,
          mcpServers: { use: false, placeholder: 'p' },
          modelSelect: true,
        },
        mcpServers: { local: { title: 'Local' }, remote: { title: 'Remote' } },
        endpoints: {
          agents: {
            pullRequests: { provider: 'gitlab' },
            eventDriven: { deadLetterRetentionDays: 30 },
          },
        },
        rateLimits: { fileUploads: { ipMax: 1 } },
        githubCompare: { timeoutMs: 40_000 },
      },
      10,
      ['config', 'filters', 'langfuse.publicKey', 'mcpServers.local', 'cloudfront'],
      'editor',
    );
    expect(reasons(getIgnoredConfigOverrides(yaml, layer))).toEqual(
      [
        'override:paths:unknown_section',
        'tombstone:config:unknown_section',
        'override:filters:base_only_section',
        'tombstone:filters:base_only_section',
        'override:langfuse:dedicated_section',
        'tombstone:langfuse.publicKey:dedicated_section',
        'override:interface.prompts:interface_permission',
        'override:interface.mcpServers.use:interface_permission',
        'override:mcpServers.local:process_mcp_server',
        'tombstone:mcpServers.local:process_mcp_server',
        'override:endpoints.agents.pullRequests.provider:base_only_path',
        'override:endpoints.agents.eventDriven:deployment_only_path',
        'override:rateLimits:deployment_only_path',
        'tombstone:cloudfront:deployment_only_path',
        'override:githubCompare.timeoutMs:invalid',
      ].sort(),
    );
  });

  it('reports what librechat.yaml keeps below a tombstone, and each stdio server a section tombstone leaves', () => {
    const layer = fakeConfig({}, 10, ['endpoints.agents', 'mcpServers'], 'editor');
    expect(reasons(getIgnoredConfigOverrides(yaml, layer))).toEqual(
      [
        'tombstone:endpoints.agents.pullRequests.provider:base_only_path',
        'tombstone:endpoints.agents.eventDriven:deployment_only_path',
        'tombstone:mcpServers.local:process_mcp_server',
      ].sort(),
    );
  });

  it('reports the defaults the merge puts back below a tombstone when given the resolved base', () => {
    const resolved = {
      config: yaml,
      mcpSettings: { catalogRecovery: { maxStateEntries: 10_000, discoveryTimeoutMs: 3_000 } },
    } as unknown as AppConfig;
    const layer = fakeConfig({}, 10, ['mcpSettings'], 'editor');
    expect(reasons(getIgnoredConfigOverrides(yaml, layer))).toEqual([]);
    expect(reasons(getIgnoredConfigOverrides(yaml, layer, [], resolved))).toEqual([
      'tombstone:mcpSettings.catalogRecovery.maxStateEntries:deployment_only_path',
    ]);
  });

  it('keeps dedicated sections for Base and reports nothing for a document the merge applies whole', () => {
    const base = fakeConfig(
      { langfuse: { publicKey: 'pk' }, interface: { modelSelect: false } },
      0,
      undefined,
      BASE_CONFIG_PRINCIPAL_ID,
    );
    expect(getIgnoredConfigOverrides(yaml, base)).toEqual([]);
  });

  it('judges values on the layers below, as the merge does', () => {
    const memorySwitch = fakeConfig(
      { memory: { agent: { provider: 'openAI', model: 'gpt-4o' } } },
      0,
      ['memory.agent.id'],
      BASE_CONFIG_PRINCIPAL_ID,
    );
    const layer = fakeConfig({ memory: { agent: { model: 'gpt-4.1' } } }, 10, undefined, 'editor');
    expect(reasons(getIgnoredConfigOverrides(yaml, layer))).toEqual([
      'override:memory.agent.model:invalid',
    ]);
    expect(getIgnoredConfigOverrides(yaml, layer, [memorySwitch])).toEqual([]);
  });

  it('does not log the merge warnings it reports', () => {
    const warn = jest.spyOn(logger, 'warn');
    getIgnoredConfigOverrides(
      yaml,
      fakeConfig({ paths: {}, githubCompare: { timeoutMs: 40_000 } }, 10, ['config'], 'editor'),
    );
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

/**
 * Keyed tombstones hide one entry of a merged-by-key array, or a path inside it, by the entry's
 * key: `endpoints.custom["Name"]` and `endpoints.custom["Name"].headers.X-Key`.
 */
describe('mergeConfigOverrides: keyed tombstones of custom endpoints', () => {
  type CustomItem = Record<string, unknown>;
  const customOf = (config: AppConfig): CustomItem[] | undefined =>
    (config as unknown as { endpoints?: { custom?: CustomItem[] } }).endpoints?.custom;
  const entry = (name: string, extra: CustomItem = {}): CustomItem => ({
    name,
    apiKey: '${KEY}',
    baseURL: `https://${encodeURIComponent(name)}.example.com/v1`,
    models: { default: ['m'] },
    ...extra,
  });
  const awkward = ['My Endpoint', 'api.example.com', 'quote " inside', 'bracket ] [ "x"'];
  const yaml = [
    ...awkward.map((name) => entry(name)),
    entry('Ollama', { headers: { 'X-Team': 'a', 'X-Trace': 'b' } }),
  ];
  const base = { endpoints: { custom: yaml }, config: { endpoints: { custom: yaml } } };
  const hide = (path: string, priority = 10, principalId = 'role') =>
    fakeConfig({}, priority, [path], principalId);

  it('hides an entry by its key, whatever characters the name holds', () => {
    for (const name of awkward) {
      const merged = mergeConfigOverrides(base as unknown as AppConfig, [
        hide(formatKeyedPath(['endpoints', 'custom'], name)),
      ]);
      expect(customOf(merged)?.map((item) => item.name)).toEqual(
        yaml.map((item) => item.name).filter((other) => other !== name),
      );
    }
  });

  it('hides the entry under the spelling the merge folds it to', () => {
    const merged = mergeConfigOverrides(base as unknown as AppConfig, [
      hide('endpoints.custom["OLLAMA"]'),
    ]);
    expect(customOf(merged)?.map((item) => item.name)).toEqual(awkward);
  });

  it('removes one inherited header and keeps its siblings (record-key tombstone)', () => {
    const merged = mergeConfigOverrides(base as unknown as AppConfig, [
      hide('endpoints.custom["Ollama"].headers.X-Team'),
    ]);
    expect(customOf(merged)?.find((item) => item.name === 'Ollama')?.headers).toEqual({
      'X-Trace': 'b',
    });
    expect(customOf(base as unknown as AppConfig)?.[4].headers).toEqual({
      'X-Team': 'a',
      'X-Trace': 'b',
    });
  });

  it('keeps a key tombstone through a sibling write, and lets a higher layer re-add the key', () => {
    const role = fakeConfig(
      { endpoints: { custom: [{ name: 'Ollama', headers: { 'X-Other': 'c' } }] } },
      10,
      ['endpoints.custom["Ollama"].headers.X-Team'],
    );
    const headersOf = (configs: IConfig[]) =>
      customOf(mergeConfigOverrides(base as unknown as AppConfig, configs))?.find(
        (item) => item.name === 'Ollama',
      )?.headers;
    expect(headersOf([role])).toEqual({ 'X-Trace': 'b', 'X-Other': 'c' });

    const user = fakeConfig(
      { endpoints: { custom: [{ name: 'Ollama', headers: { 'X-Team': 'user' } }] } },
      100,
      [],
      'user',
    );
    expect(headersOf([role, user])).toEqual({ 'X-Trace': 'b', 'X-Other': 'c', 'X-Team': 'user' });
  });

  it('lets a higher layer add a hidden entry back, as its own definition', () => {
    const readd = fakeConfig({ endpoints: { custom: [entry('My Endpoint')] } }, 20, [], 'group');
    const merged = mergeConfigOverrides(base as unknown as AppConfig, [
      hide('endpoints.custom["My Endpoint"]'),
      readd,
    ]);
    expect(customOf(merged)?.map((item) => item.name)).toEqual([
      ...awkward.slice(1),
      'Ollama',
      'My Endpoint',
    ]);
  });

  it('applies to the YAML-shaped config each layer is validated on', () => {
    expect(
      applyConfigTombstones(base.config, ['endpoints.custom["api.example.com"]']).endpoints?.custom,
    ).toHaveLength(yaml.length - 1);
    expect(
      resolveRawConfig(base.config as Partial<TCustomConfig>, [
        hide('endpoints.custom["Ollama"]'),
      ]).endpoints?.custom?.map((item) => item.name),
    ).toEqual(awkward);
  });

  it('ignores a keyed tombstone of an array the merge replaces, or a malformed one', () => {
    const specs = {
      ...base,
      modelSpecs: { list: [{ name: 'a', label: 'A', preset: { endpoint: 'openAI' } }] },
    };
    const merged = mergeConfigOverrides(specs as unknown as AppConfig, [
      fakeConfig({}, 10, [
        'modelSpecs.list["a"]',
        'endpoints.custom["Ollama"',
        'endpoints.custom[0]',
      ]),
    ]);
    expect(merged.modelSpecs?.list).toHaveLength(1);
    expect(customOf(merged)).toHaveLength(yaml.length);
  });

  it('reads a tombstone holding `["` after anything but an array merged by key as a dotted path', () => {
    const servers = {
      'a["b"]': { type: 'streamable-http', url: 'https://quoted.example.com' },
      a: { type: 'streamable-http', url: 'https://plain.example.com' },
    };
    const mcpBase = { mcpConfig: servers, config: { mcpServers: servers } };
    const merged = mergeConfigOverrides(mcpBase as unknown as AppConfig, [
      hide('mcpServers.a["b"]'),
    ]);
    expect(Object.keys(merged.mcpConfig ?? {})).toEqual(['a']);
    const raw = applyConfigTombstones(mcpBase.config as Partial<TCustomConfig>, [
      'mcpServers.a["b"]',
    ]);
    expect(Object.keys(raw.mcpServers ?? {})).toEqual(['a']);
  });

  it('tells a path inside an entry that runs into one of its own arrays', () => {
    expect(isConfigEntryArrayItemPath(['endpoints', 'custom'], ['models', 'default'])).toBe(false);
    expect(isConfigEntryArrayItemPath(['endpoints', 'custom'], ['models', 'default', '0'])).toBe(
      true,
    );
    expect(isConfigEntryArrayItemPath(['endpoints', 'custom'], ['headers', 'X-Key'])).toBe(false);
    expect(isConfigArrayItemPath(['endpoints', 'custom', '0', 'headers'])).toBe(true);
  });
});
