/**
 * Tells every LibreChat tab whether the user is looking at one of them.
 *
 * `document.hasFocus()` only answers for the tab asking, so with two tabs open the unfocused one
 * would chime and post desktop notifications while the user reads the focused one, which is
 * exactly what the settings promise not to do. The focused tab publishes a lease through
 * localStorage, the one coordination channel already shared by these alerts, and the rest read it
 * before announcing.
 *
 * The lease is refreshed on a slow heartbeat and cleared on blur, so a tab that is killed without
 * running its cleanup stops suppressing the others within one heartbeat window rather than for
 * the rest of the session.
 */
const FOCUS_LEASE_KEY = 'replyAlerts:focusedAt';
const FOCUS_LEASE_HEARTBEAT_MS = 20_000;
const FOCUS_LEASE_TTL_MS = 60_000;

/** Identifies this tab's own lease. Focus moves before the losing tab's blur handler runs, so a
 *  release that did not check ownership would delete the lease the newly focused tab had just
 *  written, and every background tab would be free to announce until its next heartbeat. */
const tabId = Math.random().toString(36).slice(2);

type Lease = { owner: string; at: number };

const readLease = (): Lease | null => {
  try {
    const raw = window.localStorage.getItem(FOCUS_LEASE_KEY);
    if (raw == null) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const { owner, at } = parsed as Partial<Lease>;
    return typeof owner === 'string' && typeof at === 'number' && Number.isFinite(at)
      ? { owner, at }
      : null;
  } catch {
    /* Private windows, quota failures and anything a previous version wrote: fall back to
       per-tab focus, which is what this tab did before the lease existed. */
    return null;
  }
};

const writeLease = (): void => {
  try {
    window.localStorage.setItem(FOCUS_LEASE_KEY, JSON.stringify({ owner: tabId, at: Date.now() }));
  } catch {
    /* See above. */
  }
};

const clearOwnLease = (): void => {
  if (readLease()?.owner !== tabId) {
    return;
  }
  try {
    window.localStorage.removeItem(FOCUS_LEASE_KEY);
  } catch {
    /* See above. */
  }
};

/**
 * How long another tab of this origin keeps focus by its lease, or null when none holds one. This
 * tab's own lease never counts: the caller checks its own focus first, so reading one here means
 * a release did not land. A tab killed without firing
 * blur or pagehide leaves its lease behind, and nothing announces its lapse, so a caller holding
 * an arrival back for it has to schedule its own recheck.
 */
export const anotherTabLeaseRemainingMs = (): number | null => {
  const lease = readLease();
  if (lease == null || lease.owner === tabId) {
    return null;
  }
  const remaining = FOCUS_LEASE_TTL_MS - (Date.now() - lease.at);
  return remaining > 0 ? remaining : null;
};

/** Calls back whenever another tab writes or clears the lease, such as on its blur. */
export const subscribeToFocusLease = (onChange: () => void): (() => void) => {
  const listener = (event: StorageEvent) => {
    if (event.key === FOCUS_LEASE_KEY || event.key === null) {
      onChange();
    }
  };
  window.addEventListener('storage', listener);
  return () => window.removeEventListener('storage', listener);
};

/** Publishes the lease for as long as this tab holds focus. */
export const startFocusLease = (): (() => void) => {
  let heartbeat: number | null = null;

  const stopHeartbeat = () => {
    if (heartbeat !== null) {
      window.clearInterval(heartbeat);
      heartbeat = null;
    }
  };

  const hold = () => {
    writeLease();
    if (heartbeat === null) {
      heartbeat = window.setInterval(writeLease, FOCUS_LEASE_HEARTBEAT_MS);
    }
  };

  const release = () => {
    stopHeartbeat();
    clearOwnLease();
  };

  if (document.hasFocus()) {
    hold();
  }

  window.addEventListener('focus', hold);
  window.addEventListener('blur', release);
  window.addEventListener('pagehide', release);

  return () => {
    window.removeEventListener('focus', hold);
    window.removeEventListener('blur', release);
    window.removeEventListener('pagehide', release);
    release();
  };
};
