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

const trigger = {
  subject: { kind: 'key' as const, id: 'key-1' },
  delivery: {
    key: 'trigger_abc',
    event: { id: 'event-1', type: 'review.submitted', occurredAt: 1_000 },
  },
};
it('saves the subject and delivery of the trigger that started a run, and nothing else of it', () => {
  const source = { type: 'trigger' as const, ...trigger, manual: false, resumed: false };
  expect(sanitizeJobMetadata({ trigger: source })).toEqual({ trigger });
  expect(sanitizeJobMetadata({ trigger: { delivery: trigger.delivery } })).toEqual({
    trigger: { delivery: trigger.delivery },
  });
  expect(sanitizeJobMetadata({})).not.toHaveProperty('trigger');
  expect(sanitizeJobMetadata({ trigger: undefined })).not.toHaveProperty('trigger');
  // A source no trigger started, such as a remote API run's, saves none.
  expect(
    sanitizeJobMetadata({ trigger: { type: 'remote_api', keyId: 'key-1' } } as never),
  ).not.toHaveProperty('trigger');
});
it.each([null, 'key-1', { subject: { kind: 'user', id: 'owner' } }, { delivery: {} }])(
  'never saves a trigger it cannot read as an ordinary job: %j',
  (value) => {
    expect(() => sanitizeJobMetadata({ trigger: value } as never)).toThrow('run_trigger_invalid');
  },
);
