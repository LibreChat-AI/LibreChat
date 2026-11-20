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

const completion = {
  scheduleId: 'schedule',
  ownerId: 'owner',
  tenantId: 'tenant',
  agentId: 'root',
  invocationMode: 'delegated' as const,
};
it('retains validated completion-lineage identity in private metadata', () => {
  expect(sanitizeJobMetadata({ scheduleMCPCompletion: completion })).toEqual({
    scheduleMCPCompletion: completion,
  });
  expect(() =>
    sanitizeJobMetadata({ scheduleMCPCompletion: { ...completion, token: 'PRIVATE' } } as never),
  ).toThrow('binding_mismatch');
  expect(sanitizeJobMetadata({})).not.toHaveProperty('scheduleMCPCompletion');
});
it.each([null, {}, 'malformed', { ...completion, invocationMode: 'autonomous' }])(
  'never treats invalid completion lineage as ordinary metadata: %s',
  (value) => {
    expect(() => sanitizeJobMetadata({ scheduleMCPCompletion: value } as never)).toThrow(
      'binding_mismatch',
    );
  },
);
