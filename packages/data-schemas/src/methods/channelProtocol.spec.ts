import type { ChannelDeliveryOutcome, ChannelRunSnapshot } from 'librechat-data-provider';
import type { ChannelRunRecord } from '~/models/channelRun';
import { deliveryDisposition, snapshotPatch } from './channelProtocol';

function run(): ChannelRunRecord {
  return {
    tenantId: 'tenant',
    channelId: 'channel',
    agentId: 'agent',
    laneId: 'lane',
    runId: 'run',
    principal: { userId: 'user', channelRevision: 'revision' },
    payloadHash: 'hash',
    sequence: 1,
    admission: {
      eventId: 'event',
      externalChannelId: 'C',
      externalThreadKey: 'C:thread',
      externalMessageKey: 'C:event',
      actor: { teamId: 'team', appId: 'app', externalUserId: 'actor' },
      input: 'question',
    },
    receivedAt: 1,
    state: 'delivering',
    leaseEpoch: 1,
    leaseExpiresAt: 1000,
    cancellationRequested: false,
    execution: {
      requestId: 'run',
      conversationId: 'conversation',
      parentMessageId: 'parent',
      responseId: 'response',
    },
    snapshot: { status: 'completed', responseId: 'response', text: 'answer', elapsedMs: 1 },
    plan: {
      revision: 'plan',
      rendererVersion: 'test',
      parts: [
        { operationId: 'required', kind: 'message', required: true, text: 'answer' },
        { operationId: 'optional', kind: 'message', required: false, text: 'footer' },
      ],
    },
    receipts: [
      {
        operationId: 'required',
        outcome: 'confirmed',
        attempts: 1,
        externalMessageKey: 'C:required',
      },
      {
        operationId: 'optional',
        outcome: 'confirmed',
        attempts: 1,
        externalMessageKey: 'C:optional',
      },
    ],
  };
}

const outcomes: ChannelDeliveryOutcome[] = [
  'planned',
  'inflight',
  'confirmed',
  'retryable',
  'unknown',
  'permanent_failure',
];
const deliveryCases = outcomes.flatMap((required) =>
  outcomes.map((optional) => ({ required, optional })),
);
it.each(deliveryCases)(
  'finalizes required=$required and optional=$optional according to delivery policy',
  ({ required, optional }) => {
    const current = run();
    current.receipts[0].outcome = required;
    current.receipts[1].outcome = optional;
    const canFinish =
      ![required, optional].includes('inflight') &&
      ['confirmed', 'permanent_failure'].includes(required);
    if (!canFinish) expect(() => deliveryDisposition(current, 100)).toThrow('delivery_incomplete');
    else
      expect(deliveryDisposition(current, 100)).toBe(
        required === 'permanent_failure' ? 'failed' : 'delivered',
      );
  },
);

const statuses: ChannelRunSnapshot['status'][] = [
  'running',
  'requires_action',
  'completed',
  'failed',
  'cancelled',
];
const snapshotCases = statuses.flatMap((previous) => statuses.map((next) => ({ previous, next })));
it.each(snapshotCases)(
  'projects $previous to $next without reopening terminal work',
  ({ previous, next }) => {
    const current = run();
    delete current.plan;
    current.snapshot = { ...current.snapshot!, status: previous };
    const phases: Record<ChannelRunSnapshot['status'], ChannelRunRecord['state']> = {
      running: 'executing',
      requires_action: 'requires_action',
      completed: 'delivering',
      failed: 'delivering',
      cancelled: 'delivering',
    };
    current.state = phases[previous];
    const incoming = { ...current.snapshot, status: next };
    if (['completed', 'failed', 'cancelled'].includes(previous) && previous !== next)
      expect(() => snapshotPatch(current, incoming)).toThrow('invalid_transition');
    else expect(snapshotPatch(current, incoming).state).toBe(phases[next]);
  },
);

it('does not finalize while a progress operation is still active', () => {
  const current = run();
  current.progress = {
    revision: 1,
    rendererVersion: 'test',
    text: 'progress',
    outcome: 'inflight',
    attempts: 1,
  };
  expect(() => deliveryDisposition(current, 100)).toThrow('delivery_incomplete');
});

it('rejects duplicate receipt identities instead of treating an incomplete plan as confirmed', () => {
  const current = run();
  current.receipts[1] = current.receipts[0];
  expect(() => deliveryDisposition(current, 100)).toThrow('invalid_transition');
});
