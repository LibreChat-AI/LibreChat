import { createContext, useCallback, useContext, useMemo } from 'react';
import { atom, createStore, useAtomValue } from 'jotai';
import {
  DEFAULT_MCP_APPS_POLICY,
  DEFAULT_MCP_APP_MAX_ACTIVE_VIEWS,
  DEFAULT_MCP_APP_ACTION_PREVIEW_CHARS,
  MAX_MCP_APP_ACTIVE_VIEWS,
  MAX_MCP_APP_ACTION_PREVIEW_CHARS,
  resolveMCPAppCspLimits,
  type TMCPAppsPolicy,
  type TStartupConfig,
} from 'librechat-data-provider';

/** One store per host provider; never share capacity across conversations or signed-in users. */
const activeAppViewsAtom = atom<ReadonlySet<string>>(new Set<string>());

function validLimit(value: unknown, fallback: number, max: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max
    ? value
    : fallback;
}

type MCPAppsHostContextValue = {
  reserveView: (key: string) => boolean;
  releaseView: (key: string) => void;
  activeViewStore: ReturnType<typeof createStore>;
  policy: Readonly<TMCPAppsPolicy>;
  userId?: string;
};

const DEFAULT_MCP_APPS_HOST: MCPAppsHostContextValue = {
  reserveView: () => false,
  releaseView: () => undefined,
  activeViewStore: createStore(),
  policy: DEFAULT_MCP_APPS_POLICY,
};

const MCPAppsPolicyContext = createContext<MCPAppsHostContextValue>(DEFAULT_MCP_APPS_HOST);

function getPublishedPolicy(
  startupConfig: TStartupConfig | undefined,
  ready: boolean,
): Readonly<TMCPAppsPolicy> {
  const policy = startupConfig?.mcpApps;
  if (
    !ready ||
    typeof policy?.enabled !== 'boolean' ||
    typeof policy.legacyHtmlEnabled !== 'boolean'
  ) {
    return DEFAULT_MCP_APPS_POLICY;
  }
  return {
    ...policy,
    cspLimits: resolveMCPAppCspLimits(policy.cspLimits),
    maxActiveViews: validLimit(
      policy.maxActiveViews,
      DEFAULT_MCP_APP_MAX_ACTIVE_VIEWS,
      MAX_MCP_APP_ACTIVE_VIEWS,
    ),
    maxActionPreviewChars: validLimit(
      policy.maxActionPreviewChars,
      DEFAULT_MCP_APP_ACTION_PREVIEW_CHARS,
      MAX_MCP_APP_ACTION_PREVIEW_CHARS,
    ),
  };
}

export function MCPAppsPolicyProvider({
  children,
  startupConfig,
  ready,
  userId,
}: {
  children: React.ReactNode;
  startupConfig?: TStartupConfig;
  ready: boolean;
  userId?: string;
}) {
  const policy = useMemo(() => getPublishedPolicy(startupConfig, ready), [ready, startupConfig]);
  const activeViewStore = useMemo(() => createStore(), []);
  const reserveView = useCallback(
    (key: string) => {
      const active = activeViewStore.get(activeAppViewsAtom);
      if (active.has(key)) return true;
      if (active.size >= (policy.maxActiveViews ?? DEFAULT_MCP_APP_MAX_ACTIVE_VIEWS)) return false;
      activeViewStore.set(activeAppViewsAtom, new Set(active).add(key));
      return true;
    },
    [activeViewStore, policy.maxActiveViews],
  );
  const releaseView = useCallback(
    (key: string) => {
      const active = activeViewStore.get(activeAppViewsAtom);
      if (active.has(key)) {
        const next = new Set(active);
        next.delete(key);
        activeViewStore.set(activeAppViewsAtom, next);
      }
    },
    [activeViewStore],
  );
  const authenticatedUserId = typeof userId === 'string' && userId.trim() ? userId : undefined;
  const value = useMemo(
    () => ({ policy, userId: authenticatedUserId, reserveView, releaseView, activeViewStore }),
    [authenticatedUserId, policy, reserveView, releaseView, activeViewStore],
  );

  return <MCPAppsPolicyContext.Provider value={value}>{children}</MCPAppsPolicyContext.Provider>;
}

export function useMCPAppsPolicy(): Readonly<TMCPAppsPolicy> {
  return useContext(MCPAppsPolicyContext).policy;
}

export function useMCPAppsHost(): MCPAppsHostContextValue {
  return useContext(MCPAppsPolicyContext);
}

/** Subscribe only a capacity notice, not every historical placeholder, to shared View changes. */
export function useMCPAppViewAtCapacity(): boolean {
  const { activeViewStore, policy } = useMCPAppsHost();
  return (
    useAtomValue(activeAppViewsAtom, { store: activeViewStore }).size >=
    (policy.maxActiveViews ?? DEFAULT_MCP_APP_MAX_ACTIVE_VIEWS)
  );
}
