import { createStore } from 'jotai';
import type { TConversationTag } from 'librechat-data-provider';
import {
  chatFilterCountAtom,
  chatFilterStatusAtom,
  chatFilterTagsAtom,
  resetChatFiltersAtom,
  selectableBookmarks,
  showProjectChatsAtom,
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

describe('showProjectChatsAtom', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('lists project chats under Chats by default', () => {
    expect(createStore().get(showProjectChatsAtom)).toBe(true);
  });

  it('counts hiding them as one change the menu badge and Reset own', () => {
    const store = createStore();
    store.set(showProjectChatsAtom, false);
    expect(store.get(chatFilterCountAtom)).toBe(1);

    store.set(resetChatFiltersAtom);
    expect(store.get(showProjectChatsAtom)).toBe(true);
    expect(store.get(chatFilterCountAtom)).toBe(0);
  });

  /** Storage is read once, when the module loads, which is what a new visit does. */
  const onNextVisit = (stored: unknown): boolean => {
    localStorage.setItem('chatListShowProjectChats', JSON.stringify(stored));
    let value: boolean | undefined;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const filters = require('../chatFilters') as typeof import('../chatFilters');
      value = createStore().get(filters.showProjectChatsAtom);
    });
    return value as boolean;
  };

  it('keeps the choice to hide them across visits', () => {
    expect(onNextVisit(false)).toBe(false);
  });

  it('reads a stored value that is not a boolean as the default', () => {
    expect(onNextVisit('no')).toBe(true);
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
