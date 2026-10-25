import { createStore } from 'jotai';
import { abortScrollFamily, showStopButtonByIndex, submissionStartFamily } from '../generation';

describe('generation atoms', () => {
  it('start idle for every pane', () => {
    const store = createStore();

    expect(store.get(showStopButtonByIndex(0))).toBe(false);
    expect(store.get(abortScrollFamily(0))).toBe(false);
    expect(store.get(submissionStartFamily(0))).toBeNull();
  });

  it('keep each pane independent', () => {
    const store = createStore();
    store.set(showStopButtonByIndex(0), true);
    store.set(submissionStartFamily(0), 1000);

    expect(store.get(showStopButtonByIndex(1))).toBe(false);
    expect(store.get(submissionStartFamily(1))).toBeNull();
  });

  it('accepts value and updater writes on the abort-scroll latch', () => {
    const store = createStore();
    store.set(abortScrollFamily(0), true);
    expect(store.get(abortScrollFamily(0))).toBe(true);

    store.set(abortScrollFamily(0), (prev) => !prev);
    expect(store.get(abortScrollFamily(0))).toBe(false);
  });
});
