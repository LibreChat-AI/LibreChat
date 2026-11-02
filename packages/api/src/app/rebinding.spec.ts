import { PrincipalType } from 'librechat-data-provider';
import { mergeConfigOverrides } from '@librechat/data-schemas';
import type { AppConfig, ConfigOverrideLayer } from '@librechat/data-schemas';
import type { SecretRebinding } from './rebinding';
import {
  withoutSecretBindings,
  toIgnoredSecretOverride,
  createSecretRebindingGuard,
} from './rebinding';

function layer(
  overrides: Record<string, unknown>,
  principalId = 'editors',
  priority = 10,
): ConfigOverrideLayer {
  return {
    principalType: PrincipalType.ROLE,
    principalId,
    priority,
    overrides,
  } as ConfigOverrideLayer;
}

const customEndpoint = {
  name: 'Gateway',
  apiKey: '${GATEWAY_KEY}',
  baseURL: 'https://gateway.example.com/v1',
  models: { default: ['gpt-4o'] },
};

const mcpServer = {
  type: 'streamable-http',
  url: 'https://mcp.example.com/mcp',
  apiKey: { source: 'admin', authorization_type: 'bearer', key: '${MCP_KEY}' },
  oauth: {
    client_id: 'client',
    client_secret: '${MCP_CLIENT_SECRET}',
    authorization_url: 'https://auth.example.com/authorize',
    token_url: 'https://auth.example.com/token',
  },
};

function baseConfig(): AppConfig {
  const config = {
    endpoints: { custom: [customEndpoint] },
    mcpServers: { tools: mcpServer },
    ocr: { apiKey: '${OCR_API_KEY}', baseURL: 'https://api.mistral.ai/v1' },
    webSearch: {
      firecrawlApiKey: '${FIRECRAWL_API_KEY}',
      firecrawlApiUrl: 'https://api.firecrawl.dev',
    },
  };
  return {
    config,
    endpoints: { custom: [{ ...customEndpoint }] },
    mcpConfig: { tools: structuredClone(mcpServer) },
    ocr: { ...config.ocr },
    webSearch: { ...config.webSearch },
  } as unknown as AppConfig;
}

function merge(
  layers: ConfigOverrideLayer[],
  base = baseConfig(),
  derivation: { rederiveEndpoints?: boolean } = {},
) {
  const rebindings: SecretRebinding[] = [];
  const merged = mergeConfigOverrides(base, layers, {
    ...derivation,
    afterLayer: createSecretRebindingGuard((rebinding) => rebindings.push(rebinding)),
  });
  return { merged, rebindings, ignored: rebindings.map(toIgnoredSecretOverride) };
}

/** {@link merge} as `CONFIG_REDERIVE_ENDPOINTS` runs it: a layer's Azure groups resolved. */
function mergeGroups(layers: ConfigOverrideLayer[], base = baseConfig()) {
  return merge(layers, base, { rederiveEndpoints: true });
}

describe('createSecretRebindingGuard', () => {
  it('drops an inherited custom endpoint key when a layer points the endpoint elsewhere', () => {
    const { merged, ignored } = merge([
      layer({ endpoints: { custom: [{ name: 'Gateway', baseURL: 'https://evil.example/v1' }] } }),
    ]);

    expect(merged.endpoints?.custom?.[0]).toMatchObject({
      name: 'Gateway',
      apiKey: '',
      baseURL: 'https://evil.example/v1',
    });
    expect(ignored).toEqual([
      {
        path: 'endpoints.custom["Gateway"].apiKey',
        segments: ['endpoints', 'custom', 'Gateway', 'apiKey'],
        reason: 'secret_rebinding',
      },
    ]);
  });

  it('keeps the key when the layer supplies it again, or leaves the binding as it was', () => {
    const resupplied = merge([
      layer({
        endpoints: {
          custom: [
            { name: 'Gateway', baseURL: 'https://other.example/v1', apiKey: '${OTHER_KEY}' },
          ],
        },
      }),
    ]);
    expect(resupplied.merged.endpoints?.custom?.[0]?.apiKey).toBe('${OTHER_KEY}');
    expect(resupplied.rebindings).toEqual([]);

    const sameHost = merge([
      layer({
        endpoints: {
          custom: [{ name: 'Gateway', baseURL: 'https://gateway.example.com/v1#frag' }],
        },
      }),
    ]);
    expect(sameHost.merged.endpoints?.custom?.[0]?.apiKey).toBe('${GATEWAY_KEY}');

    const unrelated = merge([
      layer({ endpoints: { custom: [{ name: 'Gateway', models: { default: ['gpt-5'] } }] } }),
    ]);
    expect(unrelated.merged.endpoints?.custom?.[0]?.apiKey).toBe('${GATEWAY_KEY}');
    expect(unrelated.rebindings).toEqual([]);
  });

  /**
   * The documented limit of the guard: a `${VAR}` reference is visible to config readers, so a
   * layer that restates it beside a destination of its own enters it, as it would any key. Which
   * names a layer may reference is the env allowlist's to decide (`app/allowlist.ts`).
   */
  it('keeps an inherited ${VAR} reference a layer restates beside its own destination', () => {
    const restated = merge([
      layer({
        endpoints: {
          custom: [
            { name: 'Gateway', baseURL: 'https://evil.example/v1', apiKey: '${GATEWAY_KEY}' },
          ],
        },
        mcpServers: {
          tools: {
            url: 'https://evil.example/mcp',
            apiKey: { source: 'admin', authorization_type: 'bearer', key: '${MCP_KEY}' },
            oauth: { client_secret: '${MCP_CLIENT_SECRET}' },
          },
        },
        ocr: { baseURL: 'https://evil.example/ocr', apiKey: '${OCR_API_KEY}' },
      }),
    ]);
    expect(restated.merged.endpoints?.custom?.[0]).toMatchObject({
      apiKey: '${GATEWAY_KEY}',
      baseURL: 'https://evil.example/v1',
    });
    expect(restated.merged.mcpConfig?.tools?.apiKey?.key).toBe('${MCP_KEY}');
    expect(restated.merged.mcpConfig?.tools?.oauth?.client_secret).toBe('${MCP_CLIENT_SECRET}');
    expect(restated.merged.ocr?.apiKey).toBe('${OCR_API_KEY}');
    expect(restated.rebindings).toEqual([]);

    const moved = merge([
      layer({
        endpoints: { custom: [{ name: 'Gateway', baseURL: 'https://evil.example/v1' }] },
        mcpServers: { tools: { url: 'https://evil.example/mcp' } },
        ocr: { baseURL: 'https://evil.example/ocr' },
      }),
    ]);
    expect(moved.ignored.map(({ path }) => path)).toEqual([
      'ocr.apiKey',
      'endpoints.custom["Gateway"].apiKey',
      'mcpServers.tools.apiKey.key',
      'mcpServers.tools.oauth.client_secret',
    ]);
  });

  it('drops an inherited MCP api key when the server URL changes', () => {
    const { merged, ignored } = merge([
      layer({ mcpServers: { tools: { url: 'https://evil.example/mcp' } } }),
    ]);

    const server = merged.mcpConfig?.tools as typeof mcpServer;
    expect(server.apiKey.key).toBe('');
    /** The OAuth secret is bound to the server URL too, as in the user-managed tier. */
    expect(server.oauth.client_secret).toBe('');
    expect(ignored.map(({ path }) => path)).toEqual([
      'mcpServers.tools.apiKey.key',
      'mcpServers.tools.oauth.client_secret',
    ]);
  });

  it('drops only the OAuth secret when only its endpoints change', () => {
    const { merged, ignored } = merge([
      layer({ mcpServers: { tools: { oauth: { token_url: 'https://evil.example/token' } } } }),
    ]);

    const server = merged.mcpConfig?.tools as typeof mcpServer;
    expect(server.apiKey.key).toBe('${MCP_KEY}');
    expect(server.oauth.client_secret).toBe('');
    expect(ignored.map(({ path }) => path)).toEqual(['mcpServers.tools.oauth.client_secret']);
  });

  it('drops an inherited OAuth secret when a layer routes its access token through a proxy', () => {
    const oauthOnly = baseConfig();
    const { type, url, oauth } = mcpServer;
    oauthOnly.mcpConfig = {
      tools: structuredClone({ type, url, oauth }),
    } as AppConfig['mcpConfig'];

    const { merged, ignored } = merge(
      [layer({ mcpServers: { tools: { proxy: 'http://proxy.evil.example:8080' } } })],
      oauthOnly,
    );

    expect((merged.mcpConfig?.tools as typeof mcpServer).oauth.client_secret).toBe('');
    expect(ignored.map(({ path }) => path)).toEqual(['mcpServers.tools.oauth.client_secret']);
  });

  it('treats the http transport spelling as the same binding', () => {
    const { rebindings } = merge([layer({ mcpServers: { tools: { type: 'http' } } })]);
    expect(rebindings).toEqual([]);
  });

  it('drops scalar secrets bound to a URL beside them', () => {
    const { merged, ignored } = merge([layer({ ocr: { baseURL: 'https://evil.example/v1' } })]);

    expect(merged.ocr?.apiKey).toBe('');
    expect(ignored.map(({ path }) => path)).toEqual(['ocr.apiKey']);
  });

  it('leaves web search keys to the merge rule, under which web search reads env keys', () => {
    const { merged, rebindings } = merge([
      layer({ webSearch: { firecrawlApiUrl: 'https://evil.example' } }),
    ]);

    expect(merged.webSearch?.firecrawlApiKey).toBe('${FIRECRAWL_API_KEY}');
    expect(rebindings).toEqual([]);
  });

  it('keeps a key a higher layer supplies with the destination it sets itself', () => {
    const { merged, rebindings } = merge([
      layer({ mcpServers: { tools: { url: 'https://moved.example/mcp' } } }, '__base__', 0),
      layer(
        {
          mcpServers: {
            tools: {
              url: 'https://editors.example/mcp',
              apiKey: { source: 'admin', authorization_type: 'bearer', key: '${EDITORS_KEY}' },
            },
          },
        },
        'editors',
        10,
      ),
    ]);

    const server = merged.mcpConfig?.tools as typeof mcpServer;
    expect(server.url).toBe('https://editors.example/mcp');
    expect(server.apiKey.key).toBe('${EDITORS_KEY}');
    expect(rebindings.map(({ layer: { principalId }, path }) => [principalId, path])).toEqual([
      ['__base__', 'mcpServers.tools.apiKey.key'],
      ['__base__', 'mcpServers.tools.oauth.client_secret'],
    ]);
  });

  describe('a key a layer supplies, under a destination a lower layer moved', () => {
    const editorsKey = (key = 'v3:editors-ciphertext') =>
      layer(
        {
          mcpServers: { tools: { apiKey: { source: 'admin', authorization_type: 'bearer', key } } },
        },
        'editors',
        10,
      );

    it('drops the key when a lower layer moved the server URL beneath it', () => {
      const { merged, rebindings } = merge([
        layer({ mcpServers: { tools: { url: 'https://evil.example/mcp' } } }, '__base__', 0),
        editorsKey(),
      ]);

      const server = merged.mcpConfig?.tools as typeof mcpServer;
      expect(server.url).toBe('https://evil.example/mcp');
      expect(server.apiKey.key).toBe('');
      expect(rebindings.map(({ layer: { principalId }, path }) => [principalId, path])).toEqual([
        ['__base__', 'mcpServers.tools.apiKey.key'],
        ['__base__', 'mcpServers.tools.oauth.client_secret'],
        ['editors', 'mcpServers.tools.apiKey.key'],
      ]);
    });

    it('drops the key when a lower profile routes the server through its own proxy', () => {
      const { merged, rebindings } = merge([
        layer({ mcpServers: { tools: { proxy: 'http://proxy.evil.example:8080' } } }, 'low', 5),
        editorsKey(),
      ]);

      expect((merged.mcpConfig?.tools as typeof mcpServer).apiKey.key).toBe('');
      expect(rebindings.map(({ layer: { principalId }, path }) => [principalId, path])).toEqual([
        ['low', 'mcpServers.tools.apiKey.key'],
        ['low', 'mcpServers.tools.oauth.client_secret'],
        ['editors', 'mcpServers.tools.apiKey.key'],
      ]);
    });

    it('keeps a key and URL the layer sets on a server a lower layer defines, type and all', () => {
      const { merged, rebindings } = merge([
        layer(
          {
            mcpServers: {
              defined: {
                type: 'streamable-http',
                url: 'https://base.example/mcp',
                apiKey: { source: 'admin', authorization_type: 'bearer', key: 'v3:base' },
              },
            },
          },
          '__base__',
          0,
        ),
        layer(
          {
            mcpServers: {
              defined: {
                url: 'https://editors.example/mcp',
                apiKey: { source: 'admin', authorization_type: 'bearer', key: 'v3:editors' },
              },
            },
          },
          'editors',
          10,
        ),
      ]);

      expect(merged.mcpConfig?.defined).toMatchObject({
        type: 'streamable-http',
        url: 'https://editors.example/mcp',
        apiKey: { key: 'v3:editors' },
      });
      expect(rebindings).toEqual([]);
    });

    it('keeps the key when the layers below changed nothing that binds it', () => {
      const { merged, rebindings } = merge([
        layer({ mcpServers: { tools: { title: 'Tools', timeout: 30000 } } }, '__base__', 0),
        editorsKey(),
      ]);

      expect((merged.mcpConfig?.tools as typeof mcpServer).apiKey.key).toBe(
        'v3:editors-ciphertext',
      );
      expect(rebindings).toEqual([]);
    });

    it('drops a custom endpoint key when a lower layer moved the base URL beneath it', () => {
      const { merged, ignored, rebindings } = merge([
        layer(
          { endpoints: { custom: [{ name: 'Gateway', baseURL: 'https://attacker.example/v1' }] } },
          '__base__',
          0,
        ),
        layer(
          { endpoints: { custom: [{ name: 'Gateway', apiKey: 'v3:group-ciphertext' }] } },
          'group',
          20,
        ),
      ]);

      expect(merged.endpoints?.custom?.[0]).toMatchObject({
        apiKey: '',
        baseURL: 'https://attacker.example/v1',
      });
      expect(rebindings.map(({ layer: { principalId } }) => principalId)).toEqual([
        '__base__',
        'group',
      ]);
      expect(ignored[1]).toEqual({
        path: 'endpoints.custom["Gateway"].apiKey',
        segments: ['endpoints', 'custom', 'Gateway', 'apiKey'],
        reason: 'secret_rebinding',
      });
    });

    it('drops a scalar key when a lower layer moved its URL beneath it', () => {
      const { merged, rebindings } = merge([
        layer({ ocr: { baseURL: 'https://attacker.example/v1' } }, '__base__', 0),
        layer({ ocr: { apiKey: 'v3:ocr-ciphertext' } }, 'editors', 10),
      ]);

      expect(merged.ocr?.apiKey).toBe('');
      expect(rebindings.map(({ layer: { principalId }, path }) => [principalId, path])).toEqual([
        ['__base__', 'ocr.apiKey'],
        ['editors', 'ocr.apiKey'],
      ]);
    });

    it("measures the layer's destination after its own tombstones", () => {
      const { merged, rebindings } = merge([
        {
          ...layer({ ocr: { apiKey: 'v3:ocr-ciphertext' } }, 'editors', 10),
          tombstones: ['ocr.baseURL'],
        } as ConfigOverrideLayer,
      ]);

      expect(merged.ocr?.baseURL).toBeUndefined();
      expect(merged.ocr?.apiKey).toBe('v3:ocr-ciphertext');
      expect(rebindings).toEqual([]);
    });
  });

  describe('values each user supplies', () => {
    /** A base config with a `user_provided` endpoint beside the keyed one. */
    function withUserEndpoint(endpoint: Record<string, unknown> = {}): AppConfig {
      const base = baseConfig();
      (base.endpoints as { custom: unknown[] }).custom.push({
        ...customEndpoint,
        name: 'Regional',
        apiKey: 'user_provided',
        ...endpoint,
      });
      return base;
    }

    it("sets back the destination of a user_provided endpoint a layer moves, as users' keys follow its name", () => {
      const { merged, rebindings, ignored } = merge(
        [
          layer({
            endpoints: {
              custom: [{ name: 'Regional', baseURL: 'https://attacker.example/v1' }],
            },
          }),
        ],
        withUserEndpoint(),
      );

      expect(merged.endpoints?.custom?.[1]).toMatchObject({
        name: 'Regional',
        apiKey: 'user_provided',
        baseURL: customEndpoint.baseURL,
      });
      expect(rebindings.map(({ kind }) => kind)).toEqual(['destination']);
      expect(ignored).toEqual([
        {
          path: 'endpoints.custom["Regional"].baseURL',
          segments: ['endpoints', 'custom', 'Regional', 'baseURL'],
          reason: 'secret_rebinding',
        },
      ]);
    });

    it('sets back every destination setting, a restated user_provided included', () => {
      const { merged, ignored } = merge(
        [
          layer({
            endpoints: {
              custom: [
                {
                  name: 'Regional',
                  apiKey: 'user_provided',
                  provider: 'anthropic',
                  addParams: { anthropicApiUrl: 'https://attacker.example', promptCache: true },
                  dropParams: ['temperature', 'clientOptions'],
                  models: { default: ['claude'] },
                },
              ],
            },
          }),
        ],
        withUserEndpoint({ dropParams: ['temperature'] }),
      );

      const entry = merged.endpoints?.custom?.[1] as Record<string, unknown>;
      expect(entry).toMatchObject({
        name: 'Regional',
        apiKey: 'user_provided',
        baseURL: customEndpoint.baseURL,
        addParams: { promptCache: true },
        dropParams: ['temperature'],
        models: { default: ['claude'] },
      });
      expect(entry).not.toHaveProperty('provider');
      expect(entry.addParams).not.toHaveProperty('anthropicApiUrl');
      expect(ignored.map(({ path }) => path)).toEqual([
        'endpoints.custom["Regional"].addParams.anthropicApiUrl',
        'endpoints.custom["Regional"].dropParams',
        'endpoints.custom["Regional"].provider',
      ]);
    });

    it('sets back an endpoint that sends a user placeholder in its headers, or takes the user URL', () => {
      const withHeaders = baseConfig();
      (withHeaders.endpoints as { custom: Array<Record<string, unknown>> }).custom[0].headers = {
        Authorization: 'Bearer {{LIBRECHAT_OPENID_TOKEN}}',
      };
      const headers = merge(
        [
          layer({
            endpoints: { custom: [{ name: 'Gateway', baseURL: 'https://attacker.example/v1' }] },
          }),
        ],
        withHeaders,
      );
      expect(headers.merged.endpoints?.custom?.[0]).toMatchObject({
        apiKey: '${GATEWAY_KEY}',
        baseURL: customEndpoint.baseURL,
      });
      expect(headers.ignored.map(({ path }) => path)).toEqual([
        'endpoints.custom["Gateway"].baseURL',
      ]);

      const userURL = merge(
        [
          layer({
            endpoints: {
              custom: [{ name: 'Regional', baseURL: 'https://attacker.example/v1' }],
            },
          }),
        ],
        withUserEndpoint({ baseURL: 'user_provided' }),
      );
      expect(userURL.merged.endpoints?.custom?.[1]).toMatchObject({ baseURL: 'user_provided' });

      const userVars = merge(
        [
          layer({
            endpoints: {
              custom: [{ name: 'Regional', baseURL: 'https://attacker.example/v1' }],
            },
          }),
        ],
        withUserEndpoint({
          apiKey: '${GATEWAY_KEY}',
          customUserVars: { TEAM_TOKEN: { title: 'Team token' } },
        }),
      );
      expect(userVars.merged.endpoints?.custom?.[1]).toMatchObject({
        apiKey: '${GATEWAY_KEY}',
        baseURL: customEndpoint.baseURL,
      });
    });

    it('judges an endpoint that sends only who the user is like any other', () => {
      const identified = baseConfig();
      (identified.endpoints as { custom: Array<Record<string, unknown>> }).custom[0].headers = {
        'X-User': '{{LIBRECHAT_USER_ID}}',
        'X-Conversation': '{{LIBRECHAT_BODY_CONVERSATIONID}}',
      };
      const { merged, ignored } = merge(
        [
          layer({
            endpoints: { custom: [{ name: 'Gateway', baseURL: 'https://eu.gateway.example/v1' }] },
          }),
        ],
        identified,
      );
      expect(merged.endpoints?.custom?.[0]).toMatchObject({
        apiKey: '',
        baseURL: 'https://eu.gateway.example/v1',
      });
      expect(ignored.map(({ path }) => path)).toEqual(['endpoints.custom["Gateway"].apiKey']);
    });

    it('leaves a user_provided endpoint a layer only retitles, or redefines with a key of its own', () => {
      const retitled = merge(
        [layer({ endpoints: { custom: [{ name: 'Regional', modelDisplayLabel: 'EU' }] } })],
        withUserEndpoint(),
      );
      expect(retitled.rebindings).toEqual([]);

      const keyed = merge(
        [
          layer({
            endpoints: {
              custom: [
                {
                  name: 'Regional',
                  apiKey: 'v3:editors-key',
                  baseURL: 'https://eu.gateway.example/v1',
                },
              ],
            },
          }),
        ],
        withUserEndpoint(),
      );
      expect(keyed.merged.endpoints?.custom?.[1]).toMatchObject({
        apiKey: 'v3:editors-key',
        baseURL: 'https://eu.gateway.example/v1',
      });
      expect(keyed.rebindings).toEqual([]);
    });

    it("sets back an MCP server a layer moves while it sends each user's own values", () => {
      const base = baseConfig();
      Object.assign(base.mcpConfig as Record<string, unknown>, {
        personal: {
          type: 'streamable-http',
          url: 'https://personal.example/mcp',
          apiKey: { source: 'admin', authorization_type: 'bearer', key: '{{PERSONAL_TOKEN}}' },
          customUserVars: { PERSONAL_TOKEN: { title: 'Token', description: 'Yours' } },
        },
        headed: {
          type: 'sse',
          url: 'https://headed.example/sse',
          headers: { 'X-Token': '{{HEADED_TOKEN}}' },
        },
        userKey: {
          type: 'streamable-http',
          url: 'https://user-key.example/mcp',
          apiKey: { source: 'user', authorization_type: 'bearer' },
        },
      });
      const { merged, ignored } = merge(
        [
          layer({
            mcpServers: {
              personal: { url: 'https://attacker.example/mcp' },
              headed: { type: 'streamable-http', url: 'https://attacker.example/mcp' },
              userKey: { proxy: 'http://proxy.attacker.example:8080' },
            },
          }),
        ],
        base,
      );

      expect(merged.mcpConfig?.personal).toMatchObject({
        url: 'https://personal.example/mcp',
        apiKey: { key: '{{PERSONAL_TOKEN}}' },
      });
      expect(merged.mcpConfig?.headed).toMatchObject({
        type: 'sse',
        url: 'https://headed.example/sse',
      });
      expect(merged.mcpConfig?.userKey).not.toHaveProperty('proxy');
      expect(ignored.map(({ path }) => path)).toEqual([
        'mcpServers.personal.url',
        'mcpServers.headed.url',
        'mcpServers.headed.type',
        'mcpServers.userKey.proxy',
      ]);
    });

    it('never binds a key the layer enters to the destination it set back', () => {
      const base = baseConfig();
      Object.assign(base.mcpConfig as Record<string, unknown>, {
        personal: {
          type: 'streamable-http',
          url: 'https://personal.example/mcp',
          customUserVars: { TOKEN: { title: 'Token' } },
        },
      });
      const { merged, rebindings } = merge(
        [
          layer({
            mcpServers: {
              personal: {
                url: 'https://editors.example/mcp',
                apiKey: { source: 'admin', authorization_type: 'bearer', key: 'v3:editors' },
              },
            },
          }),
        ],
        base,
      );

      expect(merged.mcpConfig?.personal).toMatchObject({
        url: 'https://personal.example/mcp',
        apiKey: { key: '' },
      });
      expect(rebindings.map(({ kind, path, binding }) => [kind, path, binding])).toEqual([
        ['destination', 'mcpServers.personal.url', undefined],
        ['secret', 'mcpServers.personal.apiKey.key', undefined],
      ]);
    });

    it('leaves a server without user values, or one a layer only renames in the UI', () => {
      const base = baseConfig();
      Object.assign(base.mcpConfig as Record<string, unknown>, {
        open: { type: 'streamable-http', url: 'https://open.example/mcp' },
        personal: {
          type: 'streamable-http',
          url: 'https://personal.example/mcp',
          customUserVars: { TOKEN: { title: 'Token' } },
        },
      });
      const { merged, rebindings } = merge(
        [
          layer({
            mcpServers: {
              open: { url: 'https://eu.open.example/mcp' },
              personal: { title: 'Personal', type: 'http' },
            },
          }),
        ],
        base,
      );
      expect(merged.mcpConfig?.open).toMatchObject({ url: 'https://eu.open.example/mcp' });
      expect(merged.mcpConfig?.personal).toMatchObject({ title: 'Personal', type: 'http' });
      expect(rebindings).toEqual([]);
    });

    it('still drops an inherited ${ENV} reference, which resolves to a deployment credential', () => {
      const { merged } = merge([
        layer({
          endpoints: { custom: [{ name: 'Gateway', baseURL: 'https://eu.gateway.example/v1' }] },
        }),
      ]);
      expect(merged.endpoints?.custom?.[0]?.apiKey).toBe('');
    });
  });

  describe('a key a layer enters over a destination a layer below defines', () => {
    /** Base defines the endpoint, server and OCR service, each with a key of its own. */
    const baseLayer = (
      endpointURL = 'https://shared.example/v1',
      serverURL = 'https://shared.example/mcp',
      ocrURL = 'https://shared.example/ocr',
    ) =>
      layer(
        {
          endpoints: {
            custom: [
              {
                name: 'Shared',
                apiKey: 'v3:base-endpoint',
                baseURL: endpointURL,
                models: { default: ['m'] },
              },
            ],
            azureOpenAI: {
              groupMap: { shared: { apiKey: 'v3:base-group', baseURL: endpointURL } },
            },
          },
          mcpServers: {
            shared: {
              type: 'streamable-http',
              url: serverURL,
              apiKey: { source: 'admin', authorization_type: 'bearer', key: 'v3:base-server' },
            },
          },
          ocr: { apiKey: 'v3:base-ocr', baseURL: ocrURL },
        },
        '__base__',
        0,
      );

    /** The editors' own keys, each bound to the fingerprints `binding` names. */
    const editors = (binding: Record<string, string | undefined> = {}) =>
      layer({
        endpoints: {
          custom: [
            { name: 'Shared', apiKey: 'v3:editors-endpoint', apiKeyBinding: binding.endpoint },
          ],
          azureOpenAI: {
            groupMap: { shared: { apiKey: 'v3:editors-group', apiKeyBinding: binding.group } },
          },
        },
        mcpServers: {
          shared: {
            apiKey: {
              source: 'admin',
              authorization_type: 'bearer',
              key: 'v3:editors-server',
              keyBinding: binding.server,
            },
          },
        },
        ocr: { apiKey: 'v3:editors-ocr', apiKeyBinding: binding.ocr },
      });

    const shared = (config: AppConfig) =>
      config.endpoints?.custom?.find((entry) => entry?.name === 'Shared');

    const OWN_PATHS = [
      'ocr.apiKey',
      'endpoints.custom["Shared"].apiKey',
      'mcpServers.shared.apiKey.key',
      'endpoints.azureOpenAI.groupMap.shared.apiKey',
    ];

    /** The fingerprints the guard reports for each of the editors' keys over `base`. */
    function fingerprintsOver(base: ConfigOverrideLayer): Record<string, string | undefined> {
      const { rebindings } = merge([base, editors()]);
      const byPath = new Map(
        rebindings
          .filter(({ layer: { principalId } }) => principalId === 'editors')
          .map(({ path, binding }) => [path, binding]),
      );
      return {
        ocr: byPath.get('ocr.apiKey'),
        endpoint: byPath.get('endpoints.custom["Shared"].apiKey'),
        server: byPath.get('mcpServers.shared.apiKey.key'),
        group: byPath.get('endpoints.azureOpenAI.groupMap.shared.apiKey'),
      };
    }

    it('drops a key bound to no destination, reporting the fingerprint of where it would go', () => {
      const { merged, rebindings } = merge([baseLayer(), editors()]);

      expect(shared(merged)?.apiKey).toBe('');
      expect((merged.mcpConfig?.shared as typeof mcpServer).apiKey.key).toBe('');
      expect(merged.ocr?.apiKey).toBe('');
      const own = rebindings.filter(({ layer: { principalId } }) => principalId === 'editors');
      expect(own.map(({ path }) => path)).toEqual(OWN_PATHS);
      for (const { binding } of own) {
        expect(binding).toMatch(/^[0-9a-f]{64}$/);
      }
    });

    it('keeps each key bound to the destination the merge sends it to, and leaves the fingerprint out', () => {
      const { merged, rebindings } = merge([baseLayer(), editors(fingerprintsOver(baseLayer()))]);

      expect(rebindings.filter(({ layer: { principalId } }) => principalId === 'editors')).toEqual(
        [],
      );
      expect(shared(merged)).toMatchObject({
        apiKey: 'v3:editors-endpoint',
        baseURL: 'https://shared.example/v1',
      });
      expect((merged.mcpConfig?.shared as typeof mcpServer).apiKey.key).toBe('v3:editors-server');
      expect(merged.ocr?.apiKey).toBe('v3:editors-ocr');
      expect(merged.endpoints?.azureOpenAI?.groupMap?.shared?.apiKey).toBe('v3:editors-group');
      expect(JSON.stringify(merged)).toContain('apiKeyBinding');
      const served = withoutSecretBindings(merged);
      expect(JSON.stringify(served)).not.toContain('Binding');
      expect(shared(served)?.apiKey).toBe('v3:editors-endpoint');
      expect(withoutSecretBindings(served)).toBe(served);
    });

    it('drops each key again once the layer below moves its destination', () => {
      const bound = fingerprintsOver(baseLayer());
      const moved = baseLayer(
        'https://attacker.example/v1',
        'https://attacker.example/mcp',
        'https://attacker.example/ocr',
      );
      const { merged, rebindings } = merge([moved, editors(bound)]);

      expect(shared(merged)?.apiKey).toBe('');
      expect((merged.mcpConfig?.shared as typeof mcpServer).apiKey.key).toBe('');
      expect(merged.ocr?.apiKey).toBe('');
      expect(merged.endpoints?.azureOpenAI?.groupMap?.shared?.apiKey).toBe('');
      expect(
        rebindings
          .filter(({ layer: { principalId } }) => principalId === 'editors')
          .map(({ path }) => path),
      ).toEqual(OWN_PATHS);
    });

    it('binds nothing to a fingerprint another destination has, or that a profile in between moved', () => {
      const bound = fingerprintsOver(baseLayer());
      const swapped = merge([
        baseLayer(),
        editors({ endpoint: bound.server, server: bound.endpoint, ocr: bound.group }),
      ]);
      expect(shared(swapped.merged)?.apiKey).toBe('');
      expect((swapped.merged.mcpConfig?.shared as typeof mcpServer).apiKey.key).toBe('');
      expect(swapped.merged.ocr?.apiKey).toBe('');

      const between = merge([
        baseLayer(),
        layer(
          { endpoints: { custom: [{ name: 'Shared', baseURL: 'https://attacker.example/v1' }] } },
          'low',
          5,
        ),
        editors(bound),
      ]);
      expect(shared(between.merged)?.apiKey).toBe('');
    });
  });

  describe('summarization, whose provider credential is used when the config sets none', () => {
    /** A base config whose librechat.yaml has a summarization section, and two Azure groups. */
    function withSummarization(summarization: Record<string, unknown> = {}): AppConfig {
      const base = baseConfig();
      (base.config as Record<string, unknown>).summarization = structuredClone(summarization);
      return {
        ...base,
        endpoints: {
          ...base.endpoints,
          azureOpenAI: {
            isValid: true,
            errors: [],
            modelNames: ['gpt-4.1-mini', 'gpt-4o-mini', 'gpt-4o'],
            groupMap: {
              east: { apiKey: '${AZURE_EAST_KEY}', instanceName: 'east', models: {} },
              west: { apiKey: '${AZURE_WEST_KEY}', instanceName: 'west', models: {} },
            },
            modelGroupMap: {
              'gpt-4.1-mini': { group: 'east' },
              'gpt-4o-mini': { group: 'east' },
              'gpt-4o': { group: 'west' },
            },
          },
        },
        summarization: structuredClone(summarization),
      } as AppConfig;
    }

    const parameters = (merged: AppConfig) =>
      merged.summarization?.parameters as Record<string, unknown> | undefined;
    const changes = (rebindings: SecretRebinding[]) =>
      rebindings.map(({ layer: { principalId }, kind, path }) => [principalId, kind, path]);

    it('ignores a base URL a profile sets without its own key', () => {
      const { merged, rebindings, ignored } = merge([
        layer({
          summarization: {
            provider: 'openAI',
            model: 'gpt-4o-mini',
            parameters: { baseURL: 'https://evil.example/v1', temperature: 0.2 },
          },
        }),
      ]);

      expect(merged.summarization).toEqual({
        provider: 'openAI',
        model: 'gpt-4o-mini',
        parameters: { temperature: 0.2 },
      });
      expect(rebindings).toEqual([
        expect.objectContaining({ kind: 'destination', path: 'summarization.parameters.baseURL' }),
      ]);
      expect(ignored).toEqual([
        {
          path: 'summarization.parameters.baseURL',
          segments: ['summarization', 'parameters', 'baseURL'],
          reason: 'secret_rebinding',
        },
      ]);
    });

    it("ignores every provider client's own URL option without a key", () => {
      const destinations = {
        anthropicApiUrl: 'https://evil.example',
        azureOpenAIBasePath: 'https://evil.example/openai/deployments/x',
        azureOpenAIEndpoint: 'https://evil.example',
        azureOpenAIApiInstanceName: 'evil',
        baseUrl: 'https://evil.example',
        endpoint: 'evil.example',
        endpointHost: 'evil.example',
        location: 'evil.example#',
        region: 'evil.example#',
        serverURL: 'https://evil.example',
      };
      const { merged, rebindings } = merge([
        layer({ summarization: { parameters: { ...destinations, max_tokens: 512 } } }),
      ]);

      expect(parameters(merged)).toEqual({ max_tokens: 512 });
      expect(rebindings.map(({ path }) => path).sort()).toEqual(
        Object.keys(destinations)
          .map((key) => `summarization.parameters.${key}`)
          .sort(),
      );
    });

    it.each([true, false])(
      'keeps firstPartyEndpoint: %p, which shapes requests to the same host',
      (firstPartyEndpoint) => {
        const { merged, rebindings } = merge([
          layer({ summarization: { provider: 'openAI', parameters: { firstPartyEndpoint } } }),
        ]);

        expect(parameters(merged)).toEqual({ firstPartyEndpoint });
        expect(rebindings).toEqual([]);

        const moved = merge([
          layer({
            summarization: {
              provider: 'openAI',
              parameters: { firstPartyEndpoint, baseURL: 'https://evil.example/v1' },
            },
          }),
        ]);
        expect(parameters(moved.merged)).toEqual({ firstPartyEndpoint });
        expect(moved.rebindings.map(({ path }) => path)).toEqual([
          'summarization.parameters.baseURL',
        ]);
      },
    );

    it('keeps a destination the profile sets with its own key', () => {
      const { merged, rebindings } = merge([
        layer({
          summarization: {
            provider: 'openAI',
            parameters: { baseURL: 'https://gateway.example/v1', apiKey: 'v3:profile-key' },
          },
        }),
      ]);

      expect(parameters(merged)).toEqual({
        baseURL: 'https://gateway.example/v1',
        apiKey: 'v3:profile-key',
      });
      expect(rebindings).toEqual([]);
    });

    /**
     * The summarizer reads only a string key; for any other value it uses the provider's own
     * credential (an Azure group's key, the agent's Vertex service account) with the client
     * options the profile set.
     */
    it.each([1, 0, true, false, null, '', '   '])(
      'ignores a destination the profile sets with a key of %p, which no client sends',
      (apiKey) => {
        const { merged, rebindings } = merge(
          [
            layer({
              summarization: {
                provider: 'azureOpenAI',
                model: 'gpt-4.1-mini',
                parameters: { baseURL: 'https://evil.example/openai/deployments/x', apiKey },
              },
            }),
          ],
          withSummarization(),
        );

        expect(parameters(merged)).toEqual({ apiKey });
        expect(changes(rebindings)).toEqual([
          ['editors', 'destination', 'summarization.parameters.baseURL'],
        ]);
      },
    );

    it.each([
      ['no provider, so each agent its own', undefined],
      ['Bedrock, which signs with AWS credentials', 'bedrock'],
      ['Bedrock spelled another way', ' Bedrock '],
    ])(
      'ignores a destination the profile sets with a key its provider (%s) does not send',
      (_label, provider) => {
        const { merged, rebindings } = merge([
          layer({
            summarization: {
              provider,
              parameters: {
                apiKey: 'v3:profile-key',
                endpointHost: 'evil.example',
                region: 'evil.example#',
              },
            },
          }),
        ]);

        expect(parameters(merged)).toEqual({ apiKey: 'v3:profile-key' });
        expect(changes(rebindings).sort()).toEqual([
          ['editors', 'destination', 'summarization.parameters.endpointHost'],
          ['editors', 'destination', 'summarization.parameters.region'],
        ]);
      },
    );

    it("keeps librechat.yaml's own destination for the credential librechat.yaml sends there", () => {
      const unkeyed = merge(
        [layer({ summarization: { model: 'gpt-5-nano', parameters: { temperature: 0 } } })],
        withSummarization({ parameters: { baseURL: 'https://yaml.example/v1' } }),
      );
      expect(parameters(unkeyed.merged)).toEqual({
        baseURL: 'https://yaml.example/v1',
        temperature: 0,
      });
      expect(unkeyed.rebindings).toEqual([]);

      const keyed = merge(
        [layer({ summarization: { model: 'gpt-4o', parameters: { temperature: 0 } } })],
        withSummarization({
          provider: 'openAI',
          parameters: { baseURL: 'https://yaml.example/v1', apiKey: '${SUMMARY_KEY}' },
        }),
      );
      expect(parameters(keyed.merged)).toEqual({
        baseURL: 'https://yaml.example/v1',
        apiKey: '${SUMMARY_KEY}',
        temperature: 0,
      });
      expect(keyed.rebindings).toEqual([]);

      const sameGroup = merge(
        [layer({ summarization: { model: 'gpt-4o-mini' } })],
        withSummarization({
          provider: 'azureOpenAI',
          model: 'gpt-4.1-mini',
          parameters: { baseURL: 'https://yaml.example/openai' },
        }),
      );
      expect(parameters(sameGroup.merged)).toEqual({ baseURL: 'https://yaml.example/openai' });
      expect(sameGroup.rebindings).toEqual([]);
    });

    it("drops librechat.yaml's destination once a profile removes the key librechat.yaml sends there", () => {
      const yaml = withSummarization({
        provider: 'azureOpenAI',
        model: 'gpt-4.1-mini',
        parameters: { baseURL: 'https://yaml-gateway.example/openai', apiKey: 'yaml-gateway-key' },
      });

      const tombstoned = merge(
        [{ ...layer({}), tombstones: ['summarization.parameters.apiKey'] } as ConfigOverrideLayer],
        yaml,
      );
      expect(parameters(tombstoned.merged)).toEqual({});
      expect(changes(tombstoned.rebindings)).toEqual([
        ['editors', 'destination', 'summarization.parameters.baseURL'],
      ]);

      const emptied = merge([layer({ summarization: { parameters: { apiKey: false } } })], yaml);
      expect(parameters(emptied.merged)).toEqual({ apiKey: false });
      expect(changes(emptied.rebindings)).toEqual([
        ['editors', 'destination', 'summarization.parameters.baseURL'],
      ]);
    });

    it("drops librechat.yaml's unkeyed destination once a profile picks another credential for it", () => {
      const yaml = withSummarization({
        provider: 'openAI',
        model: 'gpt-4.1-mini',
        parameters: { baseURL: 'https://yaml-gateway.example/v1' },
      });

      /** The provider alone changes; `parameters` is the same object the profile inherited. */
      const provider = merge([layer({ summarization: { provider: 'azureOpenAI' } })], yaml);
      expect(provider.merged.summarization).toEqual({
        provider: 'azureOpenAI',
        model: 'gpt-4.1-mini',
        parameters: {},
      });
      expect(changes(provider.rebindings)).toEqual([
        ['editors', 'destination', 'summarization.parameters.baseURL'],
      ]);

      const azureYaml = withSummarization({
        provider: 'azureOpenAI',
        model: 'gpt-4.1-mini',
        parameters: { baseURL: 'https://yaml-gateway.example/openai' },
      });
      const otherGroup = merge([layer({ summarization: { model: 'gpt-4o' } })], azureYaml);
      expect(parameters(otherGroup.merged)).toEqual({});
      expect(changes(otherGroup.rebindings)).toEqual([
        ['editors', 'destination', 'summarization.parameters.baseURL'],
      ]);

      /** Without a provider, an Azure agent summarizes with the key of the model's group. */
      const agentGroup = merge(
        [layer({ summarization: { model: 'gpt-4o-mini' } })],
        withSummarization({ parameters: { baseURL: 'https://yaml-gateway.example/v1' } }),
      );
      expect(parameters(agentGroup.merged)).toEqual({});
      expect(changes(agentGroup.rebindings)).toEqual([
        ['editors', 'destination', 'summarization.parameters.baseURL'],
      ]);

      const remapped = merge(
        [
          layer({
            endpoints: { azureOpenAI: { modelGroupMap: { 'gpt-4.1-mini': { group: 'west' } } } },
          }),
        ],
        azureYaml,
      );
      expect(parameters(remapped.merged)).toEqual({});
      expect(changes(remapped.rebindings)).toEqual([
        ['editors', 'destination', 'summarization.parameters.baseURL'],
      ]);
    });

    it('sets back a destination a profile moves away from an inherited key', () => {
      const base = withSummarization({
        provider: 'openAI',
        parameters: { baseURL: 'https://yaml.example/v1', apiKey: '${SUMMARY_KEY}' },
      });
      const { merged, rebindings } = merge(
        [layer({ summarization: { parameters: { baseURL: 'https://evil.example/v1' } } })],
        base,
      );

      expect(parameters(merged)).toEqual({
        baseURL: 'https://yaml.example/v1',
        apiKey: '${SUMMARY_KEY}',
      });
      expect(rebindings.map(({ path }) => path)).toEqual(['summarization.parameters.baseURL']);
    });

    it('drops a key once another provider would read it, and judges the destination without it', () => {
      const yaml = withSummarization({
        provider: 'openAI',
        parameters: { baseURL: 'https://yaml-gateway.example/v1', apiKey: '${GATEWAY_KEY}' },
      });

      const switched = merge([layer({ summarization: { provider: 'anthropic' } })], yaml);
      expect(switched.merged.summarization).toEqual({ provider: 'anthropic', parameters: {} });
      expect(changes(switched.rebindings)).toEqual([
        ['editors', 'secret', 'summarization.parameters.apiKey'],
        ['editors', 'destination', 'summarization.parameters.baseURL'],
      ]);
      expect(switched.ignored[0]).toEqual({
        path: 'summarization.parameters.apiKey',
        segments: ['summarization', 'parameters', 'apiKey'],
        reason: 'secret_rebinding',
      });

      const own = merge(
        [
          layer({ summarization: { provider: 'anthropic' } }, '__base__', 0),
          layer(
            {
              summarization: {
                parameters: { baseURL: 'https://own.example/v1', apiKey: 'v3:editors-key' },
              },
            },
            'editors',
            10,
          ),
        ],
        yaml,
      );
      expect(own.merged.summarization).toEqual({ provider: 'anthropic', parameters: {} });
      expect(changes(own.rebindings)).toEqual([
        ['__base__', 'secret', 'summarization.parameters.apiKey'],
        ['__base__', 'destination', 'summarization.parameters.baseURL'],
        ['editors', 'secret', 'summarization.parameters.apiKey'],
        ['editors', 'destination', 'summarization.parameters.baseURL'],
      ]);

      const restated = merge(
        [layer({ summarization: { provider: 'anthropic', parameters: { apiKey: 'v3:own' } } })],
        yaml,
      );
      expect(parameters(restated.merged)).toEqual({
        baseURL: 'https://yaml-gateway.example/v1',
        apiKey: 'v3:own',
      });
      expect(restated.rebindings).toEqual([]);
    });

    it('sets back a destination a profile empties the key under, or tombstones the key from', () => {
      const lower = layer(
        {
          summarization: {
            provider: 'openAI',
            parameters: { baseURL: 'https://low.example/v1', apiKey: 'v3:low-key' },
          },
        },
        'low',
        5,
      );

      const emptied = merge([lower, layer({ summarization: { parameters: { apiKey: '' } } })]);
      expect(parameters(emptied.merged)).toEqual({ apiKey: '' });
      expect(changes(emptied.rebindings)).toEqual([
        ['editors', 'destination', 'summarization.parameters.baseURL'],
      ]);

      const tombstoned = merge([
        lower,
        {
          ...layer({}),
          tombstones: ['summarization.parameters.apiKey'],
        } as ConfigOverrideLayer,
      ]);
      expect(parameters(tombstoned.merged)).toEqual({});
    });

    it("sets a profile's key back on its own destination when a lower layer moved it", () => {
      const base = withSummarization({
        provider: 'openAI',
        parameters: { baseURL: 'https://yaml.example/v1' },
      });
      const { merged, rebindings } = merge(
        [
          layer(
            {
              summarization: {
                parameters: { baseURL: 'https://low.example/v1', apiKey: 'v3:low-key' },
              },
            },
            '__base__',
            0,
          ),
          layer({ summarization: { parameters: { apiKey: 'v3:editors-key' } } }, 'editors', 10),
        ],
        base,
      );

      expect(parameters(merged)).toEqual({
        baseURL: 'https://yaml.example/v1',
        apiKey: 'v3:editors-key',
      });
      expect(changes(rebindings)).toEqual([
        ['editors', 'destination', 'summarization.parameters.baseURL'],
      ]);
    });

    it('leaves a destination with a key each user enters', () => {
      const { merged, rebindings } = merge([
        layer({
          summarization: {
            provider: 'openAI',
            parameters: { baseURL: 'https://gateway.example/v1', apiKey: 'user_provided' },
          },
        }),
      ]);

      expect(parameters(merged)?.baseURL).toBe('https://gateway.example/v1');
      expect(rebindings).toEqual([]);
    });
  });

  describe('resolved settings an override can write directly', () => {
    function withResolvedEndpoints(): AppConfig {
      const base = baseConfig();
      return {
        ...base,
        endpoints: {
          ...base.endpoints,
          azureOpenAI: {
            groupMap: {
              east: { apiKey: '${AZURE_EAST_KEY}', instanceName: 'east', version: '2024-10-21' },
            },
            modelGroupMap: { 'gpt-4o': { group: 'east' } },
          },
          anthropic: { vertexConfig: { region: 'us-east5', projectId: 'deployment-project' } },
        },
      } as unknown as AppConfig;
    }

    it("drops an Azure group's key when an override points the group elsewhere", () => {
      const { merged, ignored } = merge(
        [
          layer({
            endpoints: {
              azureOpenAI: { groupMap: { east: { baseURL: 'https://evil.example/openai' } } },
            },
          }),
        ],
        withResolvedEndpoints(),
      );

      expect(merged.endpoints?.azureOpenAI?.groupMap?.east).toMatchObject({
        apiKey: '',
        baseURL: 'https://evil.example/openai',
      });
      expect(ignored).toEqual([
        {
          path: 'endpoints.azureOpenAI.groupMap.east.apiKey',
          segments: ['endpoints', 'azureOpenAI', 'groupMap', 'east', 'apiKey'],
          reason: 'secret_rebinding',
        },
      ]);

      const instance = merge(
        [layer({ endpoints: { azureOpenAI: { groupMap: { east: { instanceName: 'evil' } } } } })],
        withResolvedEndpoints(),
      );
      expect(instance.merged.endpoints?.azureOpenAI?.groupMap?.east?.apiKey).toBe('');
    });

    it('keeps an Azure group key the override enters with its own destination', () => {
      const { merged, rebindings } = merge(
        [
          layer({
            endpoints: {
              azureOpenAI: {
                groupMap: {
                  east: { baseURL: 'https://own.example/openai', apiKey: 'v3:own-azure-key' },
                },
              },
            },
          }),
        ],
        withResolvedEndpoints(),
      );

      expect(merged.endpoints?.azureOpenAI?.groupMap?.east?.apiKey).toBe('v3:own-azure-key');
      expect(rebindings).toEqual([]);
    });

    it("reports nothing for Vertex AI a layer turns on, and serves it on librechat.yaml's region", () => {
      const rebindings: SecretRebinding[] = [];
      const yamlVertex = { enabled: false, region: 'europe-west1' };
      const merged = mergeConfigOverrides(
        {
          config: { endpoints: { anthropic: { vertex: yamlVertex } } },
          endpoints: { anthropic: {} },
        } as unknown as AppConfig,
        [
          layer({
            endpoints: {
              anthropic: { vertex: { enabled: true, projectId: 'p-1', region: 'evil' } },
            },
          }),
        ],
        {
          rederiveEndpoints: true,
          afterLayer: createSecretRebindingGuard((rebinding) => rebindings.push(rebinding)),
        },
      );

      expect(merged.endpoints?.anthropic?.vertexConfig).toMatchObject({
        projectId: 'p-1',
        region: 'europe-west1',
      });
      expect(rebindings).toEqual([]);
    });

    it('never applies Vertex AI settings an override writes to the resolved vertexConfig', () => {
      const base = withResolvedEndpoints();
      const { merged, rebindings } = merge(
        [
          layer({
            endpoints: {
              anthropic: {
                vertexConfig: {
                  region: 'evil.example#',
                  projectId: 'other-project',
                  serviceKeyFile: '{"type":"service_account"}',
                },
              },
            },
          }),
        ],
        base,
      );

      expect(merged.endpoints?.anthropic?.vertexConfig).toEqual(
        base.endpoints?.anthropic?.vertexConfig,
      );
      expect(rebindings).toEqual([]);
    });
  });

  describe('Azure groups an override writes, which resolve to what the Azure clients read', () => {
    const yamlGroup = {
      group: 'east',
      apiKey: 'yaml-literal-east-key',
      instanceName: 'east',
      version: '2024-10-21',
      deploymentName: 'gpt-4o',
      models: { 'gpt-4o': true },
    };

    function azureBase(): AppConfig {
      return {
        config: { endpoints: { azureOpenAI: { groups: [yamlGroup] } } },
        endpoints: {
          azureOpenAI: {
            groupMap: { east: { ...yamlGroup } },
            modelGroupMap: { 'gpt-4o': { group: 'east' } },
            modelNames: ['gpt-4o'],
            assistantModels: [],
            assistantGroups: [],
          },
        },
      } as unknown as AppConfig;
    }

    const ownGroup = {
      group: 'west',
      apiKey: 'v3:west-admin-key',
      instanceName: 'west',
      version: '2024-10-21',
      deploymentName: 'gpt-5',
      models: { 'gpt-5': true },
    };

    it("merges the layer's groups by group over librechat.yaml's, each with the key it entered", () => {
      const { merged, rebindings } = mergeGroups(
        [layer({ endpoints: { azureOpenAI: { groups: [ownGroup] } } }, '__base__', 0)],
        azureBase(),
      );

      const azure = merged.endpoints?.azureOpenAI;
      expect(Object.keys(azure?.groupMap ?? {})).toEqual(['east', 'west']);
      expect(azure?.groupMap?.east).toMatchObject({ apiKey: 'yaml-literal-east-key' });
      expect(azure?.groupMap?.west).toMatchObject({
        apiKey: 'v3:west-admin-key',
        instanceName: 'west',
      });
      expect(azure?.modelGroupMap).toEqual({
        'gpt-4o': { group: 'east' },
        'gpt-5': { group: 'west' },
      });
      expect(azure?.modelNames).toEqual(['gpt-4o', 'gpt-5']);
      expect(rebindings).toEqual([]);
    });

    it("replaces librechat.yaml's groups with a layer's that tombstones them", () => {
      const replacing = {
        ...layer({ endpoints: { azureOpenAI: { groups: [ownGroup] } } }, '__base__', 0),
        tombstones: ['endpoints.azureOpenAI.groups'],
      };
      const { merged } = mergeGroups([replacing], azureBase());

      expect(Object.keys(merged.endpoints?.azureOpenAI?.groupMap ?? {})).toEqual(['west']);
      expect(merged.endpoints?.azureOpenAI?.modelNames).toEqual(['gpt-5']);
    });

    it('keeps the inherited key of a librechat.yaml group whose item changes only its models', () => {
      const { merged, rebindings } = mergeGroups(
        [
          layer({
            endpoints: {
              azureOpenAI: {
                groups: [{ group: 'east', models: { 'gpt-4o-mini': { deploymentName: 'mini' } } }],
              },
            },
          }),
        ],
        azureBase(),
      );

      const azure = merged.endpoints?.azureOpenAI;
      expect(azure?.groupMap?.east).toMatchObject({
        apiKey: 'yaml-literal-east-key',
        instanceName: 'east',
        models: { 'gpt-4o': true, 'gpt-4o-mini': { deploymentName: 'mini' } },
      });
      expect(azure?.modelNames).toEqual(['gpt-4o', 'gpt-4o-mini']);
      expect(rebindings).toEqual([]);
    });

    it("drops librechat.yaml's key when a partial item points its group elsewhere", () => {
      const { merged, ignored } = mergeGroups(
        [
          layer({
            endpoints: { azureOpenAI: { groups: [{ group: 'east', instanceName: 'evil' }] } },
          }),
        ],
        azureBase(),
      );

      expect(merged.endpoints?.azureOpenAI?.groupMap?.east).toMatchObject({
        apiKey: '',
        instanceName: 'evil',
      });
      expect(ignored.map(({ path }) => path)).toEqual([
        'endpoints.azureOpenAI.groupMap.east.apiKey',
      ]);
    });

    it('drops and reports nothing without CONFIG_REDERIVE_ENDPOINTS, where the groups stay inert', () => {
      const { merged, ignored } = merge(
        [
          layer({
            endpoints: { azureOpenAI: { groups: [{ group: 'east', instanceName: 'evil' }] } },
          }),
        ],
        azureBase(),
      );

      expect(merged.endpoints?.azureOpenAI?.groupMap).toEqual(
        azureBase().endpoints?.azureOpenAI?.groupMap,
      );
      expect(ignored).toEqual([]);
    });

    it('keeps a key a lower layer dropped dropped when a later layer writes the same group', () => {
      const { merged, ignored } = mergeGroups(
        [
          layer(
            { endpoints: { azureOpenAI: { groups: [{ group: 'east', instanceName: 'evil' }] } } },
            '__base__',
            0,
          ),
          layer({
            endpoints: {
              azureOpenAI: {
                groups: [{ group: 'east', models: { 'gpt-4o-mini': { deploymentName: 'mini' } } }],
              },
            },
          }),
        ],
        azureBase(),
      );

      expect(merged.endpoints?.azureOpenAI?.groupMap?.east).toMatchObject({
        apiKey: '',
        instanceName: 'evil',
      });
      expect(ignored.map(({ path }) => path)).toEqual([
        'endpoints.azureOpenAI.groupMap.east.apiKey',
      ]);
    });

    it.each([
      ['hides a field it needs', 'endpoints.azureOpenAI.groups["east"].instanceName'],
      ['tombstones its groupMap entry', 'endpoints.azureOpenAI.groupMap.east'],
    ])(
      "sends no librechat.yaml key to a group a lower layer's tombstone (%s) left unserved",
      (_case, tombstone) => {
        const moved = { instanceName: 'evil', baseURL: 'https://evil.example/openai' };
        const { merged } = mergeGroups(
          [
            { ...layer({}, '__base__', 0), tombstones: [tombstone] },
            layer({ endpoints: { azureOpenAI: { groups: [{ group: 'east', ...moved }] } } }),
          ],
          azureBase(),
        );

        const east = merged.endpoints?.azureOpenAI?.groupMap?.east;
        expect(east).toMatchObject(moved);
        expect(east).not.toHaveProperty('apiKey');
        expect(merged.endpoints?.azureOpenAI?.modelGroupMap).toEqual({
          'gpt-4o': { group: 'east' },
        });
      },
    );

    it("drops a layer's own key for a group whose destination a lower layer moved", () => {
      const { merged, rebindings } = mergeGroups(
        [
          layer(
            { endpoints: { azureOpenAI: { groups: [{ group: 'east', instanceName: 'moved' }] } } },
            '__base__',
            0,
          ),
          layer({
            endpoints: { azureOpenAI: { groups: [{ group: 'east', apiKey: 'v3:own-key' }] } },
          }),
        ],
        azureBase(),
      );

      expect(merged.endpoints?.azureOpenAI?.groupMap?.east).toMatchObject({
        apiKey: '',
        instanceName: 'moved',
      });
      expect(rebindings[rebindings.length - 1]).toMatchObject({
        kind: 'secret',
        path: 'endpoints.azureOpenAI.groupMap.east.apiKey',
        binding: expect.any(String),
      });
    });

    it('keeps the key a layer enters for a librechat.yaml group it points elsewhere', () => {
      const { merged, rebindings } = mergeGroups(
        [
          layer({
            endpoints: {
              azureOpenAI: {
                groups: [{ ...yamlGroup, apiKey: 'v3:east-admin-key', instanceName: 'east-2' }],
              },
            },
          }),
        ],
        azureBase(),
      );

      expect(merged.endpoints?.azureOpenAI?.groupMap?.east).toMatchObject({
        apiKey: 'v3:east-admin-key',
        instanceName: 'east-2',
      });
      expect(rebindings).toEqual([]);
    });

    it('drops the key of a group a layer resolved once a later layer points it elsewhere', () => {
      const { merged, ignored } = mergeGroups(
        [
          layer({ endpoints: { azureOpenAI: { groups: [ownGroup] } } }, '__base__', 0),
          layer({ endpoints: { azureOpenAI: { groupMap: { west: { instanceName: 'evil' } } } } }),
        ],
        azureBase(),
      );

      expect(merged.endpoints?.azureOpenAI?.groupMap?.west).toMatchObject({
        apiKey: '',
        instanceName: 'evil',
      });
      expect(ignored.map(({ path }) => path)).toEqual([
        'endpoints.azureOpenAI.groupMap.west.apiKey',
      ]);
    });

    it('binds the deployment names of a base URL that takes its host from them', () => {
      const hostTemplate = {
        ...ownGroup,
        baseURL: 'https://${DEPLOYMENT_NAME}.inference.example.com/v1',
      };
      const pathTemplate = {
        ...ownGroup,
        baseURL: 'https://west.openai.azure.com/openai/deployments/${DEPLOYMENT_NAME}',
      };
      const renamed = (group: Record<string, unknown>) =>
        mergeGroups(
          [
            layer({ endpoints: { azureOpenAI: { groups: [group] } } }, '__base__', 0),
            layer({
              endpoints: {
                azureOpenAI: {
                  groupMap: { west: { models: { 'gpt-5': { deploymentName: 'evil' } } } },
                },
              },
            }),
          ],
          azureBase(),
        );

      expect(renamed(hostTemplate).merged.endpoints?.azureOpenAI?.groupMap?.west?.apiKey).toBe('');
      expect(renamed(pathTemplate).merged.endpoints?.azureOpenAI?.groupMap?.west?.apiKey).toBe(
        'v3:west-admin-key',
      );
    });

    it('binds the destination options its addParams reach the client with', () => {
      const moved = (addParams: Record<string, unknown>) =>
        mergeGroups(
          [
            layer({ endpoints: { azureOpenAI: { groups: [ownGroup] } } }, '__base__', 0),
            layer({ endpoints: { azureOpenAI: { groupMap: { west: { addParams } } } } }),
          ],
          azureBase(),
        ).merged.endpoints?.azureOpenAI?.groupMap?.west?.apiKey;

      expect(moved({ configuration: { baseURL: 'https://evil.example/v1' } })).toBe('');
      expect(moved({ reasoning_effort: 'high' })).toBe('v3:west-admin-key');
    });

    it('leaves groups that do not resolve unread, and what lies below in place', () => {
      const { merged } = mergeGroups(
        [
          layer({
            endpoints: { azureOpenAI: { groups: [ownGroup, { ...ownGroup, group: 'w2' }] } },
          }),
        ],
        azureBase(),
      );

      expect(Object.keys(merged.endpoints?.azureOpenAI?.groupMap ?? {})).toEqual(['east']);
      expect(merged.endpoints?.azureOpenAI?.modelNames).toEqual(['gpt-4o']);
    });
  });

  describe('custom endpoints: every setting that picks the destination, under any spelling', () => {
    const claude = {
      name: 'Claude',
      provider: 'anthropic',
      apiKey: 'yaml-literal-claude-key',
      baseURL: 'https://gateway.example.com/anthropic',
      models: { default: ['claude-x'] },
    };
    const ollama = {
      name: 'Ollama',
      apiKey: 'yaml-literal-ollama-key',
      baseURL: 'http://ollama.internal:11434/v1',
      models: { default: ['llama3'] },
    };

    function endpointsBase(...custom: Record<string, unknown>[]): AppConfig {
      return {
        config: { endpoints: { custom } },
        endpoints: { custom: structuredClone(custom) },
      } as unknown as AppConfig;
    }

    function mergeEndpoints(entries: Record<string, unknown>[][], base: AppConfig) {
      return merge(
        entries.map((custom, index) =>
          layer({ endpoints: { custom } }, index === 0 ? '__base__' : `group${index}`, index * 10),
        ),
        base,
      );
    }

    const attacker = 'https://attacker.example';

    it.each<[string, { name: string } & Record<string, unknown>]>([
      [
        'an anthropicApiUrl the native client sends to',
        { name: 'Claude', addParams: { anthropicApiUrl: attacker } },
      ],
      ['a provider switch', { name: 'Gateway', provider: 'anthropic' }],
      [
        'a provider switch with its own destination option',
        { name: 'Gateway', provider: 'anthropic', addParams: { anthropicApiUrl: attacker } },
      ],
      [
        'a nested destination option',
        { name: 'Gateway', addParams: { configuration: { baseURL: attacker } } },
      ],
      [
        'a dropParams that removes the destinations the client reads',
        { name: 'Claude', dropParams: ['anthropicApiUrl', 'clientOptions'] },
      ],
    ])('drops an inherited key under %s', (_label, change) => {
      const { merged, ignored } = mergeEndpoints([[change]], endpointsBase(customEndpoint, claude));
      const { name } = change;
      const entry = merged.endpoints?.custom?.find((item) => item.name === name);
      expect(entry?.apiKey).toBe('');
      expect(ignored).toEqual([
        {
          path: `endpoints.custom[${JSON.stringify(name)}].apiKey`,
          segments: ['endpoints', 'custom', name, 'apiKey'],
          reason: 'secret_rebinding',
        },
      ]);
    });

    it('keeps the key through options that only shape requests, or with the key entered again', () => {
      const shaped = mergeEndpoints(
        [
          [
            {
              name: 'Claude',
              addParams: { promptCache: true, web_search: true, firstPartyEndpoint: true },
              dropParams: ['temperature'],
            },
          ],
        ],
        endpointsBase(claude),
      );
      expect(shaped.merged.endpoints?.custom?.[0]?.apiKey).toBe(claude.apiKey);
      expect(shaped.rebindings).toEqual([]);

      const entered = mergeEndpoints(
        [
          [
            {
              name: 'Claude',
              apiKey: 'v3:own-ciphertext',
              addParams: { anthropicApiUrl: attacker },
            },
          ],
        ],
        endpointsBase(claude),
      );
      expect(entered.merged.endpoints?.custom?.[0]?.apiKey).toBe('v3:own-ciphertext');
      expect(entered.rebindings).toEqual([]);

      const yamlOption = {
        ...claude,
        addParams: { anthropicApiUrl: 'https://gateway.example.com/a' },
      };
      const untouched = mergeEndpoints(
        [[{ name: 'Claude', models: { default: ['claude-y'] } }]],
        endpointsBase(yamlOption),
      );
      expect(untouched.merged.endpoints?.custom?.[0]?.apiKey).toBe(claude.apiKey);
      expect(untouched.rebindings).toEqual([]);
    });

    it("drops a layer's own key when a lower layer moved the native client's destination", () => {
      const { merged, ignored, rebindings } = mergeEndpoints(
        [
          [{ name: 'Claude', addParams: { anthropicApiUrl: attacker } }],
          [{ name: 'Claude', apiKey: 'v3:group-ciphertext' }],
        ],
        endpointsBase(claude),
      );
      expect(merged.endpoints?.custom?.[0]?.apiKey).toBe('');
      expect(rebindings.map(({ layer: { principalId } }) => principalId)).toEqual([
        '__base__',
        'group1',
      ]);
      expect(ignored[1].path).toBe('endpoints.custom["Claude"].apiKey');
    });

    it.each(['ollama', 'OLLAMA'])(
      'drops an inherited key a layer moves under the folded spelling %s, named as the merge keeps it',
      (spelling) => {
        const { merged, ignored } = mergeEndpoints(
          [[{ name: spelling, baseURL: `${attacker}/v1` }]],
          endpointsBase(ollama),
        );
        expect(merged.endpoints?.custom).toEqual([
          { ...ollama, apiKey: '', baseURL: `${attacker}/v1` },
        ]);
        expect(ignored).toEqual([
          {
            path: 'endpoints.custom["Ollama"].apiKey',
            segments: ['endpoints', 'custom', 'Ollama', 'apiKey'],
            reason: 'secret_rebinding',
          },
        ]);
      },
    );

    it("drops a layer's own key under a folded spelling when a lower layer moved the endpoint", () => {
      const { merged, rebindings } = mergeEndpoints(
        [
          [{ name: 'Ollama', baseURL: `${attacker}/v1` }],
          [{ name: 'OLLAMA', apiKey: 'v3:group-ciphertext' }],
        ],
        endpointsBase(ollama),
      );
      expect(merged.endpoints?.custom?.[0]).toMatchObject({ name: 'Ollama', apiKey: '' });
      expect(rebindings.map(({ layer: { principalId }, path }) => [principalId, path])).toEqual([
        ['__base__', 'endpoints.custom["Ollama"].apiKey'],
        ['group1', 'endpoints.custom["Ollama"].apiKey'],
      ]);

      const kept = mergeEndpoints(
        [[{ name: 'ollama', models: { default: ['llama3.1'] } }]],
        endpointsBase(ollama),
      );
      expect(kept.merged.endpoints?.custom?.[0]?.apiKey).toBe(ollama.apiKey);
      expect(kept.rebindings).toEqual([]);
    });

    it('judges every entry a folded name reaches against the entry it was merged onto', () => {
      const second = { ...ollama, name: 'ollama', apiKey: 'yaml-literal-second-key' };
      const { merged, ignored } = mergeEndpoints(
        [[{ name: 'OLLAMA', baseURL: `${attacker}/v1` }]],
        endpointsBase(ollama, second),
      );
      expect(merged.endpoints?.custom?.map((entry) => entry.apiKey)).toEqual(['', '']);
      expect(ignored.map(({ path }) => path)).toEqual([
        'endpoints.custom["Ollama"].apiKey',
        'endpoints.custom["ollama"].apiKey',
      ]);
    });
  });

  describe('web search URLs a layer points at another variable', () => {
    const proxy = '${OPENAI_REVERSE_PROXY}';

    it('sets the URL back when the layer enters no key for it', () => {
      for (const firecrawlApiKey of [undefined, '', '  ']) {
        const { merged, rebindings } = merge([
          layer({ webSearch: { firecrawlApiUrl: proxy, firecrawlApiKey } }),
        ]);

        expect(merged.webSearch?.firecrawlApiUrl).toBe('https://api.firecrawl.dev');
        expect(rebindings.map(({ kind, path }) => [kind, path])).toEqual([
          ['destination', 'webSearch.firecrawlApiUrl'],
        ]);
      }
    });

    it("keeps the URL with a key the layer enters, a literal URL, or librechat.yaml's own", () => {
      const restated = merge([
        layer({ webSearch: { firecrawlApiUrl: proxy, firecrawlApiKey: '${FIRECRAWL_API_KEY}' } }),
      ]);
      expect(restated.merged.webSearch?.firecrawlApiUrl).toBe(proxy);
      expect(restated.rebindings).toEqual([]);

      const literal = merge([layer({ webSearch: { firecrawlApiUrl: 'https://other.example' } })]);
      expect(literal.merged.webSearch?.firecrawlApiUrl).toBe('https://other.example');

      const base = baseConfig();
      const yamlReference = {
        ...base,
        webSearch: { ...base.webSearch, firecrawlApiUrl: '${FIRECRAWL_API_URL}' },
      } as unknown as AppConfig;
      const back = merge(
        [
          layer({ webSearch: { firecrawlApiUrl: 'https://lower.example' } }, 'lower', 5),
          layer({ webSearch: { firecrawlApiUrl: '${FIRECRAWL_API_URL}' } }),
        ],
        yamlReference,
      );
      expect(back.merged.webSearch?.firecrawlApiUrl).toBe('${FIRECRAWL_API_URL}');
    });
  });

  describe('custom endpoints a layer changes without naming them in its overrides', () => {
    function step(merged: AppConfig, layerOverrides: Record<string, unknown> = {}) {
      const base = baseConfig();
      return {
        layer: layer(layerOverrides),
        base,
        below: base,
        applied: layerOverrides,
        merged,
        alone: () => base,
      };
    }

    it('drops the inherited key of an entry whose destination changed some other way', () => {
      const rebindings: SecretRebinding[] = [];
      const guard = createSecretRebindingGuard((rebinding) => rebindings.push(rebinding));
      const moved = {
        ...baseConfig(),
        endpoints: {
          custom: [{ name: 'Gateway', apiKey: '${GATEWAY_KEY}', models: customEndpoint.models }],
        },
      } as unknown as AppConfig;

      const result = guard(step(moved));

      expect(result.endpoints?.custom?.[0]?.apiKey).toBe('');
      expect(rebindings.map(({ path }) => path)).toEqual(['endpoints.custom["Gateway"].apiKey']);
    });

    it('keeps the key of an entry a layer left as it was below', () => {
      const guard = createSecretRebindingGuard();
      const copied = {
        ...baseConfig(),
        endpoints: { custom: [{ ...customEndpoint }] },
      } as unknown as AppConfig;

      expect(guard(step(copied)).endpoints?.custom?.[0]?.apiKey).toBe('${GATEWAY_KEY}');
    });

    it('leaves an endpoint as it was under a tombstone inside the list, which the merge never applies', () => {
      const tombstoned = {
        ...layer({}),
        tombstones: ['endpoints.custom.0.baseURL', 'endpoints.custom.0.addParams'],
      } as ConfigOverrideLayer;
      const { merged, rebindings } = merge([tombstoned]);

      expect(merged.endpoints?.custom?.[0]).toMatchObject({
        apiKey: '${GATEWAY_KEY}',
        baseURL: customEndpoint.baseURL,
      });
      expect(rebindings).toEqual([]);
    });
  });

  it('never mutates the base config or the objects a lower layer shares', () => {
    const base = baseConfig();
    const snapshot = structuredClone(base);
    merge(
      [
        layer({
          endpoints: { custom: [{ name: 'Gateway', baseURL: 'https://evil.example/v1' }] },
          mcpServers: { tools: { url: 'https://evil.example/mcp' } },
          ocr: { baseURL: 'https://evil.example/v1' },
        }),
      ],
      base,
    );
    expect(base).toEqual(snapshot);
  });
});
