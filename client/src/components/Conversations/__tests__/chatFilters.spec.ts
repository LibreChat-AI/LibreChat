import { createStore } from 'jotai';
import type { TConversationTag } from 'librechat-data-provider';
import {
  chatFilterCountAtom,
  chatFilterStatusAtom,
  chatFilterTagsAtom,
  selectableBookmarks,
} from '../chatFilters';

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

describe('selectableBookmarks', () => {
  const tag = (name: string, count: number): TConversationTag => ({
    _id: name,
    user: 'user',
    tag: name,
    count,
    position: 0,
    createdAt: '',
    updatedAt: '',
  });

  it('offers the bookmarks some chat carries', () => {
    const choices = selectableBookmarks([tag('work', 2), tag('unused', 0)], []);
    expect(choices.map((choice) => choice.tag)).toEqual(['work']);
  });

  it('keeps a selected bookmark no chat carries any more', () => {
    const choices = selectableBookmarks([tag('work', 2), tag('unused', 0)], ['unused']);
    expect(choices.map((choice) => choice.tag)).toEqual(['work', 'unused']);
  });

  it('keeps a selected bookmark that was deleted', () => {
    expect(selectableBookmarks([tag('work', 2)], ['gone'])).toEqual([
      tag('work', 2),
      { tag: 'gone', count: 0 },
    ]);
  });
});
