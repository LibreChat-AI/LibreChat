import { createContext, useContext, useLayoutEffect, useMemo, useRef } from 'react';
import axios from 'axios';
import { v4 as uuid } from 'uuid';
import {
  safelyTrack,
  toProductIdentity,
  noopProductTracker,
  browserProductFactSchema,
  getProductTrackingConfig,
  getProductTrackingHeaders,
} from 'librechat-data-provider';
import type {
  ProductTracker,
  ProductIdentity,
  BrowserProductFact,
  BrowserProductSink,
  ProductFlushReason,
  ProductTrackingContext,
} from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type { SessionRecord } from '~/utils/productSession';
import {
  ACTIVITY_THROTTLE_MS,
  createProductSession,
  PRODUCT_SESSION_KEY_PREFIX,
} from '~/utils/productSession';
import { getProductDevice } from '~/utils/productDevice';
import { useGetStartupConfig } from '~/data-provider';
import { AuthContext } from '~/hooks/AuthContext';
import { getBrowserTabId } from '~/utils/drafts';

const TrackingContext = createContext<ProductTracker<BrowserProductFact>>(noopProductTracker);
const SessionContext = createContext<() => ProductTrackingContext | undefined>(() => undefined);

type SinkRef = { readonly current: BrowserProductSink };

/** A host sink must never interrupt the page. */
function callSink(call: () => void) {
  try {
    call();
  } catch {
    // Delivery is best effort.
  }
}

/** Builds the event envelope for one identity and passes it to the current sink. */
function createDelivery(
  sinkRef: SinkRef,
  identity: ProductIdentity,
): ProductTracker<BrowserProductFact> {
  return (fact, context) => {
    const parsed = browserProductFactSchema.safeParse(fact);
    if (!parsed.success) return;
    const device = getProductDevice();
    return sinkRef.current.deliver({
      version: 1,
      eventId: uuid(),
      occurredAt: new Date().toISOString(),
      producer: 'browser',
      identity,
      ...(context ? { context } : {}),
      ...(device ? { device } : {}),
      fact: parsed.data,
    });
  };
}

/**
 * The host mounts this provider and supplies delivery. LibreChat builds each event, with the
 * identity of the signed-in user and tenant and the device, and scopes the session to that
 * identity. Tracking starts only when `GET /api/config` reports it enabled, which requires a
 * server sink. Without this provider, requests carry no correlation headers.
 *
 * Lifecycle calls to the sink come after the final activity checkpoint for that moment:
 * `flush('hidden' | 'pagehide')` when the page is hidden or unloads, `resume()` when it is
 * visible again, `flush('session')` when the user, tenant or session settings change, and
 * `flush('unmount')` when the provider unmounts. When tracking is turned off, `discard()` takes
 * the place of the final checkpoint and flush. A sink that the host replaces receives no
 * further calls.
 */
export function TrackingProvider({
  sink,
  enabled: available = true,
  children,
}: {
  sink: BrowserProductSink;
  enabled?: boolean;
  children: ReactNode;
}) {
  /** Read through a ref, so a host that passes a new sink on each render keeps its session. */
  const sinkRef = useRef(sink);
  useLayoutEffect(() => {
    sinkRef.current = sink;
  }, [sink]);
  const user = useContext(AuthContext)?.user;
  const userId = user?.id;
  const tenantId = user?.tenantId;
  const { data: startup } = useGetStartupConfig();
  const enabled = available && startup?.productTracking?.enabled === true;
  /** Read at teardown: a session that tracking turned off is discarded; any other end flushes. */
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  /** Declared before the session effect, so its cleanup runs first when the provider unmounts. */
  const mountedRef = useRef(false);
  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const { shareAcrossTabs, idleTimeoutMs, activityIntervalMs } = getProductTrackingConfig({
    productTracking: startup?.productTracking,
  }).session;
  const holder = useMemo(() => {
    const identity = toProductIdentity(userId, tenantId);
    return {
      key: `${PRODUCT_SESSION_KEY_PREFIX}${JSON.stringify([identity.userId, identity.tenantId])}`,
      enabled,
      shareAcrossTabs,
      idleTimeoutMs,
      deliver: createDelivery(sinkRef, identity),
      session: undefined as ReturnType<typeof createProductSession> | undefined,
      ready: Promise.resolve<ProductTrackingContext | undefined>(undefined),
    };
  }, [userId, tenantId, enabled, shareAcrossTabs, idleTimeoutMs]);

  useLayoutEffect(() => {
    if (!holder.enabled) return;
    let storage: Storage | undefined;
    try {
      storage = holder.shareAcrossTabs ? window.localStorage : window.sessionStorage;
    } catch {
      // Restricted storage falls back to this tab's in-memory session.
    }
    const session = createProductSession({
      key: holder.shareAcrossTabs ? holder.key : `${holder.key}:${getBrowserTabId()}`,
      storage,
      idleTimeoutMs: holder.idleTimeoutMs,
      now: Date.now,
      createId: uuid,
      exclusive:
        holder.shareAcrossTabs && storage && navigator.locks
          ? (work) => navigator.locks.request(holder.key, work)
          : undefined,
    });
    holder.session = session;
    /** Mounting is not user activity in a hidden tab, as `onActivity` also ignores hidden tabs. */
    holder.ready =
      document.visibilityState === 'hidden'
        ? Promise.resolve(session.peek())
        : session.activity().catch(() => undefined);
    const emit = (record: SessionRecord) =>
      safelyTrack(
        holder.deliver,
        {
          name: 'librechat.session.activity',
          feature: 'session',
          sessionId: record.sessionId,
          startedAt: new Date(record.startedAt).toISOString(),
          lastActivityAt: new Date(record.lastActivityAt).toISOString(),
        },
        { sessionId: record.sessionId },
      );
    const notify = (reason: ProductFlushReason) => callSink(() => sinkRef.current.flush?.(reason));
    const resume = () => callSink(() => sinkRef.current.resume?.());
    /** Any tab, visible or hidden, can report; the shared record lets only one report each marker. */
    const checkpoint = () => {
      void session.report(emit).catch(() => {});
    };
    /** The page can unload before a lock is granted, so the last report does not wait for one. */
    const flush = () => session.reportNow(emit);
    /** Mobile browsers often skip `pagehide`, but they hide the page first. */
    const onVisibility = () => {
      if (document.visibilityState !== 'hidden') return resume();
      flush();
      notify('hidden');
    };
    const onPageHide = () => {
      flush();
      notify('pagehide');
    };
    let lastActivityAt = 0;
    const onActivity = (event: Event) => {
      if (!event.isTrusted || document.visibilityState === 'hidden') return;
      const now = Date.now();
      if (now - lastActivityAt < ACTIVITY_THROTTLE_MS) return;
      lastActivityAt = now;
      void session.activity().catch(() => {});
    };
    if (document.visibilityState === 'hidden') notify('hidden');
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'popstate'] as const;
    for (const event of events) window.addEventListener(event, onActivity, { passive: true });
    const timer = window.setInterval(
      checkpoint,
      Math.min(activityIntervalMs, holder.idleTimeoutMs),
    );
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', resume);
    document.addEventListener('visibilitychange', onVisibility);
    const interceptor = axios.interceptors.request.use((config) => {
      try {
        const base = new URL(config.baseURL ?? '.', window.location.href);
        const url = new URL(config.url ?? '', base);
        if (url.origin !== window.location.origin || !url.pathname.includes('/api/')) return config;
        for (const [name, value] of Object.entries(getProductTrackingHeaders(session.peek()))) {
          if (!config.headers.has(name)) config.headers.set(name, value);
        }
      } catch {
        // Analytics must never change whether an application request is sent.
      }
      return config;
    });
    return () => {
      window.clearInterval(timer);
      axios.interceptors.request.eject(interceptor);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', resume);
      document.removeEventListener('visibilitychange', onVisibility);
      for (const event of events) window.removeEventListener(event, onActivity);
      const turnedOff = mountedRef.current && !enabledRef.current;
      if (!turnedOff) flush();
      session.stop();
      holder.session = undefined;
      if (turnedOff) {
        callSink(() => sinkRef.current.discard?.());
        return;
      }
      notify(mountedRef.current ? 'session' : 'unmount');
    };
  }, [activityIntervalMs, holder]);

  const value = useMemo<ProductTracker<BrowserProductFact>>(
    () =>
      enabled
        ? async (fact, context) => {
            const session = holder.session;
            if (!session) return;
            if (!context) await holder.ready;
            if (holder.session !== session) return;
            safelyTrack(holder.deliver, fact, context ?? session.peek());
          }
        : noopProductTracker,
    [enabled, holder],
  );
  const context = useMemo(
    () => () => {
      if (!enabled) return undefined;
      try {
        return holder.session?.activityNow();
      } catch {
        return undefined;
      }
    },
    [enabled, holder],
  );
  return (
    <SessionContext.Provider value={context}>
      <TrackingContext.Provider value={value}>{children}</TrackingContext.Provider>
    </SessionContext.Provider>
  );
}

export function useProductTracking() {
  return useContext(TrackingContext);
}

/** Called for explicit submissions; ordinary background requests only read session context. */
export function useProductTrackingContext() {
  return useContext(SessionContext);
}
