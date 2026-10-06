import type { TConversationPullRequest } from 'librechat-data-provider';
import type { Response } from 'express';
import type { ServerRequest } from '~/types';
import {
  createConversationPullRequestHandler,
  createConversationPullRequestsHandler,
  resolveTokenReference,
} from './handler';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

const pr: TConversationPullRequest = {
  number: 7,
  title: 't',
  url: 'https://github.com/o/r/pull/7',
  additions: 1,
  deletions: 2,
  state: 'open',
  isDraft: false,
  mergeable: 'clean',
  checks: 'passing',
};

const enabled = {
  enabled: true,
  token: '${GH_TOKEN}',
  cacheTtlSeconds: 30,
  allowedRepositories: ['o/r'],
};
const configWith = (pullRequests?: Record<string, unknown>) => ({
  endpoints: { agents: { pullRequests } },
});

type Lane = { branch: string | null; head: string | null; repo?: string } | null;

function setup(
  options: {
    settings?: Record<string, unknown> | null;
    laneGit?: Lane;
    lookup?: jest.Mock;
    env?: Record<string, string | undefined>;
  } = {},
) {
  /** `null` means the block is absent; omitting the option means the enabled default. */
  const settings = options.settings === undefined ? enabled : (options.settings ?? undefined);
  const laneGit: Lane =
    options.laneGit === undefined ? { branch: 'feat/x', head: null, repo: 'o/r' } : options.laneGit;
  const lookup = options.lookup ?? jest.fn().mockResolvedValue({ ok: true, value: pr });
  const env = options.env ?? { GH_TOKEN: 'ghp_secret' };
  const getConvoLaneGit = jest.fn().mockResolvedValue(laneGit);
  const handler = createConversationPullRequestHandler({
    getConvoLaneGit,
    getAppConfig: jest.fn().mockResolvedValue(configWith(settings)),
    lookup,
    env,
  });
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const run = (params: { conversationId?: string } = { conversationId: 'c1' }, user = 'u1') =>
    handler({ user: { id: user }, params } as unknown as ServerRequest, res as unknown as Response);
  return { run, res, getConvoLaneGit, lookup };
}

describe('resolveTokenReference', () => {
  it.each([
    ['${GH_TOKEN}', { GH_TOKEN: ' abc ' }, 'abc'],
    ['${GH_TOKEN}', {}, null],
    ['${GH_TOKEN}', { GH_TOKEN: '  ' }, null],
    ['literal-token', { 'literal-token': 'x' }, null],
    [undefined, { GH_TOKEN: 'x' }, null],
  ])('resolves %s', (reference, env, expected) => {
    expect(resolveTokenReference(reference, env)).toBe(expected);
  });
});

describe('createConversationPullRequestHandler', () => {
  it('returns the pull request for the owner-scoped branch', async () => {
    const { run, res, getConvoLaneGit, lookup } = setup();
    await run();
    expect(getConvoLaneGit).toHaveBeenCalledWith('u1', 'c1');
    expect(lookup).toHaveBeenCalledWith({
      repo: 'o/r',
      branch: 'feat/x',
      token: 'ghp_secret',
      head: null,
      ttlMs: 30_000,
      cacheMaxEntries: 500,
      cacheMaxCredentials: 256,
      limits: {
        requestTimeoutMs: 10_000,
        lookupTimeoutMs: 30_000,
        maxCheckRunPages: 10,
        maxCandidatePullRequests: 10,
        maxHeadComparisons: 3,
      },
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ pullRequest: pr });
  });

  it('passes the configured lookup bounds to GitHub', async () => {
    const { run, lookup } = setup({
      settings: {
        ...enabled,
        requestTimeoutSeconds: 3,
        lookupTimeoutSeconds: 8,
        maxCheckRunPages: 4,
        maxCandidatePullRequests: 25,
        maxHeadComparisons: 6,
        cacheMaxEntries: 77,
        cacheMaxCredentials: 12,
      },
    });
    await run();
    expect(lookup).toHaveBeenCalledWith(
      expect.objectContaining({
        cacheMaxEntries: 77,
        cacheMaxCredentials: 12,
        limits: {
          requestTimeoutMs: 3_000,
          lookupTimeoutMs: 8_000,
          maxCheckRunPages: 4,
          maxCandidatePullRequests: 25,
          maxHeadComparisons: 6,
        },
      }),
    );
  });

  it('passes the recorded head so the pull request can be matched to what the chat ran', async () => {
    const head = 'a'.repeat(40);
    const { run, lookup } = setup({ laneGit: { branch: 'feat/x', head, repo: 'o/r' } });
    await run();
    expect(lookup).toHaveBeenCalledWith(expect.objectContaining({ head }));
  });

  describe('repository allowlist', () => {
    const lane = (repo: string) => ({ branch: 'feat/x', head: null, repo });

    it.each([
      ['an exact match', ['o/r'], 'o/r'],
      ['a different case', ['O/R'], 'o/r'],
      ['an owner wildcard', ['o/*'], 'o/r'],
      ['one of several', ['x/y', 'o/r'], 'o/r'],
    ])('looks up a repository allowed by %s', async (_label, allowedRepositories, repo) => {
      const { run, lookup } = setup({
        settings: { ...enabled, allowedRepositories },
        laneGit: lane(repo),
      });
      await run();
      expect(lookup).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['another repository', ['o/r'], 'o/other'],
      ['another owner', ['o/*'], 'x/r'],
      ['a prefix of an allowed owner', ['org/*'], 'organization/r'],
      ['an empty allowlist', [], 'o/r'],
    ])('answers null without using the token for %s', async (_label, allowedRepositories, repo) => {
      const { run, res, lookup } = setup({
        settings: { ...enabled, allowedRepositories },
        laneGit: lane(repo),
      });
      await run();
      expect(lookup).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ pullRequest: null });
    });

    it('does not reveal whether a disallowed repository exists', async () => {
      const allowed = setup({ laneGit: lane('o/r') });
      const denied = setup({ laneGit: lane('secret/private') });
      await denied.run();
      await allowed.run();
      expect(denied.res.json).toHaveBeenCalledWith({ pullRequest: null });
      expect(JSON.stringify(denied.res.json.mock.calls)).not.toContain('secret');
    });
  });

  it('answers null, and never touches GitHub, when the feature is off', async () => {
    for (const settings of [null, { enabled: false }]) {
      const { run, res, lookup } = setup({ settings });
      await run();
      expect(lookup).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({ pullRequest: null });
    }
  });

  it('starts the config and the owner-scoped lane reads together, not one after the other', async () => {
    const order: string[] = [];
    let releaseConfig: (config: unknown) => void = () => undefined;
    const getAppConfig = jest.fn(
      () =>
        new Promise((resolve) => {
          order.push('config:start');
          releaseConfig = resolve;
        }),
    );
    const getConvoLaneGit = jest.fn(async () => {
      order.push('lane:start');
      return { branch: 'feat/x', head: null, repo: 'o/r' };
    });
    const handler = createConversationPullRequestHandler({
      getConvoLaneGit,
      getAppConfig: getAppConfig as never,
      lookup: jest.fn().mockResolvedValue({ ok: true, value: pr }),
      env: { GH_TOKEN: 'ghp_secret' },
    });
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const done = handler(
      { user: { id: 'u1' }, params: { conversationId: 'c1' } } as unknown as ServerRequest,
      res as unknown as Response,
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(['config:start', 'lane:start']);
    releaseConfig(configWith(enabled));
    await done;
    expect(res.json).toHaveBeenCalledWith({ pullRequest: pr });
  });

  it.each([
    ['no stored lane', null],
    ['a detached lane', { branch: null, head: null, repo: 'o/r' }],
    ['a lane with no repository', { branch: 'main', head: null }],
  ])('answers null for %s without calling GitHub', async (_label, laneGit) => {
    const { run, res, lookup } = setup({ laneGit });
    await run();
    expect(lookup).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ pullRequest: null });
  });

  it('answers null when the branch has no pull request', async () => {
    const { run, res } = setup({ lookup: jest.fn().mockResolvedValue({ ok: true, value: null }) });
    await run();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ pullRequest: null });
  });

  it('is a 404 for a missing or oversized conversation id', async () => {
    for (const conversationId of [undefined, '', '  ', 'x'.repeat(257)]) {
      const { run, res, getConvoLaneGit } = setup();
      await run({ conversationId });
      expect(res.status).toHaveBeenCalledWith(404);
      expect(getConvoLaneGit).not.toHaveBeenCalled();
    }
  });

  it('reports a missing token as NOT_CONFIGURED without leaking config', async () => {
    const { run, res, lookup } = setup({ env: {} });
    await run();
    expect(lookup).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Pull requests are not configured',
      code: 'NOT_CONFIGURED',
    });
  });

  it.each(['RATE_LIMITED', 'UPSTREAM_ERROR'])(
    'maps a %s failure to a 503 with its code',
    async (code) => {
      const { run, res } = setup({
        lookup: jest.fn().mockResolvedValue({ ok: false, error: { code } }),
      });
      await run();
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code }));
    },
  );

  it('answers 500 with fixed text when storage throws, never the exception', async () => {
    const { run, res, getConvoLaneGit } = setup();
    getConvoLaneGit.mockRejectedValue(new Error('mongodb://user:secret@host'));
    await run();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('secret');
  });

  it('never puts the token in a response', async () => {
    const { run, res } = setup();
    await run();
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('ghp_secret');
  });
});

describe('createConversationPullRequestsHandler', () => {
  type Row = {
    conversationId: string;
    laneGit: { branch: string | null; head: string | null; repo?: string };
  };
  const lane = (conversationId: string, repo = 'o/r', branch = `feat/${conversationId}`): Row => ({
    conversationId,
    laneGit: { branch, head: null, repo },
  });

  function batch(
    options: {
      settings?: Record<string, unknown> | null;
      lanes?: Row[];
      lookup?: jest.Mock;
      env?: Record<string, string | undefined>;
    } = {},
  ) {
    const settings = options.settings === undefined ? enabled : (options.settings ?? undefined);
    const lanes = options.lanes ?? [lane('a'), lane('b')];
    const lookup = options.lookup ?? jest.fn().mockResolvedValue({ ok: true, value: pr });
    const getConvosLaneGit = jest.fn().mockResolvedValue(lanes);
    const handler = createConversationPullRequestsHandler({
      getConvosLaneGit,
      getAppConfig: jest.fn().mockResolvedValue(configWith(settings)),
      lookup,
      env: options.env ?? { GH_TOKEN: 'ghp_secret' },
    });
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const run = (...args: [body?: unknown, user?: string | null]) => {
      /** Read by count, so an explicit `undefined` is a real "none" and not the default. */
      const body = args.length > 0 ? args[0] : { conversationIds: ['a', 'b'] };
      const user = args.length > 1 ? args[1] : 'u1';
      return handler(
        { user: user ? { id: user } : undefined, body } as unknown as ServerRequest,
        res as unknown as Response,
      );
    };
    return { run, res, lookup, getConvosLaneGit };
  }

  it('answers each conversation in the order asked, from one owner-scoped read', async () => {
    const { run, res, getConvosLaneGit, lookup } = batch();
    await run({ conversationIds: ['b', 'a'] });
    expect(getConvosLaneGit).toHaveBeenCalledTimes(1);
    expect(getConvosLaneGit).toHaveBeenCalledWith('u1', ['b', 'a']);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(res.json).toHaveBeenCalledWith({
      results: [
        { conversationId: 'b', pullRequest: pr },
        { conversationId: 'a', pullRequest: pr },
      ],
    });
  });

  it('answers no pull request for a conversation without a stored lane, without a lookup', async () => {
    const { run, res, lookup } = batch({ lanes: [lane('a')] });
    await run({ conversationIds: ['a', 'ghost'] });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith({
      results: [
        { conversationId: 'a', pullRequest: pr },
        { conversationId: 'ghost', pullRequest: null },
      ],
    });
  });

  it('never looks up a repository the administrator did not allow', async () => {
    const { run, res, lookup } = batch({ lanes: [lane('a', 'o/r'), lane('b', 'evil/secret')] });
    await run();
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith(expect.objectContaining({ repo: 'o/r' }));
    expect(res.json).toHaveBeenCalledWith({
      results: [
        { conversationId: 'a', pullRequest: pr },
        { conversationId: 'b', pullRequest: null },
      ],
    });
  });

  it('keeps one failure from hiding the others and exposes only its code', async () => {
    const lookup = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'RATE_LIMITED' } })
      .mockResolvedValueOnce({ ok: true, value: pr });
    const { run, res } = batch({ lookup });
    await run();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      results: [
        { conversationId: 'a', error: { code: 'RATE_LIMITED' } },
        { conversationId: 'b', pullRequest: pr },
      ],
    });
  });

  it('answers no pull request for everything, and reads no token, when the feature is off', async () => {
    const { run, res, lookup } = batch({ settings: { ...enabled, enabled: false } });
    await run();
    expect(lookup).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      results: [
        { conversationId: 'a', pullRequest: null },
        { conversationId: 'b', pullRequest: null },
      ],
    });
  });

  it('says not configured only for the conversations that needed the token, and keeps the rest', async () => {
    const { run, res, lookup } = batch({ env: {}, lanes: [lane('a')] });
    await run({ conversationIds: ['a', 'ghost'] });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(lookup).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      results: [
        { conversationId: 'a', error: { code: 'NOT_CONFIGURED' } },
        { conversationId: 'ghost', pullRequest: null },
      ],
    });
  });

  it('answers a plain no pull request when nothing would have needed the token', async () => {
    const { run, res } = batch({ env: {}, lanes: [] });
    await run();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      results: [
        { conversationId: 'a', pullRequest: null },
        { conversationId: 'b', pullRequest: null },
      ],
    });
  });

  it('collapses duplicate ids so one conversation is looked up once', async () => {
    const { run, lookup, getConvosLaneGit } = batch({ lanes: [lane('a')] });
    await run({ conversationIds: ['a', 'a', 'a'] });
    expect(getConvosLaneGit).toHaveBeenCalledWith('u1', ['a']);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('runs no more lookups at once than configured', async () => {
    let active = 0;
    let peak = 0;
    const lookup = jest.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { ok: true, value: pr };
    });
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const { run } = batch({
      lookup,
      settings: { ...enabled, maxConcurrentLookups: 2 },
      lanes: ids.map((id) => lane(id)),
    });
    await run({ conversationIds: ids });
    expect(lookup).toHaveBeenCalledTimes(6);
    expect(peak).toBe(2);
  });

  it.each([
    ['no body', undefined],
    ['no list', {}],
    ['an empty list', { conversationIds: [] }],
    ['a list that is not an array', { conversationIds: 'a' }],
    ['a non-string id', { conversationIds: ['a', 7] }],
    ['a blank id', { conversationIds: ['a', '  '] }],
    ['an overlong id', { conversationIds: ['x'.repeat(257)] }],
    ['more ids than the bound', { conversationIds: Array.from({ length: 51 }, (_, i) => `c${i}`) }],
  ])('rejects %s before reading anything', async (_label, body) => {
    const { run, res, getConvosLaneGit, lookup } = batch();
    await run(body);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(getConvosLaneGit).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('accepts exactly the bound', async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `c${i}`);
    const { run, res } = batch({ lanes: [] });
    await run({ conversationIds: ids });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('rejects an unauthenticated request', async () => {
    const { run, res, getConvosLaneGit } = batch();
    await run({ conversationIds: ['a'] }, null);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(getConvosLaneGit).not.toHaveBeenCalled();
  });

  it('answers 500 without the error text when the read fails', async () => {
    const { run, res, getConvosLaneGit } = batch();
    getConvosLaneGit.mockRejectedValue(new Error('mongodb://u:secret@h'));
    await run();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(JSON.stringify((res.json as jest.Mock).mock.calls)).not.toContain('secret');
  });

  describe('overall deadline', () => {
    const never = () => new Promise(() => undefined);

    it('answers within the deadline when a lookup stalls, keeping what finished', async () => {
      const lookup = jest
        .fn()
        .mockResolvedValueOnce({ ok: true, value: pr })
        .mockImplementationOnce(never);
      const { run, res } = batch({ lookup, settings: { ...enabled, batchTimeoutSeconds: 0.08 } });
      const started = Date.now();
      await run();
      expect(Date.now() - started).toBeLessThan(1000);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        results: [
          { conversationId: 'a', pullRequest: pr },
          { conversationId: 'b', error: { code: 'UPSTREAM_ERROR' } },
        ],
      });
    });

    it('starts nothing new once the deadline has passed', async () => {
      const lookup = jest.fn().mockImplementation(never);
      const ids = ['a', 'b', 'c'];
      const { run, res } = batch({
        lookup,
        lanes: ids.map((id) => lane(id)),
        settings: { ...enabled, maxConcurrentLookups: 1, batchTimeoutSeconds: 0.08 },
      });
      await run({ conversationIds: ids });
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(res.json).toHaveBeenCalledWith({
        results: ids.map((conversationId) => ({
          conversationId,
          error: { code: 'UPSTREAM_ERROR' },
        })),
      });
    });

    it('counts the time spent reading the config and lanes against the deadline', async () => {
      /** The reads take most of the 0.2 s deadline, so the lookups get what is left of it, not a fresh 0.2 s. */
      const lookup = jest.fn(() => new Promise(() => undefined));
      const slowRead = <T>(value: T, ms: number) =>
        new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
      const handler = createConversationPullRequestsHandler({
        getConvosLaneGit: jest.fn(() => slowRead([lane('a')], 150)),
        getAppConfig: jest.fn(() =>
          slowRead(configWith({ ...enabled, batchTimeoutSeconds: 0.2 }), 10),
        ) as never,
        lookup: lookup as never,
        env: { GH_TOKEN: 'ghp_secret' },
      });
      const out = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const started = Date.now();
      await handler(
        { user: { id: 'u1' }, body: { conversationIds: ['a'] } } as unknown as ServerRequest,
        out as unknown as Response,
      );
      const took = Date.now() - started;
      expect(took).toBeLessThan(330);
      expect(out.json).toHaveBeenCalledWith({
        results: [{ conversationId: 'a', error: { code: 'UPSTREAM_ERROR' } }],
      });
    });

    const respond503 = {
      error: 'Pull request lookup is unavailable',
      code: 'UPSTREAM_ERROR',
    };
    const call = (handler: ReturnType<typeof createConversationPullRequestsHandler>) => {
      const out = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const pending = handler(
        { user: { id: 'u1' }, body: { conversationIds: ['a'] } } as unknown as ServerRequest,
        out as unknown as Response,
      );
      return { out, pending };
    };

    it('ends a request whose lane read never answers at the configured deadline, not the maximum', async () => {
      jest.useFakeTimers();
      try {
        const lookup = jest.fn();
        const { out, pending } = call(
          createConversationPullRequestsHandler({
            getConvosLaneGit: jest.fn(() => new Promise(() => undefined)) as never,
            getAppConfig: jest
              .fn()
              .mockResolvedValue(configWith({ ...enabled, batchTimeoutSeconds: 20 })),
            lookup: lookup as never,
            env: { GH_TOKEN: 'ghp_secret' },
          }),
        );
        await jest.advanceTimersByTimeAsync(19_000);
        expect(out.json).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(2_000);
        await pending;
        expect(out.status).toHaveBeenCalledWith(503);
        expect(out.json).toHaveBeenCalledWith(respond503);
        expect(lookup).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('ends a request whose config read never answers at the default deadline', async () => {
      jest.useFakeTimers();
      try {
        const lookup = jest.fn();
        const { out, pending } = call(
          createConversationPullRequestsHandler({
            getConvosLaneGit: jest.fn().mockResolvedValue([lane('a')]) as never,
            getAppConfig: jest.fn(() => new Promise(() => undefined)) as never,
            lookup: lookup as never,
            env: { GH_TOKEN: 'ghp_secret' },
          }),
        );
        await jest.advanceTimersByTimeAsync(19_000);
        expect(out.json).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(2_000);
        await pending;
        expect(out.status).toHaveBeenCalledWith(503);
        expect(lookup).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('holds the lane read to a configured deadline shorter than the default', async () => {
      jest.useFakeTimers();
      try {
        const { out, pending } = call(
          createConversationPullRequestsHandler({
            getConvosLaneGit: jest.fn(() => new Promise(() => undefined)) as never,
            getAppConfig: jest
              .fn()
              .mockResolvedValue(configWith({ ...enabled, batchTimeoutSeconds: 3 })),
            lookup: jest.fn() as never,
            env: { GH_TOKEN: 'ghp_secret' },
          }),
        );
        await jest.advanceTimersByTimeAsync(3_500);
        await pending;
        expect(out.status).toHaveBeenCalledWith(503);
      } finally {
        jest.useRealTimers();
      }
    });

    it('starts no lookup when the reads alone used up the deadline', async () => {
      const lookup = jest.fn().mockResolvedValue({ ok: true, value: pr });
      const { out, pending } = call(
        createConversationPullRequestsHandler({
          getConvosLaneGit: jest.fn(
            () => new Promise((resolve) => setTimeout(() => resolve([lane('a')]), 150)),
          ) as never,
          getAppConfig: jest
            .fn()
            .mockResolvedValue(configWith({ ...enabled, batchTimeoutSeconds: 0.05 })),
          lookup: lookup as never,
          env: { GH_TOKEN: 'ghp_secret' },
        }),
      );
      await pending;
      expect(lookup).not.toHaveBeenCalled();
      expect(out.status).toHaveBeenCalledWith(503);
      expect(out.json).toHaveBeenCalledWith(respond503);
    });

    it('does not fail unhandled when the lane read rejects after the request has ended', async () => {
      const unhandled = jest.fn();
      process.on('unhandledRejection', unhandled);
      try {
        const { pending } = call(
          createConversationPullRequestsHandler({
            getConvosLaneGit: jest.fn(
              () => new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 30)),
            ) as never,
            getAppConfig: jest.fn().mockResolvedValue(configWith({ ...enabled, enabled: false })),
            lookup: jest.fn() as never,
            env: { GH_TOKEN: 'ghp_secret' },
          }),
        );
        await pending;
        await new Promise((resolve) => setTimeout(resolve, 80));
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandled);
      }
    });

    it('does not change the answer of a batch that finishes in time', async () => {
      const { run, res } = batch({ settings: { ...enabled, batchTimeoutSeconds: 5 } });
      await run();
      expect(res.json).toHaveBeenCalledWith({
        results: [
          { conversationId: 'a', pullRequest: pr },
          { conversationId: 'b', pullRequest: null },
        ].map((entry, index) => (index === 1 ? { ...entry, pullRequest: pr } : entry)),
      });
    });
  });

  describe('concurrency across requests', () => {
    /** Lookups that end only when released, so a request can finish while its lookups still run. */
    const heldLookups = () => {
      let active = 0;
      let peak = 0;
      const releases: Array<() => void> = [];
      const lookup = jest.fn(
        () =>
          new Promise((resolve) => {
            active += 1;
            peak = Math.max(peak, active);
            releases.push(() => {
              active -= 1;
              resolve({ ok: true, value: pr });
            });
          }),
      );
      return { lookup, releases, active: () => active, peak: () => peak };
    };
    const ids = ['a', 'b', 'c', 'd'];
    const lanes = ids.map((id) => lane(id));
    const settings = { ...enabled, maxConcurrentLookups: 2, batchTimeoutSeconds: 0.08 };
    const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

    it('keeps the lookups of a timed-out request inside the limit for the next request', async () => {
      const held = heldLookups();
      const handler = batch({ lookup: held.lookup, lanes, settings });
      await handler.run({ conversationIds: ids });
      /** The first request has answered, yet its two lookups are still out. */
      expect(held.active()).toBe(2);
      const second = handler.run({ conversationIds: ids });
      await flush();
      expect(held.lookup).toHaveBeenCalledTimes(2);
      expect(held.peak()).toBe(2);
      held.releases.splice(0).forEach((release) => release());
      await second;
      held.releases.splice(0).forEach((release) => release());
      expect(held.peak()).toBe(2);
    });

    it('starts no lookup for an entry that gave up while it waited behind another request', async () => {
      const held = heldLookups();
      const handler = batch({ lookup: held.lookup, lanes, settings });
      /** The first request ends with its two lookups still holding both slots. */
      await handler.run({ conversationIds: ids });
      expect(held.lookup).toHaveBeenCalledTimes(2);
      /** The second request's entries wait for those slots, and give up at its own deadline. */
      await handler.run({ conversationIds: ids });
      expect(held.lookup).toHaveBeenCalledTimes(2);
      /** Slots free up only now; the entries that already answered must not start work. */
      held.releases.splice(0).forEach((release) => release());
      await flush();
      expect(held.lookup).toHaveBeenCalledTimes(2);
      expect(held.active()).toBe(0);
    });

    it("counts slots per credential, so one tenant's stalled lookups do not block another's", async () => {
      const held = heldLookups();
      const configFor = (tokenName: string) =>
        configWith({
          ...enabled,
          token: `\${${tokenName}}`,
          maxConcurrentLookups: 1,
          batchTimeoutSeconds: 0.2,
        });
      /** Each tenant's config names its own token, as principal-scoped configuration can. */
      const getAppConfig = jest.fn(async (options: { userId?: string; role?: string }) =>
        configFor(options.userId === 'u2' ? 'TOKEN_TWO' : 'TOKEN_ONE'),
      );
      const handler = createConversationPullRequestsHandler({
        getConvosLaneGit: jest.fn().mockResolvedValue([lane('a')]),
        getAppConfig: getAppConfig as never,
        lookup: held.lookup as never,
        env: { TOKEN_ONE: 'token-one', TOKEN_TWO: 'token-two' },
      });
      const call = async (user: string) => {
        const out = { status: jest.fn().mockReturnThis(), json: jest.fn() };
        await handler(
          { user: { id: user }, body: { conversationIds: ['a'] } } as unknown as ServerRequest,
          out as unknown as Response,
        );
        return out;
      };

      /** The first tenant's only slot is now held by a lookup that outlived its request. */
      await call('u1');
      expect(held.active()).toBe(1);
      /** Same credential: the next request waits for that slot, gives up, and starts nothing. */
      const same = await call('u1');
      expect(held.lookup).toHaveBeenCalledTimes(1);
      expect(same.json).toHaveBeenCalledWith({
        results: [{ conversationId: 'a', error: { code: 'UPSTREAM_ERROR' } }],
      });
      /** Another credential has its own slots, so it is not held behind the first tenant. */
      await call('u2');
      expect(held.lookup).toHaveBeenCalledTimes(2);
    });

    it('looks identical lanes up once and spends one slot on them, so an unrelated lane still starts', async () => {
      const held = heldLookups();
      /** Four conversations on one branch and one on another, with room for a single lookup at a time. */
      const same = ['a', 'b', 'c', 'd'].map((id) => lane(id, 'o/r', 'feat/shared'));
      const other = lane('e', 'o/r', 'feat/other');
      const handler = batch({
        lookup: held.lookup,
        lanes: [...same, other],
        settings: { ...enabled, maxConcurrentLookups: 1, batchTimeoutSeconds: 5 },
      });
      const done = handler.run({ conversationIds: ['a', 'b', 'c', 'd', 'e'] });
      await flush();
      expect(held.lookup).toHaveBeenCalledTimes(1);
      held.releases.splice(0).forEach((release) => release());
      await flush();
      /** The shared branch finished in one lookup, freeing the only slot for the other branch. */
      expect(held.lookup).toHaveBeenCalledTimes(2);
      held.releases.splice(0).forEach((release) => release());
      await done;
      expect(handler.res.json).toHaveBeenCalledWith({
        results: ['a', 'b', 'c', 'd', 'e'].map((conversationId) => ({
          conversationId,
          pullRequest: pr,
        })),
      });
    });

    it('gives every conversation on a shared branch the same failure when that lookup fails', async () => {
      const lookup = jest
        .fn()
        .mockResolvedValueOnce({ ok: false, error: { code: 'RATE_LIMITED' } })
        .mockResolvedValue({ ok: true, value: pr });
      const { run, res } = batch({
        lookup,
        lanes: [lane('a', 'o/r', 'feat/s'), lane('b', 'o/r', 'feat/s'), lane('c', 'o/r', 'feat/t')],
      });
      await run({ conversationIds: ['a', 'b', 'c'] });
      expect(lookup).toHaveBeenCalledTimes(2);
      expect(res.json).toHaveBeenCalledWith({
        results: [
          { conversationId: 'a', error: { code: 'RATE_LIMITED' } },
          { conversationId: 'b', error: { code: 'RATE_LIMITED' } },
          { conversationId: 'c', pullRequest: pr },
        ],
      });
    });

    it('does not merge lanes that differ in repository, branch or head', async () => {
      const head = 'a'.repeat(40);
      const rows = [
        lane('a', 'o/r', 'feat/x'),
        lane('b', 'o/r2', 'feat/x'),
        lane('c', 'o/r', 'feat/y'),
        { conversationId: 'd', laneGit: { branch: 'feat/x', head, repo: 'o/r' } },
      ];
      const { run, lookup } = batch({
        lanes: rows,
        settings: { ...enabled, allowedRepositories: ['o/*'] },
      });
      await run({ conversationIds: ['a', 'b', 'c', 'd'] });
      expect(lookup).toHaveBeenCalledTimes(4);
    });

    it('frees the slot when a lookup fails, so later requests are not stuck', async () => {
      const lookup = jest
        .fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValue({ ok: true, value: pr });
      const handler = batch({
        lookup,
        lanes: [lane('a')],
        settings: { ...enabled, maxConcurrentLookups: 1 },
      });
      await handler.run({ conversationIds: ['a'] });
      await handler.run({ conversationIds: ['a'] });
      expect(lookup).toHaveBeenCalledTimes(2);
    });
  });

  it('uses the same lookup input as the single route', async () => {
    const single = setup({ laneGit: { branch: 'feat/a', head: null, repo: 'o/r' } });
    await single.run();
    const many = batch({ lanes: [lane('a')] });
    await many.run({ conversationIds: ['a'] });
    expect(many.lookup.mock.calls[0][0]).toEqual(single.lookup.mock.calls[0][0]);
  });
});
