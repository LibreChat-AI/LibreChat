import { buildMCPToolApprovalBinding } from '~/agents/hitl/modes';
import { buildMCPToolReviewAuthority } from './approval';

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
