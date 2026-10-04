import type { FCPMetricWithAttribution } from 'web-vitals/attribution';
import { isClientEventType, isClientLogsActive, recordClientEvent } from './logs';
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
  /** Already delivered as a client log record; persisted so a later page does not resend it. */
  logged?: unknown;
  /** Already sent to the RUM SDK; kept queued only until its client log record is acknowledged. */
  actionSent?: unknown;
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

/** Queued events handed to the log exporter and not yet acknowledged by the collector. */
const forwardingEvents = new WeakSet<RumQueuedEvent>();
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
  queuedEvents.forEach((event) => {
    emitEarlyRumEvent(HyperDX, event);
  });
  const awaitingDelivery = queuedEvents.filter(shouldRetainEvent);
  awaitingDelivery.forEach((event) => {
    event.actionSent = true;
  });
  window.__lcRumQueue?.unshift(...awaitingDelivery);
  try {
    persistEarlyQueue();
  } catch {
    HyperDX.addAction('early-rum-queue-storage-error', { operation: 'clear' });
  }

  installRumEmitter(HyperDX);
}

/** Persists what is still queued, or clears the stored copy once nothing is left. */
function persistEarlyQueue(): void {
  const queue = window.__lcRumQueue ?? [];
  if (queue.length === 0) {
    sessionStorage.removeItem(EARLY_RUM_QUEUE_STORAGE_KEY);
    return;
  }
  sessionStorage.setItem(EARLY_RUM_QUEUE_STORAGE_KEY, JSON.stringify(queue));
}

export function restoreRumEmitter(HyperDX: HyperDXActionClient): void {
  installRumEmitter(HyperDX);
}

function installRumEmitter(HyperDX: HyperDXActionClient): void {
  const clientBuildId = getClientBuildId();
  window.__lcRumPush = (type, attributes) => {
    const event: RumQueuedEvent = {
      type,
      at: performance.now(),
      visibilityState: document.visibilityState,
      attributes: { ...attributes, clientBuildId },
    };
    emitEarlyRumEvent(HyperDX, event);
    if (shouldRetainEvent(event)) {
      event.actionSent = true;
      const queue = (window.__lcRumQueue ??= []);
      queue.push(event);
      queue.splice(0, Math.max(0, queue.length - 20));
      try {
        persistEarlyQueue();
      } catch {
        /* Diagnostics should never affect app behavior. */
      }
    }
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

  if (event.actionSent !== true) {
    sendRumAction(HyperDX, event.type, event);
  }
  forwardEvent(event);
}

function sendRumAction(HyperDX: HyperDXActionClient, type: string, event: RumQueuedEvent): void {
  const actionName = type === 'spa-route-change' ? type : `early-${type}`;
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

function markEventLogged(event: RumQueuedEvent): void {
  forwardingEvents.delete(event);
  event.logged = true;
  const queue = window.__lcRumQueue;
  const index = queue?.indexOf(event) ?? -1;
  if (!queue || index === -1) {
    return;
  }
  if (event.actionSent === true) {
    queue.splice(index, 1);
  }
  try {
    persistEarlyQueue();
  } catch {
    /* Diagnostics should never affect app behavior. */
  }
}

function shouldRetainEvent(event: RumQueuedEvent): boolean {
  return isClientLogsActive() && isClientEventType(event.type) && event.logged !== true;
}

/** Hands one queued asset event to the log exporter, tracking it until the collector acks it. */
function forwardEvent(event: RumQueuedEvent): void {
  if (
    event.logged === true ||
    forwardingEvents.has(event) ||
    typeof event.type !== 'string' ||
    !isClientEventType(event.type)
  ) {
    return;
  }
  forwardingEvents.add(event);
  const accepted = recordClientEvent(
    event.type,
    sanitizeQueuedAttributes(event.attributes),
    () => markEventLogged(event),
    () => forwardingEvents.delete(event),
  );
  if (!accepted) {
    forwardingEvents.delete(event);
  }
}

/**
 * Delivers queued stale-asset events as client log records as soon as the log exporter runs,
 * independent of the RUM SDK loading. An event in flight is skipped by the SDK path; once the
 * collector accepts it, it is marked in memory and in the persisted copy so no later page logs
 * it again. An event that is never delivered stays unmarked and replays on the next load.
 */
export function forwardQueuedAssetEvents(): void {
  const queue = window.__lcRumQueue;
  if (!queue) {
    return;
  }
  queue.forEach(forwardEvent);
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
