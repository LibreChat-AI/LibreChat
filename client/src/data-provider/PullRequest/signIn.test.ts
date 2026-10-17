import { QueryKeys } from 'librechat-data-provider';
import { QueryClient } from '@tanstack/react-query';
import type { TPullRequestConnection } from 'librechat-data-provider';
import {
  PULL_REQUEST_CONNECT_POLL_MS,
  PULL_REQUEST_SETTLED_GRACE_MS,
  announceOAuthSettled,
  stopPullRequestSignIns,
  pullRequestSignInSession,
  watchPullRequestSignIn,
} from './signIn';
import { endPullRequestSession, setPullRequestSessionOwner } from './queries';

const mockGetConnection = jest.fn();

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getPullRequestConnection: (...args: unknown[]) => mockGetConnection(...args),
    },
  };
});

/** jsdom has no BroadcastChannel; this one delivers between instances of one name, as tabs do. */
class FakeBroadcastChannel {
  static open = new Set<FakeBroadcastChannel>();
  private listeners = new Set<(event: MessageEvent) => void>();
  constructor(readonly name: string) {
    FakeBroadcastChannel.open.add(this);
  }

  addEventListener(_type: 'message', listener: (event: MessageEvent) => void) {
    this.listeners.add(listener);
  }

  postMessage(data: unknown) {
    for (const other of FakeBroadcastChannel.open) {
      if (other !== this && other.name === this.name) {
        other.listeners.forEach((listener) => listener({ data } as MessageEvent));
      }
    }
  }

  close() {
    FakeBroadcastChannel.open.delete(this);
  }
}

const connection = (connected: boolean): TPullRequestConnection => ({
  configured: true,
  provider: 'github',
  connected,
});

const MINUTE = 60_000;

const setup = () => {
  const client = new QueryClient({
    logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
  });
  const invalidate = jest.spyOn(client, 'invalidateQueries');
  return { client, invalidate };
};

const pass = (ms: number) => jest.advanceTimersByTimeAsync(ms);
const focus = async () => {
  window.dispatchEvent(new Event('focus'));
  await pass(0);
};

describe('watchPullRequestSignIn', () => {
  beforeAll(() => {
    (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = FakeBroadcastChannel;
  });

  afterAll(() => {
    delete (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel;
  });

  beforeEach(() => {
    jest.useFakeTimers();
    mockGetConnection.mockReset();
    mockGetConnection.mockResolvedValue(connection(false));
  });

  afterEach(() => {
    stopPullRequestSignIns();
    jest.useRealTimers();
  });

  it('refreshes pull requests and stops once the account shows connected', async () => {
    const { client, invalidate } = setup();
    watchPullRequestSignIn(client, {
      startedIn: pullRequestSignInSession(),
      expiresAt: Date.now() + 10 * MINUTE,
    });

    await pass(PULL_REQUEST_CONNECT_POLL_MS);
    expect(mockGetConnection).toHaveBeenCalledTimes(1);
    /** The session's first status. */
    expect(invalidate).toHaveBeenCalledTimes(1);

    mockGetConnection.mockResolvedValue(connection(true));
    await focus();
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenLastCalledWith([QueryKeys.conversationPullRequest]);
    expect(client.getQueryData([QueryKeys.pullRequestConnection])).toEqual(connection(true));

    const asked = mockGetConnection.mock.calls.length;
    await pass(5 * MINUTE);
    await focus();
    expect(mockGetConnection).toHaveBeenCalledTimes(asked);
  });

  it('asks at once when the sign-in page announces it settled, however the popup reads', async () => {
    const { client, invalidate } = setup();
    watchPullRequestSignIn(client, {
      startedIn: pullRequestSignInSession(),
      expiresAt: Date.now() + 10 * MINUTE,
    });
    mockGetConnection.mockResolvedValue(connection(true));

    /** Before any timer is due: only the announcement can explain this ask. */
    announceOAuthSettled({ outcome: 'succeeded' });
    await pass(0);
    expect(mockGetConnection).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith([QueryKeys.conversationPullRequest]);
  });

  it('asks again after the announcement instead of joining a request sent before it', async () => {
    const { client, invalidate } = setup();
    watchPullRequestSignIn(client, {
      startedIn: pullRequestSignInSession(),
      expiresAt: Date.now() + 10 * MINUTE,
    });
    /** A focus asks while the callback has not stored the grant yet; that answer is slow. */
    let answerEarly: (status: TPullRequestConnection) => void = () => undefined;
    mockGetConnection.mockImplementationOnce(
      () => new Promise((resolve) => (answerEarly = resolve)),
    );
    await focus();
    expect(mockGetConnection).toHaveBeenCalledTimes(1);

    mockGetConnection.mockResolvedValue(connection(true));
    invalidate.mockClear();
    announceOAuthSettled({ outcome: 'succeeded' });
    await pass(0);
    answerEarly(connection(false));
    await pass(0);
    expect(mockGetConnection).toHaveBeenCalledTimes(2);
    expect(client.getQueryData([QueryKeys.pullRequestConnection])).toEqual(connection(true));
    expect(invalidate).toHaveBeenCalledWith([QueryKeys.conversationPullRequest]);
  });

  it('backs off asking on a timer, so a sign-in left open costs few requests', async () => {
    const { client } = setup();
    watchPullRequestSignIn(client, {
      startedIn: pullRequestSignInSession(),
      expiresAt: Date.now() + 60 * MINUTE,
    });

    await pass(15_000);
    /** Responsive while a sign-in is likely: 2, 6 and 14 seconds in. */
    expect(mockGetConnection).toHaveBeenCalledTimes(3);
    await pass(60 * MINUTE - 15_000);
    /** At most one ask per 30 seconds after that: about 120 in an hour, not 1,800. */
    expect(mockGetConnection.mock.calls.length).toBeLessThanOrEqual(122);
  });

  it('stops watching, focus and announcements included, when the flow expires', async () => {
    const { client } = setup();
    watchPullRequestSignIn(client, {
      startedIn: pullRequestSignInSession(),
      expiresAt: Date.now() + 1 * MINUTE,
    });
    await pass(1 * MINUTE);
    const asked = mockGetConnection.mock.calls.length;

    await pass(5 * MINUTE);
    await focus();
    announceOAuthSettled({ outcome: 'succeeded' });
    await pass(0);
    expect(mockGetConnection).toHaveBeenCalledTimes(asked);
  });

  it('keeps reading past expiry after its own sign-in settled, until a read succeeds', async () => {
    const { client, invalidate } = setup();
    watchPullRequestSignIn(client, {
      startedIn: pullRequestSignInSession(),
      expiresAt: Date.now() + 1 * MINUTE,
      flowId: 'flow-a',
    });
    await pass(59_000);
    /** Settled just before expiry, and the read it prompts fails. */
    mockGetConnection.mockRejectedValue(new Error('offline'));
    announceOAuthSettled({ outcome: 'succeeded', flowId: 'flow-a' });
    await pass(2_000);

    mockGetConnection.mockResolvedValue({ ...connection(true), flowId: 'flow-a' });
    invalidate.mockClear();
    await focus();
    expect(invalidate).toHaveBeenCalledWith([QueryKeys.conversationPullRequest]);
    const asked = mockGetConnection.mock.calls.length;
    await pass(PULL_REQUEST_SETTLED_GRACE_MS);
    expect(mockGetConnection).toHaveBeenCalledTimes(asked);
  });

  it('still reads a settlement announced just after the flow expired', async () => {
    const { client, invalidate } = setup();
    watchPullRequestSignIn(client, {
      startedIn: pullRequestSignInSession(),
      expiresAt: Date.now() + 1 * MINUTE,
      flowId: 'flow-a',
    });
    await pass(1 * MINUTE + 10_000);
    /** The callback was accepted just before expiry and announces only now. */
    mockGetConnection.mockResolvedValue({ ...connection(true), flowId: 'flow-a' });
    invalidate.mockClear();
    announceOAuthSettled({ outcome: 'succeeded', flowId: 'flow-a' });
    await pass(PULL_REQUEST_CONNECT_POLL_MS);
    expect(invalidate).toHaveBeenCalledWith([QueryKeys.conversationPullRequest]);
    const asked = mockGetConnection.mock.calls.length;
    await pass(10 * MINUTE);
    expect(mockGetConnection).toHaveBeenCalledTimes(asked);
  });

  it('still hears a failure that settles after the grant already showed connected', async () => {
    const { client, invalidate } = setup();
    watchPullRequestSignIn(client, {
      startedIn: pullRequestSignInSession(),
      expiresAt: Date.now() + 60 * MINUTE,
      flowId: 'flow-a',
    });
    /** A poll sees the grant the callback stored before its final check. */
    mockGetConnection.mockResolvedValue({ ...connection(true), flowId: 'flow-a' });
    await focus();
    const polled = mockGetConnection.mock.calls.length;
    await pass(10 * MINUTE);
    expect(mockGetConnection).toHaveBeenCalledTimes(polled);

    /** The callback then removes it and lands on the error page for this flow. */
    mockGetConnection.mockResolvedValue(connection(false));
    invalidate.mockClear();
    announceOAuthSettled({ outcome: 'failed', flowId: 'flow-a' });
    await pass(0);
    expect(mockGetConnection).toHaveBeenCalledTimes(polled + 1);
    expect(invalidate).toHaveBeenCalledWith([QueryKeys.conversationPullRequest]);
  });

  it('gives up a settled sign-in whose status cannot be read once the grace passes', async () => {
    const { client } = setup();
    watchPullRequestSignIn(client, {
      startedIn: pullRequestSignInSession(),
      expiresAt: Date.now() + 1 * MINUTE,
      flowId: 'flow-a',
    });
    mockGetConnection.mockRejectedValue(new Error('offline'));
    announceOAuthSettled({ outcome: 'succeeded', flowId: 'flow-a' });
    await pass(1 * MINUTE + PULL_REQUEST_SETTLED_GRACE_MS);
    const asked = mockGetConnection.mock.calls.length;
    await pass(10 * MINUTE);
    await focus();
    expect(mockGetConnection).toHaveBeenCalledTimes(asked);
  });

  it("drops a replaced watch's late answer, leaving the new watch to speak", async () => {
    const { client, invalidate } = setup();
    let answerA: (status: TPullRequestConnection) => void = () => undefined;
    mockGetConnection.mockImplementationOnce(() => new Promise((resolve) => (answerA = resolve)));
    watchPullRequestSignIn(client, {
      startedIn: pullRequestSignInSession(),
      expiresAt: Date.now() + 60 * MINUTE,
      flowId: 'flow-a',
    });
    await focus();
    /** Flow B replaces A while A's read is still out. */
    watchPullRequestSignIn(client, {
      startedIn: pullRequestSignInSession(),
      expiresAt: Date.now() + 60 * MINUTE,
      flowId: 'flow-b',
    });
    invalidate.mockClear();
    answerA({ ...connection(true), flowId: 'flow-a' });
    await pass(0);
    expect(invalidate).not.toHaveBeenCalledWith([QueryKeys.conversationPullRequest]);
  });

  it('ends the watch when another account signs in without a logout', async () => {
    const { client } = setup();
    setPullRequestSessionOwner('first');
    watchPullRequestSignIn(client, {
      startedIn: pullRequestSignInSession(),
      expiresAt: Date.now() + 60 * MINUTE,
      flowId: 'flow-a',
    });
    setPullRequestSessionOwner('first');
    await focus();
    const asked = mockGetConnection.mock.calls.length;
    expect(asked).toBeGreaterThan(0);

    setPullRequestSessionOwner('second');
    await pass(10 * MINUTE);
    await focus();
    expect(mockGetConnection).toHaveBeenCalledTimes(asked);
  });

  it("keeps watching when another flow's grant shows up, and stops on its own", async () => {
    const { client, invalidate } = setup();
    mockGetConnection.mockResolvedValue({ ...connection(true), flowId: 'flow-a' });
    watchPullRequestSignIn(client, {
      startedIn: pullRequestSignInSession(),
      expiresAt: Date.now() + 10 * MINUTE,
      flowId: 'flow-b',
    });
    announceOAuthSettled({ outcome: 'succeeded' });
    await pass(0);
    expect(invalidate).toHaveBeenCalledTimes(1);

    /** Still watching: the second sign-in replacing the first grant is a change. */
    mockGetConnection.mockResolvedValue({ ...connection(true), flowId: 'flow-b' });
    await focus();
    expect(invalidate).toHaveBeenCalledTimes(2);
    const asked = mockGetConnection.mock.calls.length;
    await pass(5 * MINUTE);
    expect(mockGetConnection).toHaveBeenCalledTimes(asked);
  });

  it('keeps watching through a failed status read', async () => {
    const { client, invalidate } = setup();
    mockGetConnection.mockRejectedValueOnce(new Error('500'));
    watchPullRequestSignIn(client, {
      startedIn: pullRequestSignInSession(),
      expiresAt: Date.now() + 10 * MINUTE,
    });
    await pass(PULL_REQUEST_CONNECT_POLL_MS);

    mockGetConnection.mockResolvedValue(connection(true));
    await focus();
    expect(invalidate).toHaveBeenCalledWith([QueryKeys.conversationPullRequest]);
  });

  it('refreshes pull requests when the account it watches turns out disconnected', async () => {
    const { client, invalidate } = setup();
    mockGetConnection.mockResolvedValueOnce(connection(true));
    watchPullRequestSignIn(client, {
      startedIn: pullRequestSignInSession(),
      expiresAt: Date.now() + 10 * MINUTE,
    });
    await focus();
    expect(invalidate).toHaveBeenCalledTimes(1);

    /** Removed elsewhere while this window still watches a new sign-in. */
    mockGetConnection.mockResolvedValue(connection(false));
    watchPullRequestSignIn(client, {
      startedIn: pullRequestSignInSession(),
      expiresAt: Date.now() + 10 * MINUTE,
    });
    await focus();
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it('replaces the watch on an earlier sign-in when another starts', async () => {
    const { client } = setup();
    watchPullRequestSignIn(client, {
      startedIn: pullRequestSignInSession(),
      expiresAt: Date.now() + 10 * MINUTE,
    });
    watchPullRequestSignIn(client, {
      startedIn: pullRequestSignInSession(),
      expiresAt: Date.now() + 10 * MINUTE,
    });

    await focus();
    expect(mockGetConnection).toHaveBeenCalledTimes(1);
  });

  it('ends every watch with the session, so none asks for the next user', async () => {
    const { client } = setup();
    watchPullRequestSignIn(client, {
      startedIn: pullRequestSignInSession(),
      expiresAt: Date.now() + 10 * MINUTE,
    });

    endPullRequestSession();
    await pass(10 * MINUTE);
    await focus();
    announceOAuthSettled({ outcome: 'succeeded' });
    await pass(0);
    expect(mockGetConnection).not.toHaveBeenCalled();
  });

  it('applies an answer asked for just before the flow expired', async () => {
    const { client, invalidate } = setup();
    let answer: (status: TPullRequestConnection) => void = () => undefined;
    mockGetConnection.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    watchPullRequestSignIn(client, {
      startedIn: pullRequestSignInSession(),
      expiresAt: Date.now() + 1 * MINUTE,
    });
    await pass(1 * MINUTE - 1);
    announceOAuthSettled({ outcome: 'succeeded' });
    await pass(1);
    expect(invalidate).not.toHaveBeenCalled();
    answer(connection(true));
    await pass(0);
    expect(invalidate).toHaveBeenCalled();
  });

  it('discards an answer that arrives after the session ended', async () => {
    const { client, invalidate } = setup();
    let answer: (status: TPullRequestConnection) => void = () => undefined;
    mockGetConnection.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    watchPullRequestSignIn(client, {
      startedIn: pullRequestSignInSession(),
      expiresAt: Date.now() + 10 * MINUTE,
    });
    announceOAuthSettled({ outcome: 'succeeded' });
    await pass(0);
    endPullRequestSession();
    invalidate.mockClear();
    answer(connection(true));
    await pass(0);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('does not start a watch for a sign-in begun in a session that has since ended', async () => {
    const { client } = setup();
    const startedIn = pullRequestSignInSession();
    endPullRequestSession();
    watchPullRequestSignIn(client, { startedIn, expiresAt: Date.now() + 10 * MINUTE });

    await pass(10 * MINUTE);
    await focus();
    expect(mockGetConnection).not.toHaveBeenCalled();
  });

  describe('a failed sign-in', () => {
    const watchFlow = (client: QueryClient, flowId?: string) =>
      watchPullRequestSignIn(client, {
        startedIn: pullRequestSignInSession(),
        expiresAt: Date.now() + 60 * MINUTE,
        flowId,
      });

    const askedAfter = async (ms: number) => {
      const before = mockGetConnection.mock.calls.length;
      await pass(ms);
      return mockGetConnection.mock.calls.length - before;
    };

    it('ends the watch on the flow it names, after one last read', async () => {
      watchFlow(setup().client, 'flow-a');
      announceOAuthSettled({ outcome: 'failed', flowId: 'flow-a' });
      /** The read the failure itself asks for, and none after it. */
      expect(await askedAfter(10 * MINUTE)).toBe(1);
    });

    it('reads the status once before ending, since the grant may have been stored', async () => {
      const { client, invalidate } = setup();
      watchFlow(client, 'flow-a');
      mockGetConnection.mockResolvedValue({ ...connection(true), flowId: 'flow-a' });
      const before = mockGetConnection.mock.calls.length;
      announceOAuthSettled({ outcome: 'failed', flowId: 'flow-a' });
      await pass(0);
      expect(mockGetConnection.mock.calls.length - before).toBe(1);
      expect(invalidate).toHaveBeenCalledWith([QueryKeys.conversationPullRequest]);
      expect(await askedAfter(10 * MINUTE)).toBe(0);
    });

    it('keeps watching when the read after a failure fails, until one succeeds', async () => {
      const { client, invalidate } = setup();
      watchFlow(client, 'flow-a');
      mockGetConnection.mockRejectedValueOnce(new Error('offline'));
      announceOAuthSettled({ outcome: 'failed', flowId: 'flow-a' });
      await pass(0);
      expect(mockGetConnection).toHaveBeenCalledTimes(1);

      /** The server had stored the grant: the next read that succeeds syncs it, then the watch ends. */
      mockGetConnection.mockResolvedValue({ ...connection(true), flowId: 'flow-a' });
      invalidate.mockClear();
      await focus();
      expect(mockGetConnection).toHaveBeenCalledTimes(2);
      expect(invalidate).toHaveBeenCalledWith([QueryKeys.conversationPullRequest]);
      expect(await askedAfter(10 * MINUTE)).toBe(0);
    });

    it('leaves the watch on another flow running', async () => {
      watchFlow(setup().client, 'flow-b');
      announceOAuthSettled({ outcome: 'failed', flowId: 'flow-a' });
      expect(await askedAfter(10 * MINUTE)).toBeGreaterThan(0);
    });

    it('ignores a failure that names no flow, such as another OAuth sign-in', async () => {
      watchFlow(setup().client, 'flow-a');
      announceOAuthSettled({ outcome: 'failed' });
      expect(await askedAfter(10 * MINUTE)).toBeGreaterThan(0);
    });

    it('ignores a failure when its own server names no flow either', async () => {
      watchFlow(setup().client);
      announceOAuthSettled({ outcome: 'failed' });
      expect(await askedAfter(10 * MINUTE)).toBeGreaterThan(0);
    });
  });
});
