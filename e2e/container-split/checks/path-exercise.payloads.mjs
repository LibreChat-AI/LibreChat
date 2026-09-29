// path-exercise.payloads.mjs — the `Path_Payload` fixture for PATH-EXERCISE-25 (task 11.4).
//
// One recorded request per exercised routed path, plus that request's expected status and one
// sentence saying why the status is the APPLICATION'S OWN answer. It lives in a non-spec sibling
// module so checks/path-exercise.spec.mjs can import it and still export nothing itself — the
// convention task 14.6 fixed, the same shape path-exercise.filter.mjs has. jest.config.mjs's
// testMatch collects `checks/**/*.spec.mjs` and `**/*.test.mjs`, so a `.payloads.mjs` is never
// collected as a test.
//
// == Why this fixture exists ==
// A live run exercised eight of twenty-six paths with NO REQUEST BODY and read the resulting 5xx as
// evidence that the ownership matrix understates those paths' collection needs. Sending nothing is
// not the neutral choice it looks like: an absent body does not test a handler on neutral input, it
// tests it on MALFORMED input, which is usually an unhandled throw, and an unhandled throw is a 5xx
// that says nothing about the grant. `/api/user/verify` is the clean demonstration — with no body
// `verifyEmail` throws on absent input and `verifyEmailController` answers 500 out of its `catch`;
// with a well-formed `{ email, token }` the SAME controller answers 400 through its
// `instanceof Error` branch, which is the application's own validation answer. The payload chooses
// which branch of one controller runs, and only one of the two is informative (Req 3.14).
//
// == The three fields, and which one is load-bearing ==
// Each entry carries `request` (method, path, query, headers, body), `expectedStatus`, and `why`.
// The third is the one that matters. Without it a future status change is absorbed as a passing
// diff; with it, changing an expected status has to be justified where it is recorded. Every `why`
// below names the middleware or controller that produces the status and the env condition it turns
// on, so the justification is checkable against the code rather than remembered.
//
// Expected statuses live HERE rather than in requirements.md deliberately: they are a property of
// the current handlers and belong where they can be revised without amending a criterion (design:
// "Per-path expected statuses are recorded alongside the payloads, in this document's companion
// fixture rather than in the requirements").
//
// == Fixed, not generated (NG8) ==
// One request per path, chosen TO REACH THE HANDLER RATHER THAN TO PROBE IT. Path exercise is
// enumeration over a small fixed domain, and sampling a domain small enough to exhaust is strictly
// weaker than exhausting it (Req 3.15). Nothing here is randomized: the one-time tokens are fixed
// hex constants, and the only values resolved per run are the Seeded_Account's credentials, which
// are a per-run SECRET rather than a generated input — they arrive through SEED_PLACEHOLDERS so the
// recorded request stays fixed and committed while no secret is committed with it.
//
// == What this fixture does NOT decide ==
// It records requests and the statuses they should produce. It does not classify an exercise
// (task 11.1's rule: `pass` / `understated` / `uncorroborated` / `undecided`), does not mint or
// attach the Session_Fixture (task 11.5), and does not derive the Unconfigured_Provider set
// (task 11.6, path-exercise.providers.mjs) — that set comes from the harness's own resolved provider
// configuration, never from a list here (Req 3.21). The `session` field records what each exercise needs attached, which
// is the one place a per-path table can say it once for all three consumers.
//
// == Verified against the handlers, not guessed ==
// Every status below was read out of the application source at the harness's env (the resolved
// env/*.env files: no ALLOW_REGISTRATION, no ALLOW_PASSWORD_RESET, no ALLOW_SOCIAL_LOGIN, no
// LDAP_URL, no EMAIL_* transport, no BAN_VIOLATIONS, ALLOW_EMAIL_LOGIN undefined). The `why`
// sentences name the file. Three findings came out of that reading and are recorded on the entries
// themselves in a `finding` field rather than smoothed over — see FINDINGS below.
//
// NG1 holds absolutely: no application code, no route mount and no HTTP path was changed to make a
// payload fit. Where a well-formed request for a routed entry cannot be expressed from outside the
// application, that is recorded as a finding to report, not treated as a licence to edit a handler.

// ---------------------------------------------------------------------------------------------
// FINDINGS — recorded here, not fixed here.
//
//   F1. `/api/auth/ldap` IS NOT A MOUNT. api/server/routes/auth.js registers no `/ldap` route; LDAP
//       login shares the `/api/auth/login` mount, which swaps `requireLdapAuth` for
//       `requireLocalAuth` when LDAP_URL and LDAP_USER_SEARCH_BASE are both set. So the LDAP
//       surface has no request shape distinct from local login: which middleware runs is a property
//       of the container's environment, not of the request, and the harness env sets neither
//       variable. The request recorded for that entry therefore reaches `app.use('/api',
//       apiNotFound)` and answers 404 — a non-5xx that decides NOTHING about the grant, and which
//       task 11.1's rule would otherwise hand a `pass`. Reported, not patched (NG1).
//
//   F2. `/api/admin/login` and `/api/admin/oauth` ARE PREFIXES, NOT MOUNTS. api/server/routes/
//       admin/auth.js mounts `POST /login/local` and `GET /oauth/<provider>`, not `/login` or
//       `/oauth`. The recorded requests target the concrete mounts — `/api/admin/login/local` and
//       `/api/admin/oauth/openid` — which the same Caddyfile.split allowlist rules route to the
//       Auth_Surface (`/api/admin/login` plus `/api/admin/login/*`, `/api/admin/oauth` plus
//       `/api/admin/oauth/*`). That is what "chosen to reach the handler" means here, and it is why
//       `request.path` is recorded per entry instead of being assumed equal to the routed path.
// ---------------------------------------------------------------------------------------------

// What each exercise must carry beyond its payload. Recorded per path here so ONE table says what
// is attached to what — task 11.5 reads it to attach the Session_Fixture, task 11.1 reads it to
// decide whether Req 3.22's fixture-failure rule applies to an exercise that arrived anonymous.
//
//   NONE           — the mount sits ahead of every authentication middleware; the payload alone
//                    reaches the handler.
//   GATED          — the mount sits behind `requireJwtAuth` (middleware.requireJwtAuth in
//                    api/server/routes/auth.js). Session-gated in Req 3.16's sense, derived from the
//                    route file at implementation time rather than re-derived from the split (NG4).
//                    An exercise of one of these with no Session_Fixture attached is a FIXTURE
//                    FAILURE, never a pass (Req 3.22) — the gate answers 401 over a clean window,
//                    which is exactly the vacuous shape Property 6 excludes.
//   REFRESH_COOKIE — not behind an authentication middleware, but the handler reads the refresh
//                    cookie and answers without touching a collection when it is absent. Attaching
//                    the Session_Fixture's cookie is what makes the recorded status the handler's
//                    answer rather than an early return.
export const SESSION_ATTACHMENT = Object.freeze({
  NONE: 'none',
  GATED: 'gated',
  REFRESH_COOKIE: 'refresh-cookie',
});

// The per-run values a recorded request may reference. They are the Seeded_Account's credentials
// (task 11.5), which are generated per run and are secrets, so the fixture records a placeholder and
// `resolveSeedPlaceholders` substitutes at exercise time. This is NOT generated input in NG8's
// sense: the request shape, the field set and the expected status are all fixed: only the identity
// of the one seeded account varies, and it varies because committing a credential is forbidden
// (Req 5.6), not because the input is being sampled.
export const SEED_PLACEHOLDERS = Object.freeze({
  EMAIL: '{{SEEDED_ACCOUNT_EMAIL}}',
  PASSWORD: '{{SEEDED_ACCOUNT_PASSWORD}}',
  USER_ID: '{{SEEDED_ACCOUNT_ID}}',
});

// A fixed, well-formed one-time token. Both `verifyEmail` (AuthService.js) and `resetPassword`
// compare a caller-supplied token against a bcrypt hash stored in `authtokens`, so the token's
// VALUE cannot be made to match without reading the database — what matters is that it is a
// well-formed 64-character hex string of the shape `createTokenHash()` issues, so the handler
// performs its real lookup and comparison instead of rejecting the request for shape. Fixed rather
// than random (NG8): a per-run token would vary an input that has no reason to vary.
export const FIXED_ONE_TIME_TOKEN =
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

// A fixed, well-formed six-digit TOTP code. Same reasoning: `verifyTOTP` must run and answer, which
// needs a code of the right shape, not a code that verifies.
export const FIXED_TOTP_CODE = '000000';

// A fixed registration body. Well-formed against `registerSchema` (api/strategies/validators.js:
// name 3–80, valid email, password ≥ MIN_PASSWORD_LENGTH which defaults to 8, confirm_password
// equal) so the request reaches `validateRegistration` on its merits. It names an address that is
// NOT the Seeded_Account, because a registration that collided with the seed would answer on the
// collision rather than on the enablement flag.
const REGISTRATION_BODY = Object.freeze({
  name: 'Harness Registration Probe',
  email: 'harness-registration@container-split.invalid',
  password: 'HarnessRegistration1',
  confirm_password: 'HarnessRegistration1',
});

// The recorded `Path_Payload` set: one entry per path checks/path-exercise.filter.mjs's
// AUTH_SURFACE_ROUTED_PATHS exercises, keyed by that list's `path` so the two join on one value.
// `assertPayloadCoverage` below is the guard that they stay one-to-one — a path added to the routed
// list with no payload here would be exercised with nothing, which is the failure this fixture
// exists to end.
//
// Field shape per entry:
//   routedPath      — the routed-path list's `path`. The join key. Never a request target on its own.
//   surface         — the routed-path list's `surface`, mirrored so a report reads without a join.
//   request         — the request ITSELF: `{ method, path, query, headers, body }`. `path` is the
//                     concrete path the request goes to, which differs from `routedPath` only where
//                     the routed entry names a mount PREFIX (F2). `query`, `headers` and `body` are
//                     omitted where the handler reads none.
//   expectedStatus  — the status the application answers for that exact request at the harness env.
//   why             — one sentence: why that status is the application's own validation,
//                     authentication, authorization or configuration answer.
//   session         — a SESSION_ATTACHMENT value (see above).
//   note            — optional: an ordering hazard or a reach limitation a consumer must know.
//   finding         — optional: a defect this fixture REPORTS rather than works around (NG1).
export const PATH_PAYLOADS = Object.freeze([
  // -------------------------------------------------------------------------------------------
  // Local authentication.
  // -------------------------------------------------------------------------------------------
  Object.freeze({
    routedPath: '/api/auth/login',
    surface: 'local login',
    request: Object.freeze({
      method: 'POST',
      path: '/api/auth/login',
      body: Object.freeze({
        email: SEED_PLACEHOLDERS.EMAIL,
        password: SEED_PLACEHOLDERS.PASSWORD,
      }),
    }),
    expectedStatus: 200,
    why:
      "200 is the application's own authentication answer: the local strategy " +
      '(api/strategies/localStrategy.js) validates the body against `loginSchema`, finds the ' +
      'Seeded_Account, matches its bcrypt password and sees `emailVerified: true`, so ' +
      '`requireLocalAuth` passes the user through and `loginController` mints a token and answers ' +
      '200 — the same login the Session_Fixture is obtained from.',
    session: SESSION_ATTACHMENT.NONE,
    note:
      'The request sets NO `Origin` and NO `Sec-Fetch-Site` header on purpose. ' +
      '`middleware.requireSameOrigin` (packages/api/src/middleware/origin.ts) treats a request ' +
      'carrying neither as a non-browser request and admits it; supplying a foreign `Origin` ' +
      "would make its 403 the observed answer instead of the login handler's.",
  }),
  Object.freeze({
    routedPath: '/api/auth/logout',
    surface: 'logout',
    request: Object.freeze({ method: 'POST', path: '/api/auth/logout' }),
    expectedStatus: 200,
    why:
      "200 is the application's own answer once the session is attached: `requireJwtAuth` admits " +
      'the Seeded_Account and `logoutUser` (api/server/services/AuthService.js) finds the durable ' +
      'session by its refresh token, deletes it and returns `{ status: 200 }`, which ' +
      '`logoutController` sends.',
    session: SESSION_ATTACHMENT.GATED,
    note:
      'ORDERING HAZARD: this exercise DELETES the durable session the Session_Fixture names, so ' +
      'every other session-gated exercise and the `/api/auth/refresh` exercise must run before it ' +
      '(or the fixture must be re-minted after it). Anonymous, `requireJwtAuth` answers 401 over a ' +
      'clean window — the vacuous shape Req 3.22 reports as a fixture failure rather than a pass.',
  }),
  Object.freeze({
    routedPath: '/api/auth/refresh',
    surface: 'refresh',
    request: Object.freeze({ method: 'POST', path: '/api/auth/refresh' }),
    expectedStatus: 200,
    why:
      "200 is the application's own answer with the refresh cookie attached: `refreshController` " +
      '(api/server/controllers/AuthController.js) verifies the cookie against `JWT_REFRESH_SECRET`, ' +
      'loads the user, finds the unexpired session and answers 200 with a fresh token.',
    session: SESSION_ATTACHMENT.REFRESH_COOKIE,
    note:
      'The cookie is what makes the 200 informative. With no `refreshToken` cookie the same ' +
      "controller returns 200 'Refresh token not provided' on its first branch, having queried " +
      'nothing — a non-5xx over a clean window that carries no information about the grant.',
  }),
  Object.freeze({
    routedPath: '/api/auth/ldap',
    surface: 'LDAP login',
    request: Object.freeze({
      method: 'POST',
      path: '/api/auth/ldap',
      body: Object.freeze({
        email: SEED_PLACEHOLDERS.EMAIL,
        password: SEED_PLACEHOLDERS.PASSWORD,
      }),
    }),
    expectedStatus: 404,
    why:
      "404 is the application's own answer for an unmounted API path: nothing under " +
      'api/server/routes/auth.js registers `/ldap`, so the request falls past every router to ' +
      "`app.use('/api', apiNotFound)` (api/server/index.js), which answers 404 " +
      "`{ message: 'Endpoint not found' }`.",
    session: SESSION_ATTACHMENT.NONE,
    finding:
      'F1 — the LDAP surface has no request shape of its own. LDAP login IS the ' +
      '`/api/auth/login` mount with `requireLdapAuth` substituted for `requireLocalAuth` when ' +
      'LDAP_URL and LDAP_USER_SEARCH_BASE are both set (api/server/routes/auth.js), and the ' +
      'harness env sets neither, so no LDAP strategy is even registered. No well-formed request ' +
      'from outside the application can reach an LDAP handler, and this 404 is non-5xx over a ' +
      "clean window — which task 11.1's rule would score `pass` on evidence identical to what a " +
      'grant of zero collections would produce. Reported rather than patched: fixing it means ' +
      'either dropping this entry from the routed-path list or configuring LDAP in the harness, ' +
      'both of which are decisions outside this fixture, and neither of which is a licence to add ' +
      'a route (NG1).',
  }),
  Object.freeze({
    routedPath: '/api/auth/register',
    surface: 'registration',
    request: Object.freeze({
      method: 'POST',
      path: '/api/auth/register',
      body: REGISTRATION_BODY,
    }),
    expectedStatus: 403,
    why:
      "403 is the application's own configuration answer: a well-formed registration body reaches " +
      '`validateRegistration` (api/server/middleware/validateRegistration.js), which answers 403 ' +
      "`'Registration is not allowed.'` because ALLOW_REGISTRATION is unset in the harness env.",
    session: SESSION_ATTACHMENT.NONE,
    note:
      'A grant gap was investigated and ruled out for this path independently of the status: the ' +
      "registration chain reads `bans` and writes `users`, and both are in the Container_1_Grant's " +
      "read-write set. The 403 is non-5xx and therefore a `pass` under task 11.1's rule, but it " +
      'is produced ahead of `registrationController`, so the exercise reaches no collection and ' +
      'the clean window behind it is weak evidence. Enabling registration in the harness env would ' +
      'convert it into a real reach — a decision for task 11.5/6.2, not a payload change.',
  }),

  // -------------------------------------------------------------------------------------------
  // Social providers. Six Unconfigured_Provider paths: exercised with a payload and attributed
  // like any other path, with only the grant-sufficiency verdict withheld (task 11.6, Req 3.19).
  // Each is a GET that initiates a handshake, so there is no body to record — the recorded
  // "payload" is the request itself, and its 500 is the absence of the feature, not a malformed
  // input. ALLOW_SOCIAL_LOGIN is unset in the harness env, so `configureSocialLogins` never runs
  // (api/server/index.js) and no provider strategy is registered; `passport.authenticate(<p>)`
  // calls `next(new Error('Unknown authentication strategy …'))`, and a plain Error carries no
  // `statusCode`/`body`, so `ErrorController` (packages/api/src/middleware/error.ts) falls through
  // to its bare 500. That is one shared `why`, restated per entry so no entry reads as unexplained.
  // -------------------------------------------------------------------------------------------
  ...['google', 'github', 'discord', 'facebook', 'openid', 'apple'].map((provider) =>
    Object.freeze({
      routedPath: `/oauth/${provider}`,
      surface: `social: ${provider}`,
      request: Object.freeze({ method: 'GET', path: `/oauth/${provider}` }),
      expectedStatus: 500,
      why:
        `500 is the application's own answer to a request for an unconfigured provider: ` +
        'ALLOW_SOCIAL_LOGIN is unset in the harness env so `configureSocialLogins` never runs and ' +
        `no \`${provider}\` passport strategy is registered, ` +
        `\`passport.authenticate('${provider}')\` hands ` +
        '`next()` an `Unknown authentication strategy` Error, and `ErrorController` answers 500 ' +
        'because a plain Error carries no `statusCode`/`body` to relay.',
      session: SESSION_ATTACHMENT.NONE,
      note:
        'This is the Unconfigured_Provider shape (Req 3.19–3.21). The 500 records the ABSENCE OF A ' +
        'FEATURE, not a grant fault — the request reaches no collection, so its clean ' +
        'Exercise_Log_Window carries no information about the grant in either direction, and the ' +
        'verdict is `undecided`. Task 11.6 decides that from the resolved provider configuration, ' +
        'never from this list; a provider the harness DOES configure is exercised in full and this ' +
        'expected status no longer holds for it.',
    }),
  ),

  // -------------------------------------------------------------------------------------------
  // Two-factor authentication. All four mounts sit behind `requireJwtAuth`, so all four are
  // session-gated (Req 3.16). Every body below is a well-formed JSON object rather than an absent
  // body: `{}` is the well-formed shape for a first enrollment and for a backup-code regeneration
  // on an account with `twoFactorEnabled: false`, because neither handler reads a field in that
  // state. All four statuses are ORDER-INDEPENDENT, which the `why` sentences record — the four
  // exercises mutate the seeded user, and a status that depended on the order would be a status
  // that broke on a reordering that breaks nothing.
  // -------------------------------------------------------------------------------------------
  Object.freeze({
    routedPath: '/api/auth/2fa/enable',
    surface: '2FA enroll',
    request: Object.freeze({
      method: 'POST',
      path: '/api/auth/2fa/enable',
      body: Object.freeze({}),
    }),
    expectedStatus: 200,
    why:
      "200 is the application's own answer: the Seeded_Account has `twoFactorEnabled: false`, so " +
      '`enable2FA` (api/server/controllers/TwoFactorController.js) skips the re-enrollment ' +
      'verification, generates a TOTP secret and backup codes, writes them to the user as ' +
      '`pendingTotpSecret`/`pendingBackupCodes`, and answers 200 with the otpauth URL.',
    session: SESSION_ATTACHMENT.GATED,
  }),
  Object.freeze({
    routedPath: '/api/auth/2fa/verify',
    surface: '2FA verify',
    request: Object.freeze({
      method: 'POST',
      path: '/api/auth/2fa/verify',
      body: Object.freeze({ token: FIXED_TOTP_CODE }),
    }),
    expectedStatus: 400,
    why:
      "400 is the application's own validation answer either way this exercise can land: " +
      "`verify2FA` answers 400 `'2FA not initiated'` when no secret is stored, and 400 " +
      "`'Invalid token or backup code.'` when the enroll exercise has already stored a pending " +
      'secret and the fixed code does not verify — so the status does not depend on the order the ' +
      '2FA exercises run in.',
    session: SESSION_ATTACHMENT.GATED,
  }),
  Object.freeze({
    routedPath: '/api/auth/2fa/disable',
    surface: '2FA disable',
    request: Object.freeze({
      method: 'POST',
      path: '/api/auth/2fa/disable',
      body: Object.freeze({ token: FIXED_TOTP_CODE }),
    }),
    expectedStatus: 400,
    why:
      "400 is the application's own answer: `disable2FA` reads the user and answers 400 " +
      "`'2FA is not setup for this user'` because the Seeded_Account has no `totpSecret` — and " +
      'enrollment writes `pendingTotpSecret`, not `totpSecret`, so the status holds whether the ' +
      'enroll exercise ran first or not.',
    session: SESSION_ATTACHMENT.GATED,
  }),
  Object.freeze({
    routedPath: '/api/auth/2fa/backup/regenerate',
    surface: '2FA backup codes',
    request: Object.freeze({
      method: 'POST',
      path: '/api/auth/2fa/backup/regenerate',
      body: Object.freeze({}),
    }),
    expectedStatus: 200,
    why:
      "200 is the application's own answer: `regenerateBackupCodes` finds the Seeded_Account, " +
      'skips verification because `twoFactorEnabled` is false, writes a fresh `backupCodes` array ' +
      'to the user and answers 200 with the plain codes.',
    session: SESSION_ATTACHMENT.GATED,
  }),

  // -------------------------------------------------------------------------------------------
  // Password reset — request and submit.
  // -------------------------------------------------------------------------------------------
  Object.freeze({
    routedPath: '/api/auth/requestPasswordReset',
    surface: 'password reset request',
    request: Object.freeze({
      method: 'POST',
      path: '/api/auth/requestPasswordReset',
      body: Object.freeze({ email: SEED_PLACEHOLDERS.EMAIL }),
    }),
    expectedStatus: 403,
    why:
      "403 is the application's own configuration answer: a well-formed body reaches " +
      '`validatePasswordReset` (api/server/middleware/validatePasswordReset.js), which answers 403 ' +
      "`'Password reset is not allowed.'` because ALLOW_PASSWORD_RESET is unset in the harness env.",
    session: SESSION_ATTACHMENT.NONE,
    note:
      'SHALLOW REACH. The 403 comes from a middleware ahead of `resetPasswordRequestController`, ' +
      'so the exercise queries no collection and the clean window behind it is weak evidence about ' +
      'the grant — the same weakness Req 3.16 answers for session-gated paths. Setting ' +
      'ALLOW_PASSWORD_RESET in env/common.env would convert both password-reset exercises into ' +
      'real reaches (the controller reads `users` and writes `authtokens`); that is an env decision ' +
      'for task 11.5/6.2, not a payload change, and it is recorded here rather than made here.',
  }),
  Object.freeze({
    routedPath: '/api/auth/resetPassword',
    surface: 'password reset submit',
    request: Object.freeze({
      method: 'POST',
      path: '/api/auth/resetPassword',
      body: Object.freeze({
        userId: SEED_PLACEHOLDERS.USER_ID,
        token: FIXED_ONE_TIME_TOKEN,
        password: 'HarnessResetSubmit1',
      }),
    }),
    expectedStatus: 403,
    why:
      "403 is the application's own configuration answer: `validatePasswordReset` guards the " +
      'submit mount exactly as it guards the request mount (api/server/routes/auth.js), and ' +
      'ALLOW_PASSWORD_RESET is unset in the harness env, so the 403 is returned ahead of ' +
      '`resetPasswordController`.',
    session: SESSION_ATTACHMENT.NONE,
    note:
      'SHALLOW REACH, same as the request mount above, and the same env lever converts it. The ' +
      'body is recorded well-formed anyway so that enabling the flag needs no payload edit: ' +
      '`resetPassword` reads `{ userId, token, password }` in that shape.',
  }),

  // -------------------------------------------------------------------------------------------
  // Email verification and resend. These two are the reason this fixture exists (Req 3.14's
  // rationale), and they are the two deepest anonymous reaches in the set.
  // -------------------------------------------------------------------------------------------
  Object.freeze({
    routedPath: '/api/user/verify',
    surface: 'email verification',
    request: Object.freeze({
      method: 'POST',
      path: '/api/user/verify',
      body: Object.freeze({
        email: SEED_PLACEHOLDERS.EMAIL,
        token: FIXED_ONE_TIME_TOKEN,
      }),
    }),
    expectedStatus: 400,
    why:
      "400 is the application's own validation answer: with a well-formed `{ email, token }` " +
      '`verifyEmail` (api/server/services/AuthService.js) passes its shape check, finds the ' +
      'Seeded_Account in `users`, finds no email-verification token for it in `authtokens` and ' +
      'RETURNS an Error, so `verifyEmailController` answers 400 through its `instanceof Error` ' +
      'branch.',
    session: SESSION_ATTACHMENT.NONE,
    note:
      'THE DEMONSTRATION CASE. With no body the same service THROWS on absent input and the same ' +
      'controller answers 500 out of its `catch` — which is the 5xx the earlier live run read as a ' +
      'grant finding. The payload chooses which branch of one controller runs, and it also buys ' +
      'real reach: this exercise queries `users` and `authtokens`, both in the ' +
      'Container_1_Grant, so a clean window here is evidence rather than silence.',
  }),
  Object.freeze({
    routedPath: '/api/user/verify/resend',
    surface: 'email verification resend',
    request: Object.freeze({
      method: 'POST',
      path: '/api/user/verify/resend',
      body: Object.freeze({ email: SEED_PLACEHOLDERS.EMAIL }),
    }),
    expectedStatus: 200,
    why:
      "200 is the application's own answer by design: `resendVerificationEmail` returns the same " +
      'generic 200 message whether the address exists or not, and swallows a send failure into ' +
      'that same 200 — the harness configures no mail transport, so the send fails and the ' +
      'controller still answers 200.',
    session: SESSION_ATTACHMENT.NONE,
    note:
      'Real reach despite the uniform status: with the Seeded_Account address the service reads ' +
      "`users` and deletes that account's prior verification tokens from `authtokens` BEFORE the " +
      'send is attempted, so the grant is exercised on both a read and a remove.',
  }),

  // -------------------------------------------------------------------------------------------
  // Admin login and admin oauth. Both routed entries name mount PREFIXES, so both requests target
  // the concrete mount underneath (F2) — the same allowlist rules route it.
  // -------------------------------------------------------------------------------------------
  Object.freeze({
    routedPath: '/api/admin/login',
    surface: 'admin login',
    request: Object.freeze({
      method: 'POST',
      path: '/api/admin/login/local',
      body: Object.freeze({
        email: SEED_PLACEHOLDERS.EMAIL,
        password: SEED_PLACEHOLDERS.PASSWORD,
      }),
    }),
    expectedStatus: 403,
    why:
      "403 is the application's own authorization answer: `requireLocalAuth` authenticates the " +
      'Seeded_Account successfully and `requireAdminAccess` — `requireCapability(ACCESS_ADMIN)`, ' +
      "packages/api/src/middleware/capabilities.ts — resolves the user's principals and answers " +
      "403 `'Forbidden'` because the seeded account holds the default user role, not admin.",
    session: SESSION_ATTACHMENT.NONE,
    note:
      'Deep reach: the capability resolution reads `users`, `roles` and `systemgrants` (and ' +
      '`groups` for principal expansion), all in the Container_1_Grant, so this is one of the ' +
      'stronger clean-window observations in the set. Sends no `Origin` header for the same reason ' +
      'as `/api/auth/login`.',
    finding:
      'F2 — `/api/admin/login` is not a mount. api/server/routes/admin/auth.js registers ' +
      "`POST /login/local`; `app.use('/api/admin', routes.adminAuth)` therefore leaves " +
      "`/api/admin/login` unmatched, and `app.use('/api', apiNotFound)` would answer 404. The " +
      'recorded request targets `/api/admin/login/local`, which Caddyfile.split routes to the ' +
      'Auth_Surface under the same `/api/admin/login/*` rule. No route was added or moved (NG1).',
  }),
  Object.freeze({
    routedPath: '/api/admin/oauth',
    surface: 'admin oauth',
    request: Object.freeze({ method: 'GET', path: '/api/admin/oauth/openid' }),
    expectedStatus: 404,
    why:
      "404 is the application's own configuration answer: `requireOpenIdConfig` " +
      '(api/server/routes/admin/auth.js) calls `getOpenIdConfig()`, which throws because the ' +
      'harness configures no OpenID provider, and the middleware answers 404 ' +
      '`OPENID_NOT_CONFIGURED`.',
    session: SESSION_ATTACHMENT.NONE,
    note:
      'SHALLOW REACH: the 404 is produced before any handler touches the database, so the clean ' +
      'window behind it says nothing about the grant. It is a configured-feature absence in the ' +
      'same family as the six provider paths, but it is NOT an Unconfigured_Provider path in ' +
      "Req 3.19's sense — that carve-out names `/oauth/{provider}`, and task 11.6 derives its set " +
      'from the resolved configuration rather than from this note.',
    finding:
      'F2 — `/api/admin/oauth` is not a mount either; the admin router mounts ' +
      '`/oauth/openid`, `/oauth/google`, `/oauth/saml`, `/oauth/exchange` and their siblings. The ' +
      'recorded request targets `/api/admin/oauth/openid`, routed to the Auth_Surface by the same ' +
      '`/api/admin/oauth/*` allowlist rule.',
  }),

  // -------------------------------------------------------------------------------------------
  // Public config and banner reads, and the SPA document load. Three GETs with no body: an absent
  // body is only a hazard where the handler reads one, and none of these does.
  // -------------------------------------------------------------------------------------------
  Object.freeze({
    routedPath: '/api/config',
    surface: 'config',
    request: Object.freeze({ method: 'GET', path: '/api/config' }),
    expectedStatus: 200,
    why:
      "200 is the application's own answer: `optionalJwtAuth` admits the anonymous caller and the " +
      "config router's `GET /` (api/server/routes/config.js) builds the pre-login payload and " +
      'answers 200 with it.',
    session: SESSION_ATTACHMENT.NONE,
  }),
  Object.freeze({
    routedPath: '/api/banner',
    surface: 'banner',
    request: Object.freeze({ method: 'GET', path: '/api/banner' }),
    expectedStatus: 200,
    why:
      "200 is the application's own answer: `getBanner` (api/server/routes/banner.js) reads the " +
      'active banner for an anonymous caller and answers 200 with it or with null; its 500 branch ' +
      'is reserved for a read that throws.',
    session: SESSION_ATTACHMENT.NONE,
    note:
      'Reaches `banners`, which the Container_1_Grant holds READ-ONLY — so this exercise is one of ' +
      'the few that observes the read-only half of the matrix from the request path.',
  }),
  Object.freeze({
    routedPath: '/login',
    surface: 'SPA load',
    request: Object.freeze({ method: 'GET', path: '/login' }),
    expectedStatus: 200,
    why:
      "200 is the application's own answer for a document route: `/login` is not under `/api`, so " +
      'it passes `apiNotFound` untouched and reaches `createSpaFallback` ' +
      '(api/server/utils/fallback.js), which serves `index.html` for any unmatched non-asset path.',
    session: SESSION_ATTACHMENT.NONE,
    note:
      'The 200 is the static shell, not a handler answer, and it queries no collection. Both ' +
      'containers serve the same `index.html` from the same image through the same ' +
      '`createSpaFallback`, so an SPA load is evidence of attribution and nothing else.',
  }),
]);

// The routed paths whose mounts sit behind `requireJwtAuth`. Derived from PATH_PAYLOADS' `session`
// field so there is one table rather than two, which is what task 11.5 asked for ("Record the
// resulting list beside the `Path_Payload` fixture, so one table says per path what is attached to
// it"). Task 11.1 reads it to know where Req 3.22's fixture-failure rule applies.
export const SESSION_GATED_PATHS = Object.freeze(
  PATH_PAYLOADS.filter((entry) => entry.session === SESSION_ATTACHMENT.GATED).map(
    (entry) => entry.routedPath,
  ),
);

// The routed paths whose recorded request needs the Session_Fixture attached at all — the gated
// mounts plus `/api/auth/refresh`, whose handler reads the refresh cookie and returns early without
// it. A consumer attaching credentials wants THIS list; a consumer applying Req 3.22's reporting
// rule wants SESSION_GATED_PATHS above, because only a gated mount's anonymous refusal is the
// vacuous pass that criterion closes.
export const SESSION_ATTACHED_PATHS = Object.freeze(
  PATH_PAYLOADS.filter((entry) => entry.session !== SESSION_ATTACHMENT.NONE).map(
    (entry) => entry.routedPath,
  ),
);

// Every entry that carries a `finding` — the paths this fixture reports rather than works around
// (F1, F2). Exported so a consumer can surface them in the run report instead of leaving them to be
// rediscovered by reading comments.
export const PAYLOAD_FINDINGS = Object.freeze(
  PATH_PAYLOADS.filter((entry) => typeof entry.finding === 'string').map((entry) =>
    Object.freeze({ routedPath: entry.routedPath, finding: entry.finding }),
  ),
);

// Look one payload up by its routed path. Returns the entry, or null when the path has none — which
// `assertPayloadCoverage` turns into a loud failure rather than an exercise with no body.
export function payloadFor(routedPath) {
  return PATH_PAYLOADS.find((entry) => entry.routedPath === routedPath) ?? null;
}

// Decide whether this fixture covers exactly the routed paths it is joined against. Pure over the
// two lists, so it is exercisable without a topology. Returns
// `{ ok, missing, extra, duplicated }`: `missing` is a routed path with no payload (it would be
// exercised with nothing, the failure this fixture ends), `extra` is a payload for a path nothing
// exercises (dead weight that reads as coverage), and `duplicated` is a routed path recorded twice
// (two payloads, one of them silently unused).
export function assertPayloadCoverage(routedPaths) {
  const routed = routedPaths.map((entry) => (typeof entry === 'string' ? entry : entry.path));
  const recorded = PATH_PAYLOADS.map((entry) => entry.routedPath);
  const recordedSet = new Set(recorded);
  const routedSet = new Set(routed);

  const missing = routed.filter((path) => !recordedSet.has(path));
  const extra = recorded.filter((path) => !routedSet.has(path));
  const duplicated = recorded.filter((path, index) => recorded.indexOf(path) !== index);

  return Object.freeze({
    ok: missing.length === 0 && extra.length === 0 && duplicated.length === 0,
    missing: Object.freeze(missing),
    extra: Object.freeze(extra),
    duplicated: Object.freeze(duplicated),
  });
}

// Substitute the Seeded_Account's per-run values into a recorded value. Walks strings, arrays and
// plain objects; leaves everything else alone. THROWS on a placeholder the caller supplied no value
// for, rather than sending the literal `{{SEEDED_ACCOUNT_EMAIL}}` to a handler — a request carrying
// an unresolved placeholder is a fixture failure, and it would land as a 400 that reads like the
// application's own validation answer.
export function resolveSeedPlaceholders(value, seededAccount = {}) {
  const substitutions = new Map([
    [SEED_PLACEHOLDERS.EMAIL, seededAccount.email],
    [SEED_PLACEHOLDERS.PASSWORD, seededAccount.password],
    [SEED_PLACEHOLDERS.USER_ID, seededAccount.id],
  ]);

  const walk = (node) => {
    if (typeof node === 'string') {
      if (!substitutions.has(node)) {
        return node;
      }
      const replacement = substitutions.get(node);
      if (typeof replacement !== 'string' || replacement === '') {
        throw new Error(
          `Path_Payload placeholder ${node} has no value: the Seeded_Account (task 11.5) must ` +
            'supply `email`, `password` and `id` before an exercise is issued. Sending the literal ' +
            "placeholder would make the handler's 400 read as the application's own validation " +
            'answer, which is exactly the misreading this fixture exists to prevent.',
        );
      }
      return replacement;
    }
    if (Array.isArray(node)) {
      return node.map(walk);
    }
    if (node !== null && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([key, item]) => [key, walk(item)]));
    }
    return node;
  };

  return walk(value);
}

// Turn one recorded payload into the argument `makeIngressClient().request()` takes — `{ path,
// method, headers, body }`, where `path` is proxy-relative and `body` is already serialized. The
// ingress client spreads everything but `path` into `fetch`, so this is the whole conversion.
//
// A recorded `body` is JSON, so the request carries `content-type: application/json`; without it
// `express.json()` does not parse the body and the handler sees `{}`, which is the absent-body case
// wearing a payload's clothes. A recorded `query` is appended as a query string. Header names are
// lowercased so a caller's later merge (the Session_Fixture's `authorization` and `cookie`) cannot
// produce two spellings of one header.
export function toIngressRequest(entry, { seededAccount } = {}) {
  const { method, path, query, headers, body } = entry.request;

  const search =
    query == null
      ? ''
      : `?${new URLSearchParams(
          Object.entries(resolveSeedPlaceholders(query, seededAccount)),
        ).toString()}`;

  const resolvedHeaders = Object.fromEntries(
    Object.entries(resolveSeedPlaceholders(headers ?? {}, seededAccount)).map(([key, value]) => [
      key.toLowerCase(),
      value,
    ]),
  );

  const request = { path: `${path}${search}`, method, headers: resolvedHeaders };

  if (body !== undefined) {
    request.headers['content-type'] = resolvedHeaders['content-type'] ?? 'application/json';
    request.body = JSON.stringify(resolveSeedPlaceholders(body, seededAccount));
  }

  return request;
}
