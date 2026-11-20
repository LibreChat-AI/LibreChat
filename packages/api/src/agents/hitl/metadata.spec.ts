import {
  bindToolApprovalIdentity,
  getToolApprovalBinding,
  getToolApprovalIdentity,
  getToolApprovalAuthKind,
  getToolApprovalName,
  getToolReviewAuthority,
} from '~/tools/approval';
import { buildMCPToolReviewAuthority } from '~/mcp/approval';
import { createMCPToolApprovalMetadata } from './metadata';
import { buildMCPToolApprovalBinding } from './modes';
import { createSafeUser } from '~/utils/env';

const config = {
  type: 'streamable-http' as const,
  source: 'yaml' as const,
  url: 'https://mcp.example.test',
  requiresOAuth: false,
};
const parameters = { type: 'object', properties: { text: { type: 'string' } } };
const user = {
  id: 'user-a',
  role: 'USER',
  openidId: 'subject-a',
  password: 'synthetic-not-authority',
};

for (const auth of ['oauth', 'other', 'runtime'] as const) {
  test(`${auth} metadata is identical across runtime and definitions loading`, () => {
    const selected =
      auth === 'runtime'
        ? {
            ...config,
            requiresOAuth: undefined,
            url: 'https://mcp.example.test/{{LIBRECHAT_USER_ID}}',
          }
        : { ...config, requiresOAuth: auth === 'oauth' };
    const input = { serverName: 'db', config: selected, user };
    const metadata = createMCPToolApprovalMetadata();
    metadata.capture(input);
    const definition = bindToolApprovalIdentity(
      { name: 'query_mcp_db', serverName: 'db', parameters },
      'db_query',
      parameters,
    );
    metadata.attach([definition]);
    const instance = metadata.bindInstance(
      { name: 'db_query_mcp_db' },
      { ...input, upstreamName: 'db_query', currentToolName: 'query', parameters },
    );
    expect(getToolApprovalBinding(instance)).toBe(getToolApprovalBinding(definition));
    expect(getToolReviewAuthority(instance)).toBe(getToolReviewAuthority(definition));
    expect(getToolApprovalIdentity(instance)).toBe(getToolApprovalIdentity(definition));
    expect(getToolApprovalAuthKind(instance)).toBe(auth === 'runtime' ? undefined : auth);
    expect(getToolApprovalAuthKind(definition)).toBe(getToolApprovalAuthKind(instance));
    expect(getToolApprovalName(instance)).toBe('query_mcp_db');
    expect(getToolApprovalBinding(instance)).toBe(buildMCPToolApprovalBinding('db', selected));
    expect(getToolReviewAuthority(instance)).toBe(
      buildMCPToolReviewAuthority({ ...input, user: createSafeUser(user) }),
    );
    expect(JSON.parse(JSON.stringify(instance))).toEqual({ name: 'db_query_mcp_db' });
  });
}

test('metadata capture is request-local and refreshes effective authority without changing definitions', () => {
  const first = createMCPToolApprovalMetadata();
  const second = createMCPToolApprovalMetadata();
  first.capture({ serverName: 'db', config });
  const a = { name: 'query_mcp_db', serverName: 'db' };
  const b = { ...a };
  first.attach([a]);
  second.attach([b]);
  expect(getToolApprovalBinding(a)).toEqual(expect.any(String));
  expect(getToolApprovalBinding(b)).toBeUndefined();
  const before = getToolApprovalBinding(a);
  first.capture({ serverName: 'db', config: { ...config, url: 'https://changed.example.test' } });
  const changed = { ...b };
  first.attach([changed]);
  expect(getToolApprovalBinding(changed)).not.toBe(before);
  expect(getToolApprovalBinding(a)).toBe(before);
});

test('review-only metadata pins resolved routes, preserves raw identity, and excludes unrelated user secrets', () => {
  const selected = { ...config, headers: { 'X-Workspace': '{{WORKSPACE}}' } };
  const metadata = createMCPToolApprovalMetadata();
  const build = (WORKSPACE: string, password = user.password, upstreamName = 'query') => {
    const principal = { ...user, password };
    return metadata.bindInstance(
      { name: 'query_mcp_db' },
      {
        serverName: 'db',
        config: selected,
        user: principal,
        customUserVars: { WORKSPACE },
        upstreamName,
        parameters,
      },
    );
  };
  const a = build('a');
  const b = build('b');
  expect(getToolApprovalBinding(a)).toBeUndefined();
  expect(getToolReviewAuthority(a)).toEqual(expect.any(String));
  expect(getToolReviewAuthority(b)).not.toBe(getToolReviewAuthority(a));
  expect(getToolReviewAuthority(build('a', 'different-synthetic-password'))).toBe(
    getToolReviewAuthority(a),
  );
  expect(getToolApprovalIdentity(build('a', undefined, 'other_query'))).not.toBe(
    getToolApprovalIdentity(a),
  );
});

test('identity uses normalized upstream schema and raw server names retain canonical key spelling', () => {
  const metadata = createMCPToolApprovalMetadata();
  const schema = { $ref: '#/definitions/Args', definitions: { Args: parameters } };
  const actual = metadata.bindInstance(
    { name: 'raw_mcp_db_ops' },
    {
      serverName: 'db ops',
      config,
      currentToolName: 'query',
      upstreamName: 'db_ops_query',
      parameters: schema,
    },
  );
  const normalized = metadata.bindInstance(
    { name: 'raw_mcp_db_ops' },
    {
      serverName: 'db ops',
      config,
      currentToolName: 'query',
      upstreamName: 'db_ops_query',
      parameters,
    },
  );
  expect(getToolApprovalName(actual)).toBe('query_mcp_db_ops');
  expect(getToolApprovalIdentity(actual)).toBe(getToolApprovalIdentity(normalized));
});
