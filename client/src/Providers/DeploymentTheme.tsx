import {
  useRef,
  useMemo,
  useState,
  useEffect,
  useReducer,
  useContext,
  createContext,
  useLayoutEffect,
} from 'react';
import { useRecoilValue } from 'recoil';
import { notifyManager, useQueryClient } from '@tanstack/react-query';
import { QueryKeys, MutationKeys, isBundledThemeName } from 'librechat-data-provider';
import {
  ThemeProvider,
  clickHouseTheme,
  libreChatTheme,
  fromLegacyTheme,
  validateThemeDefinition,
} from '@librechat/client';
import type {
  TInterfaceConfig,
  BundledThemeName,
  TRefreshTokenResponse,
} from 'librechat-data-provider';
import type { IThemeRGB, ThemeDefinition } from '@librechat/client';
import type { ComponentProps } from 'react';
import {
  themeOwner,
  appBasePath,
  isPublicRoute,
  readThemeCache,
  clearThemeCache,
  buildThemeCache,
  writeThemeCache,
  reconcileThemeCache,
} from './themeCache';
import { getThemeFromEnv } from '~/utils/getThemeFromEnv';
import { useGetStartupConfig } from '~/data-provider';
import store from '~/store';

type DeploymentThemeValue = TInterfaceConfig['theme'];

const bundledThemes: Readonly<Record<BundledThemeName, ThemeDefinition>> = {
  librechat: libreChatTheme,
  clickhouse: clickHouseTheme,
};

/**
 * Resolves `interface.theme` from librechat.yaml to a theme definition: a bundled
 * name, or an inline definition that passes the registry's validation. Anything
 * else is reported once and ignored, so a bad value falls back to today's theme.
 */
export function resolveDeploymentTheme(theme: DeploymentThemeValue): ThemeDefinition | undefined {
  if (theme == null) {
    return undefined;
  }

  if (typeof theme === 'string') {
    const definition = isBundledThemeName(theme) ? bundledThemes[theme] : undefined;
    if (!definition) {
      console.warn(`[DeploymentTheme] Ignoring unknown interface.theme "${theme}"`);
    }
    return definition;
  }

  const definition = theme as ThemeDefinition;
  const errors = validateThemeDefinition(definition);
  if (errors.length > 0) {
    console.warn(`[DeploymentTheme] Ignoring invalid interface.theme: ${errors.join('; ')}`);
    return undefined;
  }
  return definition;
}

/** A corrupt entry reads as absent, so the next storage adapter still gets its turn. */
const parseStored = (key: string): unknown => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
};

const isValidDefinition = (value: unknown): value is ThemeDefinition =>
  typeof value === 'object' &&
  value !== null &&
  validateThemeDefinition(value as ThemeDefinition).length === 0;

/**
 * The user's own theme in the shape `ThemeProvider` restores it: a versioned
 * definition, or legacy colors that the provider overlays on both modes. Stored
 * with source `legacy`, a definition is the legacy compatibility copy and goes back
 * through the legacy path. The deployment theme is never persisted, so storage
 * still holds this while the deployment theme is applied.
 */
type StoredTheme = { definition: ThemeDefinition } | { legacyColors: IThemeRGB; name: string };

export function readStoredTheme(): StoredTheme | undefined {
  try {
    const definition = parseStored('theme-definition');
    if (isValidDefinition(definition)) {
      const legacyColors = definition.modes.light?.colors;
      return localStorage.getItem('theme-source') === 'legacy' && legacyColors
        ? { legacyColors, name: definition.name }
        : { definition };
    }
    const colors = parseStored('theme-colors');
    if (typeof colors !== 'object' || colors === null) {
      return undefined;
    }
    const name = localStorage.getItem('theme-name') ?? 'custom';
    return isValidDefinition(fromLegacyTheme(colors as IThemeRGB, name))
      ? { legacyColors: colors as IThemeRGB, name }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The auth mutations call `removeQueries()`, which detaches this long-lived
 * observer from the query it was reading; only a re-render rebinds it to the
 * rebuilt one. The cache event is checked by key alone, since it fires for every
 * query in the app, and the re-render is deferred past the render that built it.
 */
function useRebindOnStartupConfigRebuild() {
  const queryClient = useQueryClient();
  const [, rebind] = useReducer((count: number) => count + 1, 0);
  useEffect(
    () =>
      queryClient.getQueryCache().subscribe(
        notifyManager.batchCalls((event) => {
          if (event.type === 'added' && event.query.queryKey[0] === QueryKeys.startupConfig) {
            rebind();
          }
        }),
      ),
    [queryClient],
  );
}

/**
 * The cached deployment theme, as last read or written. Losing the signed-in user drops
 * it, whichever way the session ended (logout, an empty silent refresh, a failed user
 * query, account deletion), so the next person on this browser does not get the
 * previous identity's theme painted before their own config answers.
 */
function useThemeCache(owner?: string) {
  const queryClient = useQueryClient();
  const [cached, setCached] = useState(() =>
    isPublicRoute(window.location.pathname, appBasePath()) ? undefined : readThemeCache(),
  );
  const signedIn = useRef(owner);
  useEffect(() => {
    if (signedIn.current && !owner) {
      clearThemeCache();
      setCached(undefined);
    }
    signedIn.current = owner;
  }, [owner]);
  /**
   * The session also ends where no user was ever set, or before it is cleared: a silent
   * refresh that fails or returns no token, a failed user query, and a logout, which goes
   * as soon as it starts because an identity-provider logout unloads the page first. An
   * account deletion only counts once it succeeds.
   */
  useEffect(() => {
    const drop = () => {
      clearThemeCache();
      setCached(undefined);
    };
    const unsubscribeMutations = queryClient.getMutationCache().subscribe((event) => {
      const key = event?.mutation?.options.mutationKey?.[0];
      if (event?.type === 'added' && key === MutationKeys.logoutUser) {
        return drop();
      }
      if (event?.type !== 'updated') {
        return;
      }
      const { status, data } = event.mutation.state;
      const tokenless = status === 'success' && !(data as TRefreshTokenResponse | undefined)?.token;
      if (
        (key === MutationKeys.deleteUser && status === 'success') ||
        (key === MutationKeys.refreshToken && (status === 'error' || tokenless))
      ) {
        drop();
      }
    });
    const unsubscribeQueries = queryClient.getQueryCache().subscribe((event) => {
      if (
        event?.type === 'updated' &&
        event.query.queryKey[0] === QueryKeys.user &&
        event.query.state.status === 'error'
      ) {
        drop();
      }
    });
    return () => {
      unsubscribeMutations();
      unsubscribeQueries();
    };
  }, [queryClient]);
  return [cached, setCached] as const;
}

/** A route's own deployment theme source; `undefined` defers to the startup config. */
type ThemeOverride = { theme: DeploymentThemeValue } | undefined;

const DeploymentThemeOverrideContext = createContext<(override: ThemeOverride) => void>(
  () => undefined,
);

/**
 * Lets a route whose policy comes from another tenant paint that tenant's theme:
 * from the commit the route mounts until it unmounts, the route's theme replaces
 * `interface.theme` from the startup config. Until `ready` that theme is absent,
 * so the viewer's theme never stands in for the link's while its policy loads,
 * including after an in-app navigation that keeps the viewer's answer on hand; a
 * route whose theme source failed passes `ready` with no theme for the same reason.
 * Registered in a layout effect so the wrapper re-renders in the same commit, and
 * `ThemeProvider` applies the change before that commit paints.
 */
export function useDeploymentThemeOverride(ready: boolean, theme: DeploymentThemeValue) {
  const setOverride = useContext(DeploymentThemeOverrideContext);
  useLayoutEffect(() => {
    setOverride({ theme: ready ? theme : undefined });
    return () => setOverride(undefined);
  }, [ready, theme, setOverride]);
}

/**
 * Supplies the deployment theme from the startup config to `ThemeProvider`.
 * Precedence: high-contrast modes (inside the provider), then `interface.theme`,
 * then the `REACT_APP_THEME_*` build colors, then the user's stored theme. The
 * deployment theme is never persisted to the user's theme keys, so the stored theme
 * survives its removal; a separate cache (`./themeCache`) paints it before the
 * config answers on a reload.
 */
export default function DeploymentTheme({ children }: { children: React.ReactNode }) {
  const envTheme = useMemo(() => getThemeFromEnv(), []);
  useRebindOnStartupConfigRebuild();
  const { data: startupConfig, isPreviousData } = useGetStartupConfig({ keepPreviousData: true });
  const owner = themeOwner(useRecoilValue(store.user));
  const [cached, setCached] = useThemeCache(owner);
  const [override, setOverride] = useState<ThemeOverride>(undefined);
  /** A route override is another tenant's theme: it neither reads nor writes the cache. */
  const decision = override
    ? { theme: override.theme, cache: 'keep' as const }
    : reconcileThemeCache({
        cached,
        owner,
        answer: startupConfig && {
          theme: startupConfig.interface?.theme,
          current: !isPreviousData,
        },
      });
  const configTheme = decision.theme;
  const themeDefinition = useMemo(() => resolveDeploymentTheme(configTheme), [configTheme]);

  /** Storage is an external system, so the cache follows the decision after the commit. */
  const cacheAction = decision.cache;
  useEffect(() => {
    if (cacheAction === 'keep') {
      return;
    }
    if (cacheAction === 'write' && owner && configTheme != null && themeDefinition) {
      const entry = buildThemeCache(owner, configTheme, themeDefinition);
      writeThemeCache(entry);
      setCached(entry);
      return;
    }
    clearThemeCache();
    setCached((entry) =>
      cacheAction === 'disown' && entry ? { ...entry, disowned: true } : undefined,
    );
  }, [cacheAction, owner, configTheme, themeDefinition, setCached]);

  /**
   * Persistence stays off while a deployment theme is applied and for the render
   * that withdraws it, so neither the deployment theme nor the restore writes
   * storage. Once the restored theme is installed, the user's own changes persist.
   */
  const deploymentThemeApplied = useRef(false);
  const [persistenceReleased, setPersistenceReleased] = useState(false);
  if (themeDefinition) {
    deploymentThemeApplied.current = true;
  }
  const withdrawn = !themeDefinition && deploymentThemeApplied.current;
  useEffect(() => {
    setPersistenceReleased(withdrawn);
  }, [withdrawn]);
  const persistenceOff = Boolean(themeDefinition) || (withdrawn && !persistenceReleased);

  /**
   * Clearing the prop would leave the provider on the LibreChat palette, so a
   * deployment theme that goes away hands the provider the user's stored theme,
   * unless the build-time colors outrank it.
   */
  const storedTheme = useMemo(
    () => (withdrawn && !envTheme ? readStoredTheme() : undefined),
    [withdrawn, envTheme],
  );

  const props: Omit<ComponentProps<typeof ThemeProvider>, 'children'> = {
    ...(envTheme && { initialTheme: 'system', themeRGB: envTheme }),
    ...(themeDefinition && { themeDefinition }),
    ...(storedTheme && 'definition' in storedTheme && { themeDefinition: storedTheme.definition }),
    ...(storedTheme &&
      'legacyColors' in storedTheme && {
        themeRGB: storedTheme.legacyColors,
        themeName: storedTheme.name,
      }),
    ...(persistenceOff && { persistThemeDefinition: false }),
  };

  return (
    <DeploymentThemeOverrideContext.Provider value={setOverride}>
      <ThemeProvider {...props}>{children}</ThemeProvider>
    </DeploymentThemeOverrideContext.Provider>
  );
}
