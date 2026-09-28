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
import { notifyManager, useQueryClient } from '@tanstack/react-query';
import { QueryKeys, isBundledThemeName } from 'librechat-data-provider';
import {
  ThemeProvider,
  clickHouseTheme,
  libreChatTheme,
  fromLegacyTheme,
  validateThemeDefinition,
} from '@librechat/client';
import type { TInterfaceConfig, BundledThemeName } from 'librechat-data-provider';
import type { IThemeRGB, ThemeDefinition } from '@librechat/client';
import type { ComponentProps } from 'react';
import { getThemeFromEnv } from '~/utils/getThemeFromEnv';
import { useGetStartupConfig } from '~/data-provider';

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

/** A route's own deployment theme source; `undefined` defers to the startup config. */
type ThemeOverride = { theme: DeploymentThemeValue } | undefined;

const DeploymentThemeOverrideContext = createContext<(override: ThemeOverride) => void>(
  () => undefined,
);

/**
 * Lets a route whose policy comes from another tenant paint that tenant's theme:
 * once `ready`, `theme` replaces `interface.theme` from the startup config, an
 * absent theme included, until the route unmounts. A route whose theme source
 * failed passes `ready` with no theme, so the viewer's theme does not stand in
 * for the link's. Registered in a layout effect so the wrapper re-renders in the
 * same commit; `ThemeProvider` still applies the change in its own effects.
 */
export function useDeploymentThemeOverride(ready: boolean, theme: DeploymentThemeValue) {
  const setOverride = useContext(DeploymentThemeOverrideContext);
  useLayoutEffect(() => {
    if (!ready) {
      return;
    }
    setOverride({ theme });
    return () => setOverride(undefined);
  }, [ready, theme, setOverride]);
}

/**
 * Supplies the deployment theme from the startup config to `ThemeProvider`.
 * Precedence: high-contrast modes (inside the provider), then `interface.theme`,
 * then the `REACT_APP_THEME_*` build colors, then the user's stored theme. The
 * deployment theme is never persisted, so the stored theme survives its removal.
 */
export default function DeploymentTheme({ children }: { children: React.ReactNode }) {
  const envTheme = useMemo(() => getThemeFromEnv(), []);
  useRebindOnStartupConfigRebuild();
  const { data: startupConfig } = useGetStartupConfig({ keepPreviousData: true });
  const [override, setOverride] = useState<ThemeOverride>(undefined);
  const configTheme = override ? override.theme : startupConfig?.interface?.theme;
  const themeDefinition = useMemo(() => resolveDeploymentTheme(configTheme), [configTheme]);

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
