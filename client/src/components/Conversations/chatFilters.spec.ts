import { createStore } from 'jotai';
import {
  DEFAULT_CHAT_SORT,
  chatFilterStatusAtom,
  chatSortAtom,
  setChatFilterStatusAtom,
} from './chatFilters';

describe('chat filter status changes', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('normalizes a malformed persisted sort before switching status', () => {
    localStorage.setItem('chatListSort', 'null');
    const store = createStore();

    expect(() => store.set(setChatFilterStatusAtom, 'archived')).not.toThrow();
    expect(store.get(chatFilterStatusAtom)).toBe('archived');
    expect(store.get(chatSortAtom)).toEqual(DEFAULT_CHAT_SORT);
  });
});
