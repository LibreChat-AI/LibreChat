import type { FCPMetricWithAttribution } from 'web-vitals/attribution';
import { normalizeRumPath } from './routes';
import { getClientBuildId } from './build';

export type RumActionAttributes = Record<string, string | number | boolean>;

export type HyperDXActionClient = {
  addAction: (name: string, attributes?: RumActionAttributes) => void;
};

type RumQueuedEvent = {
  type?: unknown;
  at?: unknown;
  visibilityState?: unknown;
  attributes?: Record<string, unknown>;
};

type NavigationTimingLike = {
  activationStart?: number;
  connectStart?: number;
  decodedBodySize?: number;
  domComplete?: number;
  domContentLoadedEventStart?: number;
  domInteractive?: number;
  domainLookupStart?: number;
  encodedBodySize?: number;
  fetchStart?: number;
  loadEventEnd?: number;
  name?: string;
  nextHopProtocol?: string;
  redirectCount?: number;
  redirectEnd?: number;
  redirectStart?: number;
  requestStart?: number;
  responseEnd?: number;
  responseStart?: number;
  transferSize?: number;
  type?: string;
  unloadEventEnd?: number;
  unloadEventStart?: number;
  workerStart?: number;
};

const URL_ATTRIBUTE_KEYS: Record<string, string> = {
  assetUrl: 'assetPath',
  currentPath: 'currentPath',
  currentUrl: 'currentPath',
  firstScopeUrl: 'firstScopePath',
  fromPath: 'fromPath',
  fullUrl: 'fullPath',
  scriptUrl: 'scriptPath',
  toPath: 'toPath',
};
const EARLY_RUM_QUEUE_STORAGE_KEY = 'lc-rum-queue';

declare global {
  interface Window {
    __lcRumQueue?: RumQueuedEvent[];
    __lcRumPush?: (type: string, attributes?: Record<string, unknown>) => void;
  }
}

let fcpAttributionRegistered = false;
let earlyQueueFlushed = false;

function round(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function compact(attributes: Record<string, unknown>): RumActionAttributes {
  return Object.fromEntries(
    Object.entries(attributes).filter(
      (entry): entry is [string, string | number | boolean] =>
        typeof entry[1] === 'string' ||
        typeof entry[1] === 'number' ||
        typeof entry[1] === 'boolean',
    ),
  );
}

function sanitizeQueuedAttributes(
  attributes: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!attributes) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(attributes).map(([key, value]) => {
      const sanitizedKey = URL_ATTRIBUTE_KEYS[key];
      if (sanitizedKey) {
        return [sanitizedKey, pathFromUrl(value)];
      }

      return [key, value];
    }),
  );
}

function pathFromUrl(rawUrl: unknown): string | undefined {
  if (typeof rawUrl !== 'string' || rawUrl === '') {
    return undefined;
  }

  try {
    return normalizeRumPath(new URL(rawUrl, window.location.origin).pathname);
  } catch {
    return normalizeRumPath(rawUrl.split('?')[0]?.split('#')[0] ?? rawUrl);
  }
}

function sharedNavigationAttributes(nav: NavigationTimingLike | undefined): RumActionAttributes {
  return compact({
    initialPath: pathFromUrl(nav?.name),
    navType: nav?.type,
    redirectCount: round(nav?.redirectCount),
    redirectStart: round(nav?.redirectStart),
    redirectEnd: round(nav?.redirectEnd),
    workerStart: round(nav?.workerStart),
    fetchStart: round(nav?.fetchStart),
    domainLookupStart: round(nav?.domainLookupStart),
    connectStart: round(nav?.connectStart),
    requestStart: round(nav?.requestStart),
    responseStart: round(nav?.responseStart),
    responseEnd: round(nav?.responseEnd),
    domInteractive: round(nav?.domInteractive),
    domContentLoadedEventStart: round(nav?.domContentLoadedEventStart),
    domComplete: round(nav?.domComplete),
    loadEventEnd: round(nav?.loadEventEnd),
    unloadEventStart: round(nav?.unloadEventStart),
    unloadEventEnd: round(nav?.unloadEventEnd),
    activationStart: round(nav?.activationStart),
    transferSize: round(nav?.transferSize),
    encodedBodySize: round(nav?.encodedBodySize),
    decodedBodySize: round(nav?.decodedBodySize),
    nextHopProtocol: nonEmptyString(nav?.nextHopProtocol),
  });
}

function fcpAttributes(
  metric: FCPMetricWithAttribution,
  currentRoute: string,
): RumActionAttributes {
  const nav = metric.attribution.navigationEntry as NavigationTimingLike | undefined;

  return compact({
    currentPath: normalizeRumPath(window.location.pathname),
    currentRoute,
    fcp: round(metric.value),
    fcpEntryStart: round(metric.attribution.fcpEntry?.startTime),
    timeToFirstByte: round(metric.attribution.timeToFirstByte),
    firstByteToFCP: round(metric.attribution.firstByteToFCP),
    loadState: metric.attribution.loadState,
    navigationType: metric.navigationType,
    ...sharedNavigationAttributes(nav),
    visibilityState: document.visibilityState,
  });
}

export function flushEarlyRumQueue(HyperDX: HyperDXActionClient): void {
  if (earlyQueueFlushed) {
    installRumEmitter(HyperDX);
    return;
  }

  earlyQueueFlushed = true;
  const queuedEvents = window.__lcRumQueue?.splice(0) ?? [];
  try {
    sessionStorage.removeItem(EARLY_RUM_QUEUE_STORAGE_KEY);
  } catch {
    HyperDX.addAction('early-rum-queue-storage-error', { operation: 'clear' });
  }
  queuedEvents.forEach((event) => {
    emitEarlyRumEvent(HyperDX, event);
  });

  installRumEmitter(HyperDX);
}

export function restoreRumEmitter(HyperDX: HyperDXActionClient): void {
  installRumEmitter(HyperDX);
}

function installRumEmitter(HyperDX: HyperDXActionClient): void {
  const clientBuildId = getClientBuildId();
  window.__lcRumPush = (type, attributes) => {
    emitEarlyRumEvent(HyperDX, {
      type,
      at: performance.now(),
      visibilityState: document.visibilityState,
      attributes: { ...attributes, clientBuildId },
    });
  };
}

export function discardEarlyRumQueue(): void {
  window.__lcRumQueue?.splice(0);
  try {
    sessionStorage.removeItem(EARLY_RUM_QUEUE_STORAGE_KEY);
  } catch {
    /* Diagnostics should never affect app behavior. */
  }
  window.__lcRumPush = () => undefined;
}

function emitEarlyRumEvent(HyperDX: HyperDXActionClient, event: RumQueuedEvent): void {
  if (typeof event.type !== 'string' || event.type === '') {
    return;
  }

  const actionName = event.type === 'spa-route-change' ? event.type : `early-${event.type}`;
  try {
    HyperDX.addAction(
      actionName,
      compact({
        at: round(event.at),
        visibilityState: nonEmptyString(event.visibilityState),
        clientBuildId: 'unknown',
        ...sanitizeQueuedAttributes(event.attributes),
      }),
    );
  } catch {
    /* Diagnostics should never affect app behavior or stale-asset recovery. */
  }
}

export function queueSpaRouteChange(
  fromPath: string,
  toPath: string,
  pageElapsedMs = performance.now(),
): void {
  const normalizedFromPath = normalizeRumPath(fromPath);
  const normalizedToPath = normalizeRumPath(toPath);

  if (normalizedFromPath === normalizedToPath) {
    return;
  }

  window.__lcRumPush?.('spa-route-change', {
    fromPath: normalizedFromPath,
    toPath: normalizedToPath,
    pageElapsedMs: round(pageElapsedMs),
  });
}

export async function registerFcpAttribution(
  HyperDX: HyperDXActionClient,
  getCurrentRoute: () => string,
): Promise<void> {
  if (fcpAttributionRegistered) {
    return;
  }

  try {
    const { onFCP } = await import('web-vitals/attribution');
    onFCP((metric) => {
      HyperDX.addAction('page-load-diagnostics', fcpAttributes(metric, getCurrentRoute()));
    });
    fcpAttributionRegistered = true;
  } catch {
    /* Diagnostics must never trigger stale-asset recovery or app reloads. */
  }
}

export function startRumDiagnostics(
  HyperDX: HyperDXActionClient,
  getCurrentRoute: () => string,
): void {
  flushEarlyRumQueue(HyperDX);
  void registerFcpAttribution(HyperDX, getCurrentRoute);
}

export const testExports = {
  compact,
  fcpAttributes,
  pathFromUrl,
  resetDiagnosticsState: () => {
    fcpAttributionRegistered = false;
    earlyQueueFlushed = false;
  },
};
