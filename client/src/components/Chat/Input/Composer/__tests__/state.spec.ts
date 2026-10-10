import { createStore } from 'jotai';
import { Constants, ReasoningEffort } from 'librechat-data-provider';
import { getReasoningStateKey, pendingReasoningOverrideFamily } from '../state';

describe('composer reasoning state', () => {
  it('isolates unsaved split panes that share the new-conversation sentinel', () => {
    const firstKey = getReasoningStateKey(Constants.NEW_CONVO, 0);
    const secondKey = getReasoningStateKey(Constants.NEW_CONVO, 1);
    const store = createStore();

    store.set(pendingReasoningOverrideFamily(firstKey), {
      key: 'reasoning_effort',
      value: ReasoningEffort.high,
    });

    expect(firstKey).not.toBe(secondKey);
    expect(store.get(pendingReasoningOverrideFamily(secondKey))).toBeUndefined();
  });
});
