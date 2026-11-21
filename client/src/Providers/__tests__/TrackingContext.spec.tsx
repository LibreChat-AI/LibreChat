import { useEffect } from 'react';
import axios from 'axios';
import { render, act } from '@testing-library/react';
import type { BrowserProductFact } from 'librechat-data-provider';
import type { InternalAxiosRequestConfig } from 'axios';
import { TrackingProvider, useProductTracking } from '../TrackingContext';

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: { productTracking: { enabled: true } } }),
}));

function Observer({ fact }: { fact: BrowserProductFact }) {
  const track = useProductTracking();
  useEffect(() => {
    void track(fact);
  }, [fact, track]);
  return <button>{'Chat remains usable'}</button>;
}

const submission: BrowserProductFact = {
  name: 'librechat.chat.message.submitted',
  feature: 'chat',
  submissionId: 'aef33490-7e1a-4786-9ac6-d45dd28ca281',
  kind: 'send',
  model: 'private-model',
  provider: 'private-endpoint',
  agentId: 'private__model___Sender',
};

it('normalizes chat labels before invoking the browser host callback', async () => {
  const track = jest.fn();
  render(
    <TrackingProvider track={track}>
      <Observer fact={submission} />
    </TrackingProvider>,
  );
  await act(async () => {});
  expect(track).toHaveBeenCalledTimes(1);
  expect(track.mock.calls[0][0]).toMatchObject({
    model: 'custom',
    provider: 'custom',
    agentId: undefined,
  });
  expect(JSON.stringify(track.mock.calls)).not.toContain('private');
});

it('drops malformed facts without interrupting the browser action', async () => {
  const track = jest.fn();
  const malformed = { ...submission, arguments: 'private' };
  const view = render(
    <TrackingProvider track={track}>
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
    <TrackingProvider track={jest.fn()}>
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
    <TrackingProvider track={track}>
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

it('reports a marker shared by two tabs once', async () => {
  const one = jest.fn();
  const two = jest.fn();
  const identity = { userId: 'user-1', tenantId: 'tenant-1' };
  render(
    <TrackingProvider track={one} identity={identity}>
      <span />
    </TrackingProvider>,
  );
  render(
    <TrackingProvider track={two} identity={identity}>
      <span />
    </TrackingProvider>,
  );
  await act(async () => {});
  await pagehide();
  expect(activityFacts(one, two)).toHaveLength(1);
});

it('starts a new session and flushes the old one when the identity changes', async () => {
  const track = jest.fn();
  const view = render(
    <TrackingProvider track={track} identity={{ userId: 'user-1' }}>
      <span />
    </TrackingProvider>,
  );
  await act(async () => {});
  const before = (await sentHeaders('/api/convos'))?.get(SESSION_HEADER);
  view.rerender(
    <TrackingProvider track={track} identity={{ userId: 'user-2' }}>
      <span />
    </TrackingProvider>,
  );
  await act(async () => {});
  const after = (await sentHeaders('/api/convos'))?.get(SESSION_HEADER);
  expect(after).toMatch(/^[0-9a-f-]{36}$/);
  expect(after).not.toBe(before);
  await pagehide();
  expect(activityFacts(track).map((fact) => fact.sessionId)).toEqual([before, after]);
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
      <TrackingProvider track={track}>
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

it('keeps one session when the host passes a new track on each render', async () => {
  const calls: unknown[] = [];
  const view = render(
    <TrackingProvider track={(fact) => void calls.push(fact)}>
      <span />
    </TrackingProvider>,
  );
  await act(async () => {});
  for (let i = 0; i < 3; i++) {
    view.rerender(
      <TrackingProvider track={(fact) => void calls.push(fact)}>
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
      <TrackingProvider track={track}>
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

it('reports when the page becomes hidden', async () => {
  const track = jest.fn();
  render(
    <TrackingProvider track={track}>
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
});
