import type { ChannelDeliveryOutcome, ChannelRunSnapshot } from 'librechat-data-provider';
import type { ChannelRunRecord } from '~/models/channelRun';
import {
  deliveryDisposition,
  snapshotPatch,
  stopScopeKey,
  laneKey,
  digest,
} from './channelProtocol';

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

it('preserves historical Slack lane, stop and admission fingerprints', () => {
  const current = run();
  expect(laneKey(current)).toBe('bd0af70711e9c79d1c19ca885dc8ad294bc75050e1dcae070fe43dd9cd3d2243');
  expect(stopScopeKey(current)).toBe(
    'c68e880e109a1c5f4616937bc4176ec4aa01c30ef80ad1a7868d8fa63988b41f',
  );
  expect(digest(current.admission)).toBe(
    'fb451a0a3ff012781408fb5dfdb7be56a070f71bd079b336ec4d493cf40bc24d',
  );
});

it('isolates Discord lanes and stop scopes by application, guild and actor', () => {
  const current = run();
  const slackLane = laneKey(current);
  current.admission.actor = {
    provider: 'discord',
    applicationId: '123456789012345678',
    guildId: '234567890123456789',
    externalUserId: '345678901234567890',
  };
  expect(laneKey(current)).not.toBe(slackLane);
  for (const field of ['applicationId', 'guildId', 'externalUserId'] as const) {
    const changed = {
      ...current,
      admission: {
        ...current.admission,
        actor: { ...current.admission.actor, [field]: '456789012345678901' },
      },
    };
    expect(laneKey(changed)).not.toBe(laneKey(current));
    expect(stopScopeKey(changed)).not.toBe(stopScopeKey(current));
  }
});

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

it('separates stable provider Stop identity from versioned execution authority', () => {
  const source = run();
  const expected = stopScopeKey(source);
  expect(
    stopScopeKey({
      ...source,
      agentId: 'other-agent',
      principal: {
        userId: 'other-user',
        channelRevision: 'other-revision',
        linkId: 'other-link',
        linkRevision: 'other-link-revision',
      },
    }),
  ).toBe(expected);
  for (const changed of [
    { ...source, tenantId: 'other-tenant' },
    { ...source, channelId: 'other-channel' },
    { ...source, admission: { ...source.admission, externalThreadKey: 'C:other' } },
    { ...source, admission: { ...source.admission, externalChannelId: 'other-C' } },
    ...['teamId', 'appId', 'externalUserId'].map((field) => ({
      ...source,
      admission: { ...source.admission, actor: { ...source.admission.actor, [field]: 'other' } },
    })),
  ])
    expect(stopScopeKey(changed)).not.toBe(expected);
});
