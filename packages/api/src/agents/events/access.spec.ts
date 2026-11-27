import { logger } from '@librechat/data-schemas';
import { generateKeyPairSync } from 'node:crypto';
import type { PullRequestFetch } from '~/pulls/shared';
import type { App } from './github/app';
import { GitHubError, createApp } from './github/app';
import { createAccessCheck } from './access';

const INSTALLATION = 4400;
const REPO = 'example-org/widgets';
const LOGIN = 'example-author';
const START = Date.UTC(2026, 10, 24, 12, 0, 0);
const HOUR = 3_600_000;
/** Text a reply carries that must never reach a log. */
const MARKER = 'marker-7a11ce';

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY = rsa.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * GitHub as the app sees it, answering each permission question with `answer`, and the
 * access check over that app with a five minute lifetime unless one is given.
 */
function harness(answer: () => Response | Promise<Response>, ttlMs = 300_000, capacity?: number) {
  let time = START;
  const questions: string[] = [];
  const fetch: PullRequestFetch = async (url, init) => {
    if ((init?.method ?? 'GET') === 'POST') {
      return json({ token: 'ghs_token', expires_at: new Date(time + HOUR).toISOString() }, 201);
    }
    questions.push(url);
    return answer();
  };
  const app = createApp(
    { id: 'Iv1.example', key: KEY, host: 'github.com', timeoutMs: 10_000 },
    { fetch, now: () => time },
  );
  const check = createAccessCheck(app, {
    ttlMs,
    now: () => time,
    ...(capacity != null && { capacity }),
  });
  return {
    check,
    questions,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe('createAccessCheck', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it.each([
    ['admin', 'write'],
    ['write', 'write'],
    ['read', 'none'],
    ['none', 'none'],
  ])('answers %s as %s and reuses it for its lifetime', async (permission, answer) => {
    const github = harness(() => json({ permission }));
    expect(await github.check(INSTALLATION, REPO, LOGIN)).toBe(answer);
    github.advance(299_999);
    expect(await github.check(INSTALLATION, REPO, LOGIN)).toBe(answer);
    expect(github.questions).toHaveLength(1);
    github.advance(1);
    expect(await github.check(INSTALLATION, REPO, LOGIN)).toBe(answer);
    expect(github.questions).toHaveLength(2);
  });

  it('asks for every event with a lifetime of zero', async () => {
    const github = harness(() => json({ permission: 'write' }), 0);
    await github.check(INSTALLATION, REPO, LOGIN);
    await github.check(INSTALLATION, REPO, LOGIN);
    expect(github.questions).toHaveLength(2);
  });

  it('keeps one answer per installation, repository and account, ignoring case', async () => {
    const github = harness(() => json({ permission: 'write' }));
    await github.check(INSTALLATION, REPO, LOGIN);
    await github.check(INSTALLATION, REPO.toUpperCase(), LOGIN.toUpperCase());
    expect(github.questions).toHaveLength(1);
    await github.check(INSTALLATION + 1, REPO, LOGIN);
    await github.check(INSTALLATION, 'example-org/gadgets', LOGIN);
    await github.check(INSTALLATION, REPO, 'example-reviewer');
    expect(github.questions).toHaveLength(4);
  });

  it('shares one question among checks of the same account made at once', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const github = harness(async () => {
      await held;
      return json({ permission: 'write' });
    });
    const answers = Promise.all([
      github.check(INSTALLATION, REPO, LOGIN),
      github.check(INSTALLATION, REPO, LOGIN),
      github.check(INSTALLATION, REPO, LOGIN),
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    release();
    expect(await answers).toEqual(['write', 'write', 'write']);
    expect(github.questions).toHaveLength(1);
  });

  it('answers an account GitHub does not know as a collaborator as none, and reuses it', async () => {
    const github = harness(() => json({ message: 'Not Found' }, 404));
    expect(await github.check(INSTALLATION, REPO, LOGIN)).toBe('none');
    expect(await github.check(INSTALLATION, REPO, LOGIN)).toBe('none');
    expect(github.questions).toHaveLength(1);
  });

  it('answers a question the app may not ask as unknown and never reuses it', async () => {
    let refused = true;
    const github = harness(() =>
      refused ? json({ message: 'Forbidden' }, 403) : json({ permission: 'write' }),
    );
    expect(await github.check(INSTALLATION, REPO, LOGIN)).toBe('unknown');
    expect(await github.check(INSTALLATION, REPO, LOGIN)).toBe('unknown');
    expect(github.questions).toHaveLength(2);
    refused = false;
    expect(await github.check(INSTALLATION, REPO, LOGIN)).toBe('write');
  });

  it('answers a rate limit as unknown, and asks again once GitHub allows it', async () => {
    let limited = true;
    const github = harness(() =>
      limited
        ? new Response('{}', { status: 429, headers: { 'retry-after': '30' } })
        : json({ permission: 'write' }),
    );
    expect(await github.check(INSTALLATION, REPO, LOGIN)).toBe('unknown');
    expect(await github.check(INSTALLATION, REPO, LOGIN)).toBe('unknown');
    limited = false;
    github.advance(30_000);
    expect(await github.check(INSTALLATION, REPO, LOGIN)).toBe('write');
  });

  it('answers an installation GitHub cannot be asked about as unknown', async () => {
    const github = harness(() => json({ permission: 'write' }));
    expect(await github.check(0, REPO, LOGIN)).toBe('unknown');
    expect(github.questions).toHaveLength(0);
  });

  it('answers an outage as unknown, logs only its code and status, and asks again', async () => {
    let down = true;
    const github = harness(() =>
      down ? json({ message: MARKER }, 503) : json({ permission: 'write' }),
    );
    expect(await github.check(INSTALLATION, REPO, LOGIN)).toBe('unknown');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toEqual({ code: 'upstream', status: 503 });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(MARKER);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(LOGIN);
    down = false;
    expect(await github.check(INSTALLATION, REPO, LOGIN)).toBe('write');
  });

  it('answers a request that never completes as unknown', async () => {
    const github = harness(() => {
      throw new TypeError(`fetch failed ${MARKER}`);
    });
    expect(await github.check(INSTALLATION, REPO, LOGIN)).toBe('unknown');
    expect(warn.mock.calls[0][1]).toEqual({ code: 'network' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(MARKER);
  });

  it('throws an error that is not an outage, since it is a defect', async () => {
    const app: Pick<App, 'access'> = {
      access: async () => {
        throw new RangeError('bad input');
      },
    };
    const check = createAccessCheck(app, { ttlMs: 1000 });
    await expect(check(INSTALLATION, REPO, LOGIN)).rejects.toThrow(RangeError);
    const outage: Pick<App, 'access'> = {
      access: async () => {
        throw new GitHubError('timeout');
      },
    };
    await expect(createAccessCheck(outage, { ttlMs: 1000 })(1, REPO, LOGIN)).resolves.toBe(
      'unknown',
    );
  });

  it('drops the oldest answer once it holds as many as it may', async () => {
    const github = harness(() => json({ permission: 'write' }), 300_000, 2);
    await github.check(INSTALLATION, REPO, 'first');
    await github.check(INSTALLATION, REPO, 'second');
    await github.check(INSTALLATION, REPO, 'third');
    expect(github.questions).toHaveLength(3);
    await github.check(INSTALLATION, REPO, 'third');
    await github.check(INSTALLATION, REPO, 'second');
    expect(github.questions).toHaveLength(3);
    await github.check(INSTALLATION, REPO, 'first');
    expect(github.questions).toHaveLength(4);
  });
});
