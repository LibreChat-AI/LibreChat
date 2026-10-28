import { createConvoPersistenceSignal } from './convoPersistence';

/** Resolves to true only if the gate is already open at this microtask depth. */
const isOpen = async (ready: Promise<void>): Promise<boolean> => {
  const sentinel = Symbol('shut');
  const result = await Promise.race([
    ready.then(() => 'open' as const),
    Promise.resolve().then(() => Promise.resolve().then(() => sentinel)),
  ]);
  return result === 'open';
};

const settled = () => new Promise((resolve) => setImmediate(resolve));

describe('createConvoPersistenceSignal', () => {
  it('starts shut, with no reference recorded', async () => {
    const signal = createConvoPersistenceSignal();

    await expect(isOpen(signal.ready)).resolves.toBe(false);
    expect(signal.recordedMessageReference('message-row')).toBe(false);
  });

  /** Each of a turn's rows is asked about separately, so one row's append says
   *  nothing about another's. */
  it('records only the row that was appended', async () => {
    const signal = createConvoPersistenceSignal();

    signal.observeMessageWrite(
      Promise.resolve({
        message: { _id: 'user-row' },
        conversation: { conversationId: 'convo-1' },
      }),
    );
    await settled();

    expect(signal.recordedMessageReference('user-row')).toBe(true);
    expect(signal.recordedMessageReference('response-row')).toBe(false);
  });

  it('compares ids by value, so a re-read of the same row matches', async () => {
    const signal = createConvoPersistenceSignal();
    const id = { toString: () => 'row-abc' };

    signal.observeMessageWrite(
      Promise.resolve({ message: { _id: id }, conversation: { conversationId: 'convo-1' } }),
    );
    await settled();

    expect(signal.recordedMessageReference({ toString: () => 'row-abc' })).toBe(true);
  });

  it('records nothing for a missing id', async () => {
    const signal = createConvoPersistenceSignal();

    signal.observeMessageWrite(
      Promise.resolve({
        message: { _id: 'user-row' },
        conversation: { conversationId: 'convo-1' },
      }),
    );
    await settled();

    expect(signal.recordedMessageReference(undefined)).toBe(false);
    expect(signal.recordedMessageReference(null)).toBe(false);
  });

  it('opens and records the reference when a write saved both', async () => {
    const signal = createConvoPersistenceSignal();

    signal.observeMessageWrite(
      Promise.resolve({
        message: { _id: 'message-row' },
        conversation: { conversationId: 'convo-1' },
      }),
    );

    await expect(signal.ready).resolves.toBeUndefined();
    expect(signal.recordedMessageReference('message-row')).toBe(true);
  });

  /** `saveMessage` can resolve falsy without throwing, and `saveTurnConversation` then
   *  appends nothing while still writing and reporting the row. The title may save
   *  against that row; the reference still has to be repaired. */
  it.each([
    ['resolved no message', { conversation: { conversationId: 'convo-1' } }],
    [
      'resolved a falsy message',
      { message: undefined, conversation: { conversationId: 'convo-1' } },
    ],
    [
      'resolved a message without an id',
      { message: {}, conversation: { conversationId: 'convo-1' } },
    ],
  ])('opens the gate but records no reference when the write %s', async (_label, result) => {
    const signal = createConvoPersistenceSignal();

    signal.observeMessageWrite(Promise.resolve(result));

    await expect(signal.ready).resolves.toBeUndefined();
    expect(signal.recordedMessageReference('message-row')).toBe(false);
  });

  it.each([
    ['persisted no conversation', () => Promise.resolve({ message: { _id: 'message-row' } })],
    ['failed', () => Promise.reject(new Error('write failed'))],
    ['reported a null conversation', () => Promise.resolve({ conversation: null })],
    [
      'reported an empty conversationId',
      () => Promise.resolve({ conversation: { conversationId: '' } }),
    ],
  ])('stays shut and reports nothing when the write %s', async (_label, makeWrite) => {
    const signal = createConvoPersistenceSignal();

    signal.observeMessageWrite(makeWrite());
    await settled();

    await expect(isOpen(signal.ready)).resolves.toBe(false);
    expect(signal.recordedMessageReference('message-row')).toBe(false);
  });

  it('stays shut while the write is still pending', async () => {
    const signal = createConvoPersistenceSignal();
    let settle: (value: unknown) => void = () => {};
    signal.observeMessageWrite(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );

    await expect(isOpen(signal.ready)).resolves.toBe(false);
    expect(signal.recordedMessageReference('message-row')).toBe(false);

    settle({ message: { _id: 'message-row' }, conversation: { conversationId: 'convo-1' } });

    await expect(signal.ready).resolves.toBeUndefined();
    expect(signal.recordedMessageReference('message-row')).toBe(true);
  });

  it('ignores a value that is not a promise', async () => {
    const signal = createConvoPersistenceSignal();

    signal.observeMessageWrite(undefined);
    signal.observeMessageWrite({
      message: { _id: 'message-row' },
      conversation: { conversationId: 'convo-1' },
    });
    await settled();

    await expect(isOpen(signal.ready)).resolves.toBe(false);
    expect(signal.recordedMessageReference('message-row')).toBe(false);
  });

  /** The terminal backstop opens the gate for a title, but it is not evidence that
   *  any write recorded the row — the reference repair must still run. */
  it('does not record a reference just because open() was called', async () => {
    const signal = createConvoPersistenceSignal();

    signal.open();
    signal.open();
    signal.observeMessageWrite(Promise.resolve({ message: { _id: 'message-row' } }));
    await settled();

    await expect(signal.ready).resolves.toBeUndefined();
    expect(signal.recordedMessageReference('message-row')).toBe(false);
  });

  it('records the reference when a later write succeeds after an earlier one did not', async () => {
    const signal = createConvoPersistenceSignal();

    signal.observeMessageWrite(Promise.resolve({ conversation: { conversationId: 'convo-1' } }));
    signal.observeMessageWrite(
      Promise.resolve({
        message: { _id: 'message-row' },
        conversation: { conversationId: 'convo-1' },
      }),
    );
    await settled();

    expect(signal.recordedMessageReference('message-row')).toBe(true);
  });

  /** A later write that appended nothing must not unset what an earlier one recorded. */
  it('keeps a recorded reference when a later write appends nothing', async () => {
    const signal = createConvoPersistenceSignal();

    signal.observeMessageWrite(
      Promise.resolve({
        message: { _id: 'message-row' },
        conversation: { conversationId: 'convo-1' },
      }),
    );
    await settled();
    signal.observeMessageWrite(Promise.resolve({ conversation: { conversationId: 'convo-1' } }));
    await settled();

    expect(signal.recordedMessageReference('message-row')).toBe(true);
  });
});
