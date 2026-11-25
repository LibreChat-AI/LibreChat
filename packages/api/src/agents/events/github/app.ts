import { createPrivateKey, createSign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { PullRequestFetch } from '~/pulls/shared';
import { gitHubApiBase, gitHubRateLimit } from '~/pulls/github';
import { isPathSegment, isRecord } from '~/pulls/shared';
import { isId } from '../item';

/** What the operator registered: the GitHub App events are delivered for. Holds a credential. */
export interface AppConfig {
  /** The app's ID or its client ID; GitHub finds the app's public key by it. */
  id: string;
  /** The app's private key as PEM. */
  key: string;
  /** The host the app is registered on, already normalized: `github.com` or an Enterprise host. */
  host: string;
  /** Longest one request to GitHub may take, in milliseconds. */
  timeoutMs: number;
  /**
   * Installations with a held token or a pause at once, 10,000 when omitted. An entry is
   * about a hundred bytes and a token is replaced hourly, so this only stops the maps growing
   * without bound; past it the oldest entry is dropped, which costs one extra request if
   * that installation is asked about again.
   */
  capacity?: number;
  /**
   * The app's OAuth client, with which a user's authorization code is exchanged to check what
   * that user can access. Holds a credential. Without it `owns` answers `credential`.
   */
  client?: { id: string; secret: string };
}

export interface AppDeps {
  /** The deployment's HTTP client, so proxying and instrumentation are the caller's choice. */
  fetch: PullRequestFetch;
  /** Unix time in milliseconds; the system clock when omitted. */
  now?: () => number;
}

/**
 * Why GitHub would not answer, as GitHub said it. None of them is an answer, so a caller
 * deciding whether to act on an event treats every one as a refusal and does not remember it
 * as a "no".
 * - `credential`: GitHub rejected the app's identity, or rejected a fresh installation token.
 * - `missing`: GitHub has no such installation of this app, or the id is not one.
 * - `forbidden`: the installation exists but may not ask, such as a suspended one or an app
 *   without the repository permission the question needs.
 * - `limited`: GitHub is rate limiting the installation; `retryAfterMs` is how long it asked
 *   callers to wait.
 * - `code`: GitHub does not accept a user's authorization code: it is wrong, used or expired.
 *
 * Everything else is an outage and is thrown as a `GitHubError`.
 */
export type AppFailure = 'credential' | 'missing' | 'forbidden' | 'limited' | 'code';

/**
 * Why GitHub could not be asked at all:
 * - `key`: the app's private key does not load as an RSA key, or signing with it failed.
 * - `network`: the request did not complete.
 * - `timeout`: the request outlasted `timeoutMs`.
 * - `upstream`: GitHub answered with a server error, a status nothing here expects, or a reply
 *   that does not read; `status` is its HTTP status.
 */
export type GitHubErrorCode = 'key' | 'network' | 'timeout' | 'upstream';

/**
 * An outage, thrown so the request or job that asked sees it. Its message is the code and
 * nothing else: no token, key, address or reply, and no cause is attached.
 */
export class GitHubError extends Error {
  constructor(
    readonly code: GitHubErrorCode,
    /** GitHub's HTTP status, for `upstream`. */
    readonly status?: number,
  ) {
    super(`GitHub app request failed: ${code}`);
    this.name = 'GitHubError';
  }
}

export type Reply<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: AppFailure; retryAfterMs?: number } };

/** What GitHub says an account may do in a repository. Safe to cache for a short while. */
export interface Access {
  /** True only when GitHub reports `admin` or `write`, which includes the maintain role. */
  write: boolean;
}

/** The app as GitHub describes it, read with the app's own token. */
export interface About {
  /** The app's page on its host, such as `https://github.com/apps/<slug>`; installs start there. */
  url: string;
}

/** One installation of this app, as GitHub reports it. */
export interface Installation {
  /** The account the app is installed on: its numeric id and its login. */
  account: { id: string; name: string };
  /** True while GitHub holds the installation suspended. */
  suspended: boolean;
}

export interface App {
  /**
   * Whether `login` may push to `repo` (`owner/name`), asked as the installation. An account
   * GitHub does not know as a collaborator, including every bot account, is a plain "no".
   * Rejects with a `GitHubError` when GitHub cannot be asked.
   */
  access(installation: number, repo: string, login: string): Promise<Reply<Access>>;
  /** The app itself. Rejects with a `GitHubError` when GitHub cannot be asked. */
  about(): Promise<Reply<About>>;
  /**
   * One installation of this app by id. `missing` when it is not one of this app's: GitHub
   * answers only for the app whose token asks. Rejects with a `GitHubError` when GitHub
   * cannot be asked.
   */
  installation(id: number): Promise<Reply<Installation>>;
  /**
   * Whether the user who authorized the app with `code` can access installation `id`, which is
   * GitHub's proof that the user installed it or administers the account it is on. The code is
   * exchanged for that user's token, the token is used for this one question, and it is then
   * dropped: it is never held, returned or logged. `credential` when no client is configured
   * or GitHub rejects it. Rejects with a `GitHubError` when GitHub cannot be asked.
   */
  owns(code: string, id: number): Promise<Reply<boolean>>;
}

const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
/** An account's login: a user's or an organization's. */
const ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;
/** A user's login, or an app's with its `[bot]` suffix. No dots, so it is safe in a path. */
const LOGIN = /^[A-Za-z0-9_-]{1,100}(?:\[bot\])?$/;
/**
 * A token is sent in a header, so it is printable ASCII. GitHub's newer tokens run to hundreds
 * of characters.
 */
const TOKEN = /^[\x21-\x7e]{1,4096}$/;

/** GitHub accepts an app token for at most ten minutes and advises dating it a minute back. */
const JWT_BACKDATE_S = 60;
const JWT_LIFETIME_S = 540;
/**
 * An installation token is replaced this long before GitHub expires it, on top of one
 * request's timeout, so a request that starts with a token finishes while it is still valid.
 */
const TOKEN_MARGIN_MS = 60_000;
/** GitHub asks for at least a minute when it limits without naming a wait. */
const LIMIT_WAIT_MS = 60_000;
/** GitHub's limits reset within the hour, so a longer wait is a header that did not read. */
const MAX_WAIT_MS = 3_600_000;
const CAPACITY = 10_000;
/** A user's installations are listed this many to a page, for at most this many pages. */
const PAGE = 100;
const PAGES = 10;
/** An authorization code as GitHub issues it. */
const CODE = /^[A-Za-z0-9_-]{1,512}$/;
/** The token endpoint's refusals of the code itself, which it answers with HTTP 200. */
const CODE_REFUSALS: ReadonlySet<string> = new Set([
  'bad_verification_code',
  'redirect_uri_mismatch',
  'invalid_grant',
]);

type Failure = Extract<Reply<never>, { ok: false }>;

function fail(code: AppFailure, retryAfterMs?: number): Failure {
  return { ok: false, error: { code, ...(retryAfterMs != null && { retryAfterMs }) } };
}

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/**
 * Asks GitHub questions as the operator's app. Only decisions and codes leave this module,
 * never GitHub's reply, an exception's text, the app token or an installation token.
 */
export function createApp(config: AppConfig, deps: AppDeps): App {
  const now = deps.now ?? Date.now;
  const api = gitHubApiBase(config.host);
  const tokens = new Map<number, { token: string; until: number }>();
  const exchanges = new Map<number, Promise<Reply<string>>>();
  const cooldowns = new Map<number, number>();
  const capacity = config.capacity ?? CAPACITY;
  let key: KeyObject | null | undefined;

  /** Sets an entry as the newest, dropping the oldest once the map is full. */
  function hold<V>(map: Map<number, V>, installation: number, value: V): void {
    map.delete(installation);
    if (map.size >= capacity) {
      for (const oldest of map.keys()) {
        map.delete(oldest);
        break;
      }
    }
    map.set(installation, value);
  }

  /** The private key, loaded once. A key that is not an RSA key GitHub could have issued throws. */
  function signer(): KeyObject {
    if (key === undefined) {
      try {
        const loaded = createPrivateKey(config.key);
        key = loaded.asymmetricKeyType === 'rsa' ? loaded : null;
      } catch {
        key = null;
      }
    }
    if (key == null) {
      throw new GitHubError('key');
    }
    return key;
  }

  /** The short-lived token that proves the app's identity when it asks for an installation's. */
  function jwt(): string {
    const signing = signer();
    const seconds = Math.floor(now() / 1000);
    const head = encode({ alg: 'RS256', typ: 'JWT' });
    const claims = encode({
      iat: seconds - JWT_BACKDATE_S,
      exp: seconds + JWT_LIFETIME_S,
      iss: config.id,
    });
    let signature: Buffer;
    try {
      signature = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(signing);
    } catch {
      throw new GitHubError('key');
    }
    return `${head}.${claims}.${signature.toString('base64url')}`;
  }

  async function request(path: string, bearer: string, method: 'GET' | 'POST'): Promise<Response> {
    const signal = AbortSignal.timeout(config.timeoutMs);
    try {
      return await deps.fetch(`${api}${path}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${bearer}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'LibreChat-Agent-Events',
        },
        signal,
      });
    } catch {
      /** Told by the signal, not the rejection, which each HTTP client words its own way. */
      throw new GitHubError(signal.aborted ? 'timeout' : 'network');
    }
  }

  /** A reply's JSON, or `null` when it does not parse; the caller rejects both alike. */
  function read(response: Response): Promise<unknown> {
    return response.json().catch(() => null);
  }

  /** A limited reply starts a pause for the installation, so a burst does not keep asking. */
  async function limited(installation: number, response: Response): Promise<Failure | null> {
    const limit = await gitHubRateLimit(response);
    if (limit == null) {
      return null;
    }
    const wait = Math.min(limit.waitMs ?? LIMIT_WAIT_MS, MAX_WAIT_MS);
    hold(cooldowns, installation, now() + wait);
    return fail('limited', wait);
  }

  async function exchange(installation: number): Promise<Reply<string>> {
    const path = `/app/installations/${installation}/access_tokens`;
    const response = await request(path, jwt(), 'POST');
    if (!response.ok) {
      const pause = await limited(installation, response);
      if (pause != null) {
        return pause;
      }
      if (response.status === 401) {
        return fail('credential');
      }
      if (response.status === 403) {
        return fail('forbidden');
      }
      if (response.status === 404) {
        return fail('missing');
      }
      throw new GitHubError('upstream', response.status);
    }
    const body = await read(response);
    if (!isRecord(body) || typeof body.token !== 'string' || !TOKEN.test(body.token)) {
      throw new GitHubError('upstream', response.status);
    }
    const expires = typeof body.expires_at === 'string' ? Date.parse(body.expires_at) : NaN;
    if (!Number.isFinite(expires)) {
      throw new GitHubError('upstream', response.status);
    }
    hold(tokens, installation, {
      token: body.token,
      until: expires - TOKEN_MARGIN_MS - config.timeoutMs,
    });
    return { ok: true, value: body.token };
  }

  /** The installation's token: the held one while it lasts, else one exchange shared by callers. */
  async function token(installation: number): Promise<Reply<string>> {
    const held = tokens.get(installation);
    if (held != null && now() < held.until) {
      return { ok: true, value: held.token };
    }
    const pending = exchanges.get(installation);
    if (pending != null) {
      return pending;
    }
    const started = exchange(installation).finally(() => exchanges.delete(installation));
    exchanges.set(installation, started);
    return started;
  }

  /**
   * One attempt at the question. `null` means GitHub no longer accepts the installation's
   * token, which is dropped so the next attempt exchanges a fresh one.
   */
  async function ask(installation: number, path: string): Promise<Reply<Access> | null> {
    const bearer = await token(installation);
    if (!bearer.ok) {
      return bearer;
    }
    const response = await request(path, bearer.value, 'GET');
    if (response.status === 404) {
      return { ok: true, value: { write: false } };
    }
    if (!response.ok) {
      const pause = await limited(installation, response);
      if (pause != null) {
        return pause;
      }
      if (response.status === 401) {
        if (tokens.get(installation)?.token === bearer.value) {
          tokens.delete(installation);
        }
        return null;
      }
      if (response.status === 403) {
        return fail('forbidden');
      }
      throw new GitHubError('upstream', response.status);
    }
    const body = await read(response);
    const level = isRecord(body) ? body.permission : undefined;
    if (level === 'admin' || level === 'write') {
      return { ok: true, value: { write: true } };
    }
    if (level === 'read' || level === 'none') {
      return { ok: true, value: { write: false } };
    }
    throw new GitHubError('upstream', response.status);
  }

  async function access(installation: number, repo: string, login: string): Promise<Reply<Access>> {
    if (!isId(installation)) {
      return fail('missing');
    }
    const [owner, name] = repo.split('/');
    if (!REPO.test(repo) || !isPathSegment(owner) || !isPathSegment(name) || !LOGIN.test(login)) {
      return { ok: true, value: { write: false } };
    }
    const resume = cooldowns.get(installation);
    if (resume != null) {
      const wait = resume - now();
      if (wait > 0) {
        return fail('limited', wait);
      }
      cooldowns.delete(installation);
    }
    const path = `/repos/${owner}/${name}/collaborators/${encodeURIComponent(login)}/permission`;
    return (await ask(installation, path)) ?? (await ask(installation, path)) ?? fail('credential');
  }

  /**
   * A question asked with the app's own token. GitHub's refusals are results; a reply that
   * does not read as `parse` expects is an outage.
   */
  async function asApp<T>(path: string, parse: (body: unknown) => T | null): Promise<Reply<T>> {
    const response = await request(path, jwt(), 'GET');
    if (!response.ok) {
      const limit = await gitHubRateLimit(response);
      if (limit != null) {
        return fail('limited', Math.min(limit.waitMs ?? LIMIT_WAIT_MS, MAX_WAIT_MS));
      }
      if (response.status === 401) {
        return fail('credential');
      }
      if (response.status === 403) {
        return fail('forbidden');
      }
      if (response.status === 404) {
        return fail('missing');
      }
      throw new GitHubError('upstream', response.status);
    }
    const value = parse(await read(response));
    if (value == null) {
      throw new GitHubError('upstream', response.status);
    }
    return { ok: true, value };
  }

  /** The app's page, only when GitHub names one on the configured host over HTTPS. */
  function page(body: unknown): About | null {
    if (!isRecord(body) || typeof body.html_url !== 'string') {
      return null;
    }
    let url: URL;
    try {
      url = new URL(body.html_url);
    } catch {
      return null;
    }
    if (url.protocol !== 'https:' || url.host !== config.host || url.search || url.hash) {
      return null;
    }
    return { url: `${url.origin}${url.pathname.replace(/\/+$/, '')}` };
  }

  function installed(body: unknown): Installation | null {
    const account = isRecord(body) ? body.account : undefined;
    if (!isRecord(body) || !isRecord(account)) {
      return null;
    }
    const { id, login } = account;
    if (!isId(id) || typeof login !== 'string' || !ACCOUNT.test(login)) {
      return null;
    }
    return { account: { id: String(id), name: login }, suspended: body.suspended_at != null };
  }

  const about = (): Promise<Reply<About>> => asApp('/app', page);

  async function installation(id: number): Promise<Reply<Installation>> {
    if (!isId(id)) {
      return fail('missing');
    }
    return asApp(`/app/installations/${id}`, installed);
  }

  /** The user's token for `code`, from the app's own token endpoint on its host. */
  async function redeem(
    code: string,
    client: { id: string; secret: string },
  ): Promise<Reply<string>> {
    const signal = AbortSignal.timeout(config.timeoutMs);
    const body = new URLSearchParams({ client_id: client.id, client_secret: client.secret, code });
    let response: Response;
    try {
      response = await deps.fetch(`https://${config.host}/login/oauth/access_token`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'LibreChat-Agent-Events',
        },
        body: body.toString(),
        signal,
      });
    } catch {
      throw new GitHubError(signal.aborted ? 'timeout' : 'network');
    }
    if (response.status >= 500) {
      throw new GitHubError('upstream', response.status);
    }
    const limit = await gitHubRateLimit(response);
    if (limit != null) {
      return fail('limited', Math.min(limit.waitMs ?? LIMIT_WAIT_MS, MAX_WAIT_MS));
    }
    const parsed = await read(response);
    const error = isRecord(parsed) && typeof parsed.error === 'string' ? parsed.error : undefined;
    // GitHub answers a refused code with 200 and an `error` field.
    if (error != null && CODE_REFUSALS.has(error)) {
      return fail('code');
    }
    if (error === 'incorrect_client_credentials' || response.status === 401) {
      return fail('credential');
    }
    const token = isRecord(parsed) ? parsed.access_token : undefined;
    if (!response.ok || error != null || typeof token !== 'string' || !TOKEN.test(token)) {
      throw new GitHubError('upstream', response.status);
    }
    return { ok: true, value: token };
  }

  async function owns(code: string, id: number): Promise<Reply<boolean>> {
    if (!isId(id)) {
      return fail('missing');
    }
    if (!CODE.test(code)) {
      return fail('code');
    }
    if (config.client == null) {
      return fail('credential');
    }
    const redeemed = await redeem(code, config.client);
    if (!redeemed.ok) {
      return redeemed;
    }
    const bearer = redeemed.value;
    for (let page = 1; page <= PAGES; page++) {
      const response = await request(
        `/user/installations?per_page=${PAGE}&page=${page}`,
        bearer,
        'GET',
      );
      if (!response.ok) {
        const limit = await gitHubRateLimit(response);
        if (limit != null) {
          return fail('limited', Math.min(limit.waitMs ?? LIMIT_WAIT_MS, MAX_WAIT_MS));
        }
        if (response.status === 401) {
          return fail('credential');
        }
        if (response.status === 403) {
          return fail('forbidden');
        }
        throw new GitHubError('upstream', response.status);
      }
      const body = await read(response);
      const listed = isRecord(body) ? body.installations : undefined;
      if (!Array.isArray(listed)) {
        throw new GitHubError('upstream', response.status);
      }
      if (listed.some((entry) => isRecord(entry) && entry.id === id)) {
        return { ok: true, value: true };
      }
      const total = isRecord(body) && isId(body.total_count) ? body.total_count : 0;
      if (listed.length < PAGE || page * PAGE >= total) {
        break;
      }
    }
    return { ok: true, value: false };
  }

  return { access, about, installation, owns };
}
