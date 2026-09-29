// path-exercise.providers.mjs — the `Unconfigured_Provider` derivation for PATH-EXERCISE-25 (task 11.6).
//
// `/oauth/{google,github,discord,facebook,openid,apple}` are routed to the Auth_Surface and are
// exercised like every other path, but they cannot decide grant sufficiency: the harness supplies no
// enablement flag and no client credential for any social provider, so passport registers no strategy
// and `passport.authenticate('google', …)` fails before a handler touches the database. Such a request
// reaches no collection, so its clean `Exercise_Log_Window` carries no information about the grant in
// either direction. This module decides WHICH of those paths are in that position and supplies the
// reason string that names the provider (Req 3.19, 3.20).
//
// == Derived from the resolved configuration, never from a path list (Req 3.21) ==
// The set is computed from two inputs and nothing else:
//
//   1. the routed-path list (path-exercise.filter.mjs: AUTH_SURFACE_ROUTED_PATHS) — which `/oauth/<p>`
//      paths the harness exercises at all, and
//   2. the RESOLVED ENVIRONMENT the containers actually run under — `docker compose config` over
//      compose.harness.yml, which is env/common.env ∪ env/auth-surface.env ∪ the inline
//      `environment:` block ∪ the `${...}` interpolation run.mjs supplies. Compose merges `env_file`
//      into the reported `environment` map, so what that read reports is what the container receives.
//
// A provider is CONFIGURED when its enablement flag and its client credential are both present, and a
// configured provider is not in this set — its path moves into full exercise (payload, window scan,
// the four outcomes) with no second edit here. That is the whole point of deriving it: the narrowing
// is tied to the configuration rather than to the paths, so `undecided` cannot outlive the absence
// that justifies it. A configured provider whose path still reported `undecided` would be a fixture
// bug, and the only way to produce one from here is to hard-code a list — so there is none.
//
// == Where the gate table comes from ==
// Both halves are read out of the application, not invented:
//
//   * The ENABLEMENT FLAG is `ALLOW_SOCIAL_LOGIN`, one flag shared by all six providers:
//     api/server/index.js only calls `configureSocialLogins(app, appConfig)` under
//     `isEnabled(ALLOW_SOCIAL_LOGIN)`, so with the flag off no provider strategy is registered
//     whatever credentials are present.
//   * The CLIENT CREDENTIAL is the per-provider condition inside `configureSocialLogins`
//     (api/server/socialLogins.js), transcribed into PROVIDER_CREDENTIAL_GATES below with the source
//     expression recorded on each entry. They are not uniform — apple pairs its client id with a
//     PRIVATE KEY PATH rather than a secret, and openid takes five values, one of which is satisfied
//     by `OPENID_USE_PKCE=true` INSTEAD of a client secret — so a "CLIENT_ID + CLIENT_SECRET"
//     assumption would call a configured apple or a PKCE openid unconfigured and withhold a verdict
//     the exercise could actually reach.
//
// Presence follows the application's own test, which is truthiness of `process.env.<KEY>`: a
// PRESENT-AND-EMPTY value is absent for this purpose. That is not a nicety — docker's `env_file` turns
// `KEY=` into an empty STRING rather than an unset variable, so a template that spelled
// `GOOGLE_CLIENT_ID=` would read as present to a naive check and as absent to the application. The
// flag is read with `isEnabled`'s exact semantics (packages/api/src/utils/common.ts: the string `true`
// case-insensitively, trimmed), reimplemented here rather than imported, because the harness reads a
// resolved env MAP rather than `process.env` and does not load the application's build output.
//
// == This `undecided` is not undecided.mjs's ==
// Two different vocabularies, deliberately kept apart:
//
//   * undecided.mjs is a CHECK-LEVEL signal: a check that ran, reached for its observation and found
//     the observation unusable throws `UndecidedObservation`, which the reporter records as a `skip`
//     that blocks exit 0. It says "this check decided nothing".
//   * This module supplies a PER-PATH outcome inside PATH-EXERCISE-25's `pathOutcomes` (task 11.1). It
//     does not fail the check and does not block the run; it narrows what one path decides while the
//     other paths still decide theirs.
//
// So a provider path must NOT be reported through `UndecidedObservation` — that would turn a narrowing
// into a run-blocking skip and discard the paths that did decide. The naming collision is real and the
// meanings are not interchangeable.
//
// == What this module does not do ==
// It does not classify an exercise (task 11.1 owns `pass` / `understated` / `uncorroborated` /
// `undecided` and the check's own status), does not record payloads (task 11.4), does not mint or
// attach the Session_Fixture (task 11.5), and changes nothing about ROUTE-ALLOW-27: routing
// attribution is decided by `X-Harness-Upstream` and never by status (Property 7), so an unregistered
// strategy is no obstacle to it, and `/oauth/*` must attribute to the Auth_Surface whether a strategy
// exists or not.
//
// NG1 holds: no application code, route mount or HTTP path is touched — the application's gating is
// READ here, never changed. NG8 holds: the derivation is a function of a small fixed table and one
// resolved env map, with nothing generated or sampled.

import { AUTH_SURFACE_ROUTED_PATHS } from './path-exercise.filter.mjs';
// The resolved-environment read the harness already owns (task 9.2's TOPO-ENV-14 seam). Reused rather
// than re-spelled so there is ONE `docker compose config` shape in Layer B: a second implementation
// could read a different profile or a different service and disagree with TOPO-ENV-14 about what the
// containers are running under.
import { readResolvedEnvironments } from './env-diff.filter.mjs';

// The compose service that serves `/oauth/*`. The Auth_Surface under the split profile, and the same
// reused service under the collapsed profile (compose.harness.yml: the collapsed topology is the
// auth-surface service with an env overlay), so one name covers both.
export const PROVIDER_ENV_SERVICE = 'auth-surface';

// The single enablement flag every social provider is behind. api/server/index.js:
// `if (isEnabled(ALLOW_SOCIAL_LOGIN)) { await configureSocialLogins(app, appConfig); }`.
export const SOCIAL_LOGIN_ENABLEMENT_FLAG = 'ALLOW_SOCIAL_LOGIN';

// The prefix every social provider path carries. `/api/admin/oauth/...` deliberately does NOT match:
// the admin oauth mount is a configured-feature absence in the same family, but it is not an
// `Unconfigured_Provider` path in Req 3.19's sense, and its own verdict is not this module's to
// withhold.
export const OAUTH_PATH_PREFIX = '/oauth/';

// The per-provider credential gate, transcribed from `configureSocialLogins`
// (api/server/socialLogins.js). Each `requires` entry is one condition the application applies; a
// condition is satisfied when any of its `present` keys carries a non-blank value OR any of its
// `enabled` keys reads true under `isEnabled`. `source` records the expression it came from, so a
// future application change is checked against the code rather than against memory.
export const PROVIDER_CREDENTIAL_GATES = Object.freeze({
  google: Object.freeze({
    requires: Object.freeze([
      Object.freeze({ present: Object.freeze(['GOOGLE_CLIENT_ID']) }),
      Object.freeze({ present: Object.freeze(['GOOGLE_CLIENT_SECRET']) }),
    ]),
    source: '`process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET`',
  }),
  github: Object.freeze({
    requires: Object.freeze([
      Object.freeze({ present: Object.freeze(['GITHUB_CLIENT_ID']) }),
      Object.freeze({ present: Object.freeze(['GITHUB_CLIENT_SECRET']) }),
    ]),
    source: '`process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET`',
  }),
  discord: Object.freeze({
    requires: Object.freeze([
      Object.freeze({ present: Object.freeze(['DISCORD_CLIENT_ID']) }),
      Object.freeze({ present: Object.freeze(['DISCORD_CLIENT_SECRET']) }),
    ]),
    source: '`process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET`',
  }),
  facebook: Object.freeze({
    requires: Object.freeze([
      Object.freeze({ present: Object.freeze(['FACEBOOK_CLIENT_ID']) }),
      Object.freeze({ present: Object.freeze(['FACEBOOK_CLIENT_SECRET']) }),
    ]),
    source: '`process.env.FACEBOOK_CLIENT_ID && process.env.FACEBOOK_CLIENT_SECRET`',
  }),
  // Apple pairs its client id with a PRIVATE KEY PATH, not a secret. A CLIENT_ID+CLIENT_SECRET
  // assumption would call a configured apple unconfigured and withhold a reachable verdict.
  apple: Object.freeze({
    requires: Object.freeze([
      Object.freeze({ present: Object.freeze(['APPLE_CLIENT_ID']) }),
      Object.freeze({ present: Object.freeze(['APPLE_PRIVATE_KEY_PATH']) }),
    ]),
    source: '`process.env.APPLE_CLIENT_ID && process.env.APPLE_PRIVATE_KEY_PATH`',
  }),
  // OpenID takes five values, and the secret condition is a DISJUNCTION: `OPENID_USE_PKCE=true`
  // satisfies it instead of a client secret, which is how a public client is configured.
  openid: Object.freeze({
    requires: Object.freeze([
      Object.freeze({ present: Object.freeze(['OPENID_CLIENT_ID']) }),
      Object.freeze({
        present: Object.freeze(['OPENID_CLIENT_SECRET']),
        enabled: Object.freeze(['OPENID_USE_PKCE']),
      }),
      Object.freeze({ present: Object.freeze(['OPENID_ISSUER']) }),
      Object.freeze({ present: Object.freeze(['OPENID_SCOPE']) }),
      Object.freeze({ present: Object.freeze(['OPENID_SESSION_SECRET']) }),
    ]),
    source:
      '`process.env.OPENID_CLIENT_ID && (isEnabled(process.env.OPENID_USE_PKCE) || ' +
      'process.env.OPENID_CLIENT_SECRET?.trim()) && process.env.OPENID_ISSUER && ' +
      'process.env.OPENID_SCOPE && process.env.OPENID_SESSION_SECRET`',
  }),
});

// Is `key` PRESENT in a resolved env map, by the application's own test? The application reads
// `process.env.<KEY>` for truthiness (and `?.trim()` for the openid secret), so a missing key, a null
// and a blank string are all absent. A non-string value (compose can report a YAML scalar) is
// stringified first, which keeps `false` present-and-falsy rather than silently absent — the
// application would see the string `"false"` and treat it as present too.
export function isPresent(env, key) {
  const value = env == null ? undefined : env[key];
  if (value === undefined || value === null) {
    return false;
  }
  return String(value).trim() !== '';
}

// Does `key` read as enabled? `isEnabled`'s exact semantics (packages/api/src/utils/common.ts): the
// boolean `true`, or a string that case-insensitively equals `true` once trimmed. Reimplemented rather
// than imported because this reads a resolved env MAP and the harness does not load the application's
// build output.
export function isFlagEnabled(env, key) {
  const value = env == null ? undefined : env[key];
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value !== 'string') {
    return false;
  }
  return value.toLowerCase().trim() === 'true';
}

// One requirement's human label, for the `missing` list a report reads: `GOOGLE_CLIENT_SECRET`, or
// `OPENID_CLIENT_SECRET or OPENID_USE_PKCE=true` for the disjunction.
export function requirementLabel(requirement) {
  return [
    ...(requirement.present ?? []),
    ...(requirement.enabled ?? []).map((key) => `${key}=true`),
  ].join(' or ');
}

// Is one requirement satisfied by this env?
function requirementSatisfied(env, requirement) {
  return (
    (requirement.present ?? []).some((key) => isPresent(env, key)) ||
    (requirement.enabled ?? []).some((key) => isFlagEnabled(env, key))
  );
}

// The provider a routed path names, or null when the path is not a social provider path. The FIRST
// segment after `/oauth/` is the provider, so a callback path (`/oauth/google/callback`) resolves to
// the same provider its initiation does — both fail identically on an unregistered strategy.
export function providerFromRoutedPath(routedPath) {
  if (typeof routedPath !== 'string' || !routedPath.startsWith(OAUTH_PATH_PREFIX)) {
    return null;
  }
  const segment = routedPath.slice(OAUTH_PATH_PREFIX.length).split('/')[0];
  return segment === '' ? null : segment;
}

// Every social provider path in a routed-path list, as `{ routedPath, provider }`. Accepts the
// routed-path entries themselves or bare path strings, matching assertPayloadCoverage's tolerance so
// the two fixtures are joined the same way.
export function socialProviderCandidates(routedPaths = AUTH_SURFACE_ROUTED_PATHS) {
  const candidates = [];
  for (const entry of routedPaths) {
    const routedPath = typeof entry === 'string' ? entry : entry.path;
    const provider = providerFromRoutedPath(routedPath);
    if (provider !== null) {
      candidates.push(Object.freeze({ routedPath, provider }));
    }
  }
  return Object.freeze(candidates);
}

// Decide ONE provider against a resolved env: is it configured, and if not, which conditions are
// missing? Returns null for a provider with no recorded gate — the caller reports that as a fixture
// bug rather than defaulting it either way. Pure over the env map.
export function decideProviderConfiguration(env, provider) {
  const gate = PROVIDER_CREDENTIAL_GATES[provider];
  if (gate === undefined) {
    return null;
  }
  const flagEnabled = isFlagEnabled(env, SOCIAL_LOGIN_ENABLEMENT_FLAG);
  const missingCredentials = gate.requires
    .filter((requirement) => !requirementSatisfied(env, requirement))
    .map(requirementLabel);
  const missing = [
    ...(flagEnabled ? [] : [`${SOCIAL_LOGIN_ENABLEMENT_FLAG}=true`]),
    ...missingCredentials,
  ];
  return Object.freeze({
    provider,
    // Both halves, as Req 3.21 words it: the enablement flag AND the client credential.
    configured: flagEnabled && missingCredentials.length === 0,
    enablementFlag: SOCIAL_LOGIN_ENABLEMENT_FLAG,
    flagEnabled,
    credentialsPresent: missingCredentials.length === 0,
    missing: Object.freeze(missing),
    source: gate.source,
  });
}

// The reason an `Unconfigured_Provider` path's grant sufficiency is undecided. It NAMES THE PROVIDER
// (Req 3.20) and the configuration it is missing, so a reader of the run report knows both which
// feature is absent and which env values would move the path into full exercise.
export function unconfiguredProviderReason(decision, routedPath) {
  return (
    `Unconfigured_Provider \`${decision.provider}\`: grant sufficiency is UNDECIDED for ` +
    `${routedPath}. The resolved provider configuration the containers run under is missing ` +
    `${decision.missing.join(', ')}, so \`configureSocialLogins\` registers no \`${decision.provider}\` ` +
    `strategy and \`passport.authenticate('${decision.provider}', …)\` fails before a handler touches ` +
    'the database. The exercise reaches no collection, so its clean Exercise_Log_Window carries no ' +
    'information about the grant in either direction — this narrows what the path decides, it does ' +
    'not excuse a failure (Req 3.19, 3.20). Routing is unaffected: ROUTE-ALLOW-27 still requires this ' +
    'path to attribute to the Auth_Surface, because attribution is decided by X-Harness-Upstream and ' +
    'never by status (Property 7). Configure the provider and the path is exercised in full under the ' +
    'same rule as every other path (Req 3.21).'
  );
}

// A routed `/oauth/<p>` path whose provider has no recorded gate. Reported as a fixture bug rather
// than folded into either verdict: defaulting it to `undecided` would let an unknown provider dodge
// the grant-sufficiency exercise by being unrecognized, and defaulting it to a full exercise would
// assert an expected status nothing derived.
function unknownProviderReason(routedPath, provider) {
  return (
    `FIXTURE BUG: ${routedPath} is routed to the Auth_Surface but PROVIDER_CREDENTIAL_GATES records ` +
    `no gate for \`${provider}\`, so whether it is configured cannot be derived from the resolved ` +
    "environment. Transcribe the provider's condition from `configureSocialLogins` " +
    '(api/server/socialLogins.js) into this module. It is NOT defaulted to `undecided`: an ' +
    'unrecognized provider must not dodge the grant-sufficiency exercise (Req 3.21).'
  );
}

// Derive the whole `Unconfigured_Provider` picture from a resolved env and a routed-path list. Pure
// over both, so the derivation is exercisable with a synthetic env and no topology, and the live run
// feeds it the real resolved environment.
//
// Returns a frozen record:
//   candidates      — `{ routedPath, provider }` for every `/oauth/<p>` path in the routed list.
//   decisions       — one per candidate with a recorded gate: the provider decision plus `routedPath`
//                     and, when unconfigured, its `reason`.
//   undecided       — the decisions whose provider is unconfigured. THE CARVE-OUT SET.
//   undecidedPaths  — those paths alone, for a caller that only needs membership.
//   configured      — the decisions whose provider IS configured; their paths are exercised in full.
//   configuredPaths — those paths alone.
//   unknown         — `/oauth/<p>` paths with no recorded gate, each with its fixture-bug reason.
export function deriveProviderConfiguration(env, routedPaths = AUTH_SURFACE_ROUTED_PATHS) {
  const candidates = socialProviderCandidates(routedPaths);
  const decisions = [];
  const unknown = [];

  for (const { routedPath, provider } of candidates) {
    const decision = decideProviderConfiguration(env, provider);
    if (decision === null) {
      unknown.push(
        Object.freeze({
          routedPath,
          provider,
          reason: unknownProviderReason(routedPath, provider),
        }),
      );
      continue;
    }
    decisions.push(
      Object.freeze({
        ...decision,
        routedPath,
        reason: decision.configured ? null : unconfiguredProviderReason(decision, routedPath),
      }),
    );
  }

  const undecided = decisions.filter((decision) => !decision.configured);
  const configured = decisions.filter((decision) => decision.configured);

  return Object.freeze({
    candidates,
    decisions: Object.freeze(decisions),
    undecided: Object.freeze(undecided),
    undecidedPaths: Object.freeze(undecided.map((decision) => decision.routedPath)),
    configured: Object.freeze(configured),
    configuredPaths: Object.freeze(configured.map((decision) => decision.routedPath)),
    unknown: Object.freeze(unknown),
  });
}

// Is this path in the carve-out? The membership test task 11.1's rule applies per exercise.
export function isUndecidedPath(derivation, routedPath) {
  return derivation.undecidedPaths.includes(routedPath);
}

// The reason to report for a path, or null when the path decides normally — a configured provider's
// path, a path with no recorded gate, or any path that is not a provider path at all. Returning null
// rather than a generic string is what keeps a configured provider from reporting `undecided`: there
// is no reason to attach, so there is no verdict to withhold.
export function undecidedReasonFor(derivation, routedPath) {
  const decision = derivation.undecided.find((entry) => entry.routedPath === routedPath);
  return decision === undefined ? null : decision.reason;
}

// Cross-check the derivation against the recorded `Path_Payload` set (task 11.4). A provider path's
// recorded status is the application's answer for an UNCONFIGURED provider — 500 out of
// `ErrorController`, because `passport.authenticate` on an unregistered strategy hands `next()` a
// plain Error. Configuring the provider changes that answer, so a configured provider still carrying
// the unconfigured status is a stale payload: the path moved into full exercise and its recorded
// expectation did not follow. This is the other half of "a configured provider whose path still
// reports `undecided` is a fixture bug" — the membership half cannot happen by construction, and this
// catches the expectation half. Pure over both tables; `payloadEntries` is PATH_PAYLOADS-shaped
// (`{ routedPath, expectedStatus }`) and passed in rather than imported, so this module stays
// independent of the payload fixture's load order.
export function findStaleProviderPayloads(
  derivation,
  payloadEntries,
  { unconfiguredStatus = 500 } = {},
) {
  const stale = [];
  for (const decision of derivation.configured) {
    const entry = payloadEntries.find((payload) => payload.routedPath === decision.routedPath);
    if (entry === undefined || entry.expectedStatus !== unconfiguredStatus) {
      continue;
    }
    stale.push(
      Object.freeze({
        routedPath: decision.routedPath,
        provider: decision.provider,
        expectedStatus: entry.expectedStatus,
        detail:
          `FIXTURE BUG: \`${decision.provider}\` IS configured in the resolved environment, so ` +
          `${decision.routedPath} is exercised in full (Req 3.21) — but its recorded Path_Payload ` +
          `still expects ${entry.expectedStatus}, which is the answer for an UNCONFIGURED provider ` +
          '(an unregistered strategy reaching `ErrorController` as a plain Error). Re-record the ' +
          'expected status and its `why` against the configured handshake.',
      }),
    );
  }
  return Object.freeze(stale);
}

// Read the resolved environment the provider-serving container actually runs under. Thin wrapper over
// the harness's existing `docker compose config` seam, so the profile and the service are named once
// and `exec` stays injectable for a test with no Docker. Throws when the service is absent from the
// resolved config — that means the topology or the profile is not what the caller thinks, which must
// not silently produce an empty env map (every provider would read as unconfigured, and the carve-out
// would be wide for the wrong reason).
export async function readProviderEnvironment({
  exec,
  profile,
  service = PROVIDER_ENV_SERVICE,
} = {}) {
  const resolved = await readResolvedEnvironments({ exec, profile, services: [service] });
  const env = resolved[service];
  if (env === undefined) {
    throw new Error(
      `path-exercise.providers: compose service ${JSON.stringify(service)} is absent from the ` +
        'resolved configuration, so the provider configuration cannot be read. An empty env map ' +
        'would make every provider read as unconfigured and widen the Unconfigured_Provider ' +
        'carve-out for the wrong reason (Req 3.21).',
    );
  }
  return env;
}

// Read the resolved provider configuration and derive the carve-out in one call — what a live check
// invokes. `env` short-circuits the read for a caller that already holds the resolved map (and for a
// test), and `routedPaths` defaults to the list this check exercises.
export async function resolveProviderConfiguration({
  env,
  routedPaths = AUTH_SURFACE_ROUTED_PATHS,
  exec,
  profile,
  service = PROVIDER_ENV_SERVICE,
} = {}) {
  const resolvedEnv = env ?? (await readProviderEnvironment({ exec, profile, service }));
  return deriveProviderConfiguration(resolvedEnv, routedPaths);
}
