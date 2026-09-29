import { act, render } from '@testing-library/react';
import { RecoilRoot, useSetRecoilState } from 'recoil';
import type { SetterOrUpdater } from 'recoil';
import type { QueuedMessage } from '~/store/families';
import store from '~/store';

const id = 'offscreen-release-test';
let setQueue: SetterOrUpdater<QueuedMessage[]>;
let setPending: SetterOrUpdater<string[]>;

function QueueProbe() {
  setQueue = useSetRecoilState(store.queuedMessagesByConvoId(id));
  setPending = useSetRecoilState(store.pendingQueuedTurnEnqueueIdsByConvoId(id));
  return null;
}

describe('offscreen queued turn reload guard', () => {
  it('tracks undrained turns after unmount and pending enqueues before server admission', () => {
    const first = render(
      <RecoilRoot>
        <QueueProbe />
      </RecoilRoot>,
    );
    expect(store.hasInMemoryQueuedTurns()).toBe(false);
    act(() => setQueue([{ id: 'turn-1', text: 'later', createdAt: 1 }]));
    expect(store.hasInMemoryQueuedTurns()).toBe(true);
    first.unmount();
    expect(store.hasInMemoryQueuedTurns()).toBe(true);

    render(
      <RecoilRoot>
        <QueueProbe />
      </RecoilRoot>,
    );
    act(() => setQueue([]));
    expect(store.hasInMemoryQueuedTurns()).toBe(false);
    act(() => setPending(['request-1']));
    expect(store.hasInMemoryQueuedTurns()).toBe(true);
    act(() => setPending([]));
    expect(store.hasInMemoryQueuedTurns()).toBe(false);
  });
});
