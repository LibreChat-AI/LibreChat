import { useEffect } from 'react';
import axios from 'axios';
import { render, act } from '@testing-library/react';
import type {
  BrowserProductFact,
  BrowserProductEvent,
  BrowserProductSink,
} from 'librechat-data-provider';
import type { InternalAxiosRequestConfig } from 'axios';
import type { ReactNode } from 'react';
import { TrackingProvider, useProductTracking } from '../TrackingContext';
import { AuthContext } from '~/hooks/AuthContext';

let mockEnabled = true;
jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: { productTracking: { enabled: mockEnabled } } }),
}));

/** Records each delivered event as `(fact, context, event)`, and each lifecycle call in `log`. */
function sinkFor(track: jest.Mock | ((...args: unknown[]) => void), log: string[] = []) {
  const sink: BrowserProductSink = {
    deliver: (event) => {
      log.push(`deliver:${event.fact.name}`);
      track(event.fact, event.context, event);
    },
    flush: (reason) => void log.push(`flush:${reason}`),
    resume: () => void log.push('resume'),
    discard: () => void log.push('discard'),
  };
  return sink;
}

type AuthValue = NonNullable<React.ContextType<typeof AuthContext>>;

function SignedIn({ user, children }: { user?: AuthValue['user']; children: ReactNode }) {
  return <AuthContext.Provider value={{ user } as AuthValue}>{children}</AuthContext.Provider>;
}

function Observer({ fact }: { fact: BrowserProductFact }) {
  const track = useProductTracking();
  useEffect(() => {
    void track(fact);
  }, [fact, track]);
  return <button>{'Chat remains usable'}</button>;
}

const opened: BrowserProductFact = {
  name: 'librechat.session.activity',
  feature: 'session',
  sessionId: 'aef33490-7e1a-4786-9ac6-d45dd28ca281',
  startedAt: '2026-01-01T00:00:00.000Z',
  lastActivityAt: '2026-01-01T00:05:00.000Z',
};

it('passes valid facts to the browser host callback once', async () => {
  const track = jest.fn();
  render(
    <TrackingProvider sink={sinkFor(track)}>
      <Observer fact={opened} />
    </TrackingProvider>,
  );
  await act(async () => {});
  expect(track).toHaveBeenCalledTimes(1);
  expect(track.mock.calls[0][0]).toEqual(opened);
});

it('drops malformed facts without interrupting the browser action', async () => {
  const track = jest.fn();
  const malformed = { ...opened, arguments: 'private' };
  const view = render(
    <TrackingProvider sink={sinkFor(track)}>
      <Observer fact={malformed} />
    </TrackingProvider>,
  );
  await act(async () => {});
  expect(track).not.toHaveBeenCalled();
  expect(view.getByRole('button', { name: 'Chat remains usable' })).toBeInTheDocument();
});

const SESSION_HEADER = 'x-librechat-product-session-id';

beforeEach(() => {
  window.localStorage.clear();
});

/** Sends a request through the global axios interceptors and returns its headers. */
async function sentHeaders(url: string, headers: Record<string, string> = {}) {
  let sent: InternalAxiosRequestConfig | undefined;
  await axios.get(url, {
    headers,
    adapter: async (config) => {
      sent = config;
      return { data: null, status: 200, statusText: 'OK', headers: {}, config };
    },
  });
  return sent?.headers;
}

function activityFacts(...tracks: jest.Mock[]) {
  return tracks
    .flatMap((track) => track.mock.calls)
    .map(([fact]) => fact)
    .filter((fact) => fact.name === 'librechat.session.activity');
}

async function pagehide() {
  await act(async () => {
    window.dispatchEvent(new Event('pagehide'));
  });
}

it('adds the session header only to same-origin API requests without replacing one', async () => {
  render(
    <TrackingProvider sink={sinkFor(jest.fn())}>
      <span />
    </TrackingProvider>,
  );
  await act(async () => {});
  const sessionId = (await sentHeaders('/api/convos'))?.get(SESSION_HEADER);
  expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
  expect((await sentHeaders('/assets/logo.svg'))?.has(SESSION_HEADER)).toBe(false);
  expect((await sentHeaders('https://other.example/api/convos'))?.has(SESSION_HEADER)).toBe(false);
  const explicit = 'd79706cc-4ddf-4cf7-b99a-333755af9be8';
  expect(
    (await sentHeaders('/api/convos', { [SESSION_HEADER]: explicit }))?.get(SESSION_HEADER),
  ).toBe(explicit);
});

it('flushes unreported activity on pagehide once', async () => {
  const track = jest.fn();
  render(
    <TrackingProvider sink={sinkFor(track)}>
      <span />
    </TrackingProvider>,
  );
  await act(async () => {});
  expect(activityFacts(track)).toEqual([]);
  await pagehide();
  const [fact] = activityFacts(track);
  expect(activityFacts(track)).toHaveLength(1);
  expect(fact).toMatchObject({ feature: 'session', startedAt: fact.lastActivityAt });
  expect(track.mock.calls[0][1]).toEqual({ sessionId: fact.sessionId });
  await pagehide();
  expect(activityFacts(track)).toHaveLength(1);
});

const userOne = { id: 'user-1', tenantId: 'tenant-1' } as AuthValue['user'];
const userTwo = { id: 'user-2', tenantId: 'tenant-1' } as AuthValue['user'];

it('builds the event envelope with the signed-in identity and the device', async () => {
  const track = jest.fn();
  render(
    <SignedIn user={userOne}>
      <TrackingProvider sink={sinkFor(track)}>
        <span />
      </TrackingProvider>
    </SignedIn>,
  );
  await act(async () => {});
  await pagehide();
  const event: BrowserProductEvent = track.mock.calls[0][2];
  expect(event).toEqual({
    version: 1,
    eventId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    occurredAt: expect.any(String),
    producer: 'browser',
    identity: { userId: 'user-1', tenantId: 'tenant-1' },
    context: { sessionId: event.fact.sessionId },
    device: { type: expect.any(String), browser: expect.any(String), os: expect.any(String) },
    fact: expect.objectContaining({ name: 'librechat.session.activity' }),
  });
});

it('reports a marker shared by two tabs once', async () => {
  const one = jest.fn();
  const two = jest.fn();
  render(
    <SignedIn user={userOne}>
      <TrackingProvider sink={sinkFor(one)}>
        <span />
      </TrackingProvider>
    </SignedIn>,
  );
  render(
    <SignedIn user={userOne}>
      <TrackingProvider sink={sinkFor(two)}>
        <span />
      </TrackingProvider>
    </SignedIn>,
  );
  await act(async () => {});
  await pagehide();
  expect(activityFacts(one, two)).toHaveLength(1);
});

it('flushes the old session to the old sink, with the old identity, when the user changes', async () => {
  const oldTrack = jest.fn();
  const newTrack = jest.fn();
  const oldLog: string[] = [];
  const view = render(
    <SignedIn user={userOne}>
      <TrackingProvider sink={sinkFor(oldTrack, oldLog)}>
        <span />
      </TrackingProvider>
    </SignedIn>,
  );
  await act(async () => {});
  const before = (await sentHeaders('/api/convos'))?.get(SESSION_HEADER);
  view.rerender(
    <SignedIn user={userTwo}>
      <TrackingProvider sink={sinkFor(newTrack)}>
        <span />
      </TrackingProvider>
    </SignedIn>,
  );
  await act(async () => {});
  const after = (await sentHeaders('/api/convos'))?.get(SESSION_HEADER);
  expect(after).toMatch(/^[0-9a-f-]{36}$/);
  expect(after).not.toBe(before);
  expect(oldLog).toEqual(['deliver:librechat.session.activity', 'flush:session']);
  expect(oldTrack.mock.calls[0][2]).toMatchObject({
    identity: { userId: 'user-1' },
    fact: { sessionId: before },
  });
  await pagehide();
  expect(newTrack.mock.calls[0][2]).toMatchObject({
    identity: { userId: 'user-2' },
    fact: { sessionId: after },
  });
});

it('asks the sink to send after the final checkpoint on pagehide and unmount', async () => {
  const log: string[] = [];
  const view = render(
    <TrackingProvider sink={sinkFor(jest.fn(), log)}>
      <span />
    </TrackingProvider>,
  );
  await act(async () => {});
  await pagehide();
  await act(async () => {
    window.dispatchEvent(new Event('pageshow'));
  });
  view.unmount();
  expect(log).toEqual([
    'deliver:librechat.session.activity',
    'flush:pagehide',
    'resume',
    'flush:unmount',
  ]);
});

it('discards without a final checkpoint when tracking is turned off', async () => {
  const log: string[] = [];
  const view = render(
    <TrackingProvider sink={sinkFor(jest.fn(), log)}>
      <span />
    </TrackingProvider>,
  );
  await act(async () => {});
  try {
    mockEnabled = false;
    view.rerender(
      <TrackingProvider sink={sinkFor(jest.fn(), log)}>
        <span />
      </TrackingProvider>,
    );
    await act(async () => {});
    expect(log).toEqual(['discard']);
    expect((await sentHeaders('/api/convos'))?.has(SESSION_HEADER)).toBe(false);
  } finally {
    mockEnabled = true;
  }
});

it('contains a sink that throws', async () => {
  const sink: BrowserProductSink = {
    deliver: () => {
      throw new Error('offline');
    },
    flush: () => {
      throw new Error('offline');
    },
  };
  const view = render(
    <TrackingProvider sink={sink}>
      <Observer fact={opened} />
    </TrackingProvider>,
  );
  await act(async () => {});
  await pagehide();
  expect(() => view.unmount()).not.toThrow();
});

it('reports on pagehide in the same task when locks are granted in a later task', async () => {
  /** Browsers grant a Web Lock in a queued task, which an unloading page may never run. */
  const request = jest.fn(
    (_name: string, work: () => unknown) =>
      new Promise((resolve) => setTimeout(() => resolve(work()), 0)),
  );
  Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });
  try {
    const track = jest.fn();
    render(
      <TrackingProvider sink={sinkFor(track)}>
        <span />
      </TrackingProvider>,
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(request).toHaveBeenCalled();
    expect(activityFacts(track)).toEqual([]);
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    expect(activityFacts(track)).toHaveLength(1);
  } finally {
    delete (navigator as { locks?: unknown }).locks;
  }
});

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
}

it('keeps one session when the host passes a new sink on each render', async () => {
  const calls: unknown[] = [];
  const view = render(
    <TrackingProvider sink={sinkFor((fact) => void calls.push(fact))}>
      <span />
    </TrackingProvider>,
  );
  await act(async () => {});
  for (let i = 0; i < 3; i++) {
    view.rerender(
      <TrackingProvider sink={sinkFor((fact) => void calls.push(fact))}>
        <span />
      </TrackingProvider>,
    );
    await act(async () => {});
  }
  expect(calls).toEqual([]);
  await pagehide();
  expect(calls).toHaveLength(1);
});

it('does not mark activity when it mounts in a hidden tab', async () => {
  setVisibility('hidden');
  try {
    const track = jest.fn();
    render(
      <TrackingProvider sink={sinkFor(track)}>
        <span />
      </TrackingProvider>,
    );
    await act(async () => {});
    await pagehide();
    expect(activityFacts(track)).toEqual([]);
  } finally {
    setVisibility('visible');
  }
});

it('reports, then asks the sink to send, when the page becomes hidden', async () => {
  const track = jest.fn();
  const log: string[] = [];
  render(
    <TrackingProvider sink={sinkFor(track, log)}>
      <span />
    </TrackingProvider>,
  );
  await act(async () => {});
  setVisibility('hidden');
  try {
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(activityFacts(track)).toHaveLength(1);
  } finally {
    setVisibility('visible');
  }
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(log).toEqual(['deliver:librechat.session.activity', 'flush:hidden', 'resume']);
});
