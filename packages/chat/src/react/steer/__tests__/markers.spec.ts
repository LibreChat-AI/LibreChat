import { createStore } from 'jotai';
import type { TMessage } from 'librechat-data-provider';
import type { DetachedRun } from '../../../core';
import {
  settleDetachedRun,
  parkDetachedRunEnd,
  detachedRunByConvoId,
  pendingRunEndByConvoId,
  stopRequestedByConvoId,
  clearSupersededRunMarkers,
} from '../queue';

const conversationId = 'thread-1';
const run: DetachedRun = {
  userMessageId: 'user-2',
  responseMessageId: 'reply-2',
  generationCreatedAt: 2000,
};
const reply = (extra: Partial<TMessage> = {}): TMessage =>
  ({
    messageId: 'reply-2',
    conversationId,
    parentMessageId: 'user-2',
    isCreatedByUser: false,
    text: 'Done',
    createdAt: new Date(2500).toISOString(),
    ...extra,
  }) as TMessage;

const left = () => {
  const store = createStore();
  store.set(detachedRunByConvoId(conversationId), run);
  return store;
};

describe('parkDetachedRunEnd', () => {
  it('parks the end the stored reply tells, under its conversation, and retires the marker', () => {
    const store = left();

    parkDetachedRunEnd(store, conversationId, run, [reply()]);

    expect(store.get(detachedRunByConvoId(conversationId))).toBeNull();
    expect(store.get(pendingRunEndByConvoId(conversationId))).toMatchObject({
      conversationId,
      outcome: 'completed',
      generationCreatedAt: 2000,
      responseMessageId: 'reply-2',
    });
  });

  it('parks a stopped or failed reply as such, so nothing queued is sent on its account', () => {
    const stopped = left();
    parkDetachedRunEnd(stopped, conversationId, run, [reply({ unfinished: true })]);
    expect(stopped.get(pendingRunEndByConvoId(conversationId))).toMatchObject({
      outcome: 'aborted',
    });

    const failed = left();
    parkDetachedRunEnd(failed, conversationId, run, [reply({ error: true })]);
    expect(failed.get(pendingRunEndByConvoId(conversationId))).toMatchObject({ outcome: 'error' });
  });

  it('keeps the marker while no reply of the run is stored, for the next visit to try again', () => {
    const store = left();

    parkDetachedRunEnd(store, conversationId, run, []);
    /** A reply written before the run began is not its reply. */
    parkDetachedRunEnd(store, conversationId, run, [
      reply({ createdAt: new Date(1000).toISOString() }),
    ]);

    expect(store.get(detachedRunByConvoId(conversationId))).toBe(run);
    expect(store.get(pendingRunEndByConvoId(conversationId))).toBeNull();
  });

  it('retires a run the reader stopped without parking an end, leaving the queue to them', () => {
    const store = left();
    store.set(stopRequestedByConvoId(conversationId), { generationCreatedAt: 2000 });

    parkDetachedRunEnd(store, conversationId, run, [reply()]);

    expect(store.get(detachedRunByConvoId(conversationId))).toBeNull();
    expect(store.get(pendingRunEndByConvoId(conversationId))).toBeNull();
  });

  it('does nothing for a marker that has been replaced since it was read', () => {
    const store = left();
    const newer = { ...run, generationCreatedAt: 3000 };
    store.set(detachedRunByConvoId(conversationId), newer);

    parkDetachedRunEnd(store, conversationId, run, [reply()]);

    expect(store.get(detachedRunByConvoId(conversationId))).toBe(newer);
    expect(store.get(pendingRunEndByConvoId(conversationId))).toBeNull();
  });
});

describe('settleDetachedRun', () => {
  it('retires the marker of the run whose end was published, and of no other', () => {
    const store = left();

    settleDetachedRun(store, { conversationId, generationCreatedAt: 9000 });
    expect(store.get(detachedRunByConvoId(conversationId))).toBe(run);

    settleDetachedRun(store, { conversationId: 'another', generationCreatedAt: 2000 });
    expect(store.get(detachedRunByConvoId(conversationId))).toBe(run);

    settleDetachedRun(store, { conversationId, generationCreatedAt: 2000 });
    expect(store.get(detachedRunByConvoId(conversationId))).toBeNull();
  });

  it('retires it for an end that names no generation', () => {
    const store = left();
    settleDetachedRun(store, { conversationId });
    expect(store.get(detachedRunByConvoId(conversationId))).toBeNull();
  });
});

describe('clearSupersededRunMarkers', () => {
  it('drops the markers of an earlier run, and keeps those of the run attached to again', () => {
    const store = left();
    store.set(stopRequestedByConvoId(conversationId), { generationCreatedAt: 2000 });

    clearSupersededRunMarkers(store, conversationId, (createdAt) => createdAt === 2000);
    expect(store.get(detachedRunByConvoId(conversationId))).toBe(run);
    expect(store.get(stopRequestedByConvoId(conversationId))).toEqual({
      generationCreatedAt: 2000,
    });

    clearSupersededRunMarkers(store, conversationId, (createdAt) => createdAt === 3000);
    expect(store.get(detachedRunByConvoId(conversationId))).toBeNull();
    expect(store.get(stopRequestedByConvoId(conversationId))).toBeNull();
  });
});
