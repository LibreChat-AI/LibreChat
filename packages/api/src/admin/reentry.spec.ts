import { encryptV3, setConfigFields, toConfigOverrideState } from '@librechat/data-schemas';
import type { AppConfig, ConfigFieldWrite } from '@librechat/data-schemas';
import type { TCustomConfig } from 'librechat-data-provider';
import {
  SECRET_BINDINGS,
  getAzureGroupFingerprint,
  getServerSecretFingerprint,
  getScalarBindingFingerprint,
  getCustomEndpointFingerprint,
} from '~/app/rebinding';
import { findSecretReentry, getBoundKeyReentryIssues, getAzureGroupReentryIssues } from './reentry';

/** Encryption reads `CREDS_KEY` when data-schemas loads, before any spec code runs. */
jest.mock('@librechat/data-schemas', () => {
  process.env.CREDS_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  return jest.requireActual('@librechat/data-schemas');
});

const STORED_KEY = 'v3:00000000000000000000000000000000:abcdef';

const yaml = {
  mcpServers: {
    tools: { type: 'streamable-http', url: 'https://yaml.example/mcp' },
  },
} as unknown as Partial<TCustomConfig>;

interface StoredDocument {
  overrides: Record<string, unknown>;
  tombstones: string[];
}

/** A document that stores only the key for the YAML server, which supplies the URL. */
const stored: StoredDocument = {
  overrides: {
    mcpServers: {
      tools: { apiKey: { source: 'admin', authorization_type: 'bearer', key: STORED_KEY } },
    },
  },
  tombstones: [] as string[],
};

/** A key the request entered, as encryption leaves it: a ciphertext no stored document holds. */
const ENTERED_KEY = 'v3:11111111111111111111111111111111:abcdef';

function check(
  writes: ConfigFieldWrite[],
  base = yaml,
  document: StoredDocument = stored,
  entered: ReadonlySet<string> = new Set([ENTERED_KEY]),
) {
  return findSecretReentry({
    stored: document,
    candidate: setConfigFields(toConfigOverrideState(document), writes),
    base,
    entered,
  });
}

describe('findSecretReentry', () => {
  describe('the mcpConfig alias, which the merge applies like mcpServers', () => {
    const aliased: StoredDocument = {
      overrides: {
        mcpConfig: {
          aliasA: {
            type: 'streamable-http',
            url: 'https://good.example/mcp',
            apiKey: { source: 'admin', authorization_type: 'bearer', key: STORED_KEY },
          },
        },
      },
      tombstones: [],
    };

    it('refuses a URL change under a key stored in the alias', () => {
      expect(
        check(
          [{ segments: ['mcpConfig', 'aliasA', 'url'], value: 'https://evil.example/mcp' }],
          yaml,
          aliased,
        ),
      ).toMatchObject({ code: 'MCP_API_KEY_REENTRY_REQUIRED', server: 'aliasA', fields: ['url'] });
    });

    it('accepts the change when the key is entered again', () => {
      expect(
        check(
          [
            { segments: ['mcpConfig', 'aliasA', 'url'], value: 'https://evil.example/mcp' },
            { segments: ['mcpConfig', 'aliasA', 'apiKey', 'key'], value: ENTERED_KEY },
          ],
          yaml,
          aliased,
        ),
      ).toBeNull();
    });

    it('resolves an alias server over its librechat.yaml entry and tombstones', () => {
      const yamlKeyed = {
        overrides: {
          mcpConfig: {
            tools: { apiKey: { source: 'admin', authorization_type: 'bearer', key: STORED_KEY } },
          },
        },
        tombstones: [] as string[],
      };
      expect(
        findSecretReentry({
          stored: yamlKeyed,
          candidate: { ...toConfigOverrideState(yamlKeyed), tombstones: ['mcpConfig.tools.url'] },
          base: yaml,
          entered: new Set(),
        }),
      ).toMatchObject({ server: 'tools', fields: ['url'] });
    });
  });

  it('compares servers as they resolve over librechat.yaml', () => {
    expect(
      check([{ segments: ['mcpServers', 'tools', 'url'], value: 'https://evil.example/mcp' }]),
    ).toEqual({
      code: 'MCP_API_KEY_REENTRY_REQUIRED',
      message: expect.stringContaining('url'),
      server: 'tools',
      fields: ['url'],
    });

    /** Spelling out the URL librechat.yaml already gives changes nothing. */
    expect(
      check([{ segments: ['mcpServers', 'tools', 'url'], value: 'https://yaml.example/mcp' }]),
    ).toBeNull();
  });

  it('catches a binding change that only shows on the resolved server, such as a tombstoned URL', () => {
    const document = { ...stored, tombstones: ['mcpServers.tools.url'] };
    const candidate = toConfigOverrideState(document);
    expect(
      findSecretReentry({
        stored,
        candidate,
        base: yaml,
        entered: new Set(),
      }),
    ).toMatchObject({ fields: ['url'] });
  });

  it('lets a write that supplies the key change the binding', () => {
    expect(
      check([
        { segments: ['mcpServers', 'tools', 'url'], value: 'https://moved.example/mcp' },
        { segments: ['mcpServers', 'tools', 'apiKey', 'key'], value: ENTERED_KEY },
      ]),
    ).toBeNull();
  });

  it('ignores a key the write removes and a key that is a visible reference', () => {
    expect(
      check([
        { segments: ['mcpServers', 'tools', 'url'], value: 'https://moved.example/mcp' },
        {
          segments: ['mcpServers', 'tools', 'apiKey'],
          value: { source: 'user', authorization_type: 'bearer' },
        },
      ]),
    ).toBeNull();

    const reference = {
      overrides: {
        mcpServers: {
          tools: { apiKey: { source: 'admin', authorization_type: 'bearer', key: '${K}' } },
        },
      },
      tombstones: [] as string[],
    };
    expect(
      check(
        [{ segments: ['mcpServers', 'tools', 'url'], value: 'https://moved.example/mcp' }],
        yaml,
        reference,
      ),
    ).toBeNull();
  });

  it('treats how the key is sent as part of its binding, as the user tier does', () => {
    /** The key as secret preservation leaves it: kept from the stored document, not supplied. */
    const writes: ConfigFieldWrite[] = [
      {
        segments: ['mcpServers', 'tools', 'apiKey'],
        value: {
          source: 'admin',
          authorization_type: 'custom',
          custom_header: 'X-Key',
          key: STORED_KEY,
        },
      },
    ];
    expect(
      findSecretReentry({
        stored,
        candidate: setConfigFields(toConfigOverrideState(stored), writes),
        base: yaml,
        entered: new Set(),
      }),
    ).toMatchObject({ fields: ['apiKey.authorization_type', 'apiKey.custom_header'] });
  });

  it('binds a kept OAuth client secret to the proxy its access token is sent through', () => {
    const oauthStored: StoredDocument = {
      overrides: {
        mcpServers: {
          tools: {
            oauth: {
              client_id: 'client',
              client_secret: STORED_KEY,
              authorization_url: 'https://auth.example/authorize',
              token_url: 'https://auth.example/token',
            },
          },
        },
      },
      tombstones: [],
    };
    const proxy: ConfigFieldWrite = {
      segments: ['mcpServers', 'tools', 'proxy'],
      value: 'http://proxy.evil.example:8080',
    };

    expect(check([proxy], yaml, oauthStored)).toMatchObject({
      code: 'MCP_OAUTH_SECRET_REENTRY_REQUIRED',
      server: 'tools',
      fields: ['proxy'],
    });
    expect(
      check(
        [
          proxy,
          { segments: ['mcpServers', 'tools', 'oauth', 'client_secret'], value: ENTERED_KEY },
        ],
        yaml,
        oauthStored,
      ),
    ).toBeNull();
  });

  describe('a key is judged by the value the document ends up with, not by the paths written', () => {
    const GOOD = 'https://good.example/mcp';
    const EVIL = 'https://evil.example/mcp';
    const OTHER_KEY = 'v3:22222222222222222222222222222222:abcdef';
    const server = (url: string, key: string) => ({
      type: 'streamable-http',
      url,
      apiKey: { source: 'admin', authorization_type: 'bearer', key },
    });
    const document = (servers: Record<string, unknown>): StoredDocument => ({
      overrides: { mcpServers: servers },
      tombstones: [],
    });
    const judge = (
      from: StoredDocument,
      servers: Record<string, unknown>,
      entered: ReadonlySet<string> = new Set(),
    ) =>
      findSecretReentry({
        stored: from,
        candidate: toConfigOverrideState(document(servers)),
        base: {},
        entered,
      });

    it('refuses a stored key put back beside a new URL, though the request entered a decoy at its path', () => {
      /** The decoy was entered, but a later write of the request put the stored ciphertext back. */
      expect(
        judge(
          document({ probe: server(GOOD, STORED_KEY) }),
          { probe: server(EVIL, STORED_KEY) },
          new Set([ENTERED_KEY]),
        ),
      ).toMatchObject({ code: 'MCP_API_KEY_REENTRY_REQUIRED', server: 'probe', fields: ['url'] });
    });

    it('accepts the URL change when the document holds the key the request entered', () => {
      expect(
        judge(
          document({ probe: server(GOOD, STORED_KEY) }),
          { probe: server(EVIL, ENTERED_KEY) },
          new Set([ENTERED_KEY]),
        ),
      ).toBeNull();
    });

    it('follows a key to the server it was renamed or copied from, under any name', () => {
      const before = document({ probe: server(GOOD, STORED_KEY) });

      expect(judge(before, { renamed: server(EVIL, STORED_KEY) })).toMatchObject({
        server: 'renamed',
        fields: ['url'],
      });
      expect(judge(before, { renamed: server(GOOD, STORED_KEY) })).toBeNull();
      expect(
        judge(before, { probe: server(GOOD, STORED_KEY), copy: server(EVIL, STORED_KEY) }),
      ).toMatchObject({ server: 'copy', fields: ['url'] });
    });

    it('accepts a name swap that moves each key with its own server', () => {
      const before = document({ a: server(GOOD, STORED_KEY), b: server(EVIL, OTHER_KEY) });

      expect(judge(before, { a: server(EVIL, OTHER_KEY), b: server(GOOD, STORED_KEY) })).toBeNull();
      /** Swapping the keys but not the URLs sends each key somewhere new. */
      expect(
        judge(before, { a: server(GOOD, OTHER_KEY), b: server(EVIL, STORED_KEY) }),
      ).toMatchObject({
        server: 'a',
        fields: ['url'],
      });
    });

    it('finds the origin of a legacy plaintext key that preservation encrypted on the way', () => {
      const legacy = 'sk-legacy-plaintext-key-0001';
      const carried = encryptV3(legacy);

      expect(
        judge(document({ probe: server(GOOD, legacy) }), { renamed: server(EVIL, carried) }),
      ).toMatchObject({ server: 'renamed', fields: ['url'] });
      expect(
        judge(document({ probe: server(GOOD, legacy) }), { renamed: server(GOOD, carried) }),
      ).toBeNull();
    });
  });
});

describe('getAzureGroupReentryIssues', () => {
  const yamlGroupMap = {
    east: { apiKey: 'yaml-literal-key', instanceName: 'east', version: '2024-10-21', models: {} },
  };
  const yamlBase = { groups: [{ group: 'east', ...yamlGroupMap.east }], groupMap: yamlGroupMap };
  const group = (overrides: Record<string, unknown> = {}) => ({
    group: 'west',
    apiKey: STORED_KEY,
    instanceName: 'west',
    version: '2024-10-21',
    deploymentName: 'gpt-5',
    models: { 'gpt-5': true },
    ...overrides,
  });
  const storedGroups: StoredDocument = {
    overrides: { endpoints: { azureOpenAI: { groups: [group()] } } },
    tombstones: [],
  };

  function judge(writes: ConfigFieldWrite[], document: StoredDocument = storedGroups) {
    return getAzureGroupReentryIssues({
      stored: document,
      candidate: setConfigFields(toConfigOverrideState(document), writes),
      base: yamlBase,
      entered: new Set([ENTERED_KEY]),
    });
  }

  const groupsWrite = (...groups: Record<string, unknown>[]): ConfigFieldWrite[] => [
    { segments: ['endpoints', 'azureOpenAI', 'groups'], value: groups },
  ];

  it('refuses a kept key under a moved instance, and accepts it entered again', () => {
    expect(judge(groupsWrite(group({ instanceName: 'attacker' })))).toEqual([
      {
        path: 'endpoints.azureOpenAI.groups.0.instanceName',
        segments: ['endpoints', 'azureOpenAI', 'groups', '0', 'instanceName'],
        code: 'secret_reentry_required',
        secretPath: 'endpoints.azureOpenAI.groups.0.apiKey',
      },
    ]);
    expect(judge(groupsWrite(group({ instanceName: 'attacker', apiKey: ENTERED_KEY })))).toEqual(
      [],
    );
    expect(judge(groupsWrite(group({ version: '2025-01-01' })))).toEqual([]);
  });

  it("judges a partial item merged over librechat.yaml's group of its name", () => {
    const partial: StoredDocument = {
      overrides: {
        endpoints: { azureOpenAI: { groups: [{ group: 'east', apiKey: STORED_KEY }] } },
      },
      tombstones: [],
    };
    const write = (item: Record<string, unknown>) =>
      judge(groupsWrite({ group: 'east', apiKey: STORED_KEY, ...item }), partial);

    expect(write({ models: { 'gpt-4o': { deploymentName: 'gpt-4o', version: 'v' } } })).toEqual([]);
    expect(write({ instanceName: 'east' })).toEqual([]);
    expect(write({ instanceName: 'attacker' })).toEqual([
      {
        path: 'endpoints.azureOpenAI.groups.0.instanceName',
        segments: ['endpoints', 'azureOpenAI', 'groups', '0', 'instanceName'],
        code: 'secret_reentry_required',
        secretPath: 'endpoints.azureOpenAI.groups.0.apiKey',
      },
    ]);
  });

  it('judges a group that does not resolve yet, so a later write cannot put the move to use', () => {
    const unresolved = group({ instanceName: 'attacker', deploymentName: undefined });

    expect(judge(groupsWrite(unresolved)).map(({ path }) => path)).toEqual([
      'endpoints.azureOpenAI.groups.0.instanceName',
    ]);
  });

  it('judges a groupMap key over the group librechat.yaml resolves, under the tombstones', () => {
    const mapped: StoredDocument = {
      overrides: { endpoints: { azureOpenAI: { groupMap: { east: { apiKey: STORED_KEY } } } } },
      tombstones: [],
    };
    const tombstoned = getAzureGroupReentryIssues({
      stored: mapped,
      candidate: {
        ...toConfigOverrideState(mapped),
        tombstones: ['endpoints.azureOpenAI.groupMap.east.instanceName'],
      },
      base: yamlBase,
      entered: new Set(),
    });

    expect(
      judge(
        [
          {
            segments: ['endpoints', 'azureOpenAI', 'groupMap', 'east', 'instanceName'],
            value: 'east',
          },
        ],
        mapped,
      ),
    ).toEqual([]);
    expect(tombstoned.map(({ path, secretPath }) => [path, secretPath])).toEqual([
      [
        'endpoints.azureOpenAI.groupMap.east.instanceName',
        'endpoints.azureOpenAI.groupMap.east.apiKey',
      ],
    ]);
  });

  it('judges a groupMap key without the groups librechat.yaml resolves once they are tombstoned', () => {
    const mapped: StoredDocument = {
      overrides: { endpoints: { azureOpenAI: { groupMap: { east: { apiKey: STORED_KEY } } } } },
      tombstones: [],
    };

    const issues = getAzureGroupReentryIssues({
      stored: mapped,
      candidate: {
        ...toConfigOverrideState(mapped),
        tombstones: ['endpoints.azureOpenAI.groups'],
      },
      base: yamlBase,
      entered: new Set(),
    });

    expect(issues.map(({ path, secretPath }) => [path, secretPath])).toEqual([
      [
        'endpoints.azureOpenAI.groupMap.east.instanceName',
        'endpoints.azureOpenAI.groupMap.east.apiKey',
      ],
    ]);
  });

  it("leaves librechat.yaml's own keys to the merge", () => {
    const empty: StoredDocument = { overrides: {}, tombstones: [] };

    expect(
      judge(
        [
          {
            segments: ['endpoints', 'azureOpenAI', 'groupMap', 'east', 'instanceName'],
            value: 'x',
          },
        ],
        empty,
      ),
    ).toEqual([]);
  });
});

describe('getBoundKeyReentryIssues', () => {
  /** librechat.yaml's resolved config: one custom endpoint and an OCR service. */
  const baseConfig = {
    config: {},
    endpoints: {
      custom: [{ name: 'Ollama', apiKey: 'ollama', baseURL: 'http://ollama:11434/v1', models: {} }],
    },
    ocr: { baseURL: 'https://ocr.yaml.example/v1' },
  } as unknown as AppConfig;

  const document = (overrides: Record<string, unknown>): StoredDocument => ({
    overrides,
    tombstones: [],
  });
  const endpointDoc = (entry: Record<string, unknown> = {}) =>
    document({
      endpoints: {
        custom: [
          {
            name: 'Gateway',
            apiKey: STORED_KEY,
            baseURL: 'https://gateway.example/v1',
            models: { default: ['m'] },
            ...entry,
          },
        ],
      },
    });

  function issues(
    stored: StoredDocument,
    writes: ConfigFieldWrite[],
    entered: ReadonlySet<string> = new Set(),
  ) {
    return getBoundKeyReentryIssues({
      stored,
      candidate: setConfigFields(toConfigOverrideState(stored), writes),
      baseConfig,
      entered,
    });
  }

  const endpointIssue = (field: string) => ({
    path: `endpoints.custom.0.${field}`,
    segments: ['endpoints', 'custom', '0', ...field.split('.')],
    code: 'secret_reentry_required',
    secretPath: 'endpoints.custom.0.apiKey',
  });

  it.each([
    ['baseURL', 'https://attacker.example/v1', 'baseURL'],
    ['provider', 'anthropic', 'provider'],
    ['addParams', { anthropicApiUrl: 'https://attacker.example' }, 'addParams.anthropicApiUrl'],
    ['dropParams', ['clientOptions'], 'dropParams'],
  ])('refuses a %s change beside a kept endpoint key', (field, value, reported) => {
    expect(
      issues(endpointDoc(), [{ segments: ['endpoints', 'custom', '0', field], value }]),
    ).toEqual([endpointIssue(reported)]);
  });

  it('accepts the move when the key is entered again, and an edit that moves nothing', () => {
    expect(
      issues(
        endpointDoc(),
        [
          {
            segments: ['endpoints', 'custom', '0', 'baseURL'],
            value: 'https://attacker.example/v1',
          },
          { segments: ['endpoints', 'custom', '0', 'apiKey'], value: ENTERED_KEY },
        ],
        new Set([ENTERED_KEY]),
      ),
    ).toEqual([]);
    expect(
      issues(endpointDoc(), [
        { segments: ['endpoints', 'custom', '0', 'models'], value: { default: ['n'] } },
        {
          segments: ['endpoints', 'custom', '0', 'baseURL'],
          value: 'https://gateway.example/v1#x',
        },
      ]),
    ).toEqual([]);
  });

  it('follows a renamed key by value, and refuses it under a name librechat.yaml points elsewhere', () => {
    const keyOnly = document({
      endpoints: { custom: [{ name: 'Gateway', apiKey: STORED_KEY, models: {} }] },
    });
    expect(
      issues(endpointDoc(), [{ segments: ['endpoints', 'custom', '0', 'name'], value: 'Renamed' }]),
    ).toEqual([]);
    expect(
      issues(keyOnly, [{ segments: ['endpoints', 'custom', '0', 'name'], value: 'ollama' }]),
    ).toEqual([endpointIssue('baseURL')]);
  });

  it('accepts a key moved onto the destination it was bound to over a lower layer', () => {
    const boundTo = {
      name: 'Gateway',
      baseURL: 'https://base.example/v1',
      models: { default: ['m'] },
    };
    const bound = endpointDoc({
      baseURL: undefined,
      apiKeyBinding: getCustomEndpointFingerprint(boundTo),
    });
    expect(
      issues(bound, [
        { segments: ['endpoints', 'custom', '0', 'baseURL'], value: 'https://base.example/v1' },
      ]),
    ).toEqual([]);
    expect(
      issues(bound, [
        { segments: ['endpoints', 'custom', '0', 'baseURL'], value: 'https://attacker.example/v1' },
      ]),
    ).toEqual([endpointIssue('baseURL')]);
  });

  it('refuses a scalar move, a removal or tombstone of its destination included', () => {
    const ocr = document({ ocr: { apiKey: STORED_KEY, baseURL: 'https://ocr.example/v1' } });
    const expected = [
      {
        path: 'ocr.baseURL',
        segments: ['ocr', 'baseURL'],
        code: 'secret_reentry_required',
        secretPath: 'ocr.apiKey',
      },
    ];
    expect(
      issues(ocr, [{ segments: ['ocr', 'baseURL'], value: 'https://attacker.example/v1' }]),
    ).toEqual(expected);
    expect(
      getBoundKeyReentryIssues({
        stored: ocr,
        candidate: { overrides: { ocr: { apiKey: STORED_KEY } }, tombstones: [] },
        baseConfig,
        entered: new Set(),
      }),
    ).toEqual(expected);
    expect(
      getBoundKeyReentryIssues({
        stored: ocr,
        candidate: { overrides: { ocr: { apiKey: STORED_KEY } }, tombstones: ['ocr.baseURL'] },
        baseConfig,
        entered: new Set(),
      }),
    ).toEqual(expected);
  });

  it('leaves visible references and keys the request entered alone', () => {
    const referenced = document({
      ocr: { apiKey: '${OCR_API_KEY}', baseURL: 'https://ocr.example/v1' },
      endpoints: {
        custom: [{ name: 'Gateway', apiKey: 'user_provided', baseURL: 'https://g/v1' }],
      },
    });
    expect(
      issues(referenced, [
        { segments: ['ocr', 'baseURL'], value: 'https://attacker.example/v1' },
        { segments: ['endpoints', 'custom', '0', 'baseURL'], value: 'https://attacker.example/v1' },
      ]),
    ).toEqual([]);
  });

  it('keeps a scalar key bound to the destination it was entered for over a lower layer', () => {
    const binding = SECRET_BINDINGS.find(({ path }) => path.join('.') === 'ocr')!;
    const bound = document({
      ocr: {
        apiKey: STORED_KEY,
        apiKeyBinding: getScalarBindingFingerprint(binding, { baseURL: 'https://base.example/v1' }),
      },
    });
    expect(
      issues(bound, [{ segments: ['ocr', 'baseURL'], value: 'https://base.example/v1' }]),
    ).toEqual([]);
  });
});

describe('a stored key bound to a destination over a lower layer', () => {
  it('lets an MCP write restate the destination its key was bound to, and nothing else', () => {
    const bound: StoredDocument = {
      overrides: {
        mcpServers: {
          shared: {
            apiKey: {
              source: 'admin',
              authorization_type: 'bearer',
              key: STORED_KEY,
              keyBinding: getServerSecretFingerprint('apiKey', {
                url: 'https://base.example/mcp',
                apiKey: { authorization_type: 'bearer' },
              }),
            },
          },
        },
      },
      tombstones: [],
    };
    const restate = (url: string) =>
      check([{ segments: ['mcpServers', 'shared', 'url'], value: url }], yaml, bound, new Set());

    expect(restate('https://base.example/mcp')).toBeNull();
    expect(restate('https://attacker.example/mcp')).toMatchObject({
      code: 'MCP_API_KEY_REENTRY_REQUIRED',
      server: 'shared',
      fields: ['url'],
    });
  });

  it('lets an Azure groupMap write restate the destination its key was bound to', () => {
    const bound: StoredDocument = {
      overrides: {
        endpoints: {
          azureOpenAI: {
            groupMap: {
              shared: {
                apiKey: STORED_KEY,
                apiKeyBinding: getAzureGroupFingerprint({ baseURL: 'https://base.example/openai' }),
              },
            },
          },
        },
      },
      tombstones: [],
    };
    const restate = (baseURL: string) =>
      getAzureGroupReentryIssues({
        stored: bound,
        candidate: setConfigFields(toConfigOverrideState(bound), [
          {
            segments: ['endpoints', 'azureOpenAI', 'groupMap', 'shared', 'baseURL'],
            value: baseURL,
          },
        ]),
        base: { groups: undefined, groupMap: {} },
        entered: new Set(),
      });

    expect(restate('https://base.example/openai')).toEqual([]);
    expect(restate('https://attacker.example/openai').map(({ path }) => path)).toEqual([
      'endpoints.azureOpenAI.groupMap.shared.baseURL',
    ]);
  });
});
