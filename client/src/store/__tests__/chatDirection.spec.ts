import { createStore } from 'jotai';

const DIRECTION_KEY = 'chatDirection';

const readStoredDirection = async () => {
  const { chatDirectionAtom } = await import('../chatDirection');
  return createStore().get(chatDirectionAtom);
};

describe('chatDirection', () => {
  beforeEach(() => {
    jest.resetModules();
    localStorage.clear();
  });

  it('defaults to auto so typed text resolves its own direction', async () => {
    expect(await readStoredDirection()).toBe('auto');
  });

  it.each([
    ['LTR', 'ltr'],
    ['RTL', 'rtl'],
    ['rtl', 'rtl'],
  ])('keeps a stored %s choice as %s', async (stored, expected) => {
    localStorage.setItem(DIRECTION_KEY, JSON.stringify(stored));
    expect(await readStoredDirection()).toBe(expected);
  });

  it('falls back to auto for an unrecognized stored value', async () => {
    localStorage.setItem(DIRECTION_KEY, JSON.stringify('sideways'));
    expect(await readStoredDirection()).toBe('auto');
  });

  it('stores a choice where older clients read it', async () => {
    const { chatDirectionAtom } = await import('../chatDirection');
    const store = createStore();
    store.set(chatDirectionAtom, 'rtl');
    expect(store.get(chatDirectionAtom)).toBe('rtl');
    expect(localStorage.getItem(DIRECTION_KEY)).toBe(JSON.stringify('rtl'));
  });
});
