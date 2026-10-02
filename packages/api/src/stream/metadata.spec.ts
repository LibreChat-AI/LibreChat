import { sanitizeJobMetadata } from './metadata';

const failure = {
  server: '',
  agentId: 'child',
  status: 'mcp_permission_denied' as const,
  reason: 'tool_policy_denied' as const,
  recovery: 'configure' as const,
  automaticReplay: false as const,
};

it('retains only safe structured schedule-denial metadata', () => {
  const outcome = { ...failure, token: 'PRIVATE', arguments: { text: 'PRIVATE' } };
  expect(sanitizeJobMetadata({ scheduleMCPFailure: outcome }).scheduleMCPFailure).toEqual(failure);
  expect(JSON.stringify(sanitizeJobMetadata({ scheduleMCPFailure: outcome }))).not.toContain(
    'PRIVATE',
  );
});

it('does not manufacture a failure receipt from a ready or ordinary outcome', () => {
  expect(sanitizeJobMetadata({}).scheduleMCPFailure).toBeUndefined();
  expect(
    sanitizeJobMetadata({ scheduleMCPFailure: { server: 'mcp', status: 'ready' } })
      .scheduleMCPFailure,
  ).toBeUndefined();
  expect(
    sanitizeJobMetadata({ scheduleMCPFailure: { server: 'mcp', status: 'mcp_permission_denied' } })
      .scheduleMCPFailure,
  ).toBeUndefined();
});
