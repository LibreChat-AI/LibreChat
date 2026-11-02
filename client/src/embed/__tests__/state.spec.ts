import { resolveEmbedState } from '../state';

const ENTRY_SEARCH = '?app=portal&origin=https%3A%2F%2Fportal.example.com';

const memoryStorage = () => {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
};

describe('resolveEmbedState', () => {
  it('records the app and host origin from the framed entry and moves to a new chat', () => {
    const storage = memoryStorage();
    expect(
      resolveEmbedState({
        framed: true,
        basePath: '',
        pathname: '/embed',
        search: ENTRY_SEARCH,
        storage,
      }),
    ).toEqual({
      state: { app: 'portal', origin: 'https://portal.example.com' },
      replaceWith: '/c/new',
    });
  });

  it('honours a deployment served under a base path', () => {
    const resolution = resolveEmbedState({
      framed: true,
      basePath: '/chat',
      pathname: '/chat/embed',
      search: ENTRY_SEARCH,
      storage: memoryStorage(),
    });
    expect(resolution.replaceWith).toBe('/chat/c/new');
    expect(resolution.state?.app).toBe('portal');
  });

  it('restores embed mode after the framed tab reloads a chat route', () => {
    const storage = memoryStorage();
    resolveEmbedState({
      framed: true,
      basePath: '',
      pathname: '/embed',
      search: ENTRY_SEARCH,
      storage,
    });

    expect(
      resolveEmbedState({ framed: true, basePath: '', pathname: '/c/abc', search: '', storage }),
    ).toEqual({ state: { app: 'portal', origin: 'https://portal.example.com' } });
  });

  it('never applies at the top level, even with stored state', () => {
    const storage = memoryStorage();
    resolveEmbedState({
      framed: true,
      basePath: '',
      pathname: '/embed',
      search: ENTRY_SEARCH,
      storage,
    });

    expect(
      resolveEmbedState({
        framed: false,
        basePath: '',
        pathname: '/embed',
        search: ENTRY_SEARCH,
        storage,
      }),
    ).toEqual({ state: null });
  });

  it('works when storage is blocked', () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(
      resolveEmbedState({
        framed: true,
        basePath: '',
        pathname: '/embed',
        search: ENTRY_SEARCH,
        storage: blocked,
      }).state,
    ).toEqual({ app: 'portal', origin: 'https://portal.example.com' });
  });

  it('rejects an origin with a path and an app id outside the slug format', () => {
    const resolve = (search: string) =>
      resolveEmbedState({
        framed: true,
        basePath: '',
        pathname: '/embed',
        search,
        storage: memoryStorage(),
      }).state;
    expect(resolve('?app=portal&origin=https%3A%2F%2Fportal.example.com%2Fpath')).toBeNull();
    expect(resolve('?app=Bad%20App&origin=https%3A%2F%2Fportal.example.com')).toBeNull();
    expect(resolve('?app=portal&origin=javascript%3Aalert(1)')).toBeNull();
  });
});
