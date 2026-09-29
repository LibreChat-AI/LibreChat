// path-exercise.session.mjs — the `Session_Fixture` for PATH-EXERCISE-25 (task 11.5, Req 3.16, 3.22).
//
// A non-spec sibling, like path-exercise.filter.mjs, path-exercise.payloads.mjs and
// path-exercise.providers.mjs: jest.config.mjs's testMatch collects only `*.spec.mjs` / `*.test.mjs`,
// so nothing here is collected as a test and the spec that imports it still exports nothing itself
// (task 14.6).
//
// == Why a session at all ==
// Roughly ten of the eighteen path exercises that were PASSING passed vacuously. An anonymous request
// to a session-gated path is refused at the gate ahead of the handler, so the handler issues no
// MongoDB query, so the `Exercise_Log_Window` is clean BECAUSE NOTHING WAS QUERIED — evidence
// identical to what a grant of zero collections would produce. That is the vacuous pass Property 6
// exists to exclude, and it is worse than a failure because it reports the grant as sufficient on
// evidence that carries no information. A real session is what converts those exercises into tests of
// the bounded-below half.
//
// == What the fixture is, and how it is obtained ==
// It is an APPLICATION session, minted by the application's own login handler:
// `POST /api/auth/login` with the `Seeded_Account`'s credentials, sent THROUGH THE INGRESS CLIENT (the
// Front_Proxy), with two things read back out of the response and nothing else —
//
//   * the refresh cookie from `set-cookie` (`refreshToken`, plus the `token_provider` marker
//     `setAuthTokens` sets beside it: api/server/services/AuthService.js), kept in a jar scoped to the
//     ingress origin;
//   * the access token from the login response BODY (`{ token, user }`:
//     api/server/controllers/auth/LoginController.js).
//
// Both are carried back on each session-gated exercise the way a browser would: the cookie as a
// `Cookie` header on the ingress origin, the token as `Authorization: Bearer`.
//
// == NOT Auth_Gate emulation (NG6) ==
// Nothing here mints, decodes, re-signs or inspects a token. The harness holds no signing key and
// performs no crypto on this path: it posts a password and copies two opaque strings back out. That is
// the same property that makes a commodity reverse proxy an adequate Front_Proxy — no credential is
// validated at the edge, and no bearer-admission or cookie-exemption rule is tested or stood in for.
// Obtaining the session through the ingress rather than by signing a JWT out of band is what keeps it
// that way, and `assertNoTokenInspection` below is the standing guard on it.
//
// == When it is minted ==
// Inside stage 11, and only after the boot window has closed. Login triggers the memoized
// `Model.createIndexes()` on `sessions`, `refreshtokenbridges` and `openidrefreshflights`, and
// BOOT-NOWRITE-23 counts write commands attributed to the Auth_Surface inside
// `[bootStart, readyAt + 60s]` — an in-window login would put a legitimate index build inside the
// count. `awaitBootWindowClosed` below is what enforces the ordering, deliberately as a property of
// THE FIXTURE rather than of Jest's file ordering: Jest picks its own file order, so a mint that
// depended on running after boot-nowrite.spec.mjs would be correct by luck. Waiting on the window's
// right edge is correct whichever file runs first. NC6 keeps the same rule honest in the other
// direction — the window is bounded by boot events, so a login inside it must not make
// BOOT-NOWRITE-23 red.
//
// == The fixture-failure signal (Req 3.22) ==
// An exercise of a session-gated path with no fixture attached is a FIXTURE FAILURE, never a pass: the
// gate refuses it with a 401 over a clean window, which is exactly the three observations criterion
// 3.13 would otherwise hand a pass to. `decideSessionAttachment` produces that signal as data so task
// 11.1's decision rule can report it, and NC8 (task 13.3) is the control that proves the bounded-below
// half cannot be satisfied by a request that queried nothing.
//
// NG1/NG2/NG4 hold: the session is obtained through an existing route with an existing request shape,
// no application code / route mount / HTTP path changes, neither container-split script is touched, and
// which paths are session-gated is read off the recorded table in path-exercise.payloads.mjs (derived
// from `middleware.requireJwtAuth` in api/server/routes/auth.js) rather than re-derived here.

// The 60-second tail past the first `/readyz` 200 that closes the boot window. Imported from the
// boot-write check's own module so the mint and BOOT-NOWRITE-23 read ONE number: a fixture that waited
// on a different tail than the check counts over would reintroduce the ordering hazard silently.
import { BOOT_WINDOW_TAIL_MS, bootWindowEnd } from './boot-nowrite.filter.mjs';
// One table says per path what is attached to it (task 11.4). SESSION_ATTACHMENT is the vocabulary;
// the per-path values live on the recorded payloads.
import { SESSION_ATTACHMENT } from './path-exercise.payloads.mjs';

// The application's own login mount — the only path this module requests. `/api/auth/login` is on the
// Auth_Surface_Allowlist, so the mint goes through the same ingress and resolves to the same container
// as the exercises it enables.
export const LOGIN_PATH = '/api/auth/login';

// The cookies `setAuthTokens` sets on a successful login (api/server/services/AuthService.js). The
// refresh cookie is the one a session-gated exercise and `/api/auth/refresh` need; `token_provider`
// travels with it because a browser would carry both and the harness is imitating a browser, not
// curating a credential.
export const REFRESH_COOKIE_NAME = 'refreshToken';
export const TOKEN_PROVIDER_COOKIE_NAME = 'token_provider';

// A login that did not yield a usable credential. Thrown rather than returned so no caller can fall
// through to an anonymous client by ignoring a return value: proceeding anonymous is precisely the
// vacuous-pass shape this fixture exists to remove, and it would be reported as grant sufficiency.
export class SessionFixtureError extends Error {
  constructor(message, { status = null, path = LOGIN_PATH, detail = null } = {}) {
    super(message);
    this.name = 'SessionFixtureError';
    this.isSessionFixtureError = true;
    this.status = status;
    this.path = path;
    this.detail = detail;
  }
}

// Read every `set-cookie` value off a response's headers into a `{ name: value }` jar.
//
// `Headers.getSetCookie()` is the only API that returns MULTIPLE Set-Cookie values separately (a
// plain `get('set-cookie')` folds them into one comma-joined string, and a cookie's `expires`
// attribute contains a comma, so splitting that string is ambiguous). undici provides it; the
// single-string path below is the fallback for a fake headers object in a unit exercise, and it splits
// only on a comma that begins a new `name=` pair.
export function parseSetCookieJar(headers) {
  const raw = (() => {
    if (headers == null) {
      return [];
    }
    if (typeof headers.getSetCookie === 'function') {
      return headers.getSetCookie();
    }
    const folded = typeof headers.get === 'function' ? headers.get('set-cookie') : null;
    if (typeof folded !== 'string' || folded === '') {
      return [];
    }
    return folded.split(/,\s*(?=[^;=\s]+=)/);
  })();

  const jar = {};
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      continue;
    }
    // The name=value pair is everything before the first `;`; the attributes after it (Path, Expires,
    // HttpOnly, SameSite, Secure) are the browser's business and not the jar's. `Secure` in particular
    // is NOT honored: the harness's ingress is plain http on loopback, a real browser would drop the
    // cookie, and dropping it here would make every session-gated exercise fail for a transport reason
    // that says nothing about the grant.
    const [pair] = entry.split(';');
    const separator = pair.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    jar[pair.slice(0, separator).trim()] = pair.slice(separator + 1).trim();
  }
  return jar;
}

// Serialize a cookie jar into the `Cookie` request header a browser would send. Returns null for an
// empty jar, so a caller attaches no header rather than an empty one.
export function cookieHeaderFrom(jar) {
  const entries = Object.entries(jar ?? {});
  if (entries.length === 0) {
    return null;
  }
  return entries.map(([name, value]) => `${name}=${value}`).join('; ');
}

// The boot window's right edge, and how long to wait for it. Pure so the ordering rule is assertable
// without sleeping: `msUntilBootWindowClosed` answers the question and `awaitBootWindowClosed`
// performs the wait through an injected clock and sleeper.
export function msUntilBootWindowClosed(
  readyAtMs,
  { now = Date.now, tailMs = BOOT_WINDOW_TAIL_MS } = {},
) {
  if (typeof readyAtMs !== 'number' || Number.isNaN(readyAtMs)) {
    // No recorded right edge means no window to be inside; the caller's context is incomplete and
    // waiting an arbitrary 60 seconds would be a guess dressed as a guarantee.
    return 0;
  }
  return Math.max(0, bootWindowEnd(readyAtMs, tailMs) - now());
}

export async function awaitBootWindowClosed(
  readyAtMs,
  { now = Date.now, tailMs = BOOT_WINDOW_TAIL_MS, sleep = defaultSleep } = {},
) {
  const waitMs = msUntilBootWindowClosed(readyAtMs, { now, tailMs });
  if (waitMs > 0) {
    await sleep(waitMs);
  }
  return { waitedMs: waitMs };
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Mint the `Session_Fixture`: wait for the boot window to close, post the Seeded_Account's credentials
// to the login mount through the INGRESS client, and read the two credentials the application returned.
//
// Everything is injected — the ingress client, the clock, the sleeper — so the whole sequence is
// exercisable with a fake ingress and no topology, and the live run passes the real ones.
//
// Throws a SessionFixtureError, loudly, on anything short of a usable credential: a non-200 login, a
// `twoFAPending` answer (which returns a temp token rather than a session), a missing body token, or a
// missing refresh cookie. It never degrades to an anonymous client.
export async function mintSessionFixture({
  ingress,
  seededAccount,
  readyAtMs = null,
  now = Date.now,
  sleep = defaultSleep,
  tailMs = BOOT_WINDOW_TAIL_MS,
}) {
  if (!ingress || typeof ingress.request !== 'function') {
    throw new SessionFixtureError(
      'The Session_Fixture must be minted through the INGRESS client (the Front_Proxy), which is the ' +
        'sole client a path-exercise check may use. No ingress client was supplied.',
    );
  }
  if (!seededAccount || !seededAccount.email || !seededAccount.password) {
    throw new SessionFixtureError(
      "The Session_Fixture needs the Seeded_Account's email and password, which the runner inserts " +
        'under the Root_Credential at stage 6 and publishes on the harness context bridge (Req 3.16, ' +
        '3.17). Neither was supplied, so no session can be minted and no session-gated path can be ' +
        'exercised non-vacuously.',
    );
  }

  // Ordering, enforced here rather than assumed from Jest's file order: login builds indexes on
  // `sessions`, `refreshtokenbridges` and `openidrefreshflights`, and BOOT-NOWRITE-23 counts writes
  // inside [bootStart, readyAt + 60s].
  const { waitedMs } = await awaitBootWindowClosed(readyAtMs, { now, sleep, tailMs });

  const result = await ingress.request({
    path: LOGIN_PATH,
    method: 'POST',
    // No `Origin` and no `Sec-Fetch-Site`: `middleware.requireSameOrigin`
    // (packages/api/src/middleware/origin.ts) treats a request carrying neither as a non-browser
    // request and admits it, while a foreign `Origin` would make its 403 the observed answer. Same
    // reasoning as the recorded `/api/auth/login` payload's note.
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: seededAccount.email, password: seededAccount.password }),
  });

  if (result.status !== 200) {
    throw new SessionFixtureError(
      `The Session_Fixture could not be minted: POST ${LOGIN_PATH} answered ${result.status} for the ` +
        'Seeded_Account. Every session-gated exercise would otherwise be issued ANONYMOUS, and an ' +
        'anonymous exercise is refused at the gate ahead of the handler — a clean Exercise_Log_Window ' +
        'over a request that queried nothing, which is the vacuous pass Req 3.16/3.22 exist to ' +
        'remove. Read the Auth_Surface log for this request: a 401/422 means the seeded document does ' +
        'not match what the login path reads (email, bcrypt password hash, provider, emailVerified), ' +
        'and a 5xx is a finding about the application or the harness configuration.',
      { status: result.status },
    );
  }

  const body = await readJsonBody(result);
  if (body !== null && body.twoFAPending === true) {
    throw new SessionFixtureError(
      'The login answered `twoFAPending`, so it returned a two-factor temp token rather than a ' +
        'session. The Seeded_Account is inserted with `twoFactorEnabled: false` precisely so this ' +
        'branch cannot be taken; a fixture that accepted the temp token would be carrying a credential ' +
        'the gate does not admit.',
      { status: result.status },
    );
  }

  const token = typeof body?.token === 'string' && body.token !== '' ? body.token : null;
  const cookies = parseSetCookieJar(result.headers);
  const refreshCookie = cookies[REFRESH_COOKIE_NAME] ?? null;

  if (token === null || refreshCookie === null) {
    throw new SessionFixtureError(
      'The login answered 200 but did not return a usable credential: ' +
        `${token === null ? 'no `token` in the response body' : 'a token was returned'}, and ` +
        `${refreshCookie === null ? `no \`${REFRESH_COOKIE_NAME}\` cookie` : 'the refresh cookie was set'}. ` +
        'The fixture fails here rather than proceeding with a half-credential, because a request that ' +
        'the gate refuses is reported as a fixture failure at best and read as grant sufficiency at ' +
        'worst (Req 3.22).',
      { status: result.status },
    );
  }

  const cookieHeader = cookieHeaderFrom(cookies);
  return Object.freeze({
    // The two credentials, carried verbatim. NOT decoded, not verified, not re-signed — the harness
    // holds no signing key and performs no crypto here (NG6).
    token,
    cookies: Object.freeze({ ...cookies }),
    cookieHeader,
    // The jar is scoped to the ingress origin: the client is baked to the Front_Proxy's address and
    // cannot be aimed elsewhere, so there is no second origin for a cookie to leak to.
    origin: ingress.baseUrl ?? null,
    mintedAtMs: now(),
    waitedForBootWindowMs: waitedMs,
    // Identity only, for a report; the password stays out of the fixture object.
    account: Object.freeze({ id: seededAccount.id ?? null, email: seededAccount.email }),
  });
}

// Read a JSON body off an ingress result without throwing on a non-JSON one: the token extraction is
// what matters, and a body that does not parse is reported by the caller as "no usable credential"
// rather than as a parse error the reader has to interpret.
async function readJsonBody(result) {
  const response = result?.body;
  if (!response || typeof response.json !== 'function') {
    return null;
  }
  try {
    return await response.json();
  } catch {
    return null;
  }
}

// The request headers one exercise needs, given what its recorded payload says is attached to it.
// Pure over the attachment value and the fixture, so every branch is exercisable without a topology.
//
//   NONE           — nothing. The mount sits ahead of every authentication middleware.
//   GATED          — both credentials, the way a browser holds them: `Authorization: Bearer <token>`
//                    for `requireJwtAuth`, and the cookie jar, so a handler that also reads the
//                    refresh cookie (logout deletes the session it names) sees it.
//   REFRESH_COOKIE — the cookie only. `/api/auth/refresh` reads the cookie, not the bearer; sending
//                    the bearer too would not change its answer but would misstate what the exercise
//                    depends on.
export function sessionHeadersFor(attachment, fixture) {
  if (attachment === SESSION_ATTACHMENT.NONE || attachment === undefined) {
    return {};
  }
  if (!fixture) {
    return {};
  }
  const headers = {};
  if (fixture.cookieHeader) {
    headers.cookie = fixture.cookieHeader;
  }
  if (attachment === SESSION_ATTACHMENT.GATED && fixture.token) {
    headers.authorization = `Bearer ${fixture.token}`;
  }
  return headers;
}

// Decide, for one recorded payload entry and one (possibly absent) fixture, whether the exercise
// carries what it needs — and produce the Req 3.22 FIXTURE FAILURE when it does not.
//
// Returns `{ attachment, required, attached, fixtureFailure }`:
//   * `required`       — this path needs the fixture at all (GATED or REFRESH_COOKIE).
//   * `attached`       — the fixture is present AND carries what this attachment needs.
//   * `fixtureFailure` — null, or `{ routedPath, attachment, reason }` for a SESSION-GATED path
//                        exercised without it. Only a gated mount produces one: a gated mount's
//                        anonymous refusal is the 401-over-a-clean-window that criterion 3.13 would
//                        otherwise pass, which is the indistinguishability 3.22 closes. A missing
//                        cookie on `/api/auth/refresh` weakens that exercise's evidence but is not the
//                        vacuous pass 3.22 names, so it is reported as `attached: false` with no
//                        fixture failure and left to task 11.1 to classify.
//
// It returns data rather than throwing, and it decides nothing about the exercise's outcome: task
// 11.1's rule owns the four outcomes and the reporting. This is the signal it consumes.
export function decideSessionAttachment({ entry, fixture = null }) {
  const attachment = entry?.session ?? SESSION_ATTACHMENT.NONE;
  const routedPath = entry?.routedPath ?? entry?.path ?? null;
  const required = attachment !== SESSION_ATTACHMENT.NONE;

  if (!required) {
    return Object.freeze({ attachment, required: false, attached: false, fixtureFailure: null });
  }

  const headers = sessionHeadersFor(attachment, fixture);
  const hasCookie = typeof headers.cookie === 'string' && headers.cookie !== '';
  const hasBearer = typeof headers.authorization === 'string' && headers.authorization !== '';
  const attached = attachment === SESSION_ATTACHMENT.GATED ? hasCookie && hasBearer : hasCookie;

  if (attached) {
    return Object.freeze({ attachment, required: true, attached: true, fixtureFailure: null });
  }

  if (attachment !== SESSION_ATTACHMENT.GATED) {
    return Object.freeze({ attachment, required: true, attached: false, fixtureFailure: null });
  }

  return Object.freeze({
    attachment,
    required: true,
    attached: false,
    fixtureFailure: Object.freeze({
      routedPath,
      attachment,
      reason:
        `FIXTURE FAILURE: ${routedPath} is session-gated (its mount sits behind ` +
        '`middleware.requireJwtAuth`) and was exercised with no Session_Fixture attached, so the gate ' +
        'refused the request ahead of the handler and the handler queried no collection. That is a ' +
        'non-5xx status over a clean Exercise_Log_Window — exactly the three observations criterion ' +
        '3.13 grants a pass on — but the exercise decided NOTHING about the Container_1_Grant, because ' +
        'the evidence is identical to what a grant of zero collections would produce. Reported as a ' +
        'fixture failure carrying the path and the unattached Session_Fixture, never as a pass ' +
        '(Req 3.22, Property 6). Mint the fixture with `mintSessionFixture` and attach it with ' +
        '`attachSessionFixture` before exercising this path.',
    }),
  });
}

// Attach the fixture to one already-converted ingress request (the `{ path, method, headers, body }`
// `toIngressRequest` produces). Returns `{ request, attachment, attached, fixtureFailure }` — the
// request with the session headers merged in, plus the same decision `decideSessionAttachment` makes,
// so a caller gets the request and the Req 3.22 signal from one call and cannot take one without the
// other.
//
// Header names are lowercased on both sides before merging, so the fixture's `authorization`/`cookie`
// cannot end up as a second spelling of a header the payload already recorded.
export function attachSessionFixture(request, { entry, fixture = null }) {
  const decision = decideSessionAttachment({ entry, fixture });
  const attachment = decision.attachment;
  const recorded = Object.fromEntries(
    Object.entries(request?.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const headers = { ...recorded, ...sessionHeadersFor(attachment, fixture) };
  return Object.freeze({
    request: { ...request, headers },
    attachment,
    required: decision.required,
    attached: decision.attached,
    fixtureFailure: decision.fixtureFailure,
  });
}

// NG6's standing guard is asserted against this file's SOURCE by the spec that imports this module
// (checks/path-exercise.spec.mjs, "Session_Fixture"): no token is minted, decoded, verified or
// re-signed anywhere here, and no signing secret is read. The list of forbidden operations lives in the
// spec rather than here, because a list of needles in this file would be a permanent match against
// itself.
