import { ContentTypes, SteerEvents } from 'librechat-data-provider';
import type {
  SubagentContentAppendResult,
  SubagentContentMethods,
  SubagentContentBatch,
  SubagentContentScope,
} from '@librechat/data-schemas';
import type { SubagentUpdateEvent } from '@librechat/agents';
import { readSubagentContent, SubagentContentJournal } from './subagentContent';

const scope: SubagentContentScope = {
  user: 'owner',
  parentConversationId: 'parent',
  conversationId: 'child',
  taskId: 'task',
};

const update = (phase: SubagentUpdateEvent['phase'], data: unknown): SubagentUpdateEvent => ({
  runId: 'root',
  subagentRunId: 'execution',
  subagentType: 'worker',
  subagentAgentId: 'worker',
  phase,
  data,
  timestamp: '2026-10-20T00:00:00.000Z',
});

function memoryStorage() {
  const batches: SubagentContentBatch[] = [];
  const methods: SubagentContentMethods = {
    reconcileSubagentContent: async () => ({ ok: true }),
    appendSubagentContentBatch: async ({ revision, fromSequence, throughSequence, eventsJson }) => {
      batches.push({ revision, fromSequence, throughSequence, eventsJson });
      return { ok: true };
    },
    getSubagentContentHead: async (_scope, throughRevision) => {
      let head: SubagentContentBatch | undefined;
      for (let index = batches.length - 1; index >= 0; index--) {
        if (throughRevision == null || batches[index].revision <= throughRevision) {
          head = batches[index];
          break;
        }
      }
      return head == null
        ? null
        : { revision: head.revision, throughSequence: head.throughSequence };
    },
    streamSubagentContentBatches: async function* (_scope, throughRevision, afterSequence = -1) {
      for (const batch of batches) {
        if (batch.revision <= throughRevision && batch.throughSequence > afterSequence) yield batch;
      }
    },
  };
  return { methods, batches };
}

const journalFor = (methods: SubagentContentMethods, batchBytes = 1_000_000) =>
  new SubagentContentJournal({
    scope,
    flushMs: 60_000,
    batchBytes,
    append: methods.appendSubagentContentBatch,
    notify: async () => undefined,
    onError: () => undefined,
  });

it('reconstructs earlier text after more than a replay window of public deltas', async () => {
  const { methods } = memoryStorage();
  const journal = journalFor(methods);
  journal.record(
    update('run_step', {
      id: 'text',
      index: 0,
      stepDetails: {
        type: 'message_creation',
        message_creation: { message_id: 'reply', phase: 'commentary' },
      },
    }),
    0,
  );
  for (let index = 1; index <= 150; index++) {
    journal.record(
      update('message_delta', {
        id: 'text',
        delta: { content: [{ type: 'text', text: `${index},` }] },
      }),
      index,
    );
  }
  await journal.close();
  const result = await readSubagentContent(methods, scope);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.content).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'text',
        text: Array.from({ length: 150 }, (_, i) => `${i + 1},`).join(''),
      }),
    ]),
  );
  expect(result.value.content[0]).toMatchObject({ phase: 'commentary' });
  expect(result.value.throughSequence).toBe(150);
});

it('keeps full tool content larger than the previous activity projection', async () => {
  const { methods } = memoryStorage();
  const journal = journalFor(methods);
  const output = 'full-output:'.repeat(4000);
  const args = { query: 'full-arguments:'.repeat(2000) };
  journal.record(
    update('run_step', {
      id: 'tool',
      index: 0,
      stepDetails: {
        type: 'tool_calls',
        tool_calls: [{ id: 'call', name: 'lookup', args, type: 'tool_call' }],
      },
    }),
    0,
  );
  journal.record(
    update('run_step_completed', {
      result: {
        id: 'tool',
        type: 'tool_call',
        tool_call: { id: 'call', name: 'lookup', args, output, progress: 1 },
      },
    }),
    1,
  );
  await journal.close();
  const result = await readSubagentContent(methods, scope);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(JSON.stringify(result.value.content)).toContain(output);
  expect(JSON.stringify(result.value.content)).toContain(args.query);
});

it('pins paged recovery before a racing later batch without duplicate sequences', async () => {
  const { methods } = memoryStorage();
  const journal = journalFor(methods);
  for (let sequence = 0; sequence < 12; sequence++) {
    journal.record(
      update('message_delta', {
        id: 's',
        delta: { content: [{ type: 'text', text: 'x'.repeat(250) }] },
      }),
      sequence,
    );
  }
  await journal.flush();
  const first = await readSubagentContent(methods, scope, -1, { pageBytes: 1024 });
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  const sequences = first.value.events.map((event) => event.sequence);
  journal.record(
    update('message_delta', { id: 's', delta: { content: [{ type: 'text', text: 'later' }] } }),
    12,
  );
  await journal.flush();
  let cursor = first.value.nextCursor;
  while (cursor != null) {
    const pin: { afterSequence: number; throughRevision: number } = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    );
    const page = await readSubagentContent(methods, scope, pin.afterSequence, {
      pageBytes: 1024,
      throughRevision: pin.throughRevision,
    });
    expect(page.ok).toBe(true);
    if (!page.ok) break;
    sequences.push(...page.value.events.map((event) => event.sequence));
    cursor = page.value.nextCursor;
  }
  await journal.close();
  expect(sequences).toEqual(Array.from({ length: 12 }, (_, i) => i));
  expect(await readSubagentContent(methods, scope, 11)).toMatchObject({
    ok: true,
    value: { events: [{ sequence: 12 }] },
  });
});

it('reports a missing committed range instead of treating it as an empty response', async () => {
  const { methods, batches } = memoryStorage();
  batches.push({ revision: 2, fromSequence: 5, throughSequence: 7, eventsJson: '[]' });
  expect(await readSubagentContent(methods, scope)).toEqual({
    ok: false,
    error: { code: 'SUBAGENT_CONTENT_GAP' },
  });
});

it('bounds a blocked capture backlog without blocking child execution or claiming complete history', async () => {
  const { methods, batches } = memoryStorage();
  const errors: unknown[] = [];
  const journal = new SubagentContentJournal({
    scope,
    flushMs: 60_000,
    batchBytes: 1_000_000,
    maxPendingBytes: 1024,
    append: methods.appendSubagentContentBatch,
    notify: async () => undefined,
    onError: (error) => errors.push(error),
  });
  for (let sequence = 0; sequence < 1000; sequence++) {
    journal.record(
      update('message_delta', {
        id: 's',
        delta: { content: [{ type: 'text', text: 'x'.repeat(250) }] },
      }),
      sequence,
    );
  }
  await journal.close();
  expect(errors).toHaveLength(1);
  expect(journal.throughSequence).toBe(999);
  expect(batches[batches.length - 1]?.throughSequence).toBeLessThan(journal.throughSequence);
  expect(
    batches.reduce((size, batch) => size + Buffer.byteLength(batch.eventsJson), 0),
  ).toBeLessThan(1024);
});

it('retries the exact frozen batch before admitting later events into a new revision', async () => {
  const { methods } = memoryStorage();
  const attempts: Array<{ revision: number; eventsJson: string }> = [];
  const fragments = new Map<number, string>();
  let fail = true;
  const journal = new SubagentContentJournal({
    scope,
    flushMs: 60_000,
    batchBytes: 1_000_000,
    append: async (input) => {
      attempts.push({ revision: input.revision, eventsJson: input.eventsJson });
      const prior = fragments.get(input.revision);
      if (prior != null && prior !== input.eventsJson) throw new Error('Conflicting revision');
      fragments.set(input.revision, input.eventsJson);
      if (fail) {
        fail = false;
        throw new Error('Lost append acknowledgment');
      }
      return methods.appendSubagentContentBatch(input);
    },
    notify: async () => undefined,
    onError: () => undefined,
  });
  journal.record(
    update('message_delta', { id: 's', delta: { content: [{ type: 'text', text: 'first' }] } }),
    0,
  );
  await expect(journal.flush()).rejects.toThrow('Lost append acknowledgment');
  journal.record(
    update('message_delta', { id: 's', delta: { content: [{ type: 'text', text: 'second' }] } }),
    1,
  );
  await expect(journal.close()).resolves.toEqual({ ok: true });
  expect(attempts).toHaveLength(3);
  expect(attempts[1]).toEqual(attempts[0]);
  expect(attempts[2].revision).toBe(2);
});

describe('journal close retries', () => {
  const timeoutResult = {
    ok: false,
    error: { code: 'SUBAGENT_CONTENT_SETTLEMENT_TIMEOUT' },
  };
  const unhandled = jest.fn();

  beforeEach(() => {
    jest.useFakeTimers();
    unhandled.mockClear();
    process.on('unhandledRejection', unhandled);
  });

  afterEach(() => {
    process.off('unhandledRejection', unhandled);
    jest.useRealTimers();
  });

  it.each([
    { trigger: 'threshold', lostAck: false },
    { trigger: 'timer', lostAck: false },
    { trigger: 'threshold', lostAck: true },
  ])(
    'retries an active $trigger flush after close begins (lost ack: $lostAck)',
    async ({ trigger, lostAck }) => {
      const { methods, batches } = memoryStorage();
      let rejectFirst: (error: Error) => void = () => undefined;
      const blocked = new Promise<SubagentContentAppendResult>((_resolve, reject) => {
        rejectFirst = reject;
      });
      const append = jest.fn(methods.appendSubagentContentBatch).mockImplementationOnce((input) => {
        if (lostAck) void methods.appendSubagentContentBatch(input);
        return blocked;
      });
      if (lostAck) {
        append.mockImplementation(async (input) =>
          batches.some((batch) => batch.revision === input.revision)
            ? { ok: true }
            : methods.appendSubagentContentBatch(input),
        );
      }
      const notify = jest.fn(async () => undefined);
      const journal = new SubagentContentJournal({
        scope,
        leaseToken: 'lease',
        flushMs: 10,
        batchBytes: trigger === 'threshold' ? 1 : 1_000_000,
        settlementTimeoutMs: 100,
        append,
        notify,
        onError: () => undefined,
      });
      const first = { id: 's', delta: { content: [{ type: 'text', text: 'first' }] } };
      journal.record(update('message_delta', first), 0);
      if (trigger === 'timer') await jest.advanceTimersByTimeAsync(10);
      expect(append).toHaveBeenCalledTimes(1);
      first.delta.content[0].text = 'mutated first';
      const suffix = { id: 's', delta: { content: [{ type: 'text', text: 'suffix' }] } };
      journal.record(update('message_delta', suffix), 1);
      suffix.delta.content[0].text = 'mutated suffix';
      const closing = journal.close();
      void closing.catch(() => undefined);
      expect(journal.close()).toBe(closing);
      rejectFirst(new Error('Transient append failure'));
      await jest.advanceTimersByTimeAsync(10);

      await expect(closing).resolves.toEqual({ ok: true });
      expect(append).toHaveBeenCalledTimes(3);
      expect(append.mock.calls[1][0]).toEqual(append.mock.calls[0][0]);
      expect(append.mock.calls[1][0]).toMatchObject({
        ...scope,
        leaseToken: 'lease',
        revision: 1,
        fromSequence: 0,
        throughSequence: 0,
      });
      expect(append.mock.calls[2][0]).toMatchObject({
        revision: 2,
        fromSequence: 1,
        throughSequence: 1,
      });
      expect(JSON.parse(append.mock.calls[0][0].eventsJson)[0].frame.data).toEqual({
        id: 's',
        delta: { content: [{ type: 'text', text: 'first' }] },
      });
      expect(JSON.parse(append.mock.calls[2][0].eventsJson)[0].frame.data).toEqual({
        id: 's',
        delta: { content: [{ type: 'text', text: 'suffix' }] },
      });
      expect(batches).toHaveLength(2);
      expect(notify.mock.calls).toEqual([
        [{ taskId: scope.taskId, revision: 1, throughSequence: 0 }],
        [{ taskId: scope.taskId, revision: 2, throughSequence: 1 }],
      ]);
      expect(journal.throughSequence).toBe(1);
      expect(jest.getTimerCount()).toBe(0);
      expect(unhandled).not.toHaveBeenCalled();
    },
  );

  it('retries a fresh close flush even when the normal flush cadence exceeds its budget', async () => {
    const { methods } = memoryStorage();
    const append = jest
      .fn(methods.appendSubagentContentBatch)
      .mockRejectedValueOnce(new Error('Transient append failure'));
    const journal = new SubagentContentJournal({
      scope,
      flushMs: 60_000,
      batchBytes: 1_000_000,
      settlementTimeoutMs: 100,
      append,
      notify: async () => undefined,
      onError: () => undefined,
    });
    journal.record(update('message_delta', { id: 's', delta: { content: [] } }), 0);
    const closing = journal.close();
    void closing.catch(() => undefined);
    await jest.advanceTimersByTimeAsync(99);
    await expect(closing).resolves.toEqual({ ok: true });
    expect(append).toHaveBeenCalledTimes(2);
    expect(append.mock.calls[1][0]).toEqual(append.mock.calls[0][0]);
    expect(jest.getTimerCount()).toBe(0);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it.each(['active', 'fresh'])(
    'bounds persistent %s failures by the original close deadline',
    async (trigger) => {
      const { methods } = memoryStorage();
      const startedAt = Date.now();
      const attempts: number[] = [];
      const append = jest.fn(async () => {
        attempts.push(Date.now() - startedAt);
        throw new Error('Storage unavailable');
      });
      const notify = jest.fn(async () => undefined);
      const journal = new SubagentContentJournal({
        scope,
        flushMs: 10,
        batchBytes: trigger === 'active' ? 1 : 1_000_000,
        settlementTimeoutMs: 100,
        append,
        notify,
        onError: () => undefined,
      });
      journal.record(update('message_delta', { id: 's', delta: { content: [] } }), 0);
      journal.record(update('message_delta', { id: 's', delta: { content: [] } }), 1);
      const closing = journal.close();
      let outcome: SubagentContentAppendResult | typeof timeoutResult | undefined;
      void closing.then(
        (result) => {
          outcome = result;
        },
        () => undefined,
      );
      await jest.advanceTimersByTimeAsync(99);
      expect(outcome).toBeUndefined();
      expect(attempts).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
      await jest.advanceTimersByTimeAsync(1);
      await expect(closing).resolves.toEqual(timeoutResult);
      expect(journal.close()).toBe(closing);
      await jest.advanceTimersByTimeAsync(1000);
      expect(append).toHaveBeenCalledTimes(10);
      expect(notify).not.toHaveBeenCalled();
      expect(journal.throughSequence).toBe(1);
      expect(await methods.getSubagentContentHead(scope)).toBeNull();
      expect(jest.getTimerCount()).toBe(0);
      expect(unhandled).not.toHaveBeenCalled();
    },
  );

  it.each(['active', 'fresh', 'prior'])(
    'keeps a typed %s append denial terminal',
    async (trigger) => {
      const { methods } = memoryStorage();
      const denied = { ok: false, error: { code: 'SUBAGENT_CONTENT_GONE' } } as const;
      const append = jest.fn(methods.appendSubagentContentBatch).mockResolvedValueOnce(denied);
      const notify = jest.fn(async () => undefined);
      const journal = new SubagentContentJournal({
        scope,
        flushMs: 10,
        batchBytes: trigger === 'fresh' ? 1_000_000 : 1,
        settlementTimeoutMs: 100,
        append,
        notify,
        onError: () => undefined,
      });
      journal.record(update('message_delta', { id: 's', delta: { content: [] } }), 0);
      if (trigger === 'prior') await jest.advanceTimersByTimeAsync(0);
      const closing = journal.close();
      await expect(closing).resolves.toEqual(denied);
      expect(journal.close()).toBe(closing);
      await expect(journal.flush()).resolves.toEqual(denied);
      await jest.advanceTimersByTimeAsync(1000);
      expect(append).toHaveBeenCalledTimes(1);
      expect(notify).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
      expect(unhandled).not.toHaveBeenCalled();
    },
  );

  it('keeps failed staged bytes charged against the capture backlog', async () => {
    const { methods, batches } = memoryStorage();
    const append = jest
      .fn(methods.appendSubagentContentBatch)
      .mockRejectedValueOnce(new Error('Transient append failure'));
    const errors: unknown[] = [];
    const journal = new SubagentContentJournal({
      scope,
      flushMs: 10,
      batchBytes: 1,
      maxPendingBytes: 1024,
      settlementTimeoutMs: 100,
      append,
      notify: async () => undefined,
      onError: (error) => errors.push(error),
    });
    const frame = update('message_delta', {
      id: 's',
      delta: { content: [{ type: 'text', text: 'x'.repeat(600) }] },
    });
    journal.record(frame, 0);
    await jest.advanceTimersByTimeAsync(0);
    journal.record(frame, 1);
    journal.record(update('message_delta', { id: 's', delta: { content: [] } }), 2);
    await expect(journal.close()).resolves.toEqual({ ok: true });
    expect(append).toHaveBeenCalledTimes(2);
    expect(append.mock.calls[1][0]).toEqual(append.mock.calls[0][0]);
    expect(errors).toContainEqual(
      new Error('Subagent content persistence backlog exceeded its byte limit'),
    );
    expect(batches).toHaveLength(1);
    expect(batches[0].throughSequence).toBe(0);
    expect(journal.throughSequence).toBe(2);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('continues cleanup-only recovery at the configured cadence after fast retries are exhausted', async () => {
    const { methods } = memoryStorage();
    let rejectAppend: (error: Error) => void = () => undefined;
    const append = jest.fn(methods.appendSubagentContentBatch).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectAppend = reject;
        }),
    );
    const reconcile = jest
      .fn(methods.reconcileSubagentContent)
      .mockRejectedValueOnce(new Error('cleanup 1'))
      .mockRejectedValueOnce(new Error('cleanup 2'))
      .mockRejectedValueOnce(new Error('cleanup 3'))
      .mockRejectedValueOnce(new Error('cleanup 4'));
    const notify = jest.fn(async () => undefined);
    const journal = new SubagentContentJournal({
      scope,
      leaseToken: 'lease',
      flushMs: 10,
      batchBytes: 1,
      settlementTimeoutMs: 100,
      append,
      reconcile,
      cleanupRetry: { retryAttempts: 3, retryBaseDelayMs: 10, recoveryDelayMs: 100 },
      notify,
      onError: () => undefined,
    });
    journal.record(update('message_delta', { id: 's', delta: { content: [] } }), 0);
    const closing = journal.close();
    await jest.advanceTimersByTimeAsync(100);
    await expect(closing).resolves.toEqual(timeoutResult);
    expect(reconcile).not.toHaveBeenCalled();
    rejectAppend(new Error('late partial write'));
    await jest.advanceTimersByTimeAsync(0);
    expect(reconcile).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(30);
    expect(reconcile).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(99);
    expect(reconcile).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(101);
    expect(reconcile).toHaveBeenCalledTimes(5);
    expect(
      reconcile.mock.calls.every(([target]) => JSON.stringify(target) === JSON.stringify(scope)),
    ).toBe(true);
    expect(append).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('reconciles when the deadline expires between failed append attempts', async () => {
    const { methods } = memoryStorage();
    const append = jest
      .fn(methods.appendSubagentContentBatch)
      .mockRejectedValue(new Error('partial write'));
    const reconcile = jest.fn(methods.reconcileSubagentContent);
    const journal = new SubagentContentJournal({
      scope,
      flushMs: 1000,
      batchBytes: 1_000_000,
      settlementTimeoutMs: 100,
      append,
      reconcile,
      notify: async () => undefined,
      onError: () => undefined,
    });
    journal.record(update('message_delta', { id: 's', delta: { content: [] } }), 0);
    const closing = journal.close();
    await jest.advanceTimersByTimeAsync(100);
    await expect(closing).resolves.toEqual(timeoutResult);
    expect(reconcile).toHaveBeenCalledTimes(1);
    const attempts = append.mock.calls.length;
    await jest.advanceTimersByTimeAsync(1000);
    expect(append).toHaveBeenCalledTimes(attempts);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['resolve', 'reject'])(
    'does not retry or notify after a timed-out append later %ss',
    async (settlement) => {
      const { methods } = memoryStorage();
      let release: () => void = () => undefined;
      const append = jest
        .fn(methods.appendSubagentContentBatch)
        .mockImplementationOnce(methods.appendSubagentContentBatch)
        .mockImplementationOnce(
          (input) =>
            new Promise<SubagentContentAppendResult>((resolve, reject) => {
              release = () => {
                if (settlement === 'reject') reject(new Error('Late append failure'));
                else resolve(methods.appendSubagentContentBatch(input));
              };
            }),
        );
      const notify = jest.fn(async () => undefined);
      const journal = new SubagentContentJournal({
        scope,
        flushMs: 10,
        batchBytes: 1,
        settlementTimeoutMs: 100,
        append,
        notify,
        onError: () => undefined,
      });
      journal.record(update('message_delta', { id: 's', delta: { content: [] } }), 0);
      await journal.flush();
      journal.record(update('message_delta', { id: 's', delta: { content: [] } }), 1);
      journal.record(update('message_delta', { id: 's', delta: { content: [] } }), 2);
      const closing = journal.close();
      await jest.advanceTimersByTimeAsync(100);
      await expect(closing).resolves.toEqual(timeoutResult);
      release();
      await jest.advanceTimersByTimeAsync(1000);
      await expect(journal.flush()).resolves.toEqual(timeoutResult);
      expect(append).toHaveBeenCalledTimes(2);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith({
        taskId: scope.taskId,
        revision: 1,
        throughSequence: 0,
      });
      expect(journal.throughSequence).toBe(2);
      expect(await methods.getSubagentContentHead(scope)).toEqual({
        revision: settlement === 'resolve' ? 2 : 1,
        throughSequence: settlement === 'resolve' ? 1 : 0,
      });
      expect(jest.getTimerCount()).toBe(0);
      expect(unhandled).not.toHaveBeenCalled();
    },
  );
});

it('bounds final settlement and never starts another batch after a timed-out append', async () => {
  jest.useFakeTimers();
  const { methods } = memoryStorage();
  let release: () => void = () => undefined;
  const blocked = new Promise<{ ok: true }>((resolve) => {
    release = () => resolve({ ok: true });
  });
  const append = jest.fn(methods.appendSubagentContentBatch).mockImplementationOnce(() => blocked);
  const notify = jest.fn(async () => undefined);
  const journal = new SubagentContentJournal({
    scope,
    flushMs: 60_000,
    batchBytes: 1024,
    settlementTimeoutMs: 100,
    append,
    notify,
    onError: () => undefined,
  });
  try {
    journal.record(
      update('message_delta', {
        id: 's',
        delta: { content: [{ type: 'text', text: 'x'.repeat(1500) }] },
      }),
      0,
    );
    journal.record(
      update('message_delta', { id: 's', delta: { content: [{ type: 'text', text: 'later' }] } }),
      1,
    );
    let outcome: unknown;
    const closing = journal.close().then((result) => {
      outcome = result;
    });
    await jest.advanceTimersByTimeAsync(100);
    const atDeadline = outcome;
    release();
    await closing;
    await Promise.resolve();
    expect(atDeadline).toEqual({
      ok: false,
      error: { code: 'SUBAGENT_CONTENT_SETTLEMENT_TIMEOUT' },
    });
    expect(journal.throughSequence).toBe(1);
    expect(append).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  } finally {
    release();
    jest.useRealTimers();
  }
});

it.each(['marker', 'argument delta'] as const)(
  'restores preparation timing from a retained %s',
  async (source) => {
    const { methods } = memoryStorage();
    const journal = journalFor(methods);
    journal.record(
      update('run_step', {
        id: 'tool',
        index: 0,
        stepDetails: {
          type: 'tool_calls',
          tool_calls: [{ id: 'call', name: 'lookup', args: '{}', type: 'tool_call' }],
        },
      }),
      0,
    );
    if (source === 'marker') {
      journal.record(
        {
          phase: 'tool_preparation',
          data: { id: 'tool', index: 0, toolCallId: 'call', observed_at: 100 },
        },
        1,
      );
    } else {
      journal.record(
        update('run_step_delta', {
          id: 'tool',
          observed_at: 100,
          delta: {
            type: 'tool_calls',
            tool_calls: [{ id: 'call', index: 0, name: 'lookup', args: '{}' }],
          },
        }),
        1,
      );
    }
    journal.record(
      update('tool_calls_dispatched', {
        dispatched_at: 1000,
        toolCalls: [{ id: 'call', stepId: 'tool', name: 'lookup' }],
      }),
      2,
    );
    journal.record(
      update('run_step_completed', {
        result: {
          id: 'tool',
          type: 'tool_call',
          completed_at: 1340,
          tool_call: { id: 'call', name: 'lookup', args: '{}', output: 'Done', progress: 1 },
        },
      }),
      3,
    );
    await journal.close();
    const result = await readSubagentContent(methods, scope);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.content[0]).toMatchObject({
      type: 'tool_call',
      tool_call: {
        toolPreparationStartedAt: 100,
        toolPreparationDurationMs: 900,
        toolDispatchedAt: 1000,
        toolExecutionDurationMs: 340,
      },
    });
    if (source === 'marker') {
      const suffix = await readSubagentContent(methods, scope, 0);
      expect(suffix).toMatchObject({
        ok: true,
        value: {
          events: expect.arrayContaining([
            expect.objectContaining({
              sequence: 1,
              frame: expect.objectContaining({ event: 'on_tool_preparation' }),
            }),
          ]),
        },
      });
    }
  },
);

it('does not open a payload cursor when the caller already has the committed head', async () => {
  const stream = jest.fn();
  const result = await readSubagentContent(
    {
      getSubagentContentHead: async () => ({ revision: 5000, throughSequence: 9999 }),
      streamSubagentContentBatches: stream,
    },
    scope,
    9999,
  );
  expect(result).toMatchObject({
    ok: true,
    value: { revision: 5000, throughSequence: 9999, events: [] },
  });
  expect(stream).not.toHaveBeenCalled();
});

it('journals applied steering in its reserved slot before later normalized SDK steps', async () => {
  const { methods } = memoryStorage();
  const journal = journalFor(methods);
  const step = (id: string, index: number) =>
    update('run_step', {
      id,
      index,
      stepDetails: { type: 'message_creation', message_creation: { message_id: id } },
    });
  journal.record(step('before', 0), 0);
  journal.record(
    update('message_delta', {
      id: 'before',
      delta: { content: [{ type: 'text', text: 'Before' }] },
    }),
    1,
  );
  const applied = {
    steerId: 'control',
    clientSteerId: 'invocation',
    index: 1,
    part: {
      type: ContentTypes.STEER,
      steer: 'Actual guidance',
      steerId: 'control',
      clientSteerId: 'invocation',
      createdAt: 42,
    },
    responseMessageId: 'task:assistant',
    conversationId: 'child',
  };
  journal.record({ phase: 'steer_applied', data: applied }, 2);
  journal.record(step('after', 2), 3);
  journal.record(
    update('message_delta', { id: 'after', delta: { content: [{ type: 'text', text: 'After' }] } }),
    4,
  );
  await journal.close();
  const snapshot = await readSubagentContent(methods, scope);
  expect(snapshot.ok).toBe(true);
  if (!snapshot.ok) return;
  expect(snapshot.value.content).toEqual([
    expect.objectContaining({ type: 'text', text: 'Before' }),
    applied.part,
    expect.objectContaining({ type: 'text', text: 'After' }),
  ]);
  expect(snapshot.value.runSteps.map(({ index }) => index)).toEqual([0, 2]);
  const suffix = await readSubagentContent(methods, scope, 1);
  expect(suffix.ok && suffix.value.events[0]).toEqual({
    sequence: 2,
    frame: { event: SteerEvents.ON_STEER_APPLIED, data: applied },
  });
});
