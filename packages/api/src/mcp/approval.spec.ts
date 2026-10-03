import { ServerConfigsCacheInMemory } from './registry/cache/ServerConfigsCacheInMemory';
import { buildMCPToolApprovalBinding } from '~/agents/hitl/modes';
import { buildMCPToolReviewAuthority } from './approval';
import { getMCPToolApprovalAuthKind } from './approval';
import { processMCPEnv } from '~/utils/env';

const config = {
  type: 'streamable-http' as const,
  source: 'yaml' as const,
  url: 'https://a.example.test/mcp',
  headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
};

test('review-only authority pins a templated endpoint without enabling remembered consent', () => {
  expect(buildMCPToolApprovalBinding('db', config)).toBeUndefined();
  const first = buildMCPToolReviewAuthority({ serverName: 'db', config });
  expect(first).toEqual(expect.any(String));
  expect(
    buildMCPToolReviewAuthority({
      serverName: 'db',
      config: { ...config, url: 'https://b.example.test/mcp' },
    }),
  ).not.toBe(first);
});

test('resolved custom destinations and request routes are part of invocation consent', () => {
  const variable = {
    ...config,
    url: '{{DESTINATION}}',
    customUserVars: { DESTINATION: { title: 'Destination', description: 'URL' } },
  };
  const input = { serverName: 'db', config: variable };
  expect(
    buildMCPToolReviewAuthority({
      ...input,
      customUserVars: { DESTINATION: 'https://a.example.test/mcp' },
    }),
  ).not.toBe(
    buildMCPToolReviewAuthority({
      ...input,
      customUserVars: { DESTINATION: 'https://b.example.test/mcp' },
    }),
  );
  const request = { ...config, url: 'https://a.example.test/{{LIBRECHAT_BODY_CONVERSATIONID}}' };
  expect(
    buildMCPToolReviewAuthority({
      serverName: 'db',
      config: request,
      body: { conversationId: 'a' },
    }),
  ).not.toBe(
    buildMCPToolReviewAuthority({
      serverName: 'db',
      config: request,
      body: { conversationId: 'b' },
    }),
  );
});

test('unresolved routing cannot establish invocation consent', () => {
  expect(
    buildMCPToolReviewAuthority({
      serverName: 'db',
      config: { ...config, url: '{{DESTINATION}}' },
    }),
  ).toBeUndefined();
});

test('current principal identity remains part of invocation-only consent', () => {
  const first = buildMCPToolReviewAuthority({
    serverName: 'db',
    config,
    user: { id: 'user-a', openidId: 'subject-a' },
  });
  expect(
    buildMCPToolReviewAuthority({
      serverName: 'db',
      config,
      user: { id: 'user-b', openidId: 'subject-b' },
    }),
  ).not.toBe(first);
});

test('plugin literals remain opaque without resolving host variables or losing review authority', () => {
  const plugin = {
    type: 'stdio' as const,
    source: 'plugin' as const,
    command: 'node',
    args: ['server.js', '${PLUGIN_LITERAL}'],
  };
  const first = buildMCPToolReviewAuthority({ serverName: 'plugin-server', config: plugin });
  expect(first).toEqual(expect.any(String));
  expect(
    buildMCPToolReviewAuthority({
      serverName: 'plugin-server',
      config: plugin,
      customUserVars: { PLUGIN_LITERAL: 'ignored' },
    }),
  ).toBe(first);
});

test('effective admin credentials are not masked by a shadowed renewable header template', () => {
  const selected = {
    ...config,
    apiKey: {
      source: 'admin' as const,
      authorization_type: 'bearer' as const,
      key: '{{ADMIN_KEY}}',
    },
  };
  const first = buildMCPToolReviewAuthority({
    serverName: 'db',
    config: selected,
    customUserVars: { ADMIN_KEY: 'review-only-renewable-bearer-a' },
  });
  const second = buildMCPToolReviewAuthority({
    serverName: 'db',
    config: selected,
    customUserVars: { ADMIN_KEY: 'review-only-renewable-bearer-b' },
  });
  expect(second).not.toBe(first);
});

test('request-only workspace headers are resolved before authority fingerprinting', () => {
  const selected = { ...config, requestHeaders: { 'X-Workspace': '{{WORKSPACE}}' } };
  const first = buildMCPToolReviewAuthority({
    serverName: 'db',
    config: selected,
    customUserVars: { WORKSPACE: 'workspace-a' },
  });
  const second = buildMCPToolReviewAuthority({
    serverName: 'db',
    config: selected,
    customUserVars: { WORKSPACE: 'workspace-b' },
  });
  expect(second).not.toBe(first);
});

test('request-only renewable auth uses the same merge and principal handling as the transport', () => {
  const selected = {
    ...config,
    headers: { 'X-Base': 'base' },
    requestHeaders: {
      Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}',
      'X-Workspace': '{{WORKSPACE}}',
    },
  };
  const first = buildMCPToolReviewAuthority({
    serverName: 'db',
    config: selected,
    user: { id: 'user-a', openidId: 'subject-a' },
    customUserVars: { WORKSPACE: 'workspace-a' },
  });
  expect(first).toEqual(expect.any(String));
  expect(
    buildMCPToolReviewAuthority({
      serverName: 'db',
      config: selected,
      user: { id: 'user-a', openidId: 'subject-a' },
      customUserVars: { WORKSPACE: 'workspace-b' },
    }),
  ).not.toBe(first);
});

const renewableFields = [
  'LIBRECHAT_OPENID_TOKEN',
  'LIBRECHAT_OPENID_ACCESS_TOKEN',
  'LIBRECHAT_OPENID_ID_TOKEN',
  'LIBRECHAT_GRAPH_ACCESS_TOKEN',
] as const;

test.each(renewableFields)('mixed %s headers retain resolved workspace authority', (field) => {
  const placeholder = `{{${field}}}`;
  const selected = { ...config, headers: { 'X-Workspace': `{{WORKSPACE}}:${placeholder}` } };
  const input = {
    serverName: 'db',
    config: selected,
    user: { id: 'user-a', openidId: 'subject-a' },
  };
  const a = buildMCPToolReviewAuthority({ ...input, customUserVars: { WORKSPACE: 'workspace-a' } });
  const b = buildMCPToolReviewAuthority({ ...input, customUserVars: { WORKSPACE: 'workspace-b' } });
  expect(a).toEqual(expect.any(String));
  expect(b).not.toBe(a);
  expect(selected.headers['X-Workspace']).toBe(`{{WORKSPACE}}:${placeholder}`);
});

test.each(renewableFields)('%s alias loading does not require renewable token bytes', (field) => {
  const selected = { ...config, headers: { Authorization: `Bearer {{${field}}}` } };
  const principal = { id: 'user-a', openidId: 'subject-a' };
  expect(() =>
    buildMCPToolReviewAuthority({ serverName: 'db', config: selected, user: principal }),
  ).not.toThrow();
  expect(
    buildMCPToolReviewAuthority({ serverName: 'db', config: selected, user: principal }),
  ).toEqual(expect.any(String));
});

const tokenPrincipal = (token: string) => ({
  id: 'user-a',
  openidId: 'subject-a',
  openidTokens: { access_token: token, expires_at: Math.floor(Date.now() / 1000) + 3600 },
});

for (const field of renewableFields) {
  test(`${field} stdio env and arguments retain routing without renewable token bytes`, () => {
    const selected = {
      type: 'stdio' as const,
      source: 'yaml' as const,
      command: 'node',
      args: ['server.js', `--credential={{${field}}}`, '--workspace={{WORKSPACE}}'],
      env: {
        UPSTREAM_ACCESS_TOKEN: `{{WORKSPACE}}:{{${field}}}`,
        USER: '{{LIBRECHAT_USER_OPENIDID}}',
      },
    };
    const authority = (token: string, workspace = 'a', subject = 'subject-a') =>
      buildMCPToolReviewAuthority({
        serverName: 'db',
        config: selected,
        user: { ...tokenPrincipal(token), openidId: subject },
        customUserVars: { WORKSPACE: workspace },
      });
    const first = authority('synthetic-a');
    expect(first).toEqual(expect.any(String));
    expect(authority('synthetic-b')).toBe(first);
    expect(authority('synthetic-b', 'b')).not.toBe(first);
    expect(authority('synthetic-b', 'a', 'subject-b')).not.toBe(first);
    expect(selected.env.UPSTREAM_ACCESS_TOKEN).toBe(`{{WORKSPACE}}:{{${field}}}`);
  });
}

test('renewable OAuth and URL fragments retain surrounding destination authority', () => {
  const selected = {
    ...config,
    url: 'https://{{WORKSPACE}}.example.test/mcp?token={{LIBRECHAT_OPENID_ACCESS_TOKEN}}',
    oauth: {
      client_id: '{{WORKSPACE}}',
      client_secret: '{{LIBRECHAT_OPENID_ACCESS_TOKEN}}',
      authorization_url: 'https://{{WORKSPACE}}.example.test/authorize',
    },
  };
  const authority = (token: string, workspace = 'a') =>
    buildMCPToolReviewAuthority({
      serverName: 'db',
      config: selected,
      user: tokenPrincipal(token),
      customUserVars: { WORKSPACE: workspace },
    });
  expect(authority('synthetic-b')).toBe(authority('synthetic-a'));
  expect(authority('synthetic-b', 'b')).not.toBe(authority('synthetic-a'));
});

test('an injected renewable API key is masked without ignoring declared credential changes', () => {
  const selected = {
    ...config,
    apiKey: {
      source: 'admin' as const,
      authorization_type: 'bearer' as const,
      key: '{{LIBRECHAT_OPENID_ACCESS_TOKEN}}',
    },
  };
  const a = buildMCPToolReviewAuthority({
    serverName: 'db',
    config: selected,
    user: tokenPrincipal('synthetic-a'),
  });
  expect(
    buildMCPToolReviewAuthority({
      serverName: 'db',
      config: selected,
      user: tokenPrincipal('synthetic-b'),
    }),
  ).toBe(a);
  expect(
    buildMCPToolReviewAuthority({
      serverName: 'db',
      config: { ...selected, apiKey: { ...selected.apiKey, key: 'static-admin-credential' } },
      user: tokenPrincipal('synthetic-b'),
    }),
  ).not.toBe(a);
});

test('real registry timestamps and inspection summaries do not change review authority', async () => {
  const registry = new ServerConfigsCacheInMemory();
  await registry.add('db', { ...config, initDuration: 2 });
  const before = buildMCPToolReviewAuthority({
    serverName: 'db',
    config: await registry.get('db'),
  });
  await registry.update('db', {
    ...config,
    initDuration: 200,
    capabilities: 'reinspected',
    tools: 'new summary',
    resolvedInstructions: 'new instructions',
  });
  expect(buildMCPToolReviewAuthority({ serverName: 'db', config: await registry.get('db') })).toBe(
    before,
  );
  expect(
    buildMCPToolReviewAuthority({ serverName: 'db', config: { ...config, source: 'user' } }),
  ).not.toBe(before);
});

test.each(['header', 'env', 'argument', 'url'] as const)(
  'environment-expanded renewable %s is stable before refresh and still binds routing',
  (field) => {
    const saved = process.env.TEST_MCP_APPROVAL_TEMPLATE;
    process.env.TEST_MCP_APPROVAL_TEMPLATE = '{{WORKSPACE}}:{{LIBRECHAT_OPENID_ACCESS_TOKEN}}';
    const template = '${TEST_MCP_APPROVAL_TEMPLATE}';
    const selected =
      field === 'env' || field === 'argument'
        ? {
            type: 'stdio' as const,
            source: 'yaml' as const,
            command: 'node',
            args: field === 'argument' ? [template] : ['server.js'],
            env: field === 'env' ? { UPSTREAM_TOKEN: template } : undefined,
          }
        : {
            ...config,
            headers: field === 'header' ? { Authorization: template } : undefined,
            url: field === 'url' ? `https://mcp.example.test/${template}` : config.url,
          };
    const authority = (access_token: string, expires_at: number, WORKSPACE = 'a') =>
      buildMCPToolReviewAuthority({
        serverName: 'db',
        config: selected,
        user: { ...tokenPrincipal(access_token), openidTokens: { access_token, expires_at } },
        customUserVars: { WORKSPACE },
      });
    try {
      const first = authority('synthetic-a', Math.floor(Date.now() / 1000) + 3600);
      expect(first).toEqual(expect.any(String));
      expect(authority('synthetic-b', 0)).toBe(first);
      expect(authority('synthetic-b', 0, 'b')).not.toBe(first);
      expect(() =>
        processMCPEnv({
          options: selected,
          user: {
            ...tokenPrincipal('synthetic-b'),
            openidTokens: { access_token: 'synthetic-b', expires_at: 0 },
          },
        }),
      ).toThrow('re-authentication');
    } finally {
      if (saved == null) delete process.env.TEST_MCP_APPROVAL_TEMPLATE;
      else process.env.TEST_MCP_APPROVAL_TEMPLATE = saved;
    }
  },
);

test('renewable placeholders introduced by operator substitution are masked after routing resolves', () => {
  const selected = { ...config, headers: { Authorization: '{{AUTH_TEMPLATE}}' } };
  const authority = (token: string, WORKSPACE: string) =>
    buildMCPToolReviewAuthority({
      serverName: 'db',
      config: selected,
      user: tokenPrincipal(token),
      customUserVars: {
        AUTH_TEMPLATE: '{{WORKSPACE}}:{{LIBRECHAT_OPENID_ACCESS_TOKEN}}',
        WORKSPACE,
      },
    });
  expect(authority('synthetic-b', 'a')).toBe(authority('synthetic-a', 'a'));
  expect(authority('synthetic-b', 'b')).not.toBe(authority('synthetic-a', 'a'));
});

test('approval authentication kind follows effective factory auth, not retained OAuth config', () => {
  const base = {
    type: 'streamable-http' as const,
    source: 'yaml' as const,
    url: 'https://mcp.example.test',
  };
  expect(getMCPToolApprovalAuthKind({ ...base, requiresOAuth: true })).toBe('oauth');
  expect(getMCPToolApprovalAuthKind({ ...base, oauth: { client_id: 'client' } })).toBe('oauth');
  expect(
    getMCPToolApprovalAuthKind({
      ...base,
      requiresOAuth: false,
      oauth: { client_id: 'retained' },
      apiKey: { source: 'admin', authorization_type: 'bearer', key: 'synthetic-key' },
    }),
  ).toBe('other');
  expect(getMCPToolApprovalAuthKind(base)).toBe('other');
  expect(getMCPToolApprovalAuthKind(undefined)).toBeUndefined();
  expect(getMCPToolApprovalAuthKind({ ...base, obo: { scopes: 'api://resource/.default' } })).toBe(
    'other',
  );
  expect(
    getMCPToolApprovalAuthKind({
      ...base,
      headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
    }),
  ).toBe('other');
  expect(
    getMCPToolApprovalAuthKind({
      ...base,
      headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
      requestHeaders: { Authorization: 'Bearer static-user-key' },
      requiresOAuth: true,
    }),
  ).toBe('oauth');
});

test.each(['yaml', 'config'] as const)(
  '%s runtime URL keeps OAuth provenance unresolved until detection',
  (source) => {
    const selected = {
      type: 'streamable-http' as const,
      source,
      url: 'https://mcp.example.test/users/{{LIBRECHAT_USER_ID}}/mcp',
    };
    expect(getMCPToolApprovalAuthKind(selected)).toBeUndefined();
    expect(getMCPToolApprovalAuthKind({ ...selected, requiresOAuth: true })).toBe('oauth');
    expect(getMCPToolApprovalAuthKind({ ...selected, requiresOAuth: false })).toBe('other');
    expect(getMCPToolApprovalAuthKind({ ...selected, oauth: { client_id: 'configured' } })).toBe(
      'oauth',
    );
    expect(
      getMCPToolApprovalAuthKind({
        ...selected,
        apiKey: { source: 'admin', key: 'synthetic-key', authorization_type: 'bearer' },
      }),
    ).toBe('other');
    expect(
      getMCPToolApprovalAuthKind({
        ...selected,
        headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
      }),
    ).toBe('other');
    expect(
      getMCPToolApprovalAuthKind({ ...selected, obo: { scopes: 'api://scope/.default' } }),
    ).toBe('other');
    expect(getMCPToolApprovalAuthKind({ ...selected, source: 'user', dbId: 'user-config' })).toBe(
      'other',
    );
    expect(getMCPToolApprovalAuthKind({ ...selected, source: 'plugin' })).toBe('other');
  },
);

test('body-bound and environment-indirected runtime URLs retain conservative OAuth checks', () => {
  const selected = {
    type: 'streamable-http' as const,
    source: 'yaml' as const,
    url: 'https://mcp.example.test/{{LIBRECHAT_BODY_CONVERSATIONID}}',
  };
  expect(getMCPToolApprovalAuthKind(selected)).toBeUndefined();
  const saved = process.env.TEST_MCP_DYNAMIC_URL;
  process.env.TEST_MCP_DYNAMIC_URL = 'https://mcp.example.test/{{LIBRECHAT_USER_ID}}';
  try {
    expect(
      getMCPToolApprovalAuthKind({ ...selected, url: '${TEST_MCP_DYNAMIC_URL}' }),
    ).toBeUndefined();
  } finally {
    if (saved == null) delete process.env.TEST_MCP_DYNAMIC_URL;
    else process.env.TEST_MCP_DYNAMIC_URL = saved;
  }
});
