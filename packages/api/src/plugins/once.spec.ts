import { createMemoryOnceStore, getPluginHookOnceStore, setPluginHookOnceStore } from './once';

describe('createMemoryOnceStore', () => {
  it('returns true only the first time a key is marked within a scope', () => {
    const store = createMemoryOnceStore();
    expect(store.markOnce('conversation-a', 'hook')).toBe(true);
    expect(store.markOnce('conversation-a', 'hook')).toBe(false);
    expect(store.markOnce('conversation-a', 'other-hook')).toBe(true);
    expect(store.markOnce('conversation-b', 'hook')).toBe(true);
  });

  it('evicts the least-recently-active scope, never a touched one', () => {
    const store = createMemoryOnceStore(2);
    expect(store.markOnce('active', 'rare-hook')).toBe(true);
    expect(store.markOnce('idle', 'hook')).toBe(true);
    /**
     * Touching refreshes the whole scope without marking any key, the way
     * registration refreshes a conversation each turn even when no `once`
     * handler matches; "idle" becomes the oldest scope.
     */
    store.touch('active');
    expect(store.markOnce('new', 'hook')).toBe(true);
    /** The rarely-marked key survived because its conversation stayed active. */
    expect(store.markOnce('active', 'rare-hook')).toBe(false);
    /** Only the idle conversation was evicted and fires again. */
    expect(store.markOnce('idle', 'hook')).toBe(true);
  });
});

describe('setPluginHookOnceStore', () => {
  afterEach(() => {
    setPluginHookOnceStore(undefined);
  });

  it('installs a replacement store and restores a fresh default when cleared', () => {
    const marked: string[] = [];
    setPluginHookOnceStore({
      touch() {},
      markOnce(scope, key) {
        marked.push(`${scope}:${key}`);
        return true;
      },
    });
    expect(getPluginHookOnceStore().markOnce('shared-scope', 'shared-key')).toBe(true);
    expect(marked).toEqual(['shared-scope:shared-key']);
    setPluginHookOnceStore(undefined);
    expect(getPluginHookOnceStore().markOnce('fresh-scope', 'fresh')).toBe(true);
    expect(getPluginHookOnceStore().markOnce('fresh-scope', 'fresh')).toBe(false);
  });
});
