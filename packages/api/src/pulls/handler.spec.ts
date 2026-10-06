import type { TConversationPullRequest } from 'librechat-data-provider';
import type { Response } from 'express';
import type { ServerRequest } from '~/types';
import { createConversationPullRequestHandler, resolveTokenReference } from './handler';

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
