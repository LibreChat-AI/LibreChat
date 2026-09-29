import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRecoilValue } from 'recoil';
import { Button } from '@librechat/client';
import { useIsMutating } from '@tanstack/react-query';
import type { FrontendRelease } from './release';
import { confirmRelease, readRelease, resolvePollInterval } from './release';
import { canLeave, hasRegisteredReloadGuard } from './activity';
import { useGetStartupConfig } from '~/data-provider';
import { getClientBuildId } from '~/lib/rum/build';
import { useLocalize } from '~/hooks';
import store from '~/store';

const ATTEMPT_KEY = 'lc-frontend-release-attempt';
const AUTO_BUDGET_KEY = 'lc-frontend-release-auto-budget';
const LEADER_LEASE_MS = 20000;
const IDLE_MS = 60000;
const NOTICE_MESSAGES = {
  hint: 'com_ui_frontend_update_hint',
  active: 'com_ui_frontend_update_deferred',
  unavailable: 'com_ui_frontend_update_unavailable',
  cooldown: 'com_ui_frontend_update_cooldown',
} as const;

type ReloadAttempt = { from: string; to: string; at: number };

function readAttempt(): ReloadAttempt | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(ATTEMPT_KEY) || 'null');
    return typeof value?.from === 'string' &&
      typeof value?.to === 'string' &&
      typeof value?.at === 'number'
      ? value
      : null;
  } catch {
    return null;
  }
}

function reloadPage(): void {
  window.location.reload();
}

export default function FrontendUpdateNotice({ reload = reloadPage }: { reload?: () => void }) {
  const clientBuildId = getClientBuildId();
  const localize = useLocalize();
  // The policy is read from the existing query; never fetch /api/config to establish a build ID.
  const { data: config } = useGetStartupConfig({ enabled: false });
  const autoReload = config?.interface?.frontendUpdates?.autoReload === true;
  const pollIntervalMs = resolvePollInterval(config?.interface?.frontendUpdates?.pollIntervalMs);
  const anySubmitting = useRecoilValue(store.anySubmittingSelector);
  const mutations = useIsMutating();
  const busyRef = useRef(anySubmitting || mutations > 0);
  busyRef.current = anySubmitting || mutations > 0;
  const [expected, setExpected] = useState<FrontendRelease | null>(null);
  const [lastInteraction, setLastInteraction] = useState(Date.now());
  const [checking, setChecking] = useState(false);
  const [noticeState, setNoticeState] = useState<'hint' | 'active' | 'unavailable' | 'cooldown'>(
    'hint',
  );
  const expectedRef = useRef(expected);
  expectedRef.current = expected;
  const checkingRef = useRef(false);
  const mismatchAt = useRef<number | null>(null);
  const releaseUrl = useMemo(() => new URL('version.json', document.baseURI), []);

  useEffect(() => {
    if (!/^assets-[a-f0-9]{64}$/.test(clientBuildId)) {
      return;
    }
    const previous = readAttempt();
    if (previous && previous.from !== clientBuildId) {
      window.__lcRumPush?.('frontend-release-reload-outcome', {
        clientBuildId,
        expectedBuildId: previous.to,
        outcome: previous.to === clientBuildId ? 'updated' : 'different-release',
      });
      try {
        sessionStorage.removeItem(ATTEMPT_KEY);
      } catch {
        /* optional diagnostics */
      }
    } else if (previous && previous.from === clientBuildId) {
      window.__lcRumPush?.('frontend-release-reload-outcome', {
        clientBuildId,
        expectedBuildId: previous.to,
        outcome: 'same-build',
      });
    }
  }, [clientBuildId]);

  useEffect(() => {
    if (!/^assets-[a-f0-9]{64}$/.test(clientBuildId)) {
      return;
    }
    let cancelled = false;
    const id = Math.random().toString(36).slice(2);
    const channel =
      typeof BroadcastChannel === 'function'
        ? new BroadcastChannel(`lc-frontend-release:${releaseUrl.pathname}`)
        : null;
    let leaderId: string | null = null;
    let leaderAt = 0;
    let lastCheckAt = 0;
    let lastPublished = '';
    const publish = (release: FrontendRelease) => {
      if (cancelled) return;
      if (release.buildId === clientBuildId) {
        lastPublished = '';
        mismatchAt.current = null;
        setExpected(null);
        return;
      }
      const identity = `${release.buildId}:${release.releaseRevision ?? ''}`;
      if (lastPublished === identity) return;
      lastPublished = identity;
      setNoticeState('hint');
      mismatchAt.current ??= Date.now();
      setExpected(release);
      window.__lcRumPush?.('frontend-release-mismatch', {
        clientBuildId,
        expectedBuildId: release.buildId,
        mismatchAgeMs: Date.now() - mismatchAt.current,
        releaseRevision: release.releaseRevision ?? -1,
      });
      channel?.postMessage({ type: 'candidate', buildId: release.buildId });
    };
    const check = async () => {
      if (cancelled || checkingRef.current) return;
      checkingRef.current = true;
      try {
        const release = await confirmRelease(releaseUrl);
        if (release) publish(release);
      } finally {
        checkingRef.current = false;
      }
    };
    const requestCheck = (force = false) => {
      if (document.visibilityState === 'hidden') return;
      if (leaderId && leaderId !== id && Date.now() - leaderAt < LEADER_LEASE_MS) {
        channel?.postMessage({ type: 'request' });
        return;
      }
      leaderId = id;
      leaderAt = Date.now();
      channel?.postMessage({ type: 'leader', id });
      if (!force && Date.now() - lastCheckAt < 10000) return;
      lastCheckAt = Date.now();
      void check();
    };
    if (channel) {
      channel.onmessage = (event: MessageEvent) => {
        const message = event.data;
        if (message?.type === 'leader' && typeof message.id === 'string' && message.id !== id) {
          if (
            message.id === leaderId ||
            !leaderId ||
            Date.now() - leaderAt >= LEADER_LEASE_MS ||
            message.id < leaderId
          ) {
            leaderId = message.id;
            leaderAt = Date.now();
          }
        } else if (message?.type === 'request' && leaderId === id) {
          requestCheck();
        } else if (
          message?.type === 'candidate' &&
          /^assets-[a-f0-9]{64}$/.test(message.buildId) &&
          message.buildId !== clientBuildId
        ) {
          // A channel message is a hint only: this tab verifies it from the static release.
          void check();
        }
      };
      channel.postMessage({ type: 'request' });
    }
    const initial = setTimeout(() => requestCheck(), 500 + Math.random() * 500);
    const interval = setInterval(() => requestCheck(), pollIntervalMs);
    const heartbeat = setInterval(() => {
      if (leaderId === id && document.visibilityState !== 'hidden') {
        leaderAt = Date.now();
        channel?.postMessage({ type: 'leader', id });
      }
    }, LEADER_LEASE_MS / 2);
    const resume = () => requestCheck(true);
    const visible = () => {
      if (document.visibilityState === 'visible') resume();
    };
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('focus', resume);
    window.addEventListener('pageshow', resume);
    window.addEventListener('online', resume);
    return () => {
      cancelled = true;
      clearTimeout(initial);
      clearInterval(interval);
      clearInterval(heartbeat);
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('focus', resume);
      window.removeEventListener('pageshow', resume);
      window.removeEventListener('online', resume);
      channel?.close();
    };
  }, [clientBuildId, pollIntervalMs, releaseUrl]);

  useEffect(() => {
    const interact = () => setLastInteraction(Date.now());
    window.addEventListener('keydown', interact, true);
    window.addEventListener('pointerdown', interact, true);
    return () => {
      window.removeEventListener('keydown', interact, true);
      window.removeEventListener('pointerdown', interact, true);
    };
  }, []);

  const attemptReload = useCallback(
    async (action: 'automatic' | 'manual') => {
      const target = expectedRef.current;
      if (!target || checking) return;
      setChecking(true);
      try {
        if (!canLeave(busyRef.current) || store.hasInMemoryQueuedTurns()) {
          setNoticeState('active');
          window.__lcRumPush?.('frontend-release-deferred', {
            expectedBuildId: target.buildId,
            reason: 'active-work',
          });
          return;
        }
        const latest = await readRelease(releaseUrl);
        if (
          latest?.buildId !== target.buildId ||
          latest.releaseRevision !== target.releaseRevision
        ) {
          setNoticeState('unavailable');
          return;
        }
        if (!canLeave(busyRef.current) || store.hasInMemoryQueuedTurns()) {
          setNoticeState('active');
          return;
        }
        const previous = readAttempt();
        if (
          previous?.from === clientBuildId &&
          previous?.to === target.buildId &&
          Date.now() - previous.at < 600000
        ) {
          setNoticeState('cooldown');
          return;
        }
        if (action === 'automatic') {
          try {
            const recent = JSON.parse(sessionStorage.getItem(AUTO_BUDGET_KEY) || '[]');
            if (!Array.isArray(recent)) return;
            const attempts = recent.filter(
              (at) => typeof at === 'number' && Date.now() - at < 3600000,
            );
            if (attempts.length >= 2) return;
            sessionStorage.setItem(AUTO_BUDGET_KEY, JSON.stringify([...attempts, Date.now()]));
          } catch {
            return;
          }
        }
        try {
          sessionStorage.setItem(
            ATTEMPT_KEY,
            JSON.stringify({ from: clientBuildId, to: target.buildId, at: Date.now() }),
          );
        } catch {
          setNoticeState('unavailable');
          return;
        }
        window.__lcRumPush?.('frontend-release-reload', {
          clientBuildId,
          expectedBuildId: target.buildId,
          mismatchAgeMs: mismatchAt.current == null ? 0 : Date.now() - mismatchAt.current,
          action,
        });
        reload();
      } finally {
        setChecking(false);
      }
    },
    [checking, clientBuildId, releaseUrl, reload],
  );

  useEffect(() => {
    if (!expected || !autoReload || checking) return;
    const tick = () => {
      const previous = readAttempt();
      if (
        previous &&
        previous.from === clientBuildId &&
        previous.to === expected.buildId &&
        Date.now() - previous.at < 600000
      )
        return;
      if (
        !hasRegisteredReloadGuard() ||
        (document.visibilityState !== 'hidden' && Date.now() - lastInteraction < IDLE_MS) ||
        !canLeave(busyRef.current) ||
        store.hasInMemoryQueuedTurns()
      )
        return;
      void attemptReload('automatic');
    };
    const timer = setInterval(tick, 2000);
    return () => clearInterval(timer);
  }, [autoReload, expected, checking, lastInteraction, clientBuildId, attemptReload]);

  if (!expected) return null;
  return (
    <aside
      role="status"
      className="fixed bottom-4 left-4 right-4 z-[1001] mx-auto max-w-md rounded-lg border border-border-medium bg-surface-primary p-4 text-text-primary shadow-lg"
      aria-label={localize('com_ui_frontend_update_available')}
    >
      <p>{localize('com_ui_frontend_update_available')}</p>
      <p className="mt-1 text-sm text-text-secondary">{localize(NOTICE_MESSAGES[noticeState])}</p>
      <Button
        type="button"
        variant="submit"
        disabled={checking}
        onClick={() => void attemptReload('manual')}
        className="mt-3"
      >
        {localize('com_ui_reload_page')}
      </Button>
    </aside>
  );
}
