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
