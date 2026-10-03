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
