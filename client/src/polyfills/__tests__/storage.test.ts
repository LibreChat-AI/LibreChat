import { createMemoryStorage, installStorageFallback } from '../storage';

function deniedWindow(): Pick<Window, 'localStorage' | 'sessionStorage'> {
  const target = {} as Pick<Window, 'localStorage' | 'sessionStorage'>;
  for (const name of ['localStorage', 'sessionStorage']) {
    Object.defineProperty(target, name, {
      configurable: true,
      get() {
        throw new DOMException('denied', 'SecurityError');
      },
    });
  }
  return target;
}

describe('installStorageFallback', () => {
  it('leaves accessible storage untouched', () => {
    const storage = createMemoryStorage();
    const target = { localStorage: storage, sessionStorage: storage };
    expect(installStorageFallback(target)).toEqual([]);
    expect(target.localStorage).toBe(storage);
  });

  it('replaces a throwing getter with a working in-memory storage', () => {
    const target = deniedWindow();
    expect(() => target.localStorage).toThrow('denied');

    expect(installStorageFallback(target)).toEqual(['localStorage', 'sessionStorage']);

    target.localStorage.setItem('color-theme', 'dark');
    expect(target.localStorage.getItem('color-theme')).toBe('dark');
    target.sessionStorage.setItem('lc-rum-queue', '[]');
    expect(target.sessionStorage.getItem('lc-rum-queue')).toBe('[]');
    expect(target.localStorage.getItem('lc-rum-queue')).toBeNull();
    expect(target.localStorage).toBe(target.localStorage);
  });
});

describe('createMemoryStorage', () => {
  it('implements the Storage methods', () => {
    const storage = createMemoryStorage();
    expect(storage.getItem('missing')).toBeNull();
    storage.setItem('a', '1');
    storage.setItem('b', '2');
    expect(storage).toHaveLength(2);
    expect(storage.key(1)).toBe('b');
    expect(storage.key(5)).toBeNull();
    storage.removeItem('a');
    expect(storage.getItem('a')).toBeNull();
    storage.clear();
    expect(storage).toHaveLength(0);
  });

  it('reports stored keys as own properties, as key-scanning readers expect', () => {
    const storage = createMemoryStorage();
    storage.setItem('textDraft_1', 'hello');
    storage.setItem('getItem', 'shadow');
    expect(Object.keys(storage)).toEqual(['textDraft_1', 'getItem']);
    expect(storage.textDraft_1).toBe('hello');
    expect(typeof storage.getItem).toBe('function');
    expect(storage.getItem('getItem')).toBe('shadow');
  });

  it('routes named-property writes and deletes through the stored items', () => {
    const storage = createMemoryStorage();
    storage.lastModel = 'gpt';
    expect(storage.getItem('lastModel')).toBe('gpt');
    expect(storage).toHaveLength(1);
    expect(Object.keys(storage)).toEqual(['lastModel']);
    delete storage.lastModel;
    expect(storage.getItem('lastModel')).toBeNull();
    expect(storage).toHaveLength(0);
  });
});
