import { createContext, useContext, useLayoutEffect, useMemo } from 'react';
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
import { createProductSession } from '~/utils/productSession';
import { useGetStartupConfig } from '~/data-provider';
import { getBrowserTabId } from '~/utils/drafts';

const TrackingContext = createContext<ProductTracker<BrowserProductFact>>(noopProductTracker);
const SessionContext = createContext<() => ProductTrackingContext | undefined>(() => undefined);

/** The host supplies identity and delivery. Session state is scoped to that identity. */
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
  const dispatch = useMemo<ProductTracker<BrowserProductFact>>(
    () => (fact, context) => {
      const parsed = browserProductFactSchema.safeParse(fact);
      if (parsed.success) return track(parsed.data, context);
    },
    [track],
  );
  const { data: startup } = useGetStartupConfig();
  const enabled = available && startup?.productTracking?.enabled === true;
  const sessionConfig = getProductTrackingConfig({
    productTracking: startup?.productTracking,
  }).session;
  const shareAcrossTabs = sessionConfig?.shareAcrossTabs ?? true;
  const idleTimeoutMs = sessionConfig?.idleTimeoutMs ?? 1800000;
  const activityIntervalMs = sessionConfig?.activityIntervalMs ?? 60000;
  const key = `lc-product-session:${JSON.stringify([identity?.userId, identity?.tenantId])}`;
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
    holder.ready = session.activity().catch(() => undefined);
    let recorded: string | undefined;
    const checkpoint = () => {
      const snapshot = session.snapshot();
      if (!snapshot) return;
      const marker = `${snapshot.sessionId}:${snapshot.lastActivityAt}`;
      if (marker === recorded) return;
      recorded = marker;
      safelyTrack(
        dispatch,
        {
          name: 'librechat.session.activity',
          feature: 'session',
          sessionId: snapshot.sessionId,
          startedAt: new Date(snapshot.startedAt).toISOString(),
          lastActivityAt: new Date(snapshot.lastActivityAt).toISOString(),
        },
        { sessionId: snapshot.sessionId },
      );
    };
    const onActivity = (event: Event) => {
      if (!event.isTrusted || document.visibilityState === 'hidden') return;
      void session.activity().catch(() => {});
    };
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'popstate'] as const;
    for (const event of events) window.addEventListener(event, onActivity, { passive: true });
    const timer = window.setInterval(
      checkpoint,
      Math.min(activityIntervalMs, holder.idleTimeoutMs),
    );
    window.addEventListener('pagehide', checkpoint);
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
      checkpoint();
      session.stop();
      holder.session = undefined;
      window.clearInterval(timer);
      axios.interceptors.request.eject(interceptor);
      window.removeEventListener('pagehide', checkpoint);
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
