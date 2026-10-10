import { useRef, useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import type { ReplyReadState } from './useUnseenConversations';
import { startFocusLease, subscribeToFocusLease, anotherTabLeaseRemainingMs } from './focusLease';
import { suppressFocusAcknowledgement } from './notificationNavigation';
import { useReplyAlertPreferences } from './replyNotificationSettings';
import { useLocalize } from '~/hooks';

let sharedContext: AudioContext | null = null;

/**
 * Opens the shared output, resuming it if the browser parked it.
 *
 * Alerts only fire while the document is unfocused, so a context first opened there has no user
 * activation behind it and browsers leave it suspended. The settings toggle calls this from its
 * change handler instead, which is a gesture, and every later chime reuses what it unlocked.
 */
const openAudioContext = (): AudioContext | null => {
  if (typeof window.AudioContext !== 'function') {
    return null;
  }
  sharedContext = sharedContext ?? new AudioContext();
  if (sharedContext.state === 'suspended') {
    void sharedContext.resume().catch(() => undefined);
  }
  return sharedContext;
};

/** Called from the sound toggle's change handler, the one gesture the audio output can use. */
export const unlockReplyNotificationSound = (): void => {
  try {
    openAudioContext();
  } catch {
    /* No output device, or the context limit is already reached. */
  }
};

/**
 * Synthesized rather than shipped as an asset: two short tones need no binary, no request, and
 * no cache entry. Failure is always silent, because a missed chime is not worth an error toast.
 */
const playChime = (arrivals: ReplyReadState['unseen']) => {
  const claimed: ReplyReadState['unseen'] = [];
  try {
    const context = openAudioContext();
    if (!context || context.state !== 'running') {
      return;
    }
    for (const conversation of arrivals) {
      if (
        claimReplyAnnouncement('sound', conversation.conversationId, conversation.lastResponseAt)
      ) {
        claimed.push(conversation);
      }
    }
    if (claimed.length === 0) {
      return;
    }
    const start = context.currentTime;
    const tones: Array<[number, number]> = [
      [880, 0],
      [1174.66, 0.12],
    ];

    for (const [frequency, offset] of tones) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start + offset);
      gain.gain.exponentialRampToValueAtTime(0.12, start + offset + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.25);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start + offset);
      oscillator.stop(start + offset + 0.3);
    }
  } catch {
    /* Autoplay policy or an unavailable output device. Nothing played, so the claims taken
       above are handed back rather than left to silence these replies in every tab. */
    for (const conversation of claimed) {
      releaseReplyAnnouncement('sound', conversation.conversationId, conversation.lastResponseAt);
    }
  }
};

const canNotify = (): boolean => 'Notification' in window && Notification.permission === 'granted';

type AlertChannel = 'sound' | 'notification';

const ANNOUNCED_KEY: Record<AlertChannel, string> = {
  sound: 'replyAlerts:announced:sound',
  notification: 'replyAlerts:announced:notification',
};
const ANNOUNCED_LIMIT = 100;

/**
 * Claims one reply announcement for one channel across every open tab.
 *
 * Each tab polls on its own timer and keeps its own baseline, so without a shared record the
 * same reply would chime once per tab, seconds apart, and stack duplicate notifications.
 * localStorage is the coordination channel because it is synchronous and shared per origin:
 * the first tab to reach an arrival records its stamp and the rest read it before announcing.
 * A dead-heat between two timers can still double one alert, which was the failure mode
 * everywhere before; unavailable storage (private windows, quota) falls back to announcing
 * locally for the same reason.
 *
 * Per channel, because two tabs are not necessarily duplicates of each other: notification
 * permission is asked for per tab and can be granted in one and denied in another, and a
 * settings change reaches other tabs only once its storage event lands. A single shared claim
 * would let whichever tab reached the reply first silence the other channel entirely.
 */
const claimReplyAnnouncement = (
  channel: AlertChannel,
  conversationId: string,
  lastResponseAt: string,
): boolean => {
  try {
    const raw = window.localStorage.getItem(ANNOUNCED_KEY[channel]);
    const parsed: unknown = raw != null ? JSON.parse(raw) : [];
    const entries = (Array.isArray(parsed) ? parsed : []) as Array<[string, string]>;
    if (entries.some(([id, stamp]) => id === conversationId && stamp === lastResponseAt)) {
      return false;
    }
    const next: Array<[string, string]> = [
      [conversationId, lastResponseAt],
      ...entries.filter(([id]) => id !== conversationId),
    ];
    window.localStorage.setItem(
      ANNOUNCED_KEY[channel],
      JSON.stringify(next.slice(0, ANNOUNCED_LIMIT)),
    );
    return true;
  } catch {
    return true;
  }
};

/**
 * Gives back a claim whose announcement never happened, so another tab, or this one on a
 * later arrival pass, can still deliver it. Removes the entry only while it still names this
 * exact stamp: a newer reply claimed in the meantime belongs to whoever claimed it.
 */
const releaseReplyAnnouncement = (
  channel: AlertChannel,
  conversationId: string,
  lastResponseAt: string,
): void => {
  try {
    const raw = window.localStorage.getItem(ANNOUNCED_KEY[channel]);
    const parsed: unknown = raw != null ? JSON.parse(raw) : [];
    const entries = (Array.isArray(parsed) ? parsed : []) as Array<[string, string]>;
    const next = entries.filter(
      ([id, stamp]) => !(id === conversationId && stamp === lastResponseAt),
    );
    if (next.length !== entries.length) {
      window.localStorage.setItem(ANNOUNCED_KEY[channel], JSON.stringify(next));
    }
  } catch {
    /* Storage unavailable: the claim could not have been written either. */
  }
};

const notificationPermission = (): NotificationPermission | null =>
  'Notification' in window ? Notification.permission : null;

/** Notified when a pending permission prompt settles; see `requestReplyNotificationPermission`. */
const permissionListeners = new Set<() => void>();

const subscribeToPermission = (listener: () => void): (() => void) => {
  permissionListeners.add(listener);
  return () => {
    permissionListeners.delete(listener);
  };
};

/**
 * Requests desktop-notification permission on behalf of the settings toggle.
 *
 * Must be called from the toggle's change handler: that is the user gesture browsers require.
 * An effect on the persisted toggle fires on load without one, and Chrome answers gestureless
 * requests by denying them, which locks the origin out of notifications until the user digs
 * into site settings.
 *
 * The answer is published rather than dropped: a reply can arrive while the prompt is still
 * open, and nothing else would tell the hook that this tab may now notify.
 */
export const requestReplyNotificationPermission = (): void => {
  if (!('Notification' in window) || Notification.permission !== 'default') {
    return;
  }
  let settled = false;
  const publishPermission = () => {
    if (settled) {
      return;
    }
    settled = true;
    for (const listener of permissionListeners) {
      listener();
    }
  };
  /* Callback-only browsers return undefined; dual implementations must publish only once. */
  const request = Notification.requestPermission(publishPermission);
  void request?.then(publishPermission, publishPermission);
};

/**
 * Announces replies that landed while the user was away.
 *
 * Alerts are suppressed whenever the document has focus: the sidebar dot already covers the case
 * where the user is looking at the app, and interrupting them there would be noise. The first
 * pass only records what is already unseen, so signing in with a backlog does not fire a burst.
 */
export default function useReplyAlerts(state: ReplyReadState | null) {
  const { notificationsEnabled, soundEnabled } = useReplyAlertPreferences();
  const localize = useLocalize();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  /** Read from the click handler, which outlives the render that created it. */
  const locationRef = useRef(pathname);
  locationRef.current = pathname;
  /** Reply stamps, not just ids: a second reply to a chat that is already unseen is its own
   *  arrival, and keying on membership alone would swallow it. */
  const knownRef = useRef<Map<string, string> | null>(null);
  const unlockedRef = useRef(false);
  /** Arrivals held back only by another tab's focus lease, keyed to the stamp they arrived with.
   *  They are already in the baseline, so without this a lease left by a killed tab would retire
   *  them unannounced; the recheck below replays them once that lease lapses. */
  const leaseHeldRef = useRef<Map<string, string>>(new Map());
  const leaseTimerRef = useRef<number | null>(null);
  const [leaseRecheck, setLeaseRecheck] = useState(0);
  useEffect(() => {
    /* A tab that blurs normally clears its lease well before the lapse, and the reply it held
       back is due as soon as nobody is looking. */
    const unsubscribe = subscribeToFocusLease(() => {
      if (leaseHeldRef.current.size > 0) {
        setLeaseRecheck((count) => count + 1);
      }
    });
    return () => {
      unsubscribe();
      if (leaseTimerRef.current !== null) {
        window.clearTimeout(leaseTimerRef.current);
      }
    };
  }, []);

  /* Published for the other tabs of this origin, and read by them below: a reply announced by
     a background tab while the user reads a focused one is exactly the interruption the focus
     guard exists to prevent, and `document.hasFocus()` cannot see across tabs. */
  useEffect(() => startFocusLease(), []);

  /* The prompt the settings toggle opens settles long after its click, and nothing else would
     tell this hook that the tab may now notify. */
  const [permission, setPermission] = useState(notificationPermission);
  useEffect(() => subscribeToPermission(() => setPermission(notificationPermission())), []);

  /* The setting survives a reload but the audio output does not, and the toggle gesture that
     opened it last session is not replayed. Without this the first chime of a restored session
     would try to open the output while the tab is unfocused, which browsers refuse, and every
     later one would stay silent until the user toggled the setting off and on. The first click
     or keystroke anywhere in the app is gesture enough. */
  useEffect(() => {
    if (!soundEnabled || unlockedRef.current) {
      return;
    }
    const unlock = () => {
      if (unlockedRef.current) {
        return;
      }
      unlockedRef.current = true;
      unlockReplyNotificationSound();
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, [soundEnabled]);

  useEffect(() => {
    /* Null means no list has resolved yet, which is not an empty backlog. Initializing from it
       would let the real backlog arrive as a burst of alerts on a tab restored in the
       background, where the focus guard below never gets a chance to suppress them. */
    if (state === null) {
      return;
    }
    const { unseen, stamps, arrivalStamps } = state;

    const known = knownRef.current;
    const priorStamps = new Map(known ?? []);
    /* The baseline records the seen conversations too, and stamps are retained rather than
       replaced when a row leaves the cache. A conversation that has been read, whether during
       this session or before it started, keeps the reply stamp it always had, and if another
       device later marks it unread it re-enters the unseen set carrying that same stamp.
       Without the baseline that re-entry would look like a new reply and announce one that
       never happened. */
    const next = known === null ? new Map<string, string>() : known;
    /* A prompt this tab opened is still unanswered, so a reply arriving now cannot be
       announced yet. Baselining it would retire the arrival before the answer lands and lose
       the first notification the user enabled the setting for; the subscription below re-runs
       this pass once the prompt settles. */
    const awaitingPermission = notificationsEnabled && permission === 'default';
    if (!awaitingPermission) {
      for (const [conversationId, lastResponseAt] of stamps) {
        next.set(conversationId, lastResponseAt);
      }
    }
    knownRef.current = next;

    if (known === null) {
      return;
    }

    /* A local first-page merge must update a row already known without a reply stamp; a server
       first-page success may also provide evidence for a newly discovered reply. Pagination and
       newly mounted filter variants expose backlog rather than arrivals. */
    const discovered = new Map(arrivalStamps);
    const held = leaseHeldRef.current;
    const arrivals = unseen.filter(
      (conversation) =>
        conversation.conversationId &&
        !conversation.flagged &&
        (held.get(conversation.conversationId) === conversation.lastResponseAt ||
          (priorStamps.has(conversation.conversationId)
            ? priorStamps.get(conversation.conversationId) !== conversation.lastResponseAt
            : discovered.get(conversation.conversationId) === conversation.lastResponseAt)),
    );
    held.clear();
    if (arrivals.length === 0 || document.hasFocus()) {
      return;
    }
    /* "Away" means away from LibreChat, not away from this tab: a second tab holding focus is
       the user reading the app, and the sidebar dot already covers them there. */
    const leaseRemainingMs = anotherTabLeaseRemainingMs();
    if (leaseRemainingMs !== null) {
      for (const conversation of arrivals) {
        held.set(conversation.conversationId, conversation.lastResponseAt);
      }
      if (leaseTimerRef.current !== null) {
        window.clearTimeout(leaseTimerRef.current);
      }
      leaseTimerRef.current = window.setTimeout(() => {
        leaseTimerRef.current = null;
        setLeaseRecheck((count) => count + 1);
      }, leaseRemainingMs + 1);
      return;
    }

    /* Only a tab that will actually announce may claim, and only for the channel it will
       announce on. A tab with both channels off still runs this hook for the badge, and a tab
       whose notification permission was denied still holds the setting on; letting either
       claim would consume the reply while producing neither chime nor notification. The focus
       guard stays first, so a focused tab never claims a reply it would not announce either. */
    const willNotify = notificationsEnabled && canNotify();
    if (!soundEnabled && !willNotify) {
      return;
    }

    /* The usable audio context claims every covered arrival, so a suspended tab cannot silence
       the same reply in another tab that can actually schedule playback. */
    if (soundEnabled) {
      playChime(arrivals);
    }

    if (!willNotify) {
      return;
    }

    const announced = arrivals.filter((conversation) =>
      claimReplyAnnouncement(
        'notification',
        conversation.conversationId,
        conversation.lastResponseAt,
      ),
    );

    for (const conversation of announced) {
      try {
        /* Android Chrome exposes the API and the permission but throws here: notifications
           have to come from the service worker there. A missed alert degrades quietly rather
           than throwing out of the effect. */
        const notification = new Notification(localize('com_ui_reply_ready'), {
          body: conversation.title || localize('com_ui_untitled'),
          tag: conversation.conversationId,
        });
        const target = `/c/${conversation.conversationId}`;
        notification.onclick = () => {
          /* Only when the click is leaving for a different conversation, where the focus would
             otherwise read as the user catching up on whatever is still open behind it. A
             notification for the conversation already on screen navigates nowhere, and
             suppressing there would swallow the one trigger that acknowledges it. */
          if (locationRef.current !== target) {
            suppressFocusAcknowledgement();
          }
          navigate(target);
          window.focus();
          notification.close();
        };
      } catch {
        /* Constructor unsupported on this platform, or the notification was rejected. The
           claim was taken before construction, so it is handed back rather than left to
           silence this reply in every tab for good. */
        releaseReplyAnnouncement(
          'notification',
          conversation.conversationId,
          conversation.lastResponseAt,
        );
      }
    }
  }, [state, soundEnabled, notificationsEnabled, permission, leaseRecheck, localize, navigate]);
}
