import { useEffect, useMemo, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import type { TRumConfig, TUser } from 'librechat-data-provider';
import type { HyperDXActionClient } from './diagnostics';
import type { BrowserConfig } from './browser';
import {
  discardEarlyRumQueue,
  queueSpaRouteChange,
  forwardQueuedAssetEvents,
  restoreRumEmitter,
  startRumDiagnostics,
} from './diagnostics';
import { startClientLogs, stopClientLogs } from './logs';
import { useGetStartupConfig } from '~/data-provider';
import { useAuthContext } from '~/hooks/AuthContext';
import { isReplayRouteAllowed } from './privacy';
import { normalizeRumPath } from './routes';
import { getClientBuildId } from './build';

const PROXY_API_KEY = 'librechat-rum-proxy';

let rumProxyToken: string | undefined;
let rumProxyFetchPatched = false;

type HyperDXBrowser = HyperDXActionClient & {
  init: (config: BrowserConfig) => void;
  setGlobalAttributes: (attributes: Record<string, string>) => void;
  getSessionId?: () => string | undefined;
  stopSessionRecorder: () => void;
  resumeSessionRecorder: () => void;
};

function shouldInitializeRum(config: TRumConfig | undefined, token: string | undefined): boolean {
  if (!config?.enabled || config.provider !== 'hyperdx' || !config.url || !config.serviceName) {
    return false;
  }

  if (config.authMode === 'publicToken') {
    return !!config.publicToken;
  }

  return config.authMode === 'proxy' && !!token && !config.publicToken;
}

function isProxyRumWaitingForToken(
  config: TRumConfig | undefined,
  token: string | undefined,
): boolean {
  return (
    !!config?.enabled &&
    config.provider === 'hyperdx' &&
    !!config.url &&
    !!config.serviceName &&
    config.authMode === 'proxy' &&
    !token &&
    !config.publicToken
  );
}

/**
 * Client logs ride the authenticated proxy only: the browser never holds a collector URL or
 * ingestion key for them, so public-token deployments keep just the RUM SDK's own signals.
 */
function syncClientLogs(config: TRumConfig, getSessionId: () => string | undefined): void {
  if (config.authMode !== 'proxy' || !config.clientLogs) {
    stopClientLogs();
    return;
  }

  startClientLogs({
    endpoint: `${config.url}/v1/logs`,
    serviceName: config.serviceName,
    environment: config.environment,
    buildId: getClientBuildId() ?? 'unknown',
    getToken: () => rumProxyToken,
    getSessionId,
  });
  forwardQueuedAssetEvents();
}

function getApiKey(config: TRumConfig, token: string | undefined): string {
  if (config.authMode === 'proxy') {
    return token ? PROXY_API_KEY : '';
  }

  return config.publicToken ?? '';
}

function isRumProxyRequest(input: RequestInfo | URL, proxyUrl: string): boolean {
  const rawUrl =
    typeof Request !== 'undefined' && input instanceof Request ? input.url : input.toString();
  const url = new URL(rawUrl, window.location.origin);
  const proxy = new URL(proxyUrl, window.location.origin);

  return url.origin === window.location.origin && url.pathname.startsWith(`${proxy.pathname}/`);
}

function withAuthorization(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  token: string,
): [RequestInfo | URL, RequestInit | undefined] {
  const headers = new Headers(
    init?.headers ??
      (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined),
  );
  headers.set('authorization', `Bearer ${token}`);

  if (typeof Request !== 'undefined' && input instanceof Request) {
    return [new Request(input, { ...init, headers }), undefined];
  }

  return [input, { ...init, headers }];
}

function ensureRumProxyAuth(proxyUrl: string): void {
  if (rumProxyFetchPatched || typeof window === 'undefined' || typeof window.fetch !== 'function') {
    return;
  }

  const originalFetch = window.fetch.bind(window);
  const patchedFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (rumProxyToken && isRumProxyRequest(input, proxyUrl)) {
      const [authorizedInput, authorizedInit] = withAuthorization(input, init, rumProxyToken);
      return originalFetch(authorizedInput, authorizedInit);
    }

    return originalFetch(input, init);
  };
  window.fetch = patchedFetch;
  rumProxyFetchPatched = true;
}

function buildGlobalAttributes(
  user: TUser | undefined,
  config: TRumConfig,
  route: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries({
      route,
      clientBuildId: getClientBuildId(),
      role: user?.role,
      userId: user?.id,
      orgId: user?.tenantId,
      serviceName: config.serviceName,
      environment: config.environment,
    }).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '',
    ),
  );
}

async function loadHyperDX(): Promise<HyperDXBrowser> {
  const module = await import('./browser');
  return module.default;
}

export default function useRum(): void {
  const { data: startupConfig, isFetched: startupConfigFetched } = useGetStartupConfig();
  const { token, user } = useAuthContext();
  const location = useLocation();
  const initializedKeyRef = useRef<string | undefined>(undefined);
  const sampledInitKeyRef = useRef<string | undefined>(undefined);
  const sampledInRef = useRef<boolean>(true);
  const hyperDxRef = useRef<HyperDXBrowser | undefined>(undefined);
  const rumConfig = startupConfig?.rum;
  const replayEnabled =
    (rumConfig?.sessionReplay?.enabled ?? rumConfig?.disableReplay === false) &&
    isReplayRouteAllowed(location.pathname);
  const shouldBufferRoutes = !startupConfigFetched || !!rumConfig;
  const route = useMemo(() => normalizeRumPath(location.pathname), [location.pathname]);
  const routeRef = useRef<string>(route);

  useEffect(() => {
    const previousRoute = routeRef.current;
    if (previousRoute && previousRoute !== route && shouldBufferRoutes) {
      queueSpaRouteChange(previousRoute, route);
    }

    routeRef.current = route;
  }, [route, shouldBufferRoutes]);

  /** Leaving the RUM layout (e.g. for a share link) ends this session's recording and log export. */
  useEffect(
    () => () => {
      stopClientLogs();
      hyperDxRef.current?.stopSessionRecorder();
      hyperDxRef.current = undefined;
      initializedKeyRef.current = undefined;
    },
    [],
  );

  useEffect(() => {
    if (!rumConfig) {
      if (startupConfigFetched) {
        discardEarlyRumQueue();
        stopClientLogs();
        hyperDxRef.current?.stopSessionRecorder();
      }
      return;
    }

    if (!shouldInitializeRum(rumConfig, token)) {
      stopClientLogs();
      hyperDxRef.current?.stopSessionRecorder();
      if (rumConfig?.authMode === 'proxy') {
        rumProxyToken = undefined;
        hyperDxRef.current = undefined;
        initializedKeyRef.current = undefined;
      }
      if (!isProxyRumWaitingForToken(rumConfig, token)) {
        discardEarlyRumQueue();
      }
      return;
    }

    const config = rumConfig;
    const apiKey = getApiKey(config, token);
    if (config.authMode === 'proxy') {
      rumProxyToken = token;
      ensureRumProxyAuth(config.url);
    }

    const identity = config.authMode === 'proxy' ? JSON.stringify([user?.tenantId, user?.id]) : '';
    const samplingKey = [config.url, config.serviceName, config.authMode, apiKey, identity].join(
      ':',
    );
    const initKey = [samplingKey, replayEnabled].join(':');
    const getSessionId = () => hyperDxRef.current?.getSessionId?.();

    if (initializedKeyRef.current === initKey) {
      if (hyperDxRef.current) {
        restoreRumEmitter(hyperDxRef.current);
        if (replayEnabled) {
          hyperDxRef.current.resumeSessionRecorder();
        }
      }
      syncClientLogs(config, getSessionId);
      return;
    }

    /* Retire the previous recorder and correlation before accepting new records. */
    stopClientLogs();
    hyperDxRef.current?.stopSessionRecorder();
    hyperDxRef.current = undefined;
    initializedKeyRef.current = undefined;

    // Changing replay policy must not re-roll the general RUM sampling decision.
    if (sampledInitKeyRef.current !== samplingKey) {
      sampledInitKeyRef.current = samplingKey;
      sampledInRef.current =
        typeof config.sampleRate === 'number' ? Math.random() < config.sampleRate : true;
    }

    if (!sampledInRef.current) {
      discardEarlyRumQueue();
      stopClientLogs();
      return;
    }

    syncClientLogs(config, getSessionId);

    let cancelled = false;

    loadHyperDX()
      .then((HyperDX) => {
        if (cancelled || initializedKeyRef.current === initKey) {
          return;
        }

        HyperDX.init({
          advancedNetworkCapture: config.advancedNetworkCapture ?? false,
          apiKey,
          consoleCapture: config.consoleCapture ?? false,
          disableReplay: !replayEnabled,
          // Mask chat text and typed values before replay events leave the browser.
          maskAllInputs: true,
          maskAllText: true,
          service: config.serviceName,
          tracePropagationTargets: config.tracePropagationTargets,
          url: config.url,
        });

        hyperDxRef.current = HyperDX;
        initializedKeyRef.current = initKey;
        HyperDX.setGlobalAttributes(buildGlobalAttributes(user, config, routeRef.current));
        if (replayEnabled) {
          HyperDX.resumeSessionRecorder();
        }
        startRumDiagnostics(HyperDX, () => routeRef.current);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [rumConfig, replayEnabled, startupConfigFetched, token, user]);

  useEffect(() => {
    hyperDxRef.current?.setGlobalAttributes(
      rumConfig ? buildGlobalAttributes(user, rumConfig, route) : { route },
    );
  }, [route, rumConfig, user]);
}
