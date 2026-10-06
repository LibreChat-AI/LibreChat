import { useState } from 'react';
import { RecoilRoot, useSetRecoilState } from 'recoil';
import { useTheme, clickHouseTheme } from '@librechat/client';
import { act, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { QueryKeys, MutationKeys, dataService } from 'librechat-data-provider';
import type { TStartupConfig, TUser } from 'librechat-data-provider';
import type { ThemeDefinition } from '@librechat/client';
import { buildThemeCache, writeThemeCache, THEME_CACHE_KEY } from '../themeCache';
import DeploymentTheme, { useDeploymentThemeOverride } from '../DeploymentTheme';
import { useGetStartupConfig } from '~/data-provider';
import store from '~/store';

const mockGetThemeFromEnv = jest.fn();

jest.mock('librechat-data-provider', () => {
  const actual =
    jest.requireActual<typeof import('librechat-data-provider')>('librechat-data-provider');
  return { ...actual, dataService: { ...actual.dataService } };
});

jest.mock('~/utils/getThemeFromEnv', () => ({
  getThemeFromEnv: () => mockGetThemeFromEnv(),
}));

type ConfigTheme = NonNullable<TStartupConfig['interface']>['theme'];

const THEME_KEYS = ['theme-definition', 'theme-colors', 'theme-name', 'theme-source'];

const storedDefinition = {
  version: 1,
  name: 'stored',
  modes: { light: { colors: { 'rgb-accent-primary': '1 2 3' } } },
};

const inlineTheme = {
  version: 1 as const,
  name: 'acme',
  modes: {
    light: {
      colors: { 'rgb-surface-primary': '10 20 30' },
      appearance: { controlRadius: '2px' },
    },
    dark: { colors: { 'rgb-surface-primary': '40 50 60' } },
  },
};

const configWith = (theme?: ConfigTheme) =>
  ({ interface: theme === undefined ? {} : { theme } }) as TStartupConfig;

const snapshotStorage = () => THEME_KEYS.map((key) => localStorage.getItem(key));

const root = () => document.documentElement;

let applyUserColors: () => void = () => undefined;

/** Stands in for a host surface that lets the user change their theme. */
function ThemeEditor() {
  const { setThemeRGB } = useTheme();
  applyUserColors = () => setThemeRGB({ 'rgb-accent-primary': '9 9 9' });
  return null;
}

function StartupConsumer() {
  useGetStartupConfig();
  return null;
}

let mountRoute: () => void = () => undefined;

/** Mounts a startup config consumer later without re-rendering the wrapper, as a route does. */
function LateRoute() {
  const [mounted, setMounted] = useState(false);
  mountRoute = () => setMounted(true);
  return mounted ? <StartupConsumer /> : null;
}

let showSharedRoute: (theme: ConfigTheme | null) => void = () => undefined;

/** Stands in for the share route; `null` unmounts it, `undefined` serves no theme. */
function SharedRoute() {
  const [route, setRoute] = useState<{ theme: ConfigTheme } | null>(null);
  showSharedRoute = (theme) => setRoute(theme === null ? null : { theme });
  return route ? <SharedThemeSource theme={route.theme} /> : null;
}

function SharedThemeSource({ theme, ready = true }: { theme: ConfigTheme; ready?: boolean }) {
  useDeploymentThemeOverride(ready, theme);
  return null;
}

let showLoadingRoute: (route: { ready: boolean; theme?: ConfigTheme } | null) => void = () =>
  undefined;

/** Stands in for the share route while its own config is still loading. */
function LoadingRoute() {
  const [route, setRoute] = useState<{ ready: boolean; theme?: ConfigTheme } | null>(null);
  showLoadingRoute = setRoute;
  return route ? <SharedThemeSource theme={route.theme} ready={route.ready} /> : null;
}

function renderTheme(queryClient: QueryClient, user?: Pick<TUser, 'id' | 'tenantId'>) {
  return render(
    <RecoilRoot initializeState={({ set }) => user && set(store.user, user as TUser)}>
      <QueryClientProvider client={queryClient}>
        <DeploymentTheme>
          <LateRoute />
          <SharedRoute />
          <LoadingRoute />
          <ThemeEditor />
        </DeploymentTheme>
      </QueryClientProvider>
    </RecoilRoot>,
  );
}

describe('DeploymentTheme', () => {
  let queryClient: QueryClient;
  let getStartupConfig: jest.SpyInstance;
  let warn: jest.SpyInstance;

  const serveTheme = (theme?: ConfigTheme) => getStartupConfig.mockResolvedValue(configWith(theme));

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('theme', 'light');
    localStorage.setItem('theme-definition', JSON.stringify(storedDefinition));
    localStorage.setItem('theme-name', 'stored');
    localStorage.setItem('theme-source', 'definition');
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    getStartupConfig = jest.spyOn(dataService, 'getStartupConfig');
    mockGetThemeFromEnv.mockReturnValue(undefined);
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    queryClient.clear();
    getStartupConfig.mockRestore();
    warn.mockRestore();
    mockGetThemeFromEnv.mockReset();
  });

  it('resolves a bundled theme name without touching stored preferences', async () => {
    const before = snapshotStorage();
    serveTheme('clickhouse');
    renderTheme(queryClient);

    await waitFor(() => expect(root().dataset.theme).toBe('clickhouse'));
    expect(root().style.getPropertyValue('--surface-primary')).toBe('255 255 255');
    expect(snapshotStorage()).toEqual(before);
    expect(warn).not.toHaveBeenCalled();
  });

  it('applies a valid inline definition without persisting it', async () => {
    const before = snapshotStorage();
    serveTheme(inlineTheme);
    renderTheme(queryClient);

    await waitFor(() => expect(root().dataset.theme).toBe('acme'));
    expect(root().style.getPropertyValue('--surface-primary')).toBe('10 20 30');
    expect(root().style.getPropertyValue('--theme-control-radius')).toBe('2px');
    expect(snapshotStorage()).toEqual(before);
  });

  it('applies an inline definition with an unknown appearance key and reports the key', async () => {
    const before = snapshotStorage();
    serveTheme({
      ...inlineTheme,
      modes: {
        ...inlineTheme.modes,
        light: {
          ...inlineTheme.modes.light,
          appearance: { controlRadius: '2px', futureSpacing: '3.3125rem' },
        },
      },
    });
    renderTheme(queryClient);

    await waitFor(() => expect(root().dataset.theme).toBe('acme'));
    expect(root().style.getPropertyValue('--surface-primary')).toBe('10 20 30');
    expect(root().style.getPropertyValue('--theme-control-radius')).toBe('2px');
    expect(root().getAttribute('style')).not.toContain('3.3125rem');
    expect(warn).toHaveBeenCalledWith(
      '[ThemeProvider] Unknown light appearance token ignored: futureSpacing',
    );
    expect(snapshotStorage()).toEqual(before);
  });

  it('applies an inline definition carrying a color role this build predates', async () => {
    serveTheme({
      ...inlineTheme,
      modes: {
        ...inlineTheme.modes,
        light: {
          ...inlineTheme.modes.light,
          colors: { ...inlineTheme.modes.light.colors, 'rgb-future-role': '1 2 3' },
        },
      },
    });
    renderTheme(queryClient);

    await waitFor(() => expect(root().dataset.theme).toBe('acme'));
    expect(root().style.getPropertyValue('--surface-primary')).toBe('10 20 30');
    expect(root().getAttribute('style')).not.toContain('--future-role');
    expect(warn).toHaveBeenCalledWith(
      '[ThemeProvider] Unknown light color token ignored: rgb-future-role',
    );
  });

  it('ignores an invalid inline definition with a warning and keeps the stored theme', async () => {
    serveTheme({
      ...inlineTheme,
      modes: { light: { colors: { 'rgb-not-a-token': 'red' } } },
    });
    renderTheme(queryClient);

    await waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(warn.mock.calls[0][0]).toContain('Invalid RGB value for rgb-not-a-token: red');
    expect(root().dataset.theme).toBe('stored');
  });

  it('rejects names that are not deployment themes', async () => {
    serveTheme('high-contrast');
    renderTheme(queryClient);

    await waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(warn.mock.calls[0][0]).toContain('"high-contrast"');
    expect(root().dataset.theme).toBe('stored');
  });

  it('prefers the yaml theme over the build-time environment colors', async () => {
    mockGetThemeFromEnv.mockReturnValue({ 'rgb-surface-primary': '99 99 99' });
    serveTheme(inlineTheme);
    renderTheme(queryClient);

    await waitFor(() => expect(root().dataset.theme).toBe('acme'));
    expect(root().style.getPropertyValue('--surface-primary')).toBe('10 20 30');
  });

  it('falls back to the environment colors when no yaml theme is set', async () => {
    mockGetThemeFromEnv.mockReturnValue({ 'rgb-surface-primary': '99 99 99' });
    serveTheme();
    renderTheme(queryClient);

    await waitFor(() => expect(getStartupConfig).toHaveBeenCalled());
    await waitFor(() =>
      expect(root().style.getPropertyValue('--surface-primary')).toBe('99 99 99'),
    );
    expect(root().dataset.theme).not.toBe('clickhouse');
  });

  const replaceConfig = (theme?: ConfigTheme) =>
    act(() => {
      queryClient.setQueryData([QueryKeys.startupConfig, false, 'default'], configWith(theme));
    });

  it('restores the stored theme when the deployment theme is withdrawn', async () => {
    const before = snapshotStorage();
    serveTheme('clickhouse');
    renderTheme(queryClient);
    await waitFor(() => expect(root().dataset.theme).toBe('clickhouse'));

    replaceConfig();

    await waitFor(() => expect(root().dataset.theme).toBe('stored'));
    expect(root().style.getPropertyValue('--accent-primary')).toBe('1 2 3');
    expect(snapshotStorage()).toEqual(before);
  });

  it('restores a legacy color map behind a corrupt stored definition when the deployment theme is withdrawn', async () => {
    localStorage.setItem('theme-definition', '{not json');
    localStorage.setItem('theme-colors', JSON.stringify({ 'rgb-accent-primary': '7 8 9' }));
    localStorage.setItem('theme-name', 'legacy-colors');
    localStorage.setItem('theme-source', 'legacy');
    const before = snapshotStorage();
    serveTheme('clickhouse');
    renderTheme(queryClient);
    await waitFor(() => expect(root().dataset.theme).toBe('clickhouse'));

    replaceConfig();

    await waitFor(() => expect(root().dataset.theme).toBe('legacy-colors'));
    expect(root().style.getPropertyValue('--accent-primary')).toBe('7 8 9');
    expect(snapshotStorage()).toEqual(before);
  });

  it('restores a legacy-source theme onto dark mode when the deployment theme is withdrawn', async () => {
    const legacy = {
      version: 1,
      name: 'legacy-stored',
      modes: { light: { colors: { 'rgb-accent-primary': '4 5 6' } } },
    };
    localStorage.setItem('color-theme', 'dark');
    localStorage.setItem('theme-definition', JSON.stringify(legacy));
    localStorage.setItem('theme-colors', JSON.stringify(legacy.modes.light.colors));
    localStorage.setItem('theme-name', 'legacy-stored');
    localStorage.setItem('theme-source', 'legacy');
    const before = snapshotStorage();
    serveTheme('clickhouse');
    renderTheme(queryClient);
    await waitFor(() => expect(root().dataset.theme).toBe('clickhouse'));

    replaceConfig();

    await waitFor(() => expect(root().dataset.theme).toBe('legacy-stored'));
    expect(root().classList.contains('dark')).toBe(true);
    expect(root().style.getPropertyValue('--accent-primary')).toBe('4 5 6');
    expect(snapshotStorage()).toEqual(before);
  });

  it('falls back to the environment colors when the deployment theme is withdrawn', async () => {
    mockGetThemeFromEnv.mockReturnValue({ 'rgb-surface-primary': '99 99 99' });
    serveTheme('clickhouse');
    renderTheme(queryClient);
    await waitFor(() => expect(root().dataset.theme).toBe('clickhouse'));

    replaceConfig();

    await waitFor(() =>
      expect(root().style.getPropertyValue('--surface-primary')).toBe('99 99 99'),
    );
    expect(root().dataset.theme).not.toBe('stored');
  });

  it('persists theme changes the user makes after the deployment theme is withdrawn', async () => {
    serveTheme('clickhouse');
    renderTheme(queryClient);
    await waitFor(() => expect(root().dataset.theme).toBe('clickhouse'));
    act(() => applyUserColors());
    expect(localStorage.getItem('theme-colors')).toBeNull();

    replaceConfig();
    await waitFor(() => expect(root().dataset.theme).toBe('stored'));
    expect(JSON.parse(localStorage.getItem('theme-definition') ?? '{}')).toEqual(storedDefinition);

    act(() => applyUserColors());

    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem('theme-colors') ?? '{}')).toEqual({
        'rgb-accent-primary': '9 9 9',
      }),
    );
    expect(localStorage.getItem('theme-source')).toBe('legacy');
  });

  it('does not persist a deployment theme that returns after a withdrawal', async () => {
    const before = snapshotStorage();
    serveTheme('clickhouse');
    renderTheme(queryClient);
    await waitFor(() => expect(root().dataset.theme).toBe('clickhouse'));

    replaceConfig();
    await waitFor(() => expect(root().dataset.theme).toBe('stored'));
    replaceConfig(inlineTheme);

    await waitFor(() => expect(root().dataset.theme).toBe('acme'));
    expect(snapshotStorage()).toEqual(before);
  });

  it('paints the theme a route supplies over the startup config until it unmounts', async () => {
    serveTheme('clickhouse');
    renderTheme(queryClient);
    await waitFor(() => expect(root().dataset.theme).toBe('clickhouse'));

    act(() => showSharedRoute(inlineTheme));
    await waitFor(() => expect(root().dataset.theme).toBe('acme'));
    expect(root().style.getPropertyValue('--surface-primary')).toBe('10 20 30');

    act(() => showSharedRoute(null));
    await waitFor(() => expect(root().dataset.theme).toBe('clickhouse'));
    expect(localStorage.getItem('theme-definition')).toBe(JSON.stringify(storedDefinition));
  });

  it('drops the viewer theme in the commit a route mounts, before its own theme is ready', async () => {
    serveTheme('clickhouse');
    renderTheme(queryClient);
    await waitFor(() => expect(root().dataset.theme).toBe('clickhouse'));

    act(() => showLoadingRoute({ ready: false }));
    expect(root().dataset.theme).toBe('stored');

    act(() => showLoadingRoute({ ready: true, theme: inlineTheme }));
    expect(root().dataset.theme).toBe('acme');

    act(() => showLoadingRoute(null));
    expect(root().dataset.theme).toBe('clickhouse');
    expect(localStorage.getItem('theme-definition')).toBe(JSON.stringify(storedDefinition));
  });

  it('shows the stored theme when a route supplies no deployment theme', async () => {
    serveTheme('clickhouse');
    renderTheme(queryClient);
    await waitFor(() => expect(root().dataset.theme).toBe('clickhouse'));

    act(() => showSharedRoute(undefined));
    await waitFor(() => expect(root().dataset.theme).toBe('stored'));
    expect(root().style.getPropertyValue('--accent-primary')).toBe('1 2 3');
    expect(localStorage.getItem('theme-definition')).toBe(JSON.stringify(storedDefinition));
  });

  it('picks up the theme after the auth flow removes the startup config query', async () => {
    const before = snapshotStorage();
    getStartupConfig.mockReturnValueOnce(new Promise(() => undefined));
    renderTheme(queryClient);
    await waitFor(() => expect(getStartupConfig).toHaveBeenCalledTimes(1));

    /** What the refresh-token and login mutations do in `onMutate`. */
    act(() => queryClient.removeQueries());
    serveTheme('clickhouse');
    act(() => mountRoute());

    await waitFor(() => expect(root().dataset.theme).toBe('clickhouse'));
    expect(getStartupConfig).toHaveBeenCalledTimes(2);
    expect(snapshotStorage()).toEqual(before);
  });
});

describe('DeploymentTheme cache', () => {
  const user = { id: 'user-1', tenantId: 'tenant-a' };
  let queryClient: QueryClient;
  let getStartupConfig: jest.SpyInstance;
  let warn: jest.SpyInstance;

  const cacheTheme = (owner = 'tenant-a:user-1', theme: ConfigTheme = 'clickhouse') => {
    const definition = theme === 'clickhouse' ? clickHouseTheme : (theme as ThemeDefinition);
    writeThemeCache(buildThemeCache(owner, theme as NonNullable<ConfigTheme>, definition));
  };
  const cachedEntry = () => JSON.parse(localStorage.getItem(THEME_CACHE_KEY) ?? 'null');
  const pending = () => getStartupConfig.mockReturnValue(new Promise(() => undefined));

  beforeEach(() => {
    localStorage.clear();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    getStartupConfig = jest.spyOn(dataService, 'getStartupConfig');
    mockGetThemeFromEnv.mockReturnValue(undefined);
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    queryClient.clear();
    getStartupConfig.mockRestore();
    warn.mockRestore();
  });

  it('paints the cached theme in the first commit, before the config answers', () => {
    cacheTheme();
    pending();
    renderTheme(queryClient);

    expect(root().dataset.theme).toBe('clickhouse');
    expect(localStorage.getItem('theme-definition')).toBeNull();
  });

  it('does not seed the cache on a shared link, which paints its own tenant', () => {
    cacheTheme();
    pending();
    window.history.pushState({}, '', '/share/abc');
    renderTheme(queryClient);
    window.history.pushState({}, '', '/');

    expect(root().dataset.theme).toBeUndefined();
  });

  it('caches the theme served to the signed-in identity', async () => {
    getStartupConfig.mockResolvedValue(configWith(inlineTheme));
    renderTheme(queryClient, user);

    await waitFor(() => expect(cachedEntry()?.source).toEqual(inlineTheme));
    expect(cachedEntry().owner).toBe('tenant-a:user-1');
    expect(cachedEntry().modes.light.properties).toContainEqual(['--surface-primary', '10 20 30']);
    expect(localStorage.getItem('theme-definition')).toBeNull();
  });

  it('lets a changed deployment theme win over the cache', async () => {
    cacheTheme();
    getStartupConfig.mockResolvedValue(configWith(inlineTheme));
    renderTheme(queryClient, user);

    await waitFor(() => expect(root().dataset.theme).toBe('acme'));
    await waitFor(() => expect(cachedEntry()?.source).toEqual(inlineTheme));
  });

  it('lets a removed deployment theme win and clears the cache', async () => {
    cacheTheme();
    getStartupConfig.mockResolvedValue(configWith());
    renderTheme(queryClient, user);

    await waitFor(() => expect(localStorage.getItem(THEME_CACHE_KEY)).toBeNull());
    expect(root().dataset.theme).toBeUndefined();
  });

  it('clears the cache when the served theme is invalid', async () => {
    cacheTheme();
    getStartupConfig.mockResolvedValue(configWith('not-a-theme' as ConfigTheme));
    renderTheme(queryClient, user);

    await waitFor(() => expect(localStorage.getItem(THEME_CACHE_KEY)).toBeNull());
    expect(root().dataset.theme).toBeUndefined();
  });

  it('never paints a theme cached for another tenant', async () => {
    cacheTheme('tenant-b:user-1');
    pending();
    renderTheme(queryClient, user);

    expect(root().dataset.theme).toBeUndefined();
    await waitFor(() => expect(localStorage.getItem(THEME_CACHE_KEY)).toBeNull());
  });

  it('paints no previous answer after a cache from another tenant until its own answer', async () => {
    cacheTheme('tenant-b:user-1');
    let signIn: () => void = () => undefined;
    function SignIn() {
      const setUser = useSetRecoilState(store.user);
      signIn = () => setUser(user as TUser);
      return null;
    }
    getStartupConfig.mockResolvedValueOnce(configWith('clickhouse'));
    render(
      <RecoilRoot>
        <QueryClientProvider client={queryClient}>
          <DeploymentTheme>
            <SignIn />
          </DeploymentTheme>
        </QueryClientProvider>
      </RecoilRoot>,
    );
    await waitFor(() => expect(root().dataset.theme).toBe('clickhouse'));

    let answer: (config: TStartupConfig) => void = () => undefined;
    getStartupConfig.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    act(() => signIn());
    await waitFor(() => expect(localStorage.getItem(THEME_CACHE_KEY)).toBeNull());
    expect(root().dataset.theme).toBeUndefined();

    await act(async () => answer(configWith(inlineTheme)));
    await waitFor(() => expect(root().dataset.theme).toBe('acme'));
  });

  it('keeps painting the signed-out answer while the signed-in one loads', async () => {
    let signIn: () => void = () => undefined;
    function SignIn() {
      const setUser = useSetRecoilState(store.user);
      signIn = () => setUser(user as TUser);
      return null;
    }
    getStartupConfig.mockResolvedValueOnce(configWith('clickhouse'));
    render(
      <RecoilRoot>
        <QueryClientProvider client={queryClient}>
          <DeploymentTheme>
            <SignIn />
          </DeploymentTheme>
        </QueryClientProvider>
      </RecoilRoot>,
    );
    await waitFor(() => expect(root().dataset.theme).toBe('clickhouse'));

    getStartupConfig.mockReturnValue(new Promise(() => undefined));
    act(() => signIn());
    expect(root().dataset.theme).toBe('clickhouse');
  });

  it('drops a signed-in answer when the identity ends before the signed-out one loads', async () => {
    let signOut: () => void = () => undefined;
    function SignOut() {
      const setUser = useSetRecoilState(store.user);
      signOut = () => setUser(undefined);
      return null;
    }
    getStartupConfig.mockResolvedValueOnce(configWith('clickhouse'));
    render(
      <RecoilRoot initializeState={({ set }) => set(store.user, user as TUser)}>
        <QueryClientProvider client={queryClient}>
          <DeploymentTheme>
            <SignOut />
          </DeploymentTheme>
        </QueryClientProvider>
      </RecoilRoot>,
    );
    await waitFor(() => expect(root().dataset.theme).toBe('clickhouse'));

    getStartupConfig.mockReturnValue(new Promise(() => undefined));
    act(() => signOut());
    await waitFor(() => expect(root().dataset.theme).toBeUndefined());
  });

  it('does not write a signed-out answer over the cache', async () => {
    cacheTheme();
    getStartupConfig.mockResolvedValue(configWith());
    renderTheme(queryClient);

    await waitFor(() => expect(getStartupConfig).toHaveBeenCalled());
    await waitFor(() => expect(root().dataset.theme).toBeUndefined());
    expect(cachedEntry()?.source).toBe('clickhouse');
  });

  it('neither reads nor writes the cache for a route override', async () => {
    getStartupConfig.mockResolvedValue(configWith('clickhouse'));
    renderTheme(queryClient, user);
    await waitFor(() => expect(cachedEntry()?.source).toBe('clickhouse'));

    act(() => showSharedRoute(inlineTheme));
    await waitFor(() => expect(root().dataset.theme).toBe('acme'));
    expect(cachedEntry()?.source).toBe('clickhouse');
  });

  it('clears the cache whenever the signed-in user goes away', async () => {
    cacheTheme();
    pending();
    let signOut: () => void = () => undefined;
    function SignOut() {
      const setUser = useSetRecoilState(store.user);
      signOut = () => setUser(undefined);
      return null;
    }
    render(
      <RecoilRoot initializeState={({ set }) => set(store.user, user as TUser)}>
        <QueryClientProvider client={queryClient}>
          <DeploymentTheme>
            <SignOut />
          </DeploymentTheme>
        </QueryClientProvider>
      </RecoilRoot>,
    );
    expect(cachedEntry()?.source).toBe('clickhouse');

    act(() => signOut());
    await waitFor(() => expect(localStorage.getItem(THEME_CACHE_KEY)).toBeNull());
    expect(root().dataset.theme).toBeUndefined();
  });

  it('clears the cache as soon as a logout starts, before any identity-provider redirect', () => {
    cacheTheme();
    pending();
    renderTheme(queryClient, user);

    act(() => {
      void queryClient
        .getMutationCache()
        .build(queryClient, {
          mutationKey: [MutationKeys.logoutUser],
          mutationFn: () => new Promise(() => undefined),
        })
        .execute();
    });
    expect(localStorage.getItem(THEME_CACHE_KEY)).toBeNull();
  });

  const runMutation = (key: string, mutationFn: () => Promise<unknown>) =>
    act(async () => {
      await queryClient
        .getMutationCache()
        .build(queryClient, { mutationKey: [key], mutationFn })
        .execute()
        .catch(() => undefined);
    });

  it('keeps the cache when an account deletion fails, and drops it when one succeeds', async () => {
    cacheTheme();
    pending();
    renderTheme(queryClient, user);

    await runMutation(MutationKeys.deleteUser, () => Promise.reject(new Error('bad 2FA code')));
    expect(cachedEntry()?.source).toBe('clickhouse');

    await runMutation(MutationKeys.deleteUser, () => Promise.resolve({}));
    expect(localStorage.getItem(THEME_CACHE_KEY)).toBeNull();
  });

  it.each([
    ['fails', () => Promise.reject(new Error('expired'))],
    ['returns no token', () => Promise.resolve(undefined)],
  ])('clears the cache when the silent refresh %s before any user is set', async (_, refresh) => {
    cacheTheme();
    pending();
    renderTheme(queryClient);

    await runMutation(MutationKeys.refreshToken, refresh);
    expect(localStorage.getItem(THEME_CACHE_KEY)).toBeNull();
  });

  it('keeps the cache when the silent refresh restores a session', async () => {
    cacheTheme();
    pending();
    renderTheme(queryClient);

    await runMutation(MutationKeys.refreshToken, () => Promise.resolve({ token: 't', user }));
    expect(cachedEntry()?.source).toBe('clickhouse');
  });

  it('clears the cache when the user query fails', async () => {
    cacheTheme();
    pending();
    renderTheme(queryClient);

    await act(() =>
      queryClient
        .fetchQuery([QueryKeys.user], () => Promise.reject(new Error('401')))
        .catch(() => undefined),
    );
    expect(localStorage.getItem(THEME_CACHE_KEY)).toBeNull();
  });
});
