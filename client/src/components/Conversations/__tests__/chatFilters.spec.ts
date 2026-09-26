import { createStore } from 'jotai';
import { chatFilterCountAtom, chatFilterStatusAtom, chatFilterTagsAtom } from '../chatFilters';

describe('chatFilterCountAtom', () => {
  it('counts nothing while every property is at its default', () => {
    expect(createStore().get(chatFilterCountAtom)).toBe(0);
  });

  it('counts bookmarks once, however many are selected', () => {
    const store = createStore();
    store.set(chatFilterTagsAtom, ['work', 'travel', 'ideas']);
    expect(store.get(chatFilterCountAtom)).toBe(1);
  });

  it('adds the archived view to the bookmark group', () => {
    const store = createStore();
    store.set(chatFilterTagsAtom, ['work', 'travel']);
    store.set(chatFilterStatusAtom, 'archived');
    expect(store.get(chatFilterCountAtom)).toBe(2);
  });
});
