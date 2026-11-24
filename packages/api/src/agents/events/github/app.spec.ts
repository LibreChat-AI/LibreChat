import crypto, { createVerify, generateKeyPairSync } from 'node:crypto';
import type { App, AppConfig, GitHubErrorCode } from './app';
import type { PullRequestFetch } from '~/pulls/shared';
import { GitHubError, createApp } from './app';

const INSTALLATION = 4400;
const REPO = 'example-org/widgets';
const LOGIN = 'example-author';
const START = Date.UTC(2026, 10, 23, 12, 0, 0);
const HOUR = 3_600_000;
/** Text a reply or an exception carries that must never reach a caller. */
const MARKER = 'marker-5c1e77';

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY = rsa.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const KEY_BODY = KEY.split('\n')[1];

type Call = { url: string; method: string; headers: Record<string, string>; signal?: AbortSignal };
/** Answers one request; `time` is the client's clock when it was made. */
type Handler = (call: Call, time: number) => Response | Promise<Response>;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function isExchange(call: Call): boolean {
  return call.method === 'POST' && call.url.endsWith('/access_tokens');
}

/** GitHub as the client sees it: tokens numbered in the order they are issued. */
function harness(
  options: {
    config?: Partial<AppConfig>;
    exchange?: Handler;
    permission?: Handler;
  } = {},
) {
  const calls: Call[] = [];
  let time = START;
  let issued = 0;
  const exchange: Handler =
    options.exchange ??
    (() => {
      issued += 1;
      return json(
        { token: `ghs_token${issued}`, expires_at: new Date(time + HOUR).toISOString() },
        201,
      );
    });
  const permission: Handler = options.permission ?? (() => json({ permission: 'write' }));
  const fetch: PullRequestFetch = async (input, init) => {
    const call: Call = {
      url: input,
      method: init?.method ?? 'GET',
      headers: {},
      ...(init?.signal != null && { signal: init.signal }),
    };
    /** Recorded before its headers are read, so a request whose header cannot be sent counts. */
    calls.push(call);
    call.headers = Object.fromEntries(new Headers(init?.headers).entries());
    return isExchange(call) ? exchange(call, time) : permission(call, time);
  };
  const app: App = createApp(
    { id: 'Iv1.example', key: KEY, host: 'github.com', timeoutMs: 10_000, ...options.config },
    { fetch, now: () => time },
  );
  return {
    app,
    calls,
    exchanges: () => calls.filter(isExchange),
    questions: () => calls.filter((call) => !isExchange(call)),
    advance: (ms: number) => {
      time += ms;
    },
  };
}

/** The installation an exchange asks a token for. */
function installationOf(call: Call): string | undefined {
  return /\/installations\/(\d+)\//.exec(call.url)?.[1];
}

/** The rejection of `pending`, which must be a `GitHubError` with this code and status. */
async function outage(
  pending: Promise<unknown>,
  code: GitHubErrorCode,
  status?: number,
): Promise<GitHubError> {
  const error = await pending.then(
    () => {
      throw new Error('expected a GitHubError');
    },
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(GitHubError);
  const thrown = error as GitHubError;
  expect({ code: thrown.code, status: thrown.status }).toEqual({ code, status });
  expect(thrown.message).toBe(`GitHub app request failed: ${code}`);
  expect(thrown.cause).toBeUndefined();
  return thrown;
}

function bearer(call: Call): string {
  return call.headers.authorization.replace(/^Bearer /, '');
}

describe('createApp access', () => {
  it('exchanges an app token for an installation token and asks with it', async () => {
    const { app, calls } = harness();
    await expect(app.access(INSTALLATION, REPO, LOGIN)).resolves.toEqual({
      ok: true,
      value: { write: true },
    });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `POST https://api.github.com/app/installations/${INSTALLATION}/access_tokens`,
      `GET https://api.github.com/repos/${REPO}/collaborators/${LOGIN}/permission`,
    ]);
    expect(bearer(calls[1])).toBe('ghs_token1');
    for (const call of calls) {
      expect(call.headers).toMatchObject({
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'LibreChat-Agent-Events',
      });
      expect(call.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('signs the app token with the private key, dated a minute back and under ten minutes', async () => {
    const { app, calls } = harness();
    await app.access(INSTALLATION, REPO, LOGIN);
    const [head, claims, signature] = bearer(calls[0]).split('.');
    expect(JSON.parse(Buffer.from(head, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toEqual({
      iat: START / 1000 - 60,
      exp: START / 1000 + 540,
      iss: 'Iv1.example',
    });
    expect(
      createVerify('RSA-SHA256')
        .update(`${head}.${claims}`)
        .verify(rsa.publicKey, signature, 'base64url'),
    ).toBe(true);
  });

  it.each([
    ['github.com', 'https://api.github.com'],
    ['acme.ghe.com', 'https://api.acme.ghe.com'],
    ['github.example.com', 'https://github.example.com/api/v3'],
  ])('asks the API of %s', async (host, base) => {
    const { app, calls } = harness({ config: { host } });
    await app.access(INSTALLATION, REPO, LOGIN);
    expect(calls.map((call) => call.url.slice(0, base.length + 1))).toEqual([
      `${base}/`,
      `${base}/`,
    ]);
  });

  it.each([
    ['admin', true],
    ['write', true],
    ['read', false],
    ['none', false],
  ])('reads the permission %s as write %s', async (permission, write) => {
    const { app } = harness({ permission: () => json({ permission, role_name: 'maintain' }) });
    await expect(app.access(INSTALLATION, REPO, LOGIN)).resolves.toEqual({
      ok: true,
      value: { write },
    });
  });

  it('reads an account GitHub does not know as a collaborator as a plain no', async () => {
    const { app, calls } = harness({ permission: () => json({ message: 'Not Found' }, 404) });
    await expect(app.access(INSTALLATION, REPO, 'example-app[bot]')).resolves.toEqual({
      ok: true,
      value: { write: false },
    });
    expect(calls[1].url).toBe(
      `https://api.github.com/repos/${REPO}/collaborators/example-app%5Bbot%5D/permission`,
    );
  });

  it.each([
    ['a repository that is not owner/name', 'example-org', LOGIN],
    ['a repository with a third segment', 'example-org/widgets/extra', LOGIN],
    ['a repository named ..', 'example-org/..', LOGIN],
    ['an owner named .', './widgets', LOGIN],
    ['a repository with a query', 'example-org/widgets?x=1', LOGIN],
    ['a login with a slash', REPO, 'a/b'],
    ['a login of ..', REPO, '..'],
    ['a login with an encoded slash', REPO, 'a%2Fb'],
    ['an empty login', REPO, ''],
    ['a login longer than GitHub allows', REPO, 'a'.repeat(101)],
  ])('answers no for %s without asking GitHub', async (_name, repo, login) => {
    const { app, calls } = harness();
    await expect(app.access(INSTALLATION, repo, login)).resolves.toEqual({
      ok: true,
      value: { write: false },
    });
    expect(calls).toEqual([]);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'reports installation %p as missing without asking GitHub',
    async (installation) => {
      const { app, calls } = harness();
      await expect(app.access(installation, REPO, LOGIN)).resolves.toEqual({
        ok: false,
        error: { code: 'missing' },
      });
      expect(calls).toEqual([]);
    },
  );
});

describe('createApp installation tokens', () => {
  it('reuses a token for later questions', async () => {
    const { app, exchanges, questions } = harness();
    await app.access(INSTALLATION, REPO, LOGIN);
    await app.access(INSTALLATION, REPO, 'another-author');
    expect(exchanges()).toHaveLength(1);
    expect(questions().map(bearer)).toEqual(['ghs_token1', 'ghs_token1']);
  });

  it('shares one exchange between questions asked at once', async () => {
    const { app, exchanges, questions } = harness();
    const answers = await Promise.all([
      app.access(INSTALLATION, REPO, LOGIN),
      app.access(INSTALLATION, REPO, 'another-author'),
      app.access(INSTALLATION, 'example-org/gadgets', LOGIN),
    ]);
    expect(answers.every((answer) => answer.ok)).toBe(true);
    expect(exchanges()).toHaveLength(1);
    expect(questions()).toHaveLength(3);
  });

  it('holds a token for each installation', async () => {
    const { app, exchanges, questions } = harness();
    await app.access(INSTALLATION, REPO, LOGIN);
    await app.access(INSTALLATION + 1, REPO, LOGIN);
    await app.access(INSTALLATION, REPO, LOGIN);
    expect(exchanges().map((call) => installationOf(call))).toEqual(['4400', '4401']);
    expect(questions().map(bearer)).toEqual(['ghs_token1', 'ghs_token2', 'ghs_token1']);
  });

  it('replaces a token a minute and one request timeout before GitHub expires it', async () => {
    const { app, exchanges, questions, advance } = harness({ config: { timeoutMs: 10_000 } });
    await app.access(INSTALLATION, REPO, LOGIN);
    advance(HOUR - 70_000 - 1);
    await app.access(INSTALLATION, REPO, LOGIN);
    expect(exchanges()).toHaveLength(1);
    advance(1);
    await app.access(INSTALLATION, REPO, LOGIN);
    expect(exchanges()).toHaveLength(2);
    expect(questions().map(bearer)).toEqual(['ghs_token1', 'ghs_token1', 'ghs_token2']);
  });

  it('drops the oldest token once more installations are held than its capacity', async () => {
    const { app, exchanges } = harness({ config: { capacity: 2 } });
    await app.access(1, REPO, LOGIN);
    await app.access(2, REPO, LOGIN);
    await app.access(1, REPO, LOGIN);
    expect(exchanges()).toHaveLength(2);
    await app.access(3, REPO, LOGIN);
    await app.access(2, REPO, LOGIN);
    expect(exchanges()).toHaveLength(3);
    await app.access(1, REPO, LOGIN);
    expect(exchanges().map((call) => installationOf(call))).toEqual(['1', '2', '3', '1']);
  });

  it('keeps the other tokens when one installation replaces its own at capacity', async () => {
    const { app, exchanges, advance } = harness({
      config: { capacity: 2 },
      exchange: (call, time) => {
        const installation = installationOf(call);
        const lifetime = installation === '1' ? HOUR / 2 : HOUR * 2;
        return json(
          {
            token: `ghs_for${installation}at${time}`,
            expires_at: new Date(time + lifetime).toISOString(),
          },
          201,
        );
      },
    });
    await app.access(2, REPO, LOGIN);
    await app.access(1, REPO, LOGIN);
    advance(HOUR);
    await app.access(1, REPO, LOGIN);
    await app.access(2, REPO, LOGIN);
    expect(exchanges().map((call) => installationOf(call))).toEqual(['2', '1', '1']);
  });

  it('loads the private key once', async () => {
    const load = jest.spyOn(crypto, 'createPrivateKey');
    try {
      const { app, exchanges } = harness({ config: { capacity: 1 } });
      await app.access(1, REPO, LOGIN);
      await app.access(2, REPO, LOGIN);
      expect(exchanges()).toHaveLength(2);
      expect(load).toHaveBeenCalledTimes(1);
    } finally {
      load.mockRestore();
    }
  });

  it('does not exchange again after a failed exchange until it is asked again', async () => {
    let fail = true;
    const { app, exchanges } = harness({
      exchange: () => {
        if (fail) {
          return json({ message: MARKER }, 500);
        }
        return json({ token: 'ghs_later', expires_at: new Date(START + HOUR).toISOString() }, 201);
      },
    });
    await outage(app.access(INSTALLATION, REPO, LOGIN), 'upstream', 500);
    fail = false;
    await expect(app.access(INSTALLATION, REPO, LOGIN)).resolves.toEqual({
      ok: true,
      value: { write: true },
    });
    expect(exchanges()).toHaveLength(2);
  });

  it.each([
    ['rejects the app token', () => json({ message: MARKER }, 401), 'credential'],
    ['has no such installation', () => json({ message: MARKER }, 404), 'missing'],
    ['forbids the installation', () => json({ message: MARKER }, 403), 'forbidden'],
  ] as const)('answers that GitHub %s and asks no question', async (_name, exchange, code) => {
    const { app, questions } = harness({ exchange });
    const answer = await app.access(INSTALLATION, REPO, LOGIN);
    expect(answer).toEqual({ ok: false, error: { code } });
    expect(questions()).toEqual([]);
  });

  it.each([
    ['fails', () => json({ message: MARKER }, 500), 500],
    ['answers with a status nothing expects', () => json({ message: MARKER }, 422), 422],
    ['answers with something that is not JSON', () => new Response(MARKER, { status: 201 }), 201],
    ['answers without a token', () => json({ expires_at: '2026-11-23T13:00:00Z' }, 201), 201],
    [
      'answers with a token that is not text',
      () => json({ token: 7, expires_at: '2026-11-23T13:00:00Z' }, 201),
      201,
    ],
    [
      'answers with a token holding a line break',
      () => json({ token: 'ghs_a\r\nx: y', expires_at: '2026-11-23T13:00:00Z' }, 201),
      201,
    ],
    ['answers without an expiry', () => json({ token: 'ghs_a' }, 201), 201],
    [
      'answers with an expiry that is not a time',
      () => json({ token: 'ghs_a', expires_at: MARKER }, 201),
      201,
    ],
  ] as const)('throws when GitHub %s and asks no question', async (_name, exchange, status) => {
    const { app, questions } = harness({ exchange });
    await outage(app.access(INSTALLATION, REPO, LOGIN), 'upstream', status);
    expect(questions()).toEqual([]);
  });

  it('throws a network failure when the exchange cannot be sent, without its text', async () => {
    const { app } = harness({
      exchange: () => {
        throw new Error(`connect failed ${MARKER}`);
      },
    });
    const error = await outage(app.access(INSTALLATION, REPO, LOGIN), 'network');
    expect(String(error.stack)).not.toContain(MARKER);
  });

  it('lets the next question exchange again after an exchange threw', async () => {
    let fail = true;
    const { app, exchanges } = harness({
      exchange: () => {
        if (fail) {
          throw new Error('connect failed');
        }
        return json({ token: 'ghs_later', expires_at: new Date(START + HOUR).toISOString() }, 201);
      },
    });
    await Promise.all([
      outage(app.access(INSTALLATION, REPO, LOGIN), 'network'),
      outage(app.access(INSTALLATION, REPO, 'another-author'), 'network'),
    ]);
    expect(exchanges()).toHaveLength(1);
    fail = false;
    await expect(app.access(INSTALLATION, REPO, LOGIN)).resolves.toEqual({
      ok: true,
      value: { write: true },
    });
    expect(exchanges()).toHaveLength(2);
  });

  it.each([
    ['is not a key', `-----BEGIN RSA PRIVATE KEY-----\n${MARKER}\n-----END RSA PRIVATE KEY-----`],
    ['is empty', ''],
    [
      'is not an RSA key',
      generateKeyPairSync('ec', { namedCurve: 'P-256' })
        .privateKey.export({ type: 'pkcs8', format: 'pem' })
        .toString(),
    ],
  ])('throws a key failure for a private key that %s, without asking', async (_name, key) => {
    const { app, calls } = harness({ config: { key } });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await outage(app.access(INSTALLATION, REPO, LOGIN), 'key');
    }
    expect(calls).toEqual([]);
  });

  it('throws a key failure when signing fails, without asking', async () => {
    const sign = jest.spyOn(crypto, 'createSign').mockImplementation(() => {
      throw new Error(`sign failed ${MARKER}`);
    });
    try {
      const { app, calls } = harness();
      const error = await outage(app.access(INSTALLATION, REPO, LOGIN), 'key');
      expect(String(error.stack)).not.toContain(MARKER);
      expect(calls).toEqual([]);
    } finally {
      sign.mockRestore();
    }
  });

  it('accepts the key in PKCS#8 as well as the PKCS#1 GitHub issues', async () => {
    const key = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const { app } = harness({ config: { key } });
    await expect(app.access(INSTALLATION, REPO, LOGIN)).resolves.toEqual({
      ok: true,
      value: { write: true },
    });
  });
});

describe('createApp access failures', () => {
  it('tries one fresh token when GitHub rejects the held one', async () => {
    const { app, exchanges, questions } = harness({
      permission: (call) =>
        bearer(call) === 'ghs_token1'
          ? json({ message: 'Bad credentials' }, 401)
          : json({ permission: 'admin' }),
    });
    await expect(app.access(INSTALLATION, REPO, LOGIN)).resolves.toEqual({
      ok: true,
      value: { write: true },
    });
    expect(exchanges()).toHaveLength(2);
    expect(questions().map(bearer)).toEqual(['ghs_token1', 'ghs_token2']);
  });

  it('reports a credential failure when the fresh token is rejected too, and asks no more', async () => {
    const { app, exchanges, questions } = harness({
      permission: () => json({ message: MARKER }, 401),
    });
    await expect(app.access(INSTALLATION, REPO, LOGIN)).resolves.toEqual({
      ok: false,
      error: { code: 'credential' },
    });
    expect(exchanges()).toHaveLength(2);
    expect(questions()).toHaveLength(2);
  });

  it('keeps a newer token when an older one is rejected', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { app, exchanges, questions, advance } = harness({
      permission: async (call) => {
        if (bearer(call) !== 'ghs_token1') {
          return json({ permission: 'write' });
        }
        await gate;
        return json({ message: 'Bad credentials' }, 401);
      },
    });
    const slow = app.access(INSTALLATION, REPO, LOGIN);
    await new Promise((resolve) => setImmediate(resolve));
    advance(HOUR);
    await app.access(INSTALLATION, REPO, 'another-author');
    release?.();
    await expect(slow).resolves.toEqual({ ok: true, value: { write: true } });
    expect(exchanges()).toHaveLength(2);
    expect(questions().map(bearer)).toEqual(['ghs_token1', 'ghs_token2', 'ghs_token2']);
  });

  it('answers forbidden when GitHub forbids the question', async () => {
    const { app } = harness({ permission: () => json({ message: MARKER }, 403) });
    await expect(app.access(INSTALLATION, REPO, LOGIN)).resolves.toEqual({
      ok: false,
      error: { code: 'forbidden' },
    });
  });

  it.each([
    ['fails', () => json({ message: MARKER }, 502), 502],
    ['answers with a status nothing expects', () => json({ message: MARKER }, 422), 422],
    ['answers with something that is not JSON', () => new Response(MARKER), 200],
    ['answers with a permission it does not document', () => json({ permission: 'maintain' }), 200],
    ['answers without a permission', () => json({ role_name: 'admin' }), 200],
    ['answers with a list', () => json([{ permission: 'admin' }]), 200],
  ] as const)('throws when GitHub %s', async (_name, permission, status) => {
    const { app, questions } = harness({ permission });
    await outage(app.access(INSTALLATION, REPO, LOGIN), 'upstream', status);
    expect(questions()).toHaveLength(1);
  });

  it('throws a network failure when the question cannot be sent, without its text', async () => {
    const { app } = harness({
      permission: () => {
        throw new Error(`socket hang up ${MARKER}`);
      },
    });
    const error = await outage(app.access(INSTALLATION, REPO, LOGIN), 'network');
    expect(String(error.stack)).not.toContain(MARKER);
  });

  it('throws a timeout for a request that outlasts its timeout', async () => {
    const { app, questions } = harness({
      config: { timeoutMs: 20 },
      permission: (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.signal?.addEventListener('abort', () => reject(call.signal?.reason));
        }),
    });
    await outage(app.access(INSTALLATION, REPO, LOGIN), 'timeout');
    expect(questions()[0].signal?.aborted).toBe(true);
  });

  it('keeps the held token after a question throws', async () => {
    let fail = true;
    const { app, exchanges } = harness({
      permission: () => (fail ? json({}, 500) : json({ permission: 'write' })),
    });
    await outage(app.access(INSTALLATION, REPO, LOGIN), 'upstream', 500);
    fail = false;
    await expect(app.access(INSTALLATION, REPO, LOGIN)).resolves.toEqual({
      ok: true,
      value: { write: true },
    });
    expect(exchanges()).toHaveLength(1);
  });
});

describe('createApp rate limits', () => {
  it.each([
    ['a 429 naming a wait', () => json({}, 429, { 'retry-after': '30' }), 30_000],
    [
      'a 403 with no requests remaining',
      () =>
        json({}, 403, {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Date.now() / 1000 + 120),
        }),
      120_000,
    ],
    [
      'a secondary limit that names no wait',
      () => json({ message: 'You have exceeded a secondary rate limit.' }, 403),
      60_000,
    ],
    ['a 429 that names no wait', () => json({}, 429), 60_000],
    ['a wait longer than an hour', () => json({}, 429, { 'retry-after': '86400' }), 3_600_000],
  ] as const)('reports %s as limited on a question', async (_name, permission, wait) => {
    const { app } = harness({ permission });
    const answer = await app.access(INSTALLATION, REPO, LOGIN);
    expect(answer.ok).toBe(false);
    expect(!answer.ok && answer.error.code).toBe('limited');
    const retryAfterMs = answer.ok ? undefined : answer.error.retryAfterMs;
    expect(retryAfterMs).toBeGreaterThan(wait - 2_000);
    expect(retryAfterMs).toBeLessThanOrEqual(wait);
  });

  it('reports a limited exchange as limited', async () => {
    const { app, questions } = harness({
      exchange: () => json({}, 429, { 'retry-after': '45' }),
    });
    await expect(app.access(INSTALLATION, REPO, LOGIN)).resolves.toEqual({
      ok: false,
      error: { code: 'limited', retryAfterMs: 45_000 },
    });
    expect(questions()).toEqual([]);
  });

  it('does not ask again for that installation until the wait is over', async () => {
    let limited = true;
    const { app, calls, advance } = harness({
      permission: () =>
        limited ? json({}, 429, { 'retry-after': '30' }) : json({ permission: 'write' }),
    });
    await app.access(INSTALLATION, REPO, LOGIN);
    limited = false;
    const asked = calls.length;
    advance(10_000);
    await expect(app.access(INSTALLATION, REPO, 'another-author')).resolves.toEqual({
      ok: false,
      error: { code: 'limited', retryAfterMs: 20_000 },
    });
    expect(calls).toHaveLength(asked);
    await expect(app.access(INSTALLATION + 1, REPO, LOGIN)).resolves.toEqual({
      ok: true,
      value: { write: true },
    });
    advance(20_000);
    await expect(app.access(INSTALLATION, REPO, LOGIN)).resolves.toEqual({
      ok: true,
      value: { write: true },
    });
  });
});

describe('createApp disclosure', () => {
  it("never returns or throws a token, the key or GitHub's words", async () => {
    const replies: Array<[Handler | undefined, Handler | undefined]> = [
      [undefined, undefined],
      [undefined, () => json({ message: MARKER }, 401)],
      [undefined, () => json({ message: MARKER }, 403)],
      [undefined, () => json({ message: MARKER }, 404)],
      [undefined, () => json({ message: MARKER }, 500)],
      [undefined, () => json({ permission: MARKER })],
      [undefined, () => json({ message: MARKER }, 429, { 'retry-after': '5' })],
      [() => json({ message: MARKER }, 401), undefined],
      [() => json({ message: MARKER }, 500), undefined],
      [() => json({ token: MARKER.repeat(200), expires_at: MARKER }, 201), undefined],
      [() => json({ token: 'ghs_ok' }, 201), undefined],
      [
        () => {
          throw new Error(MARKER);
        },
        undefined,
      ],
      [
        undefined,
        () => {
          throw new Error(MARKER);
        },
      ],
    ];
    let thrown = 0;
    for (const [exchange, permission] of replies) {
      const { app, calls } = harness({
        ...(exchange != null && { exchange }),
        ...(permission != null && { permission }),
      });
      const text = await app.access(INSTALLATION, REPO, LOGIN).then(
        (answer) => JSON.stringify(answer),
        (error: GitHubError) => {
          thrown += 1;
          return [
            JSON.stringify(error),
            String(error),
            String(error.stack),
            JSON.stringify(Object.entries(error)),
          ].join('\n');
        },
      );
      expect(text).not.toContain(MARKER);
      expect(text).not.toContain('ghs_');
      expect(text).not.toContain(KEY_BODY);
      for (const call of calls) {
        expect(text).not.toContain(bearer(call));
      }
    }
    expect(thrown).toBe(7);
  });
});

describe('createApp as the app itself', () => {
  const page = { html_url: 'https://github.com/apps/example-events', slug: 'example-events' };
  const installed = {
    id: INSTALLATION,
    account: { id: 9001, login: 'example-org', type: 'Organization' },
    suspended_at: null,
  };

  it('reads the app page with the app token, not an installation token', async () => {
    const { app, calls, exchanges } = harness({ permission: () => json(page) });
    await expect(app.about()).resolves.toEqual({
      ok: true,
      value: { url: 'https://github.com/apps/example-events' },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.github.com/app');
    expect(calls[0].method).toBe('GET');
    expect(bearer(calls[0]).split('.')).toHaveLength(3);
    expect(exchanges()).toHaveLength(0);
  });

  it.each([
    ['another host', { html_url: 'https://example.com/apps/example-events' }],
    ['plain HTTP', { html_url: 'http://github.com/apps/example-events' }],
    ['a query', { html_url: 'https://github.com/apps/example-events?next=x' }],
    ['no page', { slug: 'example-events' }],
    ['a page that is not a URL', { html_url: 'not a url' }],
  ])('throws an upstream failure for an app page on %s', async (_label, body) => {
    expect.hasAssertions();
    const { app } = harness({ permission: () => json(body) });
    await outage(app.about(), 'upstream', 200);
  });

  it('keeps an Enterprise host with its port', async () => {
    const { app, calls } = harness({
      config: { host: 'git.example.com:8443' },
      permission: () => json({ html_url: 'https://git.example.com:8443/github-apps/events/' }),
    });
    await expect(app.about()).resolves.toEqual({
      ok: true,
      value: { url: 'https://git.example.com:8443/github-apps/events' },
    });
    expect(calls[0].url).toBe('https://git.example.com:8443/api/v3/app');
  });

  it('reads one installation of the app: its account and whether it is suspended', async () => {
    const { app, calls } = harness({ permission: () => json(installed) });
    await expect(app.installation(INSTALLATION)).resolves.toEqual({
      ok: true,
      value: { account: { id: '9001', name: 'example-org' }, suspended: false },
    });
    expect(calls[0].url).toBe(`https://api.github.com/app/installations/${INSTALLATION}`);
    const held = harness({
      permission: () => json({ ...installed, suspended_at: '2026-11-20T00:00:00Z' }),
    });
    await expect(held.app.installation(INSTALLATION)).resolves.toMatchObject({
      ok: true,
      value: { suspended: true },
    });
  });

  it.each([
    [401, 'credential'],
    [403, 'forbidden'],
    [404, 'missing'],
  ] as const)('answers GitHub status %i as %s', async (status, code) => {
    const { app } = harness({ permission: () => json({ message: MARKER }, status) });
    await expect(app.installation(INSTALLATION)).resolves.toEqual({ ok: false, error: { code } });
    await expect(app.about()).resolves.toEqual({ ok: false, error: { code } });
  });

  it('answers a rate limit as limited with the wait GitHub asked for', async () => {
    const { app } = harness({
      permission: () => json({ message: MARKER }, 429, { 'retry-after': '30' }),
    });
    await expect(app.installation(INSTALLATION)).resolves.toEqual({
      ok: false,
      error: { code: 'limited', retryAfterMs: 30_000 },
    });
  });

  it('throws an upstream failure for a server error or an account that does not read', async () => {
    expect.hasAssertions();
    await outage(
      harness({ permission: () => json({ message: MARKER }, 502) }).app.installation(INSTALLATION),
      'upstream',
      502,
    );
    await outage(
      harness({
        permission: () => json({ ...installed, account: { id: 9001, login: '../x' } }),
      }).app.installation(INSTALLATION),
      'upstream',
      200,
    );
    await outage(
      harness({ permission: () => json({ id: INSTALLATION }) }).app.installation(INSTALLATION),
      'upstream',
      200,
    );
  });

  it('asks nothing for an id that is not one', async () => {
    const { app, calls } = harness();
    for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
      await expect(app.installation(id)).resolves.toEqual({
        ok: false,
        error: { code: 'missing' },
      });
    }
    expect(calls).toHaveLength(0);
  });

  it('throws a key failure without asking when the key does not load', async () => {
    const { app, calls } = harness({ config: { key: 'not a key' } });
    await outage(app.about(), 'key');
    expect(calls).toHaveLength(0);
  });
});

describe('createApp owns', () => {
  const CLIENT = { id: 'Iv23.client', secret: 'client-secret-6b0e' };
  const USER_TOKEN = 'ghu_usertoken77c4';
  type Sent = { url: string; method: string; body: string; headers: Record<string, string> };

  /** GitHub's token endpoint and the user's installations, as `answer` decides. */
  function owner(
    answer: (sent: Sent) => Response | Promise<Response>,
    config: Partial<AppConfig> = {},
  ) {
    const sent: Sent[] = [];
    const fetch: PullRequestFetch = async (input, init) => {
      const entry: Sent = {
        url: input,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : '',
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      };
      sent.push(entry);
      return answer(entry);
    };
    const app = createApp(
      {
        id: 'Iv1.example',
        key: KEY,
        host: 'github.com',
        timeoutMs: 10_000,
        client: CLIENT,
        ...config,
      },
      { fetch, now: () => START },
    );
    return { app, sent };
  }

  const isToken = (sent: Sent) => sent.url.endsWith('/login/oauth/access_token');
  const page = (url: string) => Number(new URL(url).searchParams.get('page'));

  /** An account that can access `ids`, a hundred to a page. */
  const account = (ids: number[]) => (sent: Sent) =>
    isToken(sent)
      ? json({ access_token: USER_TOKEN, token_type: 'bearer' })
      : json({
          total_count: ids.length,
          installations: ids
            .slice((page(sent.url) - 1) * 100, page(sent.url) * 100)
            .map((id) => ({ id })),
        });

  it('redeems the code with the client on the app host and asks as that account', async () => {
    const { app, sent } = owner(account([12, INSTALLATION]));
    await expect(app.owns('code1f2e', INSTALLATION)).resolves.toEqual({ ok: true, value: true });
    expect(sent.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
      'POST https://github.com/login/oauth/access_token',
      'GET https://api.github.com/user/installations?per_page=100&page=1',
    ]);
    expect(Object.fromEntries(new URLSearchParams(sent[0].body))).toEqual({
      client_id: CLIENT.id,
      client_secret: CLIENT.secret,
      code: 'code1f2e',
    });
    expect(sent[0].headers.accept).toBe('application/json');
    expect(sent[1].headers.authorization).toBe(`Bearer ${USER_TOKEN}`);
  });

  it('answers no for an installation the account cannot access', async () => {
    const { app } = owner(account([12, 13]));
    await expect(app.owns('code1f2e', INSTALLATION)).resolves.toEqual({ ok: true, value: false });
  });

  it('reads further pages, and stops at the last one', async () => {
    const ids = Array.from({ length: 250 }, (_, index) => 10_000 + index);
    ids[180] = INSTALLATION;
    let found = owner(account(ids));
    await expect(found.app.owns('code1f2e', INSTALLATION)).resolves.toEqual({
      ok: true,
      value: true,
    });
    expect(found.sent.filter((entry) => !isToken(entry)).map((entry) => page(entry.url))).toEqual([
      1, 2,
    ]);
    found = owner(account(ids.filter((id) => id !== INSTALLATION)));
    await expect(found.app.owns('code1f2e', INSTALLATION)).resolves.toEqual({
      ok: true,
      value: false,
    });
    expect(found.sent.filter((entry) => !isToken(entry))).toHaveLength(3);
  });

  it('reads at most ten pages', async () => {
    const ids = Array.from({ length: 5_000 }, (_, index) => 10_000 + index);
    const { app, sent } = owner(account(ids));
    await expect(app.owns('code1f2e', INSTALLATION)).resolves.toEqual({ ok: true, value: false });
    expect(sent.filter((entry) => !isToken(entry))).toHaveLength(10);
  });

  it('uses the Enterprise host for the token and its API for the account', async () => {
    const { app, sent } = owner(account([INSTALLATION]), { host: 'git.example.com:8443' });
    await app.owns('code1f2e', INSTALLATION);
    expect(sent.map((entry) => entry.url)).toEqual([
      'https://git.example.com:8443/login/oauth/access_token',
      'https://git.example.com:8443/api/v3/user/installations?per_page=100&page=1',
    ]);
  });

  it.each([
    ['bad_verification_code', 'code'],
    ['redirect_uri_mismatch', 'code'],
    ['incorrect_client_credentials', 'credential'],
  ] as const)('answers the token endpoint refusing with %s as %s', async (error, code) => {
    const { app, sent } = owner(() => json({ error, error_description: MARKER }));
    await expect(app.owns('code1f2e', INSTALLATION)).resolves.toEqual({
      ok: false,
      error: { code },
    });
    expect(sent).toHaveLength(1);
  });

  it('answers a rejected account token as credential and a rate limit as limited', async () => {
    let { app } = owner((sent) =>
      isToken(sent) ? json({ access_token: USER_TOKEN }) : json({ message: MARKER }, 401),
    );
    await expect(app.owns('code1f2e', INSTALLATION)).resolves.toEqual({
      ok: false,
      error: { code: 'credential' },
    });
    ({ app } = owner(() => json({ message: MARKER }, 429, { 'retry-after': '20' })));
    await expect(app.owns('code1f2e', INSTALLATION)).resolves.toEqual({
      ok: false,
      error: { code: 'limited', retryAfterMs: 20_000 },
    });
  });

  it("answers the account's installation list being limited or forbidden as GitHub said", async () => {
    const list =
      (status: number, headers: Record<string, string> = {}) =>
      (sent: Sent) =>
        isToken(sent)
          ? json({ access_token: USER_TOKEN })
          : json({ message: MARKER }, status, headers);
    await expect(
      owner(list(429, { 'retry-after': '5' })).app.owns('code1f2e', INSTALLATION),
    ).resolves.toEqual({ ok: false, error: { code: 'limited', retryAfterMs: 5_000 } });
    await expect(owner(list(403)).app.owns('code1f2e', INSTALLATION)).resolves.toEqual({
      ok: false,
      error: { code: 'forbidden' },
    });
  });

  it('throws an outage for a server error, an unreadable token, an unreadable list or a failed request', async () => {
    expect.hasAssertions();
    await outage(
      owner(() => json({ message: MARKER }, 502)).app.owns('c', INSTALLATION),
      'upstream',
      502,
    );
    await outage(
      owner(() => json({ token_type: 'bearer' })).app.owns('c', INSTALLATION),
      'upstream',
      200,
    );
    await outage(
      owner((sent) =>
        isToken(sent) ? json({ access_token: USER_TOKEN }) : json({ total_count: 1 }),
      ).app.owns('c', INSTALLATION),
      'upstream',
      200,
    );
    await outage(
      owner(() => {
        throw new Error(MARKER);
      }).app.owns('c', INSTALLATION),
      'network',
    );
  });

  it('asks nothing without a client, for a code that does not read, or for an id that is not one', async () => {
    const bare = owner(account([INSTALLATION]), { client: undefined });
    await expect(bare.app.owns('code1f2e', INSTALLATION)).resolves.toEqual({
      ok: false,
      error: { code: 'credential' },
    });
    const { app, sent } = owner(account([INSTALLATION]));
    await expect(app.owns('a code', INSTALLATION)).resolves.toEqual({
      ok: false,
      error: { code: 'code' },
    });
    await expect(app.owns('code1f2e', 0)).resolves.toEqual({
      ok: false,
      error: { code: 'missing' },
    });
    expect([...bare.sent, ...sent]).toHaveLength(0);
  });

  it("never returns or throws the account's token or the client secret", async () => {
    const seen: unknown[] = [];
    const answers: Array<(sent: Sent) => Response> = [
      account([INSTALLATION]),
      account([1]),
      () => json({ error: 'bad_verification_code', error_description: USER_TOKEN }),
      (sent) =>
        isToken(sent) ? json({ access_token: USER_TOKEN }) : json({ message: USER_TOKEN }, 500),
      () => {
        throw new Error(`${USER_TOKEN} ${CLIENT.secret}`);
      },
    ];
    for (const answer of answers) {
      seen.push(
        await owner(answer)
          .app.owns('code1f2e', INSTALLATION)
          .catch((error: unknown) => ({ ...(error as object), message: (error as Error).message })),
      );
    }
    const text = JSON.stringify(seen);
    expect(text).not.toContain(USER_TOKEN);
    expect(text).not.toContain(CLIENT.secret);
  });
});
