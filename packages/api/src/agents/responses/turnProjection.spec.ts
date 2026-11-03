import { randomUUID } from 'node:crypto';
import { createManagedMessageId, createManagedConversationId } from '@librechat/data-schemas';
import type { StoredResponseRecord } from '@librechat/data-schemas';
import type { ResponseTurnIntent } from './foreground';
import { normalizeResponseTurnIntent, projectCanonicalResponseTurn } from './turnProjection';

function fixture(count = 2) {
  const record: StoredResponseRecord = {
    userId: 'projection-owner',
    responseId: createManagedMessageId(),
    storageTarget: { kind: 'response', id: '507f1f77bcf86cd799439011', incarnation: randomUUID() },
    requestKey: randomUUID(),
    fingerprint: 'immutable-request',
    agentId: 'agent',
    requestJSON: JSON.stringify({
      input: Array.from({ length: count }, (_, index) => ({
        type: 'message',
        role: 'user',
        content: `input ${index}`,
      })),
    }),
    conversationId: createManagedConversationId(),
    parentMessageId: 'existing-authorized-parent',
    status: 'in_progress',
    revision: 1,
    generationCreatedAt: 100,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  let parentMessageId = record.parentMessageId;
  const inputs = Array.from({ length: count }, (_, index) => {
    const input = { index, messageId: randomUUID(), parentMessageId };
    parentMessageId = input.messageId;
    return input;
  });
  const intent: ResponseTurnIntent = {
    version: 1,
    inputs,
    parentMessageId,
    context: { userId: record.userId },
    conversation: { conversationId: record.conversationId, agent_id: record.agentId },
    initialAgentId: record.agentId,
    trace: {},
  };
  return { record, intent };
}

it('assigns stable managed input IDs and remaps the entire canonical parent chain', () => {
  const { record, intent } = fixture();
  const raw = JSON.stringify(intent);
  const normalized = normalizeResponseTurnIntent(record, raw);
  expect(normalizeResponseTurnIntent(record, raw)).toBe(normalized);
  expect(normalizeResponseTurnIntent(record, normalized)).toBe(normalized);
  expect(JSON.stringify(intent)).toBe(raw);
  const writes = projectCanonicalResponseTurn(record, {
    generationCreatedAt: record.generationCreatedAt!,
    providerExecutionId: 'provider',
    status: 'completed',
    turnJSON: normalized,
    responseJSON: JSON.stringify({ status: 'completed', output: [] }),
  })!;
  expect(writes.messages).toHaveLength(3);
  expect(writes.messages.map((message) => message.messageId)).toEqual([
    expect.stringMatching(/^resp_d_[a-f\d]{32}$/),
    expect.stringMatching(/^resp_d_[a-f\d]{32}$/),
    record.responseId,
  ]);
  expect(new Set(writes.messages.map((message) => message.messageId)).size).toBe(3);
  expect(writes.messages.map((message) => message.parentMessageId)).toEqual([
    record.parentMessageId,
    writes.messages[0].messageId,
    writes.messages[1].messageId,
  ]);
  expect(writes.messages.slice(0, 2).map((message) => message.text)).toEqual([
    'input 0',
    'input 1',
  ]);
});

it('does not let a recreated physical Root reuse the earlier input identities', () => {
  const { record, intent } = fixture();
  const raw = JSON.stringify(intent);
  const replacement = {
    ...record,
    storageTarget: { ...record.storageTarget!, incarnation: randomUUID() },
  };
  expect(normalizeResponseTurnIntent(replacement, raw)).not.toBe(
    normalizeResponseTurnIntent(record, raw),
  );
});

it('preserves the authorized parent when a resumed segment has no new inputs', () => {
  const { record, intent } = fixture(0);
  expect(JSON.parse(normalizeResponseTurnIntent(record, JSON.stringify(intent)))).toMatchObject({
    inputs: [],
    parentMessageId: record.parentMessageId,
  });
});

it('reconstructs original inputs for a resumed terminal turn without relying on unfinished history', () => {
  const { record, intent } = fixture();
  const initial = normalizeResponseTurnIntent(record, JSON.stringify(intent));
  record.resume = {
    intentId: 'resume',
    actionId: 'action',
    previousProviderExecutionId: 'first',
    providerExecutionId: 'second',
    fingerprint: 'reviewed',
    resolutionJSON: '{}',
    state: 'admitted',
    reservedAt: 1,
  };
  const resumed = normalizeResponseTurnIntent(
    record,
    JSON.stringify({
      ...intent,
      inputs: [],
      parentMessageId: record.parentMessageId,
    }),
  );
  expect(resumed).toBe(initial);
  const writes = projectCanonicalResponseTurn(record, {
    generationCreatedAt: 100,
    providerExecutionId: 'second',
    status: 'completed',
    turnJSON: resumed,
    responseJSON: JSON.stringify({ status: 'completed', output: [] }),
  });
  expect(writes?.messages.map((message) => message.text)).toEqual(['input 0', 'input 1', '']);
});

it.each(['first parent', 'later parent', 'output parent', 'ordinal'] as const)(
  'rejects a changed %s before freezing the turn',
  (change) => {
    const { record, intent } = fixture();
    if (change === 'first parent') intent.inputs[0].parentMessageId = 'unrelated';
    if (change === 'later parent') intent.inputs[1].parentMessageId = 'unrelated';
    if (change === 'output parent') intent.parentMessageId = 'unrelated';
    if (change === 'ordinal') intent.inputs[1].index = 0;
    expect(() => normalizeResponseTurnIntent(record, JSON.stringify(intent))).toThrow('ancestry');
  },
);
