import type { TConversationPullRequest } from 'librechat-data-provider';
import type { Response } from 'express';
import type { ServerRequest } from '~/types';
import {
  createConversationPullRequestHandler,
  createConversationPullRequestsHandler,
} from './handler';
import { resolveTokenReference } from './settings';

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

type Lane = {
  branch: string | null;
  head: string | null;
  repo?: string;
  pullRequest?: number;
} | null;

function setup(
  options: {
    settings?: Record<string, unknown> | null;
    laneGit?: Lane;
    lookup?: jest.Mock;
    env?: Record<string, string | undefined>;
    userToken?: jest.Mock;
  } = {},
) {
  /** `null` means the block is absent; omitting the option means the enabled default. */
  const settings = options.settings === undefined ? enabled : (options.settings ?? undefined);
  const laneGit: Lane =
    options.laneGit === undefined
      ? { branch: 'feat/x', head: 'c0ffee1', repo: 'o/r' }
      : options.laneGit;
  const lookup = options.lookup ?? jest.fn().mockResolvedValue({ ok: true, value: pr });
  const env = options.env ?? { GH_TOKEN: 'ghp_secret' };
  const getConvoLaneGit = jest.fn().mockResolvedValue(laneGit);
  const handler = createConversationPullRequestHandler({
    getConvoLaneGit,
    getAppConfig: jest.fn().mockResolvedValue(configWith(settings)),
    lookup,
    env,
    ...(options.userToken ? { userToken: options.userToken } : {}),
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
      head: 'c0ffee1',
      provider: 'github',
      host: 'github.com',
      ttlMs: 30_000,
      cacheMaxEntries: 500,
      cacheMaxCredentials: 256,
      sharedCache: false,
      sharedCacheTimeoutMs: 250,
      sharedCacheSlots: 65_536,
      allowedRepositories: ['o/r'],
      limits: {
        requestTimeoutMs: 10_000,
        lookupTimeoutMs: 30_000,
        maxCheckRunPages: 10,
        maxCandidatePullRequests: 10,
        maxHeadComparisons: 3,
        maxCandidatePages: 1,
      },
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ pullRequest: pr });
  });

  it('looks up on the configured GitHub host, normalized', async () => {
    const { run, lookup } = setup({ settings: { ...enabled, host: ' GHE.Example.com ' } });
    await run();
    expect(lookup).toHaveBeenCalledWith(expect.objectContaining({ host: 'ghe.example.com' }));
  });

  /** The operator's YAML holds `base`; a role, group or user override in the database holds `override`. */
  async function hostFor(base: Record<string, unknown>, override: Record<string, unknown>) {
    const lookup = jest.fn().mockResolvedValue({ ok: true, value: pr });
    const handler = createConversationPullRequestHandler({
      getConvoLaneGit: jest
        .fn()
        .mockResolvedValue({ branch: 'feat/x', head: 'c0ffee1', repo: 'o/r' }),
      getAppConfig: jest
        .fn()
        .mockImplementation(async (options: { baseOnly?: boolean }) =>
          configWith(options.baseOnly ? base : override),
        ),
      lookup,
      env: { GH_TOKEN: 'ghp_secret' },
    });
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await handler(
      { user: { id: 'u1' }, params: { conversationId: 'c1' } } as unknown as ServerRequest,
      res as unknown as Response,
    );
    return lookup.mock.calls[0]?.[0]?.host;
  }

  it('takes the provider from the operator config, never from a database override', async () => {
    const lookup = jest.fn().mockResolvedValue({ ok: true, value: pr });
    const handler = createConversationPullRequestHandler({
      getConvoLaneGit: jest
        .fn()
        .mockResolvedValue({ branch: 'feat/x', head: 'c0ffee1', repo: 'o/r' }),
      getAppConfig: jest
        .fn()
        .mockImplementation(async (options: { baseOnly?: boolean }) =>
          configWith(options.baseOnly ? enabled : { ...enabled, provider: 'gitlab' }),
        ),
      lookup,
      env: { GH_TOKEN: 'ghp_secret', GITLAB_TOKEN: 'glpat_other' },
    });
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await handler(
      { user: { id: 'u1' }, params: { conversationId: 'c1' } } as unknown as ServerRequest,
      res as unknown as Response,
    );
    expect(lookup).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'github', host: 'github.com', token: 'ghp_secret' }),
    );
  });

  describe('with users connecting their own accounts', () => {
    const connectable = {
      ...enabled,
      token: undefined,
      oauth: { clientId: '${GH_CLIENT_ID}', clientSecret: '${GH_CLIENT_SECRET}' },
    };
    const oauthEnv = { GH_CLIENT_ID: 'id', GH_CLIENT_SECRET: 'secret' };

    it("looks up with the user's own token, in any repository that user can see", async () => {
      const { run, lookup } = setup({
        settings: connectable,
        env: { ...oauthEnv, GH_TOKEN: 'ghp_server' },
        laneGit: { branch: 'feat/x', head: 'c0ffee1', repo: 'elsewhere/private' },
        userToken: jest.fn().mockResolvedValue('gho_user'),
      });
      await run();
      expect(lookup).toHaveBeenCalledWith(
        expect.objectContaining({
          token: 'gho_user',
          repo: 'elsewhere/private',
          allowedRepositories: ['*/*'],
        }),
      );
    });

    it("does not read the user's token for a lane with no commit yet", async () => {
      const userToken = jest.fn().mockResolvedValue('gho_user');
      const { run, res } = setup({
        settings: connectable,
        env: oauthEnv,
        laneGit: { branch: 'feat/x', head: null, repo: 'o/r' },
        userToken,
      });
      await run();
      expect(userToken).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({ pullRequest: null });
    });

    it.each([
      ["the user's own token", true],
      ["the server's token", false],
    ])('invalidates %s only when the provider refuses it', async (_label, personal) => {
      const userToken = Object.assign(jest.fn().mockResolvedValue(personal ? 'gho_user' : null), {
        reject: jest.fn().mockResolvedValue(undefined),
      });
      const { run, res } = setup({
        settings: personal ? connectable : enabled,
        env: { ...oauthEnv, GH_TOKEN: 'ghp_server' },
        lookup: jest.fn().mockResolvedValue({ ok: false, error: { code: 'CREDENTIAL_REJECTED' } }),
        userToken,
      });
      await run();
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'UPSTREAM_ERROR' }));
      if (personal) {
        expect(userToken.reject).toHaveBeenCalledWith('u1', expect.anything(), 'gho_user');
      } else {
        expect(userToken.reject).not.toHaveBeenCalled();
      }
    });

    it("falls back to the server's token, still held to its list, for a user who has not connected", async () => {
      const { run, lookup, res } = setup({
        settings: connectable,
        env: { ...oauthEnv, GH_TOKEN: 'ghp_server' },
        laneGit: { branch: 'feat/x', head: 'c0ffee1', repo: 'elsewhere/private' },
        userToken: jest.fn().mockResolvedValue(null),
      });
      await run();
      expect(lookup).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({ pullRequest: null });
    });

    it('answers no pull request, not a configuration error, when nothing can look up', async () => {
      const { run, lookup, res } = setup({
        settings: connectable,
        env: oauthEnv,
        userToken: jest.fn().mockResolvedValue(null),
      });
      await run();
      expect(lookup).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ pullRequest: null });
    });

    it("does not read the user's token while the feature is turned off", async () => {
      const userToken = jest.fn().mockResolvedValue('gho_user');
      const { run, res } = setup({
        settings: { ...connectable, enabled: false },
        env: { ...oauthEnv, GH_TOKEN: 'ghp_server' },
        userToken,
      });
      await run();
      expect(userToken).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({ pullRequest: null });
    });

    it.each([
      ['no lane', null],
      ['a lane without a branch', { branch: null, head: 'c0ffee1', repo: 'o/r' }],
    ])(
      "answers no pull request for %s without reading the user's token",
      async (_label, laneGit) => {
        const userToken = jest.fn().mockRejectedValue(new Error('key unavailable'));
        const { run, lookup, res } = setup({
          settings: connectable,
          env: { ...oauthEnv, GH_TOKEN: 'ghp_server' },
          laneGit: laneGit as Lane,
          userToken,
        });
        await run();
        expect(userToken).not.toHaveBeenCalled();
        expect(lookup).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith({ pullRequest: null });
      },
    );

    it("answers unavailable, not the server's token or no pull request, when the user's cannot be read", async () => {
      const { run, lookup, res } = setup({
        settings: connectable,
        env: { ...oauthEnv, GH_TOKEN: 'ghp_server' },
        userToken: jest.fn().mockRejectedValue(new Error('mongodb://secret@host')),
      });
      await run();
      expect(lookup).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'UPSTREAM_ERROR' }));
      expect(JSON.stringify(res.json.mock.calls)).not.toContain('secret@host');
    });
  });

  it('looks a GitLab lane up with the GitLab token on the GitLab host', async () => {
    const { run, lookup } = setup({
      settings: { ...enabled, token: undefined, provider: 'gitlab' },
      env: { GH_TOKEN: 'ghp_secret', GITLAB_TOKEN: 'glpat_secret' },
    });
    await run();
    expect(lookup).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'gitlab', host: 'gitlab.com', token: 'glpat_secret' }),
    );
  });

  it('takes the host from the operator config, never from a database override', async () => {
    const override = { ...enabled, host: 'attacker.example' };
    expect(await hostFor({ ...enabled, host: 'ghe.example.com' }, override)).toBe(
      'ghe.example.com',
    );
    expect(await hostFor(enabled, override)).toBe('github.com');
  });

  it('never sends the token anywhere when the host is not a host name', async () => {
    const { run, res, lookup } = setup({
      settings: { ...enabled, host: 'https://ghe.example.com' },
    });
    await run();
    expect(lookup).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ pullRequest: null });
  });

  it('passes the pull request the conversation linked to', async () => {
    const { run, lookup } = setup({
      laneGit: { branch: 'feat/x', head: 'c0ffee1', repo: 'o/r', pullRequest: 7 },
    });
    await run();
    expect(lookup).toHaveBeenCalledWith(expect.objectContaining({ pullRequest: 7 }));
  });

  it('passes the configured lookup bounds to GitHub', async () => {
    const { run, lookup } = setup({
      settings: {
        ...enabled,
        requestTimeoutSeconds: 3,
        lookupTimeoutSeconds: 8,
        maxCheckRunPages: 4,
        maxCandidatePullRequests: 25,
        maxCandidatePages: 4,
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
          maxCandidatePages: 4,
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

  describe('without an enabled switch or a token reference', () => {
    const scoped = { allowedRepositories: ['o/r'] };

    it('looks the pull request up, using the deployment GitHub token', async () => {
      const { run, res, lookup } = setup({ settings: scoped, env: { GITHUB_TOKEN: 'ghp_deploy' } });
      await run();
      expect(lookup).toHaveBeenCalledWith(expect.objectContaining({ token: 'ghp_deploy' }));
      expect(res.json).toHaveBeenCalledWith({ pullRequest: pr });
    });

    it('answers no pull request, and reads nothing, with no token anywhere', async () => {
      const { run, res, lookup } = setup({ settings: scoped, env: {} });
      await run();
      expect(lookup).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({ pullRequest: null });
    });

    it('still reports a configured reference that does not resolve', async () => {
      const { run, res } = setup({
        settings: { ...scoped, token: '${MISSING}' },
        env: { GITHUB_TOKEN: 'ghp_deploy' },
      });
      await run();
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'NOT_CONFIGURED' }));
    });

    it('is off when switched off, even with a token and a scope', async () => {
      const { run, res, lookup } = setup({
        settings: { ...scoped, enabled: false },
        env: { GITHUB_TOKEN: 'ghp_deploy' },
      });
      await run();
      expect(lookup).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({ pullRequest: null });
    });
  });

  describe('allowAllRepositories', () => {
    const lane = { branch: 'feat/x', head: 'c0ffee1', repo: 'someone/else' };
    const open = { allowAllRepositories: true };

    it('looks up a repository nobody listed, when the administrator opted in', async () => {
      const { run, lookup } = setup({
        settings: open,
        laneGit: lane,
        env: { GITHUB_TOKEN: 'ghp_deploy' },
      });
      await run();
      expect(lookup).toHaveBeenCalledWith(expect.objectContaining({ repo: 'someone/else' }));
    });

    it('passes the open scope on, so a fork named by the worker is authorized the same way', async () => {
      const { run, lookup } = setup({
        settings: open,
        laneGit: lane,
        env: { GITHUB_TOKEN: 'ghp_deploy' },
      });
      await run();
      expect(lookup.mock.calls[0][0].allowedRepositories).toEqual(['*/*']);
    });

    it('does not look it up without the opt-in, even with a token', async () => {
      const { run, lookup } = setup({
        settings: { allowedRepositories: ['o/r'] },
        laneGit: lane,
        env: { GITHUB_TOKEN: 'ghp_deploy' },
      });
      await run();
      expect(lookup).not.toHaveBeenCalled();
    });
  });

  describe('repository allowlist', () => {
    const lane = (repo: string) => ({ branch: 'feat/x', head: 'c0ffee1', repo });

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
    const pending: Array<(config: unknown) => void> = [];
    const releaseConfig = (config: unknown) => pending.forEach((resolve) => resolve(config));
    const getAppConfig = jest.fn(
      () =>
        new Promise((resolve) => {
          order.push('config:start');
          pending.push(resolve);
        }),
    );
    const getConvoLaneGit = jest.fn(async () => {
      order.push('lane:start');
      return { branch: 'feat/x', head: 'c0ffee1', repo: 'o/r' };
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
    /** The resolved config and the operator's base config, then the lane, all before any settles. */
    expect(order).toEqual(['config:start', 'config:start', 'lane:start']);
    releaseConfig(configWith(enabled));
    await done;
    expect(res.json).toHaveBeenCalledWith({ pullRequest: pr });
  });

  it.each([
    ['no stored lane', null],
    ['a detached lane', { branch: null, head: 'c0ffee1', repo: 'o/r' }],
    ['a lane with no repository', { branch: 'main', head: 'c0ffee1' }],
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
    laneGit: { branch, head: 'c0ffee1', repo },
  });

  function batch(
    options: {
      settings?: Record<string, unknown> | null;
      lanes?: Row[];
      lookup?: jest.Mock;
      env?: Record<string, string | undefined>;
      userToken?: jest.Mock;
      /** Answers the config read only when this resolves. */
      configGate?: Promise<void>;
    } = {},
  ) {
    const settings = options.settings === undefined ? enabled : (options.settings ?? undefined);
    const lanes = options.lanes ?? [lane('a'), lane('b')];
    const gate = options.configGate;
    const lookup = options.lookup ?? jest.fn().mockResolvedValue({ ok: true, value: pr });
    const getConvosLaneGit = jest.fn().mockResolvedValue(lanes);
    const handler = createConversationPullRequestsHandler({
      getConvosLaneGit,
      getAppConfig: jest.fn().mockImplementation(async () => {
        await gate;
        return configWith(settings);
      }),
      lookup,
      env: options.env ?? { GH_TOKEN: 'ghp_secret' },
      ...(options.userToken ? { userToken: options.userToken } : {}),
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

  describe('a token read the request no longer waits for', () => {
    const connectable = {
      ...enabled,
      oauth: { clientId: '${GH_CLIENT_ID}', clientSecret: '${GH_CLIENT_SECRET}' },
    };
    const env = { GH_CLIENT_ID: 'id', GH_CLIENT_SECRET: 'secret' };

    it('is not started once the configured deadline has passed', async () => {
      let open: () => void = () => undefined;
      const configGate = new Promise<void>((resolve) => (open = resolve));
      const userToken = jest.fn().mockResolvedValue('gho_user');
      const { run, res } = batch({
        settings: { ...connectable, batchTimeoutSeconds: 1 },
        env,
        userToken,
        configGate,
      });
      const running = run();
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      open();
      await running;
      await new Promise((resolve) => setImmediate(resolve));
      expect(res.status).toHaveBeenCalledWith(503);
      expect(userToken).not.toHaveBeenCalled();
    });

    it('is not started after the request was answered for a config read that took too long', async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
      try {
        let open: () => void = () => undefined;
        const configGate = new Promise<void>((resolve) => (open = resolve));
        const userToken = jest.fn().mockResolvedValue('gho_user');
        const { run, res } = batch({
          settings: { ...connectable, batchTimeoutSeconds: 120 },
          env,
          userToken,
          configGate,
        });
        const running = run();
        await jest.advanceTimersByTimeAsync(20_001);
        await running;
        expect(res.status).toHaveBeenCalledWith(503);
        /** The config arrives within its own, longer deadline, but nobody is waiting any more. */
        open();
        for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
        expect(userToken).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  it("looks the batch up with the user's own token", async () => {
    const { run, lookup } = batch({
      settings: {
        ...enabled,
        token: undefined,
        oauth: { clientId: '${GH_CLIENT_ID}', clientSecret: '${GH_CLIENT_SECRET}' },
      },
      env: { GH_CLIENT_ID: 'id', GH_CLIENT_SECRET: 'secret' },
      userToken: jest.fn().mockResolvedValue('gho_user'),
    });
    await run({ conversationIds: ['a', 'b'] });
    expect(lookup).toHaveBeenCalledWith(expect.objectContaining({ token: 'gho_user' }));
  });

  it("does not read the user's token for a batch whose lanes have no commit yet", async () => {
    const userToken = jest.fn().mockResolvedValue('gho_user');
    const { run } = batch({
      settings: {
        ...enabled,
        token: undefined,
        oauth: { clientId: '${GH_CLIENT_ID}', clientSecret: '${GH_CLIENT_SECRET}' },
      },
      env: { GH_CLIENT_ID: 'id', GH_CLIENT_SECRET: 'secret' },
      lanes: [{ conversationId: 'a', laneGit: { branch: 'feat/a', head: null, repo: 'o/r' } }],
      userToken,
    });
    await run({ conversationIds: ['a'] });
    expect(userToken).not.toHaveBeenCalled();
  });

  it("does not read the user's token for a batch while the feature is turned off", async () => {
    const userToken = jest.fn().mockResolvedValue('gho_user');
    const { run } = batch({
      settings: {
        ...enabled,
        enabled: false,
        oauth: { clientId: '${GH_CLIENT_ID}', clientSecret: '${GH_CLIENT_SECRET}' },
      },
      env: { GH_CLIENT_ID: 'id', GH_CLIENT_SECRET: 'secret' },
      userToken,
    });
    await run({ conversationIds: ['a', 'b'] });
    expect(userToken).not.toHaveBeenCalled();
  });

  it("does not read the user's token for a batch with no lane to look up", async () => {
    const userToken = jest.fn().mockResolvedValue('gho_user');
    const { run, res } = batch({
      settings: {
        ...enabled,
        oauth: { clientId: '${GH_CLIENT_ID}', clientSecret: '${GH_CLIENT_SECRET}' },
      },
      env: { GH_CLIENT_ID: 'id', GH_CLIENT_SECRET: 'secret' },
      lanes: [{ conversationId: 'b', laneGit: { branch: null, head: 'c0ffee1' } }],
      userToken,
    });
    await run({ conversationIds: ['a', 'b'] });
    expect(userToken).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("invalidates the user's own token when a batch lookup is refused with it", async () => {
    const userToken = Object.assign(jest.fn().mockResolvedValue('gho_user'), {
      reject: jest.fn().mockResolvedValue(undefined),
    });
    const { run, res } = batch({
      settings: {
        ...enabled,
        oauth: { clientId: '${GH_CLIENT_ID}', clientSecret: '${GH_CLIENT_SECRET}' },
      },
      env: { GH_CLIENT_ID: 'id', GH_CLIENT_SECRET: 'secret' },
      lanes: [lane('a', 'o/r')],
      lookup: jest.fn().mockResolvedValue({ ok: false, error: { code: 'CREDENTIAL_REJECTED' } }),
      userToken,
    });
    await run({ conversationIds: ['a'] });
    expect(userToken.reject).toHaveBeenCalledTimes(1);
    expect(userToken.reject).toHaveBeenCalledWith('u1', expect.anything(), 'gho_user');
    expect(res.json).toHaveBeenCalledWith({
      results: [{ conversationId: 'a', error: { code: 'UPSTREAM_ERROR' } }],
    });
  });

  it("answers the batch's lanes unavailable when the user's own token cannot be read", async () => {
    const { run, lookup, res } = batch({
      settings: {
        ...enabled,
        oauth: { clientId: '${GH_CLIENT_ID}', clientSecret: '${GH_CLIENT_SECRET}' },
      },
      env: { GH_CLIENT_ID: 'id', GH_CLIENT_SECRET: 'secret', GH_TOKEN: 'ghp_server' },
      lanes: [
        lane('a', 'elsewhere/private'),
        { conversationId: 'b', laneGit: { branch: null, head: 'c0ffee1' } },
      ],
      userToken: jest.fn().mockRejectedValue(new Error('refresh timed out')),
    });
    await run({ conversationIds: ['a', 'b'] });
    expect(lookup).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      results: [
        { conversationId: 'a', error: { code: 'UPSTREAM_ERROR' } },
        { conversationId: 'b', pullRequest: null },
      ],
    });
  });

  it('takes the host from the operator config for the batch too', async () => {
    const lookup = jest.fn().mockResolvedValue({ ok: true, value: pr });
    const handler = createConversationPullRequestsHandler({
      getConvosLaneGit: jest.fn().mockResolvedValue([lane('a')]),
      getAppConfig: jest
        .fn()
        .mockImplementation(async (options: { baseOnly?: boolean }) =>
          configWith(options.baseOnly ? enabled : { ...enabled, host: 'attacker.example' }),
        ),
      lookup,
      env: { GH_TOKEN: 'ghp_secret' },
    });
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await handler(
      { user: { id: 'u1' }, body: { conversationIds: ['a'] } } as unknown as ServerRequest,
      res as unknown as Response,
    );
    expect(lookup).toHaveBeenCalledWith(expect.objectContaining({ host: 'github.com' }));
  });

  it('keeps conversations on one lane apart when they linked different pull requests', async () => {
    const linked = (conversationId: string, pullRequest: number) => ({
      conversationId,
      laneGit: { branch: 'feat/x', head: 'c0ffee1', repo: 'o/r', pullRequest },
    });
    const { run, lookup } = batch({ lanes: [linked('a', 7), linked('b', 9)] });
    await run({ conversationIds: ['a', 'b'] });
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(lookup).toHaveBeenCalledWith(expect.objectContaining({ pullRequest: 7 }));
    expect(lookup).toHaveBeenCalledWith(expect.objectContaining({ pullRequest: 9 }));
  });

  it('looks up any repository on the batch route too, when the administrator opted in', async () => {
    const { run, lookup } = batch({
      settings: { allowAllRepositories: true },
      lanes: [
        {
          conversationId: 'a',
          laneGit: { branch: 'feat/x', head: 'c0ffee1', repo: 'someone/else' },
        },
      ],
      env: { GITHUB_TOKEN: 'ghp_deploy' },
    });
    await run({ conversationIds: ['a'] });
    expect(lookup).toHaveBeenCalledWith(expect.objectContaining({ repo: 'someone/else' }));
  });

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

    it('joins a lane another request already started instead of taking a slot of its own for it', async () => {
      const started: string[] = [];
      const releases: Array<() => void> = [];
      const lookup = jest.fn(
        (input: { branch: string }) =>
          new Promise((resolve) => {
            started.push(input.branch);
            releases.push(() => resolve({ ok: true, value: pr }));
          }),
      );
      const rows = [
        lane('a', 'o/r', 'feat/shared'),
        lane('b', 'o/r', 'feat/shared'),
        lane('e', 'o/r', 'feat/other'),
      ];
      const handler = createConversationPullRequestsHandler({
        getConvosLaneGit: jest.fn(async (_user: string, wanted: string[]) =>
          rows.filter((row) => wanted.includes(row.conversationId)),
        ),
        getAppConfig: jest
          .fn()
          .mockResolvedValue(
            configWith({ ...enabled, maxConcurrentLookups: 1, batchTimeoutSeconds: 5 }),
          ),
        lookup: lookup as never,
        env: { GH_TOKEN: 'ghp_secret' },
      });
      const call = (conversationIds: string[]) => {
        const out = { status: jest.fn().mockReturnThis(), json: jest.fn() };
        const done = handler(
          { user: { id: 'u1' }, body: { conversationIds } } as unknown as ServerRequest,
          out as unknown as Response,
        );
        return { out, done };
      };
      const first = call(['a']);
      await flush();
      const second = call(['b', 'e']);
      await flush();
      expect(started).toEqual(['feat/shared']);
      releases.shift()?.();
      await flush();
      /** The shared lane was answered once for both requests, so the only slot went to the other lane. */
      expect(started).toEqual(['feat/shared', 'feat/other']);
      releases.shift()?.();
      await Promise.all([first.done, second.done]);
      expect(second.out.json).toHaveBeenCalledWith({
        results: [
          { conversationId: 'b', pullRequest: pr },
          { conversationId: 'e', pullRequest: pr },
        ],
      });
    });

    it('does not join a lookup started for another host', async () => {
      const hosts: Array<string | undefined> = [];
      const lookup = jest.fn(
        (input: { host?: string }) =>
          new Promise(() => {
            hosts.push(input.host);
          }),
      );
      const settings = { ...enabled, batchTimeoutSeconds: 1 };
      const getAppConfig = jest
        .fn()
        .mockResolvedValueOnce(configWith(settings))
        .mockResolvedValueOnce(configWith(settings))
        .mockResolvedValue(configWith({ ...settings, host: 'ghe.example.com' }));
      const handler = createConversationPullRequestsHandler({
        getConvosLaneGit: jest.fn(async () => [lane('a', 'o/r', 'feat/shared')]),
        getAppConfig,
        lookup: lookup as never,
        env: { GH_TOKEN: 'ghp_secret' },
      });
      const call = () =>
        handler(
          { user: { id: 'u1' }, body: { conversationIds: ['a'] } } as unknown as ServerRequest,
          { status: jest.fn().mockReturnThis(), json: jest.fn() } as unknown as Response,
        );
      void call();
      await flush();
      void call();
      await flush();
      expect(hosts).toEqual(['github.com', 'ghe.example.com']);
    });

    it.each([
      ['sharing setting', { sharedCache: true }],
      ['shared cache deadline', { sharedCache: true, sharedCacheTimeoutMs: 10 }],
      ['cache capacity', { cacheMaxEntries: 50 }],
    ])('does not join a lookup started with another %s', async (_label, changed) => {
      const inputs: unknown[] = [];
      const lookup = jest.fn(
        (input: unknown) =>
          new Promise(() => {
            inputs.push(input);
          }),
      );
      const settings = { ...enabled, batchTimeoutSeconds: 1 };
      const getAppConfig = jest
        .fn()
        .mockResolvedValueOnce(configWith(settings))
        .mockResolvedValueOnce(configWith(settings))
        .mockResolvedValue(configWith({ ...settings, ...changed }));
      const handler = createConversationPullRequestsHandler({
        getConvosLaneGit: jest.fn(async () => [lane('a', 'o/r', 'feat/shared')]),
        getAppConfig,
        lookup: lookup as never,
        env: { GH_TOKEN: 'ghp_secret' },
      });
      const call = () =>
        handler(
          { user: { id: 'u1' }, body: { conversationIds: ['a'] } } as unknown as ServerRequest,
          { status: jest.fn().mockReturnThis(), json: jest.fn() } as unknown as Response,
        );
      void call();
      await flush();
      void call();
      await flush();
      expect(inputs).toHaveLength(2);
      expect(inputs[1]).toMatchObject(changed);
    });

    it('does not join a lookup started for another provider on the same host', async () => {
      const providers: Array<string | undefined> = [];
      const lookup = jest.fn(
        (input: { provider?: string }) =>
          new Promise(() => {
            providers.push(input.provider);
          }),
      );
      const settings = { ...enabled, host: 'git.example.com', batchTimeoutSeconds: 1 };
      const getAppConfig = jest
        .fn()
        .mockResolvedValueOnce(configWith(settings))
        .mockResolvedValueOnce(configWith(settings))
        .mockResolvedValue(configWith({ ...settings, provider: 'gitlab' as const }));
      const handler = createConversationPullRequestsHandler({
        getConvosLaneGit: jest.fn(async () => [lane('a', 'o/r', 'feat/shared')]),
        getAppConfig,
        lookup: lookup as never,
        env: { GH_TOKEN: 'ghp_secret' },
      });
      const call = () =>
        handler(
          { user: { id: 'u1' }, body: { conversationIds: ['a'] } } as unknown as ServerRequest,
          { status: jest.fn().mockReturnThis(), json: jest.fn() } as unknown as Response,
        );
      void call();
      await flush();
      void call();
      await flush();
      expect(providers).toEqual(['github', 'gitlab']);
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
    const single = setup({ laneGit: { branch: 'feat/a', head: 'c0ffee1', repo: 'o/r' } });
    await single.run();
    const many = batch({ lanes: [lane('a')] });
    await many.run({ conversationIds: ['a'] });
    expect(many.lookup.mock.calls[0][0]).toEqual(single.lookup.mock.calls[0][0]);
  });
});
