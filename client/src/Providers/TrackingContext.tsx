import { createContext, useContext, useLayoutEffect, useMemo, useRef } from 'react';
import axios from 'axios';
import { v4 as uuid } from 'uuid';
import {
  safelyTrack,
  browserProductFactSchema,
  noopProductTracker,
  getProductTrackingConfig,
  getProductTrackingHeaders,
} from 'librechat-data-provider';
import type {
  BrowserProductFact,
  ProductIdentity,
  ProductTracker,
  ProductTrackingContext,
} from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type { SessionRecord } from '~/utils/productSession';
import {
  ACTIVITY_THROTTLE_MS,
  createProductSession,
  PRODUCT_SESSION_KEY_PREFIX,
} from '~/utils/productSession';
import { useGetStartupConfig } from '~/data-provider';
import { getBrowserTabId } from '~/utils/drafts';

const TrackingContext = createContext<ProductTracker<BrowserProductFact>>(noopProductTracker);
const SessionContext = createContext<() => ProductTrackingContext | undefined>(() => undefined);

/**
 * The host mounts this provider and supplies identity and delivery. Session state is scoped to
 * that identity. Tracking starts only when `GET /api/config` reports it enabled, which requires
 * a server tracker factory. Without this provider, requests carry no correlation headers.
 */
export function TrackingProvider({
  track,
  identity,
  enabled: available = true,
  children,
}: {
  track: ProductTracker<BrowserProductFact>;
  identity?: ProductIdentity;
  enabled?: boolean;
  children: ReactNode;
}) {
  /** Read through a ref, so a host that passes a new `track` on each render keeps its session. */
  const trackRef = useRef(track);
  useLayoutEffect(() => {
    trackRef.current = track;
  }, [track]);
  const dispatch = useMemo<ProductTracker<BrowserProductFact>>(
    () => (fact, context) => {
      const parsed = browserProductFactSchema.safeParse(fact);
      if (parsed.success) return trackRef.current(parsed.data, context);
    },
    [],
  );
  const { data: startup } = useGetStartupConfig();
  const enabled = available && startup?.productTracking?.enabled === true;
  const { shareAcrossTabs, idleTimeoutMs, activityIntervalMs } = getProductTrackingConfig({
    productTracking: startup?.productTracking,
  }).session;
  const key = `${PRODUCT_SESSION_KEY_PREFIX}${JSON.stringify([identity?.userId, identity?.tenantId])}`;
  const holder = useMemo(
    () => ({
      key,
      enabled,
      shareAcrossTabs,
      idleTimeoutMs,
      session: undefined as ReturnType<typeof createProductSession> | undefined,
      ready: Promise.resolve<ProductTrackingContext | undefined>(undefined),
    }),
    [key, enabled, shareAcrossTabs, idleTimeoutMs],
  );

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
        dispatch,
        {
          name: 'librechat.session.activity',
          feature: 'session',
          sessionId: record.sessionId,
          startedAt: new Date(record.startedAt).toISOString(),
          lastActivityAt: new Date(record.lastActivityAt).toISOString(),
        },
        { sessionId: record.sessionId },
      );
    /** Any tab, visible or hidden, can report; the shared record lets only one report each marker. */
    const checkpoint = () => {
      void session.report(emit).catch(() => {});
    };
    /** The page can unload before a lock is granted, so the last report does not wait for one. */
    const flush = () => session.reportNow(emit);
    /** Mobile browsers often skip `pagehide`, but they hide the page first. */
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    let lastActivityAt = 0;
    const onActivity = (event: Event) => {
      if (!event.isTrusted || document.visibilityState === 'hidden') return;
      const now = Date.now();
      if (now - lastActivityAt < ACTIVITY_THROTTLE_MS) return;
      lastActivityAt = now;
      void session.activity().catch(() => {});
    };
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'popstate'] as const;
    for (const event of events) window.addEventListener(event, onActivity, { passive: true });
    const timer = window.setInterval(
      checkpoint,
      Math.min(activityIntervalMs, holder.idleTimeoutMs),
    );
    window.addEventListener('pagehide', flush);
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
      flush();
      session.stop();
      holder.session = undefined;
      window.clearInterval(timer);
      axios.interceptors.request.eject(interceptor);
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
      for (const event of events) window.removeEventListener(event, onActivity);
    };
  }, [activityIntervalMs, holder, dispatch]);

  const value = useMemo<ProductTracker<BrowserProductFact>>(
    () =>
      enabled
        ? async (fact, context) => {
            const session = holder.session;
            if (!session) return;
            if (!context) await holder.ready;
            if (holder.session !== session) return;
            safelyTrack(dispatch, fact, context ?? session.peek());
          }
        : noopProductTracker,
    [enabled, holder, dispatch],
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
