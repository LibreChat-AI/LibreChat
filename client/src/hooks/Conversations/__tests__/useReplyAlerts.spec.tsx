import React from 'react';
import { RecoilRoot } from 'recoil';
import { QueryKeys } from 'librechat-data-provider';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { Provider as JotaiProvider, createStore } from 'jotai';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReplyReadState, UnseenConversation } from '../useUnseenConversations';
import { replyNotificationsAtom, replyNotificationSoundAtom } from '../replyNotificationSettings';
import useReplyAlerts, { requestReplyNotificationPermission } from '../useReplyAlerts';
import { consumeFocusSuppression } from '../notificationNavigation';
import useUnseenConversations from '../useUnseenConversations';
import { startupConfigKey } from '~/data-provider';
import { applyServerReplyStamp } from '~/utils';

/* The hooks barrel is circular with ~/data-provider; mocking it wholesale keeps the
   suite off that cycle while still exercising the hook's real diff/notify logic. */
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

/* The alert capabilities stay off until the deployment has answered, so every render starts
   from a loaded startup config that restricts none of them. */
const withLoadedConfig = (client: QueryClient): QueryClient => {
  client.setQueryData(startupConfigKey(false), { interface: {} });
  return client;
};

const permissionRequest = jest.fn();

class FakeNotification {
  static permission: NotificationPermission = 'granted';
  static requestPermission = permissionRequest;
  onclick: (() => void) | null = null;
  close = jest.fn();

  constructor(
    public title: string,
    public options?: { body?: string; tag?: string },
  ) {
    createdNotifications.push(this);
  }
}

const createdNotifications: FakeNotification[] = [];

const createOscillator = jest.fn();
const createGain = jest.fn();
let audioState: AudioContextState = 'running';
const resumeAudio = jest.fn().mockResolvedValue(undefined);

class FakeAudioContext {
  get state() {
    return audioState;
  }

  currentTime = 0;
  destination = {};
  resume = resumeAudio;
  createOscillator = createOscillator;
  createGain = createGain;
}

function stubOscillator() {
  createOscillator.mockImplementation(() => ({
    type: '',
    frequency: { value: 0 },
    connect: jest.fn(() => ({ connect: jest.fn() })),
    start: jest.fn(),
    stop: jest.fn(),
  }));
  createGain.mockImplementation(() => ({
    gain: {
      setValueAtTime: jest.fn(),
      exponentialRampToValueAtTime: jest.fn(),
    },
    connect: jest.fn(),
  }));
}

type Toggles = { notifications?: boolean; sound?: boolean };

const row = (
  conversationId: string,
  title: string,
  lastResponseAt = '2026-08-16T10:00:00.000Z',
  flagged = false,
): UnseenConversation => ({ conversationId, title, lastResponseAt, flagged });

/** Mirrors the hook's real feed: every unseen row's stamp is in the baseline, and seen
 *  conversations contribute stamps without appearing in the unseen set. */
const stateOf = (
  unseen: UnseenConversation[] | null,
  seenStamps: Array<[string, string]> = [],
  arrivalStamps = unseen?.map((c): [string, string] => [c.conversationId, c.lastResponseAt]) ?? [],
): ReplyReadState | null =>
  unseen === null
    ? null
    : {
        unseen,
        arrivalStamps,
        stamps: [
          ...seenStamps,
          ...unseen.map((c): [string, string] => [c.conversationId, c.lastResponseAt]),
        ],
      };

function setup(
  toggles: Toggles = {},
  initialState: ReplyReadState | null = stateOf([]),
  initialRoute = '/',
) {
  const { notifications = false, sound = false } = toggles;
  const pathnameRef = { current: initialRoute };

  const Probe = () => {
    const location = useLocation();
    pathnameRef.current = location.pathname;
    return null;
  };

  const settings = createStore();
  settings.set(replyNotificationsAtom, notifications);
  settings.set(replyNotificationSoundAtom, sound);

  const configClient = withLoadedConfig(new QueryClient());
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <RecoilRoot>
      <QueryClientProvider client={configClient}>
        <JotaiProvider store={settings}>
          <MemoryRouter initialEntries={[initialRoute]}>
            {children}
            <Probe />
          </MemoryRouter>
        </JotaiProvider>
      </QueryClientProvider>
    </RecoilRoot>
  );

  return {
    ...renderHook((state: ReplyReadState | null) => useReplyAlerts(state), {
      initialProps: initialState,
      wrapper,
    }),
    pathnameRef,
  };
}
function setupWithAggregate(toggles: Toggles = {}) {
  const { notifications = false, sound = false } = toggles;
  const settings = createStore();
  settings.set(replyNotificationsAtom, notifications);
  settings.set(replyNotificationSoundAtom, sound);

  const queryClient = withLoadedConfig(
    new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  queryClient.setQueryData([QueryKeys.allConversations, { isArchived: false }], {
    pages: [
      {
        conversations: [{ conversationId: 'user-only', title: 'User only' }],
        nextCursor: null,
      },
    ],
    pageParams: [null],
  });

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <RecoilRoot>
      <QueryClientProvider client={queryClient}>
        <JotaiProvider store={settings}>
          <MemoryRouter>{children}</MemoryRouter>
        </JotaiProvider>
      </QueryClientProvider>
    </RecoilRoot>
  );

  return {
    ...renderHook(
      () => {
        const state = useUnseenConversations();
        useReplyAlerts(state);
        return state;
      },
      { wrapper },
    ),
    queryClient,
  };
}

describe('useReplyAlerts', () => {
  let hasFocus: jest.SpyInstance;

  beforeEach(() => {
    window.localStorage.clear();
    createdNotifications.length = 0;
    permissionRequest.mockReset();
    createOscillator.mockReset();
    createGain.mockReset();
    audioState = 'running';
    resumeAudio.mockReset().mockResolvedValue(undefined);
    stubOscillator();
    FakeNotification.permission = 'granted';
    /* jsdom ships neither API; the narrowest honest stand-ins are constructor shims. */
    window.Notification = FakeNotification as unknown as typeof Notification;
    window.AudioContext = FakeAudioContext as unknown as typeof AudioContext;
    hasFocus = jest.spyOn(document, 'hasFocus').mockReturnValue(false);
  });

  afterEach(() => {
    hasFocus.mockRestore();
    Reflect.deleteProperty(window, 'Notification');
    Reflect.deleteProperty(window, 'AudioContext');
  });

  it('does not fire a burst for a backlog that predates the session', () => {
    /* Signing in with unread conversations: the first pass only records them. */
    setup({ notifications: true }, stateOf([row('convo-backlog', 'Backlog')]));

    expect(createdNotifications).toHaveLength(0);
  });

  it('waits for a resolved list before recording the backlog', async () => {
    /* A tab restored in the background renders before the conversation query settles; taking
       that empty pass as the baseline turns the whole backlog into arrivals. */
    const { rerender } = setup({ notifications: true }, null);

    act(() => {
      rerender(stateOf([row('convo-backlog', 'Backlog')]));
    });

    expect(createdNotifications).toHaveLength(0);
  });

  it('alerts again when an already-unseen conversation gets another reply', async () => {
    const { rerender } = setup(
      { notifications: true },
      stateOf([row('convo-b', 'Beta', '2026-08-16T10:00:00.000Z')]),
    );

    act(() => {
      rerender(stateOf([row('convo-b', 'Beta', '2026-08-16T10:05:00.000Z')]));
    });

    await waitFor(() => expect(createdNotifications).toHaveLength(1));
    expect(createdNotifications[0].options?.tag).toBe('convo-b');
  });

  it('stays quiet when only the title of an unseen conversation changes', () => {
    const { rerender } = setup({ notifications: true }, stateOf([row('convo-b', 'Untitled')]));

    act(() => {
      rerender(stateOf([row('convo-b', 'Auto Titled')]));
    });

    expect(createdNotifications).toHaveLength(0);
  });

  it('stays quiet when a read conversation is marked unread from another device', () => {
    /* It re-enters the unseen set carrying the same reply stamp it always had, even when the
       row has meanwhile left the cache entirely. Only a stamp that actually moved is a new
       reply. */
    const { rerender } = setup({ notifications: true }, stateOf([row('convo-b', 'Beta')]));

    act(() => {
      rerender(stateOf([]));
    });
    act(() => {
      rerender(stateOf([row('convo-b', 'Beta')]));
    });

    expect(createdNotifications).toHaveLength(0);
  });

  it('stays quiet when a never-replied conversation is flagged unread elsewhere', () => {
    /* The manual flag manufactures a reply stamp the baseline has never seen; the dot and the
       badge carry it, but "Reply ready" would name a reply that does not exist. */
    const { rerender } = setup({ notifications: true }, stateOf([]));

    act(() => {
      rerender(stateOf([row('convo-b', 'Beta', '2026-08-16T10:05:00.000Z', true)]));
    });

    expect(createdNotifications).toHaveLength(0);
  });

  it('stays quiet when a conversation seen since sign-in is marked unread elsewhere', () => {
    /* This tab never saw the conversation unseen, so only the seen rows' baseline can tell
       its re-entry, carrying the stamp it always had, apart from a new reply. */
    const { rerender } = setup(
      { notifications: true },
      stateOf([], [['convo-b', '2026-08-16T10:00:00.000Z']]),
    );

    act(() => {
      rerender(stateOf([row('convo-b', 'Beta')]));
    });

    expect(createdNotifications).toHaveLength(0);
  });

  it('still alerts for a reply to a conversation that had been read', () => {
    const { rerender } = setup({ notifications: true }, stateOf([row('convo-b', 'Beta')]));

    act(() => {
      rerender(stateOf([]));
    });
    act(() => {
      rerender(stateOf([row('convo-b', 'Beta', '2026-08-16T10:05:00.000Z')]));
    });

    expect(createdNotifications).toHaveLength(1);
  });

  it('does not claim a reply it has no enabled channel to announce', () => {
    /* Settings are per-tab snapshots; a badge-only tab claiming here would consume the reply
       while the tab that would chime or notify reads the claim and stays silent. */
    const { rerender } = setup({}, stateOf([]));

    act(() => {
      rerender(stateOf([row('convo-b', 'Beta')]));
    });

    expect(window.localStorage.getItem('replyAlerts:announced:sound')).toBeNull();
    expect(window.localStorage.getItem('replyAlerts:announced:notification')).toBeNull();
  });

  it('stays quiet for a reply another tab has already announced', () => {
    /* Every open tab polls on its own timer; without the shared claim the same reply would
       chime once per tab, seconds apart. */
    window.localStorage.setItem(
      'replyAlerts:announced:notification',
      JSON.stringify([['convo-b', '2026-08-16T10:05:00.000Z']]),
    );
    const { rerender } = setup({ notifications: true }, stateOf([row('convo-b', 'Beta')]));

    act(() => {
      rerender(stateOf([row('convo-b', 'Beta', '2026-08-16T10:05:00.000Z')]));
    });

    expect(createdNotifications).toHaveLength(0);
  });

  it('still notifies for a reply another tab has only claimed the chime for', async () => {
    /* The toggles are per-tab snapshots, so a sound-only tab and a notification-only tab can
       both be open: one channel's claim must not silence the other. */
    window.localStorage.setItem(
      'replyAlerts:announced:sound',
      JSON.stringify([['convo-b', '2026-08-16T10:05:00.000Z']]),
    );
    const { rerender } = setup({ notifications: true }, stateOf([row('convo-b', 'Beta')]));

    act(() => {
      rerender(stateOf([row('convo-b', 'Beta', '2026-08-16T10:05:00.000Z')]));
    });

    await waitFor(() => expect(createdNotifications).toHaveLength(1));
  });

  it('records its own announcement where the other tabs will look', async () => {
    const { rerender } = setup({ notifications: true }, stateOf([]));

    act(() => {
      rerender(stateOf([row('convo-b', 'Beta')]));
    });
    await waitFor(() => expect(createdNotifications).toHaveLength(1));

    const raw = window.localStorage.getItem('replyAlerts:announced:notification');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toEqual([['convo-b', '2026-08-16T10:00:00.000Z']]);
  });

  it('degrades quietly where the Notification constructor is unsupported', () => {
    /* Android Chrome exposes the API and grants permission, then throws here. */
    window.Notification = function () {
      throw new TypeError('Illegal constructor');
    } as unknown as typeof Notification;
    (window.Notification as unknown as { permission: string }).permission = 'granted';
    const { rerender } = setup({ notifications: true });

    expect(() =>
      act(() => {
        rerender(stateOf([row('convo-b', 'Beta')]));
      }),
    ).not.toThrow();
  });

  /* The claim is written before construction, so a throw must hand it back: otherwise every
     tab reads the reply as already announced and nobody ever delivers it. */
  it('leaves a reply claimable when its notification could not be created', () => {
    window.Notification = function () {
      throw new TypeError('Illegal constructor');
    } as unknown as typeof Notification;
    (window.Notification as unknown as { permission: string }).permission = 'granted';
    const { rerender } = setup({ notifications: true });

    act(() => {
      rerender(stateOf([row('convo-b', 'Beta')]));
    });

    const raw = window.localStorage.getItem('replyAlerts:announced:notification');
    const claims = raw == null ? [] : (JSON.parse(raw) as Array<[string, string]>);
    expect(claims.some(([id]) => id === 'convo-b')).toBe(false);
  });

  it('notifies for arrivals while the user is away', async () => {
    const { rerender } = setup({ notifications: true });

    act(() => {
      rerender(stateOf([row('convo-b', 'Beta')]));
    });

    await waitFor(() => expect(createdNotifications).toHaveLength(1));
    expect(createdNotifications[0].title).toBe('com_ui_reply_ready');
    expect(createdNotifications[0].options?.body).toBe('Beta');
    expect(createdNotifications[0].options?.tag).toBe('convo-b');
  });
  it('notifies for the first reply merged into a known user-only conversation', async () => {
    const { queryClient } = setupWithAggregate({ notifications: true });

    act(() => {
      applyServerReplyStamp(queryClient, 'user-only', {
        lastResponseAt: '2026-08-16T10:00:00.000Z',
      });
    });

    await waitFor(() => expect(createdNotifications).toHaveLength(1));
    expect(createdNotifications[0].options?.tag).toBe('user-only');
  });

  const otherTabLease = (at = Date.now()) =>
    window.localStorage.setItem(
      'replyAlerts:focusedAt',
      JSON.stringify({ owner: 'other-tab', at }),
    );

  it('stays quiet while another tab of the app holds focus', () => {
    /* `document.hasFocus()` answers only for this tab, so without the shared lease a
       background tab would chime over the one the user is reading. */
    otherTabLease();
    const { rerender } = setup({ notifications: true, sound: true });

    act(() => {
      rerender(stateOf([row('convo-b', 'Beta')]));
    });

    expect(createdNotifications).toHaveLength(0);
    expect(createOscillator).not.toHaveBeenCalled();
    /* Unclaimed, so the tab the user later leaves can still announce the reply. */
    expect(window.localStorage.getItem('replyAlerts:announced:notification')).toBeNull();
  });

  it('announces again once a stale focus lease has expired', async () => {
    otherTabLease(Date.now() - 120_000);
    const { rerender } = setup({ notifications: true });

    act(() => {
      rerender(stateOf([row('convo-b', 'Beta')]));
    });

    await waitFor(() => expect(createdNotifications).toHaveLength(1));
  });

  it('announces a reply held back by a lease its tab never released once it lapses', async () => {
    /* A tab killed without firing blur or pagehide leaves its lease behind. The reply that
       arrived under it is already in the baseline, so only a recheck at the lapse delivers it. */
    jest.useFakeTimers();
    try {
      otherTabLease();
      const { rerender } = setup({ notifications: true });

      act(() => {
        rerender(stateOf([row('convo-b', 'Beta')]));
      });
      expect(createdNotifications).toHaveLength(0);

      await act(async () => {
        jest.advanceTimersByTime(60_001);
      });

      expect(createdNotifications).toHaveLength(1);
      expect(createdNotifications[0].options?.tag).toBe('convo-b');
    } finally {
      jest.useRealTimers();
    }
  });

  it('announces a held reply as soon as the focused tab releases its lease', async () => {
    otherTabLease();
    const { rerender } = setup({ notifications: true });

    act(() => {
      rerender(stateOf([row('convo-b', 'Beta')]));
    });
    expect(createdNotifications).toHaveLength(0);

    act(() => {
      window.localStorage.removeItem('replyAlerts:focusedAt');
      window.dispatchEvent(new StorageEvent('storage', { key: 'replyAlerts:focusedAt' }));
    });

    await waitFor(() => expect(createdNotifications).toHaveLength(1));
  });

  it('keeps holding the reply while the focused tab keeps its lease alive', async () => {
    jest.useFakeTimers();
    try {
      otherTabLease();
      const { rerender } = setup({ notifications: true });

      act(() => {
        rerender(stateOf([row('convo-b', 'Beta')]));
      });
      await act(async () => {
        jest.advanceTimersByTime(40_000);
        otherTabLease();
        jest.advanceTimersByTime(20_001);
      });

      expect(createdNotifications).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('leaves a lease this tab does not own in place when it unmounts', () => {
    /* Focus reaches the winning tab before the losing tab's blur handler runs, so a release
       that did not check ownership would delete the lease that tab had just written. */
    otherTabLease();
    const { unmount } = setup({ notifications: true });

    unmount();

    expect(window.localStorage.getItem('replyAlerts:focusedAt')).not.toBeNull();
  });

  it.each(['promise', 'callback', 'both'] as const)(
    'announces a pending reply after a %s permission grant',
    async (api) => {
      FakeNotification.permission = 'default';
      let grant!: (value: NotificationPermission) => void;
      permissionRequest.mockImplementation((callback?: NotificationPermissionCallback) => {
        if (api === 'callback') {
          grant = (permission) => callback?.(permission);
          return undefined;
        }
        return new Promise<NotificationPermission>((resolve) => {
          grant = (permission) => {
            if (api === 'both') {
              callback?.(permission);
            }
            resolve(permission);
          };
        });
      });

      const { rerender } = setup({ notifications: true });
      await act(async () => {
        requestReplyNotificationPermission();
      });
      rerender(stateOf([row('convo-b', 'Beta')]));
      expect(createdNotifications).toHaveLength(0);

      await act(async () => {
        FakeNotification.permission = 'granted';
        grant('granted');
      });

      await waitFor(() => expect(createdNotifications).toHaveLength(1));
      expect(createdNotifications[0].options?.tag).toBe('convo-b');
    },
  );

  it('stays quiet for paginated backlog even when its server clock is ahead', async () => {
    const { rerender } = setup(
      { notifications: true },
      stateOf([row('convo-b', 'Beta', '2026-08-16T10:00:00.000Z')]),
    );

    act(() => {
      rerender(
        stateOf(
          [
            row('convo-b', 'Beta', '2026-08-16T10:00:00.000Z'),
            row('convo-old', 'Backlog', '2026-09-01T09:00:00.000Z'),
          ],
          [],
          [],
        ),
      );
    });

    expect(createdNotifications).toHaveLength(0);
  });

  it('announces a newly discovered reply even when its server clock is behind', () => {
    const { rerender } = setup(
      { notifications: true },
      stateOf([row('convo-b', 'Beta', '2026-08-16T10:00:00.000Z')]),
    );

    act(() => {
      rerender(
        stateOf([
          row('convo-b', 'Beta', '2026-08-16T10:00:00.000Z'),
          row('convo-new', 'Remote', '2026-08-16T09:00:00.000Z'),
        ]),
      );
    });

    expect(createdNotifications).toHaveLength(1);
    expect(createdNotifications[0].options?.tag).toBe('convo-new');
  });

  it('falls back to the untitled label when the conversation has no title', async () => {
    const { rerender } = setup({ notifications: true });

    act(() => {
      rerender(stateOf([row('convo-c', '')]));
    });

    await waitFor(() => expect(createdNotifications).toHaveLength(1));
    expect(createdNotifications[0].options?.body).toBe('com_ui_untitled');
  });

  it('stays quiet while the user is looking at the app', () => {
    hasFocus.mockReturnValue(true);
    const { rerender } = setup({ notifications: true });

    act(() => {
      rerender(stateOf([row('convo-b', 'Beta')]));
    });

    expect(createdNotifications).toHaveLength(0);
  });

  it('plays the chime for sound-only users without desktop notifications', () => {
    const { rerender } = setup({ sound: true });

    act(() => {
      rerender(stateOf([row('convo-b', 'Beta')]));
    });

    expect(createdNotifications).toHaveLength(0);
    expect(createOscillator).toHaveBeenCalledTimes(2);
  });

  /* A running context can still throw while the tones are being built. Nothing played, so the
     claim is handed back instead of silencing the reply in every tab. */
  it('leaves a reply claimable when its chime could not be scheduled', () => {
    createOscillator.mockImplementation(() => {
      throw new Error('output device lost');
    });
    const { rerender } = setup({ sound: true });

    act(() => {
      rerender(stateOf([row('convo-b', 'Beta')]));
    });

    const raw = window.localStorage.getItem('replyAlerts:announced:sound');
    const claims = raw == null ? [] : (JSON.parse(raw) as Array<[string, string]>);
    expect(claims.some(([id]) => id === 'convo-b')).toBe(false);
  });

  it('leaves a suspended tab’s chime claim available to a usable audio context', async () => {
    audioState = 'suspended';
    resumeAudio.mockReturnValue(Promise.withResolvers<void>().promise);
    const locked = setup({ sound: true }, stateOf([]));
    await act(async () => {
      locked.rerender(stateOf([row('shared-reply', 'Reply')]));
    });
    expect(window.localStorage.getItem('replyAlerts:announced:sound')).toBeNull();
    expect(createOscillator).not.toHaveBeenCalled();

    audioState = 'running';
    const ready = setup({ sound: true }, stateOf([]));
    act(() => {
      ready.rerender(stateOf([row('shared-reply', 'Reply')]));
    });
    expect(createOscillator).toHaveBeenCalledTimes(2);
    expect(JSON.parse(window.localStorage.getItem('replyAlerts:announced:sound') ?? '[]')).toEqual([
      ['shared-reply', '2026-08-16T10:00:00.000Z'],
    ]);
  });

  it('leaves the focus trigger alone for the conversation already on screen', async () => {
    /* That click navigates nowhere, so suppressing would swallow the one trigger that
       acknowledges the reply the user is looking at. */
    const windowFocus = jest.spyOn(window, 'focus').mockImplementation(() => undefined);
    const { rerender } = setup({ notifications: true }, stateOf([]), '/c/convo-b');

    act(() => {
      rerender(stateOf([row('convo-b', 'Beta')]));
    });
    await waitFor(() => expect(createdNotifications).toHaveLength(1));

    hasFocus.mockReturnValue(false);
    act(() => {
      createdNotifications[0].onclick?.();
    });

    expect(consumeFocusSuppression()).toBe(false);
    windowFocus.mockRestore();
  });

  it('suppresses the focus trigger when the notification leads elsewhere', async () => {
    const windowFocus = jest.spyOn(window, 'focus').mockImplementation(() => undefined);
    const { rerender } = setup({ notifications: true }, stateOf([]), '/c/convo-open');

    act(() => {
      rerender(stateOf([row('convo-b', 'Beta')]));
    });
    await waitFor(() => expect(createdNotifications).toHaveLength(1));

    hasFocus.mockReturnValue(false);
    act(() => {
      createdNotifications[0].onclick?.();
    });

    expect(consumeFocusSuppression()).toBe(true);
    windowFocus.mockRestore();
  });

  it('navigates to the conversation when the notification is clicked', async () => {
    const windowFocus = jest.spyOn(window, 'focus').mockImplementation(() => undefined);
    const { rerender, pathnameRef } = setup({ notifications: true });

    act(() => {
      rerender(stateOf([row('convo-b', 'Beta')]));
    });
    await waitFor(() => expect(createdNotifications).toHaveLength(1));

    act(() => {
      createdNotifications[0].onclick?.();
    });

    await waitFor(() => expect(pathnameRef.current).toBe('/c/convo-b'));
    expect(windowFocus).toHaveBeenCalled();
    expect(createdNotifications[0].close).toHaveBeenCalled();
    windowFocus.mockRestore();
  });
});
