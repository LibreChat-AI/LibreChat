#!/usr/bin/env node
// run.mjs — the two-container-test-harness Layer B runner (Req 5.1, 5.5, 5.6).
//
// One documented entry command, zero interactive prompts, so the command an engineer runs locally
// (`npm run harness:container-split`) is the command CI runs. This file is authored in pieces
// across task 7: THIS commit lands 7.1 — per-run secret generation, resolved-env-file writing, the
// password-distinctness assertion, MONGO_URI validation, and the classification of setup outcomes
// as SETUP FAILURES distinct from check failures (Property 9). Later 7.x tasks add the observer
// credential and profiling (7.2), teardown (7.4), the Jest config and check-record serializer
// (7.5), and the two HTTP clients (7.6).
//
// It composes existing artifacts and changes no application code, no route mount and no HTTP path
// (NG1), and it never edits either container-split script (NG2). Secrets are generated with
// crypto.randomBytes per run and written only into env/*.env, which .gitignore excludes; the
// committed env/*.env.example templates carry names and non-secret values only (Req 5.6).
//
// == Why the pieces below are pure and exported ==
// Docker bring-up cannot be exercised here (task 15 owns that). So the four things that CAN run
// without Docker — secret generation, env-file resolution, the distinctness assertion, and URI
// validation — are written as pure, independently importable functions with no Docker or process
// side effects, and are unit-tested by task 15's siblings and runnable now via `--validate`. The
// Docker-touching orchestration is quarantined in `main()` behind that flag.

import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The application's OWN password hasher, at the application's own cost factor — the `bcryptjs` the
// registration path and the local login strategy both require (api/server/services/AuthService.js,
// api/strategies/localStrategy.js). The Seeded_Account's password hash has to be a hash the login
// comparison accepts, so the harness uses the same library rather than a second convention
// (task 11.5). Nothing else here hashes anything, and the harness performs no other crypto.
import bcrypt from 'bcryptjs';

// The Check Catalog's id set — the vocabulary the early-exit report accounts for, so a run that ended
// before stage 11 still records one result per id the catalog carries rather than leaving ids
// unmentioned. The early-exit report (below) tells a backend-lane id from a Layer B one through
// layer-a-outcome.mjs's `isBackendLaneCheck`, which reads the catalog's own `layer` rather than a
// second list here.
// `checkIdsForProfile` is the profile dimension of the same table: a run accounts for the ids its
// profile selects, not every id the catalog carries (the collapsed profile runs one container, so the
// checks whose claim is about the relationship between two containers are not its to decide). The
// early-exit report and the post-run artifact validation below are both built over that set, so a
// correct collapsed report is not failed for "missing" ids the run never claimed.
import { CHECK_IDS, CHECK_PROFILES, checkIdsForProfile } from './check-catalog.mjs';

// The record shape and the run-level fold. The runner needs them for the ONE case the Jest reporter
// cannot cover: a run that ends before stage 11 never invokes the reporter, so the runner builds and
// writes that run's report itself, in the same shape and through the same serializer, so the two
// paths cannot disagree about what a record looks like.
// Imported under an alias. `CHECK_STATUS` is the check RECORD's status vocabulary ('pass' | 'fail' |
// 'skip' | 'setup-failure'), and this file also handles per-path outcome labels and setup-failure
// kinds; spelling it `RECORD_STATUS` at each use site keeps it unambiguous which vocabulary is in play.
import {
  CHECK_STATUS as RECORD_STATUS,
  SKIP_REASON,
  buildCheckRecord,
  serializeRun,
} from './serializer.mjs';

// The one artifact path, owned by the module that normally writes it (reporter.mjs). Imported rather
// than respelled so the runner deletes and writes the same file the reporter does.
import { RUN_REPORT_PATH } from './reporter.mjs';

// Layer A's one spawn result -> twelve catalog records. The classification lives in its own module
// because BOTH report writers need it: the early-exit report below, and the stage-11 reporter inside
// the Layer B Jest run (which had no knowledge of Layer A at all and therefore misreported all twelve
// as "optional dependency absent"). Re-exported at the bottom of this section so the existing
// importers of these names from run.mjs keep working.
import {
  LAYER_A_RESULT_ENV,
  isBackendLaneCheck,
  classifyLayerAOutcomeFor,
  serializeLayerASummary,
} from './layer-a-outcome.mjs';

// The tested-image record and its runner→reporter env hand-off (task 17.5, Req 5.12). The reporter
// reads the same env var back through this module's readImageRecord.
import { IMAGE_RECORD_ENV, serializeImageRecord } from './image-record.mjs';

// The run-report artifact deciders — well-formedness and the catalog-accounting rules. Shared with
// RUN-REPORT-32 (checks/run-report.filter.mjs), which decides them over a synthesized report, while
// the runner below decides them over the file the stage-11 reporter actually wrote. One decider, two
// inputs: the check can assert the rules without depending on its own run's output file, and the
// runner validates the artifact at the only moment it exists.
import { decideArtifactWellFormed, decideArtifactAccounting } from './report-artifact.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV_DIR = path.join(HERE, 'env');

// ---------------------------------------------------------------------------------------------
// Fixed identities. The usernames and the LibreChat database name are the design's (design:
// "The URI construction") and provision.mongo.js's defaults (harness_root is the root bootstrap
// user, the two grant users are the script's AUTH_USER_NAME / API_USER_NAME defaults). They are
// NOT secrets, so they are named here rather than generated. The observer user is created by the
// harness's own root snippet in task 7.2 (NG2); its name is fixed here so the generated password
// has a home the moment 7.2 lands.
// ---------------------------------------------------------------------------------------------
export const IDENTITIES = Object.freeze({
  mongoDb: 'LibreChat',
  rootUsername: 'harness_root',
  authUsername: 'librechat_auth_surface',
  apiUsername: 'librechat_api_container',
  observerUsername: 'librechat_observer',
  authSource: 'admin',
});

// The one address the compose file publishes MONGO_URI against. Kept here so the resolved URIs the
// runner validates match compose.harness.yml's `environment:` MONGO_URI exactly (host `mongodb`,
// container port 27017), which is what makes MONGO-URI-19's cross-check against the resolved
// container environment meaningful rather than a comparison of two independently-authored strings.
const MONGO_HOST = 'mongodb';
const MONGO_PORT = 27017;

// The supported profiles. compose.harness.yml defines both; the collapsed profile reuses the same
// auth-surface service with an env overlay (design: PARITY-COLLAPSE-29). Re-exported from the Check
// Catalog rather than respelled: the catalog keys each check's profile applicability on these names,
// so a profile this parser accepted and the catalog did not know would select no checks at all.
export const PROFILES = CHECK_PROFILES;

// The observer role's name on admin. The user's name is IDENTITIES.observerUsername; the role is
// harness machinery created by the runner's own root snippet (below), never by the provisioning
// script (NG2), so it is named here rather than in the script's output.
export const OBSERVER_ROLE_NAME = 'librechatHarnessObserver';

// The read set the observer holds and nothing more. `find` alone — the observer is read-only by
// construction (Req 3.9). Kept as its own constant so the privilege builder and any test read one
// source, and it mirrors the Layer A fixture's READ_ACTIONS.
export const OBSERVER_READ_ACTIONS = Object.freeze(['find']);

// Readiness and bring-up budgets (Req 2.3, 1.11 / 1.13). Named constants because task 7's later
// pieces and task 9's checks reference the same numbers; a single source keeps them in agreement.
export const MONGO_READINESS_TIMEOUT_MS = 60_000;
export const BRINGUP_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------------------------
// SetupFailure — the classification Property 9 turns on.
//
// A setup failure means the topology never came up, so it has FALSIFIED NOTHING (Req 1.13, 2.3,
// 2.6, 2.8, 2.9). It is reported distinctly from a check failure and, once one occurs, no
// request-level check is admitted — the compose `depends_on` chain (task 6.1) enforces the same
// ordering structurally, so the two mechanisms agree rather than one carrying it alone.
//
// `kind` is a stable machine tag the run report (task 7.5) keys on; `service` names the offending
// service where one applies; `detail` carries verbatim context (a
// script's stderr, a log tail) so a diagnosis does not require re-running.
// ---------------------------------------------------------------------------------------------
export const SETUP_FAILURE_KINDS = Object.freeze({
  MONGO_READINESS_TIMEOUT: 'mongo-readiness-timeout',
  PROVISION_FAILED: 'provision-failed',
  EQUAL_GRANT_PASSWORDS: 'equal-grant-passwords',
  MONGO_URI_AUTHSOURCE: 'mongo-uri-authsource',
  // A service never reached a serving state inside the 300-second window and NOTHING failed outright:
  // a healthcheck that stayed `starting` until the budget ran out. A genuine readiness timeout.
  BRINGUP_TIMEOUT: 'bringup-timeout',
  // A container FAILED — exited non-zero, or went `unhealthy` — so compose aborted the bring-up
  // instead of waiting the window out. Distinct from BRINGUP_TIMEOUT because the two have different
  // causes, different elapsed times and different first things to read: a container that exited has a
  // log with a reason in it, while a readiness timeout has a container that is still running. Reporting
  // an exit-in-14-seconds as "did not reach a healthy topology within 300s" asserts an elapsed time the
  // runner never observed and sends the reader to the wrong evidence.
  BRINGUP_CONTAINER_FAILED: 'bringup-container-failed',
  // A resolved env file sets a key to the EMPTY STRING whose consumer parses it with math() and no
  // fallbackValue, so the container dies at module load rather than starting (see
  // MATH_PARSED_ENV_KEYS). A fixture defect, caught before bring-up instead of arriving as a
  // 300-second bring-up timeout with the real cause 80 log lines deep.
  ENV_EMPTY_MATH_VALUE: 'env-empty-math-value',
  // The image could be neither found in the local store nor built (stage 1). A run against a stale
  // or absent image is the one failure mode that produces confident nonsense, so it fails loudly.
  IMAGE_UNRESOLVED: 'image-unresolved',
  // One of the nine compose ${...} interpolation values was not resolved by the runner before the
  // compose spawn (stage 2 preflight). The compose file carries no defaults, so an unresolved value
  // is a HARNESS bug, not a container that will not start — surfaced here rather than as empty.
  INTERPOLATION_UNRESOLVED: 'interpolation-unresolved',
  // The harness-owned root snippet (observer credential + profiling sizing) failed to apply (stage 7).
  OBSERVER_SNIPPET_FAILED: 'observer-snippet-failed',
});

export class SetupFailure extends Error {
  constructor(kind, message, { service = null, detail = null } = {}) {
    super(message);
    this.name = 'SetupFailure';
    this.kind = kind;
    this.service = service;
    this.detail = detail;
    // Marks this apart from an ordinary Error or a check failure at the reporting boundary, so a
    // catch site never mistakes an infrastructure flake for a falsified property (Property 9).
    this.isSetupFailure = true;
  }
}

// ---------------------------------------------------------------------------------------------
// Secret generation (Req 5.6). Every value below is generated per run with crypto.randomBytes and
// written only into env/*.env. Nothing here is committed.
//
// CREDS_KEY is 32 bytes hex and CREDS_IV is 16 bytes hex because the application's AES-256-CBC
// credential encryption requires exactly those sizes — a 32-byte key and a 16-byte IV — and both
// must be identical on the two containers (common.env), since the Auth_Surface decrypts stored
// TOTP secrets the API_Container wrote. The other values are opaque high-entropy tokens; their
// only contract is uniqueness and unguessability.
// ---------------------------------------------------------------------------------------------
const hex = (bytes) => randomBytes(bytes).toString('hex');

export function generateSecrets() {
  return {
    MONGO_ROOT_PASSWORD: hex(24),
    AUTH_MONGO_PASSWORD: hex(24),
    API_MONGO_PASSWORD: hex(24),
    OBSERVER_MONGO_PASSWORD: hex(24),
    // Sized to the cipher, not chosen freely: 32-byte key, 16-byte IV, both as hex.
    CREDS_KEY: hex(32),
    CREDS_IV: hex(16),
    JWT_SECRET: hex(32),
    JWT_REFRESH_SECRET: hex(32),
    MEILI_MASTER_KEY: hex(32),
  };
}

// ---------------------------------------------------------------------------------------------
// The password-distinctness assertion (Req 2.8, Property 9).
//
// Run BEFORE the provisioning spawn. A collision between two independent crypto.randomBytes draws
// is not bad luck — at 24 bytes it is a ~1-in-2^192 event — it means the generator is broken, and
// provisioning under two equal grant passwords would hand both containers interchangeable
// credentials and dissolve the enforcement boundary the whole harness exists to test. The script
// refuses equal passwords too; failing here first gives a clearer message than parsing the
// script's throw, and the two refusals agree rather than one carrying it.
// ---------------------------------------------------------------------------------------------
export function assertGrantPasswordsDistinct(secrets) {
  if (secrets.AUTH_MONGO_PASSWORD === secrets.API_MONGO_PASSWORD) {
    throw new SetupFailure(
      SETUP_FAILURE_KINDS.EQUAL_GRANT_PASSWORDS,
      'Refusing to provision: AUTH_MONGO_PASSWORD equals API_MONGO_PASSWORD. Two independent ' +
        'crypto.randomBytes draws collided, which means the secret generator is broken, not ' +
        'unlucky. The two containers must never share a grant credential.',
    );
  }
}

// ---------------------------------------------------------------------------------------------
// MONGO_URI validation (Req 2.5, 2.6, MONGO-URI-19 setup guard).
//
// Parse each container's MONGO_URI before bring-up and fail setup if it omits authSource or names
// anything but admin. Cheap, and it catches the single most likely configuration mistake: roles
// and users live on admin while privileges name the LibreChat database, so a URI without
// authSource authenticates against the default database and fails with an error that reads like a
// wrong password. Reporting it here as an authentication-source defect — before bring-up — is what
// NC5 proves the guard does. This is a URI-string guard; MONGO-URI-19's full check also reads the
// resolved container environment in task 9.4, and this function is what that check reuses.
// ---------------------------------------------------------------------------------------------
export function validateMongoUri(uri, label) {
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    throw new SetupFailure(
      SETUP_FAILURE_KINDS.MONGO_URI_AUTHSOURCE,
      `${label} MONGO_URI is not a parseable URI.`,
      { service: label },
    );
  }

  if (parsed.protocol !== 'mongodb:' && parsed.protocol !== 'mongodb+srv:') {
    throw new SetupFailure(
      SETUP_FAILURE_KINDS.MONGO_URI_AUTHSOURCE,
      `${label} MONGO_URI must use the mongodb scheme; found "${parsed.protocol}".`,
      { service: label },
    );
  }

  const authSource = parsed.searchParams.get('authSource');
  if (authSource === null) {
    throw new SetupFailure(
      SETUP_FAILURE_KINDS.MONGO_URI_AUTHSOURCE,
      `${label} MONGO_URI omits authSource. The two grant users live on the admin database, so ` +
        'the URI must carry authSource=admin; without it the credential authenticates against ' +
        'the default database and fails with an error that reads like a wrong password.',
      { service: label },
    );
  }
  if (authSource !== IDENTITIES.authSource) {
    throw new SetupFailure(
      SETUP_FAILURE_KINDS.MONGO_URI_AUTHSOURCE,
      `${label} MONGO_URI names authSource="${authSource}" but the two roles and users were ` +
        `created on "${IDENTITIES.authSource}". This is an authentication-source defect, not a ` +
        'container that will not start.',
      { service: label },
    );
  }

  // The default database (the path segment) must name the LibreChat database the script scoped its
  // privileges to. A grant credential pointed at the wrong default database authenticates on admin
  // (correct) but addresses the wrong data, so the collection-scoped privileges reach nothing.
  const defaultDb = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (defaultDb !== IDENTITIES.mongoDb) {
    throw new SetupFailure(
      SETUP_FAILURE_KINDS.MONGO_URI_AUTHSOURCE,
      `${label} MONGO_URI names default database "${defaultDb || '(none)'}" but the grant ` +
        `privileges are scoped to "${IDENTITIES.mongoDb}".`,
      { service: label },
    );
  }

  return { username: decodeURIComponent(parsed.username), authSource, defaultDb };
}

// Build the two containers' MONGO_URI values the way compose.harness.yml interpolates them
// (design: "The URI construction"), so what the runner validates is what the containers receive.
// Kept beside the validator so the assembled URI and the guard that checks it share one shape.
export function buildContainerUris(secrets) {
  const uri = (user, password) =>
    `mongodb://${user}:${password}@${MONGO_HOST}:${MONGO_PORT}/` +
    `${IDENTITIES.mongoDb}?authSource=${IDENTITIES.authSource}`;
  return {
    auth: uri(IDENTITIES.authUsername, secrets.AUTH_MONGO_PASSWORD),
    api: uri(IDENTITIES.apiUsername, secrets.API_MONGO_PASSWORD),
  };
}

// Validate both container URIs. Names each side (auth-surface / api-container) so a failure points
// at the offending container, which is what Req 2.6 requires the report to identify.
export function validateContainerUris(secrets) {
  const { auth, api } = buildContainerUris(secrets);
  validateMongoUri(auth, 'auth-surface');
  validateMongoUri(api, 'api-container');
}

// ---------------------------------------------------------------------------------------------
// Env-file resolution (Req 5.6).
//
// Copy each committed env/*.env.example to env/*.env, substituting GENERATED_PER_RUN and the other
// per-run placeholders with the generated secrets. The templates are the authority on names,
// comments and non-secret values; this function only fills the holes they mark, so a value the
// matrix records survives untouched into the resolved file. .gitignore excludes env/*.env, so the
// resolved files never enter version control.
// ---------------------------------------------------------------------------------------------

// Every substitution the runner performs, expressed as example-file line rewrites. A resolved
// value is written by matching `KEY=<placeholder>` and replacing only the value, so a comment or a
// non-secret value in the template is preserved verbatim.
//
// collapsed.env carries the Container_2_Grant MONGO_URI as three GENERATED_PER_RUN segments
// (user:pw@host/db); it is resolved to the full API-grant URI rather than field by field, because
// the URI is one value the API_Container also receives via compose and the two must be identical.
function resolvedValuesFor(fileName, secrets) {
  const common = {
    CREDS_KEY: secrets.CREDS_KEY,
    CREDS_IV: secrets.CREDS_IV,
    JWT_SECRET: secrets.JWT_SECRET,
    JWT_REFRESH_SECRET: secrets.JWT_REFRESH_SECRET,
  };
  switch (fileName) {
    case 'common.env':
      // Everything Req 1.5 requires identical on both containers.
      return { ...common };
    case 'auth-surface.env':
      // No secret placeholders — MEILI_* are deliberately absent here (env-matrix.md).
      return {};
    case 'api-container.env':
      return { MEILI_MASTER_KEY: secrets.MEILI_MASTER_KEY };
    case 'collapsed.env':
      return {
        MEILI_MASTER_KEY: secrets.MEILI_MASTER_KEY,
        // The Container_2_Grant URI, resolved whole — same value the API_Container gets via compose.
        MONGO_URI: buildContainerUris(secrets).api,
      };
    default:
      return {};
  }
}

// The list of example files the runner resolves. Sourced from the committed templates (task 6.2).
export const ENV_EXAMPLE_FILES = Object.freeze([
  'common.env',
  'auth-surface.env',
  'api-container.env',
  'collapsed.env',
]);

// Resolve one example file's text into its concrete form. Pure: takes template text, returns
// resolved text, so it is testable without touching the filesystem. A GENERATED_PER_RUN left after
// resolution is a template that grew a placeholder the runner does not know how to fill — a bug
// worth failing on rather than shipping an unresolved marker into a live container.
export function resolveEnvText(fileName, exampleText, secrets) {
  const values = resolvedValuesFor(fileName, secrets);
  const lines = exampleText.split('\n');
  const resolved = lines.map((line) => {
    // Only rewrite `KEY=...` assignment lines; comments and blanks pass through untouched.
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!match) {
      return line;
    }
    const key = match[1];
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      return `${key}=${values[key]}`;
    }
    return line;
  });

  // Only an assignment VALUE still carrying the marker is a real miss; a comment that mentions
  // GENERATED_PER_RUN (the templates explain the convention in prose) is not. Inspect the value
  // side of `KEY=value` lines only.
  const leftover = resolved
    .map((line) => /^([A-Z0-9_]+)=(.*)$/.exec(line))
    .filter((m) => m && m[2].includes('GENERATED_PER_RUN'))
    .map((m) => m[1]);
  if (leftover.length > 0) {
    throw new Error(
      `Unresolved GENERATED_PER_RUN placeholder(s) in ${fileName}: ${leftover.join(', ')}. The ` +
        'template grew a per-run secret the runner does not fill; add it to resolvedValuesFor().',
    );
  }
  return resolved.join('\n');
}

// Read each *.env.example, resolve it, and write the *.env sibling. Returns the paths written so a
// caller (and the run report) can name them.
export async function writeResolvedEnvFiles(secrets, { envDir = ENV_DIR } = {}) {
  await mkdir(envDir, { recursive: true });
  const written = [];
  for (const fileName of ENV_EXAMPLE_FILES) {
    const examplePath = path.join(envDir, `${fileName}.example`);
    const outPath = path.join(envDir, fileName);
    const exampleText = await readFile(examplePath, 'utf8');
    const resolved = resolveEnvText(fileName, exampleText, secrets);
    await writeFile(outPath, resolved, { mode: 0o600 });
    written.push(outPath);
  }
  return written;
}

// ---------------------------------------------------------------------------------------------
// The empty-value fixture guard (Property 9).
//
// Why this guard exists: `KEY=` in an env file is not "unset". Docker's env_file reader turns it
// into an empty STRING in the container's environment, and an empty string is a value the
// application must then parse. For most keys that is harmless — isEnabled('') is false, and the
// string readers all spell `?.trim() || default`. For the keys below it is fatal at MODULE LOAD:
// packages/api/src/mcp/mcpConfig.ts reads each as `math(process.env.KEY ?? <default>)`, `??` falls
// back on null/undefined only, so '' is passed straight through to math() with NO fallbackValue;
// math()'s validator (packages/api/src/utils/math.ts) is /^[+\-\d.\s*\/%()]+$/, `+`-quantified, so
// it does not match '' and math() throws. mcpConfig.ts evaluates these at import time, so the
// throw happens before any route mounts and the container never serves.
//
// Without this guard that failure arrives as a 300-second SETUP FAILURE [bringup-timeout] naming
// an unhealthy service, with `Error: Invalid characters in string` buried in the log tail and
// nothing pointing at the env fixture that caused it. So the guard reads the fixture instead: it
// names the file, the key, and why the empty value is fatal, before any container starts.
//
// This is a FIXTURE-CORRECTNESS guard, not a general env validator. It asserts one thing about the
// harness's own generated files, over a closed key list, and it has no opinion about any other key:
// DISABLE_STARTUP_TASKS= in collapsed.env is deliberately empty and stays that way, because
// isEnabled('') is false and that is exactly the collapse lever the matrix names.
// ---------------------------------------------------------------------------------------------

// The guarded keys, derived explicitly rather than inferred. This is every site in the application
// that calls `math(process.env.KEY ?? …)` with no `fallbackValue` — which is to say every key for
// which an empty string throws instead of defaulting. All of them live in one module,
// packages/api/src/mcp/mcpConfig.ts, and all are read at import time. Re-derive with:
//
//   grep -rnE "math\(process\.env\.[A-Z_0-9]+ *\?\?" --include='*.ts' --include='*.js' packages api
//
// A `math(process.env.KEY, fallback)` call site is deliberately NOT on this list: the second
// argument makes math() return the fallback for '' instead of throwing, so an empty value there is
// merely ignored. Keeping the list to the throwing sites is what keeps it small and true.
export const MATH_PARSED_ENV_KEYS = Object.freeze([
  'MCP_OAUTH_HANDLING_TIMEOUT',
  'MCP_OAUTH_FLOW_TTL',
  'MCP_OAUTH_DETECTION_TIMEOUT',
  'MCP_CONNECTION_CHECK_TTL',
  'MCP_TOOLS_LIST_MAX_PAGES',
  'MCP_TOOLS_LIST_MAX_TOOLS',
  'MCP_TOOLS_LIST_MAX_BYTES',
  'MCP_TOOLS_LIST_TIMEOUT_MS',
  'MCP_CB_MAX_CYCLES',
  'MCP_CB_CYCLE_WINDOW_MS',
  'MCP_CB_CYCLE_COOLDOWN_MS',
  'MCP_CB_MAX_FAILED_ROUNDS',
  'MCP_CB_FAILED_WINDOW_MS',
  'MCP_CB_BASE_BACKOFF_MS',
  'MCP_CB_MAX_BACKOFF_MS',
]);

// Scan one env file's text for guarded keys assigned an empty (or whitespace-only) value. Pure over
// the text, so the decision is exercisable without a filesystem or a container. Returns the offending
// keys in the order they appear; an empty array means the file is clean.
//
// A commented-out line is not an assignment, so `# MCP_OAUTH_FLOW_TTL=` is ignored: a comment sets
// nothing, and the templates explain the absent keys in prose that would otherwise trip the scan.
// A whitespace-only value counts as empty because math() rejects ' ' for the same reason it rejects
// '' — the validator matches digits and operators, not a bare space.
export function findEmptyMathParsedKeys(envText, guardedKeys = MATH_PARSED_ENV_KEYS) {
  const guarded = new Set(guardedKeys);
  const offenders = [];
  for (const rawLine of (envText ?? '').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=(.*)$/.exec(rawLine);
    if (match === null) {
      continue;
    }
    const [, key, value] = match;
    if (guarded.has(key) && value.trim() === '') {
      offenders.push(key);
    }
  }
  return offenders;
}

// Classify a set of already-read env files. Pure over `[{ file, text }]` — no filesystem, no spawn —
// so the classifier is unit-testable exactly as the other pre-bring-up guards are. Returns the
// files unchanged on a clean scan; throws one ENV_EMPTY_MATH_VALUE SetupFailure naming every
// offending file and key otherwise, so a fixture with two defects is fixed in one pass.
export function assertNoEmptyMathParsedValues(files, guardedKeys = MATH_PARSED_ENV_KEYS) {
  const offenses = [];
  for (const { file, text } of files) {
    for (const key of findEmptyMathParsedKeys(text, guardedKeys)) {
      offenses.push({ file, key });
    }
  }
  if (offenses.length === 0) {
    return files;
  }
  const named = offenses.map(({ file, key }) => `${path.basename(file)}: ${key}=`).join(', ');
  throw new SetupFailure(
    SETUP_FAILURE_KINDS.ENV_EMPTY_MATH_VALUE,
    `Resolved env fixture sets ${offenses.length} key(s) to an empty value that the application ` +
      `parses with math() and no fallback: ${named}. This is FATAL, not untidy: docker's env_file ` +
      'turns `KEY=` into an empty string rather than an unset variable, ' +
      'packages/api/src/mcp/mcpConfig.ts reads these as `math(process.env.KEY ?? <default>)`, `??` ' +
      "falls back on null/undefined only, and math()'s /^[+\\-\\d.\\s*/%()]+$/ validator rejects " +
      "'' — so math() throws at module load and the container dies before any route mounts. Remove " +
      'the key from the corresponding env/*.env.example (and the resolved env/*.env) so it resolves ' +
      'the application default; do not substitute a value. Caught before bring-up so this reads as ' +
      'the fixture defect it is rather than as a 300-second bring-up timeout.',
    { service: 'env-fixture', detail: offenses.map(({ file }) => file).join('\n') },
  );
}

// Read the resolved env files back and run the classifier over them. Reads what the containers will
// actually receive — the resolved env/*.env, not the committed templates — so a defect introduced by
// resolution is caught as well as one carried in from a template. The read/throw split keeps the
// decision pure (assertNoEmptyMathParsedValues) and this wrapper thin.
export async function assertResolvedEnvFilesHaveNoEmptyMathValues(envFiles) {
  const files = await Promise.all(
    envFiles.map(async (file) => ({ file, text: await readFile(file, 'utf8') })),
  );
  assertNoEmptyMathParsedValues(files);
  return envFiles;
}

// ---------------------------------------------------------------------------------------------
// Provisioning-outcome classification (Req 2.9, Property 9).
//
// The Provisioning_Script signals success with exit 0 AND "Done." on stdout. Anything else — a
// non-zero exit, or exit 0 without the marker — is a setup failure carrying the script's stderr
// verbatim, so the diagnosis is in the report rather than requiring a re-run. This is a pure
// classifier over an already-captured spawn result, so it is testable without spawning mongosh;
// the actual spawn lands with the Docker orchestration (task 15).
// ---------------------------------------------------------------------------------------------
export const PROVISION_SUCCESS_MARKER = 'Done.';

export function classifyProvisionOutcome({ status, stdout = '', stderr = '' }) {
  const sawDone = stdout.split('\n').some((line) => line.trim() === PROVISION_SUCCESS_MARKER);
  if (status === 0 && sawDone) {
    return { ok: true };
  }
  const reason =
    status !== 0
      ? `provision.mongo.js exited ${status}`
      : `provision.mongo.js exited 0 but did not emit "${PROVISION_SUCCESS_MARKER}" on stdout`;
  throw new SetupFailure(
    SETUP_FAILURE_KINDS.PROVISION_FAILED,
    `Provisioning failed: ${reason}. No request-level check is admitted.`,
    { service: 'provision', detail: stderr },
  );
}

// ---------------------------------------------------------------------------------------------
// The observer credential and boot-time profiling (Req 3.9; setup for BOOT-NOWRITE-23 and
// GRANT-DENY-WRITE-04 corroboration).
//
// Two things land here, both built as pure snippet-producers so the logic is testable without a
// live mongod (the actual root `mongosh` spawn is task 15):
//
//  1. A read-only observer role + user, created by the runner's OWN root snippet — never by
//     provision.mongo.js (NG2). It grants `find` on `system.profile` and on every collection a
//     check inspects, and nothing else. It is Req 3.9's read-only credential distinct from the
//     Container_1_Grant, and it is what lets BOOT-NOWRITE-23 read the profile and GRANT-DENY-WRITE-04
//     confirm a refused write left the target unchanged, both without using either container's
//     credential to look.
//
//  2. Boot-time profiling: before the Auth_Surface starts, as root, disable profiling, drop
//     system.profile, recreate it CAPPED AT 64 MB, then set profiling to level 2 (all operations).
//     The explicit sizing is load-bearing: system.profile is capped at 1 MB by default, and a
//     read-heavy boot can roll it and discard the earliest entries — a false pass on exactly the
//     window BOOT-NOWRITE-23 cares about. 64 MB removes that failure mode (design: Boot-Write
//     Observation).
//
// NG2 is absolute here: none of this touches or is emitted by the provisioning script. NG1 holds
// too — this composes machinery around the existing image and changes no application code.
// ---------------------------------------------------------------------------------------------

// system.profile is the mongod-managed profiling collection. The observer must read it (that is how
// BOOT-NOWRITE-23 counts boot writes) and the runner sizes it below, so it is named once here.
export const SYSTEM_PROFILE_COLLECTION = 'system.profile';

// The capped size for system.profile, in bytes. 64 MB, spelled as the byte count mongod stores, so
// the generated `createCollection` carries the literal 67108864 the design specifies rather than an
// expression a reader has to evaluate.
export const SYSTEM_PROFILE_CAP_BYTES = 64 * 1024 * 1024; // 67108864

// The collections a check inspects under the observer, mirrored from the Layer A fixture's
// OBSERVER_SEEDED_COLLECTIONS conceptually: the five collections outside the twelve that a refused
// read targets (conversations, messages, files, tokens, keys) plus the four read-only collections a
// refused write targets (roles, configs, systemgrants, banners). authtokens and bans are absent by
// design — a materialization check asserts they appear on first write, and the observer reads only
// what a refusal check reads. This is the single source the observer's grant is built from.
export const OBSERVER_INSPECTED_COLLECTIONS = Object.freeze([
  'conversations',
  'messages',
  'files',
  'tokens',
  'keys',
  'roles',
  'configs',
  'systemgrants',
  'banners',
]);

// Everything the observer is granted `find` on: system.profile plus the inspected collections, and
// nothing else. Exported so a test can assert exhaustiveness (find-only, no thirteenth resource).
export const OBSERVER_GRANTED_COLLECTIONS = Object.freeze([
  SYSTEM_PROFILE_COLLECTION,
  ...OBSERVER_INSPECTED_COLLECTIONS,
]);

// Build the mongosh snippet that creates the observer role and user on admin. Pure: takes the
// database name and the observer password, returns the script text. The role names every privilege
// resource for the LibreChat database and grants only `find`; the user is created on admin with the
// role on admin, so it authenticates with authSource=admin in the same shape as the two grants
// (design: "The observer credential").
export function buildObserverSnippet(dbName, observerPassword) {
  const privileges = OBSERVER_GRANTED_COLLECTIONS.map((collection) => ({
    resource: { db: dbName, collection },
    actions: [...OBSERVER_READ_ACTIONS],
  }));
  return [
    'db.getSiblingDB("admin").createRole({',
    `  role: ${JSON.stringify(OBSERVER_ROLE_NAME)},`,
    `  privileges: ${JSON.stringify(privileges)},`,
    '  roles: [],',
    '});',
    'db.getSiblingDB("admin").createUser({',
    `  user: ${JSON.stringify(IDENTITIES.observerUsername)},`,
    `  pwd: ${JSON.stringify(observerPassword)},`,
    `  roles: [{ role: ${JSON.stringify(OBSERVER_ROLE_NAME)}, db: "admin" }],`,
    '});',
  ].join('\n');
}

// The boot-window ANCHOR collection, and why the boot-write check needs one.
//
// BOOT-NOWRITE-23 must not pass off an unusable observation (Property 6), so it asserts that the
// profile still holds the window's left edge: a capped `system.profile` that rolled discarded its
// oldest entries, and a zero count read off a rolled profile is silence mistaken for evidence. The
// original test for that was "the oldest surviving entry predates the container's start timestamp" —
// and on a real run it failed on every boot, because the profile is DROPPED AND RECREATED EMPTY
// milliseconds before that timestamp is recorded. There was nothing before the window for the oldest
// entry to be. The precondition could not hold on a healthy run, which is the definition of a broken
// check rather than a finding.
//
// So the runner writes the anchor itself: with profiling already at level 2 and before any container
// starts, it issues ONE profiled read against this collection. That read is the first entry in the
// fresh profile, and it sits before the boot window opens. The check then decides usability by the
// anchor's PRESENCE:
//
//   * anchor present  => nothing has been discarded since profiling was enabled, so the profile
//                        covers the whole window. A strictly stronger statement than "some entry
//                        predates boot start", which a partial roll can still satisfy.
//   * anchor absent   => the capped collection rolled past the window's left edge (or profiling never
//                        recorded), so the observation is unusable and the check reports that rather
//                        than a verdict — never a pass.
//
// Presence rather than a timestamp comparison is deliberate: mongod runs in a container and the
// timestamp the runner records for the window's left edge comes from the host clock, so a
// millisecond-scale comparison across the two would make the check hostage to clock skew between them.
// The anchor is a read, and it is issued by root rather than by either container, so it can never be
// counted as a boot write on either the operation filter or the attribution filter.
export const BOOT_WINDOW_ANCHOR_COLLECTION = 'harnessBootWindowAnchor';

// Build the mongosh snippet that sizes and enables command profiling on the LibreChat database.
// Pure: takes the database name, returns the script text. Ordered exactly as the design requires —
// disable, drop, recreate capped at 64 MB, then enable level 2 — because dropping system.profile
// requires profiling off first, and the cap must be set at creation (a capped collection cannot be
// resized afterward). Then the boot-window anchor: create its collection while profiling is still off
// (so the namespace exists and the anchor read is a plain profiled query rather than a read of a
// missing namespace), and issue the anchor read once profiling is on. Runs as root before the
// Auth_Surface starts.
export function buildProfilingSnippet(dbName) {
  return [
    `const profiled = db.getSiblingDB(${JSON.stringify(dbName)});`,
    'profiled.setProfilingLevel(0);',
    'profiled.system.profile.drop();',
    'profiled.createCollection("system.profile", ' +
      `{ capped: true, size: ${SYSTEM_PROFILE_CAP_BYTES} });`,
    // Created BEFORE profiling is enabled, so this creation is not itself profiled and the anchor
    // entry below is the first thing in the collection.
    `profiled.createCollection(${JSON.stringify(BOOT_WINDOW_ANCHOR_COLLECTION)});`,
    'profiled.setProfilingLevel(2);',
    // The anchor: one profiled READ, before any container starts. Its surviving presence is what tells
    // BOOT-NOWRITE-23 the profile still covers the boot window's left edge.
    `profiled.getCollection(${JSON.stringify(BOOT_WINDOW_ANCHOR_COLLECTION)})` +
      '.find({ harnessBootWindowAnchor: true }).toArray();',
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------
// The `Seeded_Account` (Req 3.16, 3.17, 3.18; task 11.5; fixture for PATH-EXERCISE-25).
//
// == Why it exists ==
// Roughly ten of the eighteen path exercises that were PASSING passed vacuously. An anonymous
// request to a session-gated path is refused at the gate ahead of the handler, so the handler issues
// no MongoDB query, so the `Exercise_Log_Window` is clean BECAUSE NOTHING WAS QUERIED — evidence
// identical to what a grant of zero collections would produce (Property 6). One seeded local account
// plus a real session is what converts those exercises into tests of the bounded-below half.
//
// == Inserted, not registered ==
// `/api/auth/register` answers 403 in the harness env (ALLOW_REGISTRATION unset), and registration is
// itself one of the paths under exercise — so registering the account would both fail and entangle the
// fixture with a path whose verdict it is meant to enable. The account is inserted directly into
// `users` with the field set the login path reads.
//
// == Under the Root_Credential, never the Container_1_Grant (Req 3.17) ==
// Seeding with the grant the checks decide on would test the grant with itself: a failed seed would be
// indistinguishable from the grant gap the checks are looking for, and a successful one would have
// assumed the answer to the `users`-write question GRANT-ALLOW-WRITE-05 is supposed to decide. The
// snippet below is appended to the harness-owned ROOT snippet, which already holds the
// `Root_Credential` for exactly this class of precondition (the observer credential, the profile
// sizing).
//
// == Outside the boot window (Req 3.18) ==
// It is the LAST step of that root snippet, which the runner applies immediately before
// `captureBootStart()` records the boot window's left edge — so the insert completes ahead of the
// window BOOT-NOWRITE-23 counts writes inside. Attribution by `user` would filter the seed out anyway
// (it is `harness_root@admin`; the check reads `librechat_auth_surface@admin`), but relying on that
// filter would make the check's correctness depend on a coincidence of credentials rather than on the
// window being clean, and not relying on it costs nothing.
//
// It is also after profiling is enabled, which gives BOOT-NOWRITE-23's usability guard a second
// profiled entry beside the anchor read rather than leaving the profile's contents to whatever the
// boot happened to do.
//
// NG1/NG2 hold: this writes one document into an existing collection through the harness's own root
// connection. No application code, route mount or HTTP path changes, and neither container-split
// script is touched.
// ---------------------------------------------------------------------------------------------

// The bcrypt cost factor the application's OWN registration path uses:
// `const salt = bcrypt.genSaltSync(10)` in `registerUser` (api/server/services/AuthService.js), with
// `resetPassword` and `createTokenHash` hashing at the same 10. The seed hashes at the same factor so
// the login comparison (`comparePassword` → `bcrypt.compare`, api/strategies/localStrategy.js)
// succeeds and the stored hash is not a second convention the application would have to tolerate.
export const SEEDED_ACCOUNT_BCRYPT_COST = 10;

// The provider the local login strategy requires, and the role the application defaults a registered
// user to (`SystemRoles.USER`, which is the `role` default in packages/data-schemas' user schema and
// what `registerUser` assigns to every non-first user). The seed is an ORDINARY user on purpose: the
// admin-login exercise's recorded 403 is the capability middleware's answer for a non-admin, so an
// admin seed would change what that path observes.
export const SEEDED_ACCOUNT_PROVIDER = 'local';
export const SEEDED_ACCOUNT_ROLE = 'USER';

// The reserved TLD the seed's address sits under. `.invalid` can never resolve (RFC 2606), so a
// verification or reset mail the harness's unconfigured transport did try to send could not reach a
// real mailbox.
export const SEEDED_ACCOUNT_EMAIL_DOMAIN = 'container-split.invalid';

// The collection the seed lands in. Named once so the snippet and any test read one source; `users` is
// in the Container_1_Grant's read-write set, which is exactly why the seed must NOT use that grant.
export const SEEDED_ACCOUNT_COLLECTION = 'users';

// Generate the per-run `Seeded_Account` identity. The password is a per-run SECRET (Req 5.6): it is
// generated with crypto.randomBytes like every other harness credential, is never committed, and
// travels to the checks only through the mode-0600 gitignored context bridge. The `_id` is generated
// here rather than left to mongod so the runner can publish it — the recorded `/api/auth/resetPassword`
// payload references the seeded user's id — and it is 12 random bytes as hex, which is exactly what
// `ObjectId(<24 hex chars>)` takes.
//
// The email carries the id's first bytes so two runs (or a run against a volume a previous run left)
// cannot collide on the `users` email index, and so a document found in a database can be traced to
// the run that seeded it.
export function generateSeededAccount() {
  const id = hex(12);
  const handle = `harness-seed-${id.slice(0, 12)}`;
  return Object.freeze({
    id,
    email: `${handle}@${SEEDED_ACCOUNT_EMAIL_DOMAIN}`,
    // Lowercase: the schema lowercases both `email` and `username`, so a mixed-case value here would
    // be stored differently from what was recorded.
    username: handle,
    name: 'Container Split Harness Seed',
    // 48 hex characters: comfortably past the 8-character minimum `loginSchema` and the user schema's
    // `minlength` both enforce, and under the 128-character maximum.
    password: hex(24),
    provider: SEEDED_ACCOUNT_PROVIDER,
    role: SEEDED_ACCOUNT_ROLE,
  });
}

// Hash the seed's password the way the application would. Separated from the snippet builder so a test
// can assert the cost factor off the hash itself (`$2a$10$…`) and so the builder can take an injected
// hasher and stay pure.
export function hashSeededPassword(password, cost = SEEDED_ACCOUNT_BCRYPT_COST) {
  return bcrypt.hashSync(password, bcrypt.genSaltSync(cost));
}

// Build the mongosh snippet that inserts the `Seeded_Account` as root. Pure: takes the database name,
// the generated account and (optionally) a hasher, and returns the script text — so the document shape
// and the insert's ordering are assertable without a live mongod.
//
// The field set is the one the login path reads, and each field is here for a reason:
//   * `_id`            — the generated ObjectId, so the runner can publish the id the reset-password
//                        payload references.
//   * `email`          — what `findUser({ email })` looks up (api/strategies/localStrategy.js).
//   * `password`       — the bcrypt hash at the application's own cost factor, which
//                        `comparePassword` compares against. `select: false` on the schema is
//                        irrelevant to a raw insert.
//   * `provider`       — 'local', required by the schema and what marks this as a local account rather
//                        than one first created through social/OIDC (which `comparePassword` refuses).
//   * `emailVerified`  — true, so login does not divert into the verification branch and answer
//                        'Email not verified.' (no mail transport is configured in the harness).
//   * `name`/`username`— what the login response and the SPA read back; `username` is also lowercased
//                        by the schema.
//   * `role`           — the application's default user role.
//   * `avatar`         — null, exactly as `registerUser` writes it.
//   * `twoFactorEnabled` / `termsAccepted` — false, the schema defaults, spelled out because a raw
//                        insert applies no default. `twoFactorEnabled: false` is load-bearing for two
//                        recorded payloads: `loginController` answers `twoFAPending` instead of a token
//                        when it is true, and the 2FA enroll/backup-code exercises record a 200 that
//                        depends on it.
//   * `createdAt`/`updatedAt` — the timestamps the schema maintains; `localStrategy` reads `createdAt`
//                        to decide the legacy pre-verification carve-out, and an absent value makes
//                        that comparison NaN.
//
// The insert is followed by a readback that THROWS when the document is not there. mongosh exits
// non-zero on a throw, so a seed that silently did not land becomes a setup failure rather than a run
// whose session mint fails later for an unexplained reason.
export function buildSeededAccountSnippet(dbName, account, { hash = hashSeededPassword } = {}) {
  const document = {
    email: account.email,
    emailVerified: true,
    password: hash(account.password),
    provider: account.provider ?? SEEDED_ACCOUNT_PROVIDER,
    name: account.name,
    username: account.username,
    role: account.role ?? SEEDED_ACCOUNT_ROLE,
    avatar: null,
    twoFactorEnabled: false,
    termsAccepted: false,
  };
  return [
    `const seeded = db.getSiblingDB(${JSON.stringify(dbName)})` +
      `.getCollection(${JSON.stringify(SEEDED_ACCOUNT_COLLECTION)});`,
    `const seededId = ObjectId(${JSON.stringify(account.id)});`,
    `seeded.insertOne(Object.assign({ _id: seededId }, ${JSON.stringify(document)}, ` +
      '{ createdAt: new Date(), updatedAt: new Date() }));',
    // Loud rather than silent: the session mint depends on this document existing, and a seed that did
    // not land would otherwise surface as a login failure with no stated cause.
    'if (seeded.countDocuments({ _id: seededId }) !== 1) {',
    '  throw new Error("Seeded_Account insert did not land in ' +
      `${SEEDED_ACCOUNT_COLLECTION}; the Session_Fixture cannot be minted without it.");`,
    '}',
  ].join('\n');
}

// The combined root snippet the runner feeds to `mongosh` after provisioning and before the
// Auth_Surface starts: create the observer, size and enable profiling, then — LAST — insert the
// `Seeded_Account`. One snippet so all three run under a single root connection in the order the
// design's sequence shows.
//
// The seed's position is not cosmetic. It is last so that it is after profiling (BOOT-NOWRITE-23 reads
// a profile that records it) and still before the caller's `captureBootStart()`, which is the boot
// window's left edge (Req 3.18). `seededAccount` is optional so a caller that only needs the observer
// and the profile — the existing stage-6 tests — reads unchanged.
export function buildObserverAndProfilingSnippet(
  dbName,
  observerPassword,
  { seededAccount = null } = {},
) {
  const parts = [buildObserverSnippet(dbName, observerPassword), buildProfilingSnippet(dbName)];
  if (seededAccount !== null) {
    parts.push(buildSeededAccountSnippet(dbName, seededAccount));
  }
  return parts.join('\n');
}

// The identity string the boot-write check filters system.profile on. mongod records the
// authenticated principal as `user@authSource`, so the Auth_Surface's writes are attributed to
// `librechat_auth_surface@admin`. Exported so BOOT-NOWRITE-23 (task 9) and any test read one source
// rather than reconstructing the format.
export const AUTH_SURFACE_PROFILE_USER = `${IDENTITIES.authUsername}@${IDENTITIES.authSource}`;

// Capture the Auth_Surface's process-start timestamp, recorded immediately BEFORE
// `docker compose up auth-surface`, so the boot window has a left edge the check can assert against
// (design: "The window"). A tiny exported helper rather than an inline `Date.now()` so the capture
// point is named and testable, and so the returned shape (epoch millis + ISO) is one the check and
// the run report can both consume. `now` is injectable for deterministic tests.
export function captureBootStart({ now = Date.now } = {}) {
  const epochMs = now();
  return { epochMs, iso: new Date(epochMs).toISOString() };
}

// ---------------------------------------------------------------------------------------------
// TeardownFailure — a leak is a reported failure, not a cleanup detail (Req 5.1, teardown half of
// RUN-REPORT-32).
//
// Teardown runs `docker compose --profile split --profile collapsed down --volumes
// --remove-orphans` and then reads `docker compose ps -a --format json` back to confirm nothing
// remains. If a container, network or volume survives, the next run inherits it — a leaked network
// with the harness's fixed name collides on the following bring-up, and a leaked volume carries a
// prior run's data into a suite that assumes a clean database. So a leak is a FAILURE the runner
// reports and exits non-zero on, distinct from both a SetupFailure (the topology never came up) and
// a check failure (a property was falsified). It carries a non-zero exit EVEN WHEN every check
// passed, because "the checks passed but the harness left resources behind" is not a green run.
//
// It is a sibling of SetupFailure rather than a subclass: the two are reported under different
// headings and key different report fields, and a catch site must never mistake one for the other.
// `kind` is a stable machine tag; `remaining` names exactly what survived so a diagnosis (and the
// run report, task 7.5) does not require re-inspecting Docker.
// ---------------------------------------------------------------------------------------------
export const TEARDOWN_FAILURE_KINDS = Object.freeze({
  DOWN_FAILED: 'teardown-down-failed',
  RESOURCES_REMAINED: 'teardown-resources-remained',
});

export class TeardownFailure extends Error {
  constructor(kind, message, { remaining = [], detail = null } = {}) {
    super(message);
    this.name = 'TeardownFailure';
    this.kind = kind;
    // The list of survivors (each `{ type, name, ... }`), so the report names what remained rather
    // than a bare "teardown leaked". Empty for a DOWN_FAILED where `down` itself errored.
    this.remaining = remaining;
    this.detail = detail;
    // Marks this apart from a SetupFailure and an ordinary Error at the reporting boundary, so the
    // catch site reports a leak under its own heading and never as a falsified property.
    this.isTeardownFailure = true;
  }
}

// The teardown command's argv, spelled once. Both profiles are named so a run under either profile
// releases everything either profile could have created — the collapsed profile reuses the same
// auth-surface service (PARITY-COLLAPSE-29), but naming both is what guarantees a split run does
// not leave a collapsed-only artifact and vice versa. `--volumes` releases the named volumes (a
// leaked volume carries stale data into the next run), `--remove-orphans` sweeps services no longer
// in the compose file. Exported so the wiring and any test read one source rather than restating
// the flags.
export const TEARDOWN_COMPOSE_ARGS = Object.freeze([
  'compose',
  '--profile',
  'split',
  '--profile',
  'collapsed',
  'down',
  '--volumes',
  '--remove-orphans',
]);

// The readback command's argv: `docker compose ps -a --format json`. `-a` includes stopped
// containers, so a container that `down` failed to remove still shows; `--format json` is the shape
// parseComposePs below reads. Exported for the same single-source reason.
export const TEARDOWN_PS_ARGS = Object.freeze(['compose', 'ps', '-a', '--format', 'json']);

// Parse `docker compose ps -a --format json` output into a list of remaining containers. Pure over
// its input string, so a test can feed synthetic output without Docker.
//
// The format is version-dependent: newer `docker compose` emits one JSON object per line (JSONL),
// older emits a single JSON array. This tolerates both, plus an empty or whitespace-only string
// (the clean case — nothing remained). A line that does not parse is surfaced as an error rather
// than silently dropped, because a parse failure here could otherwise hide a survivor and read as a
// clean teardown — the exact false pass this readback exists to prevent.
export function parseComposePs(psOutput) {
  const text = (psOutput ?? '').trim();
  if (text === '') {
    return [];
  }
  // Single-array form.
  if (text.startsWith('[')) {
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) {
      throw new Error('docker compose ps -a --format json did not yield an array or JSONL.');
    }
    return arr;
  }
  // JSONL form: one object per non-blank line.
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));
}

// Summarize one parsed `ps` entry as `{ type, name, state }` for the failure message. `docker
// compose ps` names containers under `Name` (older) or `Names` (newer) and carries the compose
// service under `Service`; both are surfaced so the report can name the survivor the way an
// operator sees it in `docker ps`.
function describePsEntry(entry) {
  const name = entry.Name ?? entry.Names ?? entry.Service ?? '(unnamed)';
  return { type: 'container', name, service: entry.Service ?? null, state: entry.State ?? null };
}

// Classify a teardown readback. `down` already ran; this decides whether it released everything.
// Pure over the captured `docker compose ps -a` output, so the leak-detection decision is testable
// without Docker (task 15 wires the live `down` and `ps` spawns). Empty => clean, returns
// `{ ok: true, remaining: [] }`. Anything left => a RESOURCES_REMAINED TeardownFailure naming each
// survivor, which yields a non-zero exit even when every check passed.
//
// This reads containers, which is what `ps -a` reports. A leaked network or volume that `down`
// failed to remove but that carries no container does not appear here; that residue is caught by
// the `down` command's own non-zero exit (classifyDownResult below). The two together — `down`
// must succeed AND `ps -a` must come back empty — are what "released every container and network"
// (RUN-REPORT-32) turns on.
export function classifyTeardownReadback(psOutput) {
  const entries = parseComposePs(psOutput);
  if (entries.length === 0) {
    return { ok: true, remaining: [] };
  }
  const remaining = entries.map(describePsEntry);
  const names = remaining.map((r) => r.name).join(', ');
  throw new TeardownFailure(
    TEARDOWN_FAILURE_KINDS.RESOURCES_REMAINED,
    `Teardown leaked ${remaining.length} resource(s) that "docker compose down --volumes ` +
      `--remove-orphans" did not release: ${names}. These are left for the next run to trip over ` +
      '— a leaked network collides on the next bring-up and a leaked volume carries stale data ' +
      'into a suite that assumes a clean database. Reported as a teardown failure with a non-zero ' +
      'exit even though the checks themselves may have passed.',
    { remaining },
  );
}

// Classify the `down` command's own result. A non-zero exit means teardown could not even complete
// — a network still in use, a volume it could not remove — so the survivor list from the readback
// would be incomplete. Reported as a DOWN_FAILED teardown failure carrying stderr verbatim. Pure
// over an already-captured spawn result, so it is testable without spawning `docker`.
export function classifyDownResult({ status, stderr = '' }) {
  if (status === 0) {
    return { ok: true };
  }
  throw new TeardownFailure(
    TEARDOWN_FAILURE_KINDS.DOWN_FAILED,
    `"docker compose down --volumes --remove-orphans" exited ${status}. Teardown did not ` +
      'complete, so resources the run created may remain. Reported as a teardown failure with a ' +
      'non-zero exit.',
    { detail: stderr },
  );
}

// ---------------------------------------------------------------------------------------------
// Teardown execution and registration (Req 5.1).
//
// Teardown is REGISTERED BEFORE BRING-UP and runs from a `finally` plus `SIGINT`/`SIGTERM` handlers,
// so an interrupted run releases what it created rather than leaving containers, networks and
// volumes behind. The Docker-touching part is a single injected exec runner (`exec`), so the
// orchestration — run `down`, classify it, read `ps -a` back, classify the readback — is exercisable
// without Docker (task 15 supplies the real spawner). The exec runner is expected to return
// `{ status, stdout, stderr }` synchronously-or-awaited for one `docker <args>` invocation.
//
// Teardown is IDEMPOTENT: the `finally` runs it, and if a signal arrived mid-run the handler runs it
// too; a `ran` guard makes the second call a no-op so an interrupt during teardown does not stack a
// second `down`. It never throws out of itself — it returns a result the caller inspects — because a
// throw from a signal handler or a `finally` would mask the outcome it is meant to report.
// ---------------------------------------------------------------------------------------------

// Run teardown once: `docker compose ... down ...`, classify it, then `docker compose ps -a` and
// classify the readback. Returns `{ ok: true }` on a clean release or `{ ok: false, failure }`
// carrying the TeardownFailure — it does not throw, so a `finally` or a signal handler can call it
// and then decide the exit code without a try/catch of its own. `exec('docker', args)` is injected.
export async function runTeardown({ exec }) {
  let downResult;
  try {
    downResult = await exec('docker', [...TEARDOWN_COMPOSE_ARGS]);
  } catch (error) {
    return {
      ok: false,
      failure: new TeardownFailure(
        TEARDOWN_FAILURE_KINDS.DOWN_FAILED,
        `Could not invoke "docker compose down": ${error.message}`,
        { detail: error.stack ?? null },
      ),
    };
  }
  try {
    classifyDownResult(downResult);
  } catch (failure) {
    return { ok: false, failure };
  }

  let psResult;
  try {
    psResult = await exec('docker', [...TEARDOWN_PS_ARGS]);
  } catch (error) {
    return {
      ok: false,
      failure: new TeardownFailure(
        TEARDOWN_FAILURE_KINDS.RESOURCES_REMAINED,
        `Could not read "docker compose ps -a" back to confirm teardown: ${error.message}. ` +
          'Treating the release as unconfirmed rather than clean.',
        { detail: error.stack ?? null },
      ),
    };
  }
  try {
    classifyTeardownReadback(psResult.stdout ?? '');
  } catch (failure) {
    return { ok: false, failure };
  }
  return { ok: true };
}

// Build a teardown registration that guarantees teardown runs exactly once, from whichever of the
// three paths fires first: the normal `finally`, a `SIGINT`, or a `SIGTERM`. Called BEFORE bring-up
// so an interrupt at any point during bring-up or checks still releases what was created (Req 5.1).
//
// Returns `{ teardownOnce, dispose }`. `teardownOnce()` is what the `finally` awaits; the signal
// handlers (installed here) call it too. A `ran` guard collapses concurrent calls to one `down`.
// The last outcome is stored on the returned object so the caller can fold a teardown leak into the
// process exit code after the `finally`. `dispose()` removes the signal handlers so an imported
// module (tests, later pieces) does not leave listeners attached.
export function registerTeardown({
  exec,
  signals = ['SIGINT', 'SIGTERM'],
  process: proc = process,
}) {
  const state = { ran: false, promise: null, result: null };

  const teardownOnce = () => {
    if (state.ran) {
      return state.promise;
    }
    state.ran = true;
    state.promise = runTeardown({ exec }).then((result) => {
      state.result = result;
      return result;
    });
    return state.promise;
  };

  const handlers = {};
  for (const signal of signals) {
    const handler = () => {
      // On a signal, tear down then exit non-zero (128 + signal is the shell convention; the exact
      // value matters less than "not 0"). A leak discovered during signal teardown is still a
      // non-zero exit, which it already is here.
      teardownOnce().finally(() => {
        proc.exit(state.result && state.result.ok ? 130 : 1);
      });
    };
    handlers[signal] = handler;
    proc.on(signal, handler);
  }

  const dispose = () => {
    for (const signal of signals) {
      proc.removeListener(signal, handlers[signal]);
    }
  };

  return { teardownOnce, dispose, state };
}

// ---------------------------------------------------------------------------------------------
// The run report's lifecycle at BOTH ends of a run that does not reach stage 11 (Req 5.9, 5.10).
//
// reporter.mjs writes run-report.json from inside the Layer B Jest run, which is stage 11. That
// leaves two holes at either end of the sequence, and both of them produce a MISREADING rather than a
// missing file:
//
//   * At the start: a run that fails before stage 11 leaves the PREVIOUS run's report on disk,
//     untouched and undated in any way a reader notices. The next person reads an hour-old tally as
//     this run's result — which is exactly the confusion Req 5.9/5.10 exist to prevent, arriving
//     through the artifact instead of through the exit code. So the report is DELETED at run start,
//     before stage 1: after that, the file's presence means this run produced it.
//
//   * At the end: the run that failed had already decided the twelve backend-lane catalog ids at
//     stage 1 — Layer A ran, and in the observed failure it passed — and then discarded all of it,
//     because the only writer of the report lives in the stage the run never reached. So the runner
//     writes the report itself when it ends early, carrying Layer A's verdict and recording every
//     unreached Layer B id as a `skip`.
//
// Three lines are held exactly in that early report:
//
//   1. An unexecuted check NEVER reads as passed (Req 5.10). Every unreached id is `skip` with
//      SKIP_REASON.NOT_EXECUTED — the tag the catalog machinery already uses for not-executed — and
//      that reason is deliberately NOT in serializer.mjs's ENUMERATED_SKIP_REASONS, so it counts as a
//      masquerading setup failure in runOutcome rather than as a benign absence.
//   2. A setup-failure run still exits non-zero (Req 5.9). runOutcome sees a non-null setupFailure
//      AND non-enumerated skips, so `ok` is false whatever Layer A did.
//   3. The setup failure itself stays legible. It is carried as the run-level `setupFailure`, which
//      serializeRun renders as its own `SETUP FAILURE [kind]` section and records in the JSON, so a
//      report whose Layer A ids all say `pass` cannot be mistaken for a successful run: the outcome
//      line says FAIL and the failure section names what could not be brought up (Property 9 — a
//      topology that never came up falsified nothing).
// ---------------------------------------------------------------------------------------------

// Delete a previous run's report, if one is there. Called at RUN START, before stage 1.
//
// ENOENT is the ordinary case (a first run, or a clean checkout) and is not an error. Any other
// failure IS rethrown: if a stale report exists and cannot be removed, continuing would leave the
// exact artifact this deletion exists to prevent, and failing loudly beats proceeding with a file
// that will be read as this run's result. `rm` and `reportPath` are injectable so the behavior is
// unit-exercisable without touching the real artifact.
export async function removeStaleRunReport({ reportPath = RUN_REPORT_PATH, remove = rm } = {}) {
  try {
    await remove(reportPath);
    return { removed: true, path: reportPath };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { removed: false, path: reportPath };
    }
    throw error;
  }
}

// Layer A's classification — the self-skip marker, the backend-lane predicate and the per-id
// classifier — now lives in layer-a-outcome.mjs, because the stage-11 reporter needs the same
// classification and importing it from the runner would have been a cycle. Re-exported here so every
// existing importer of these names from run.mjs is unaffected by the move.
export {
  LAYER_A_SELF_SKIP_MARKER,
  LAYER_A_RESULT_ENV,
  isBackendLaneCheck,
  classifyLayerAOutcomeFor,
  summarizeLayerAResult,
  serializeLayerASummary,
  readLayerASummary,
} from './layer-a-outcome.mjs';

// Build the outcome map for a run that ended before stage 11. Pure over Layer A's result, so the
// whole report can be asserted without Docker, Jest, or a filesystem.
//
// `layerA` is Layer A's captured `{ status, stderr }`, or null when the run failed BEFORE stage 1
// (a prepareSetup failure — bad MONGO_URI, an empty math()-parsed env value).
// With it null every id is unreached, backend-lane ids included, and the report says so rather than
// crediting Layer A for a run it never had.
export function buildEarlyRunOutcomes({ layerA = null, ids = CHECK_IDS } = {}) {
  // Where the run stopped, said precisely rather than approximately. With Layer A absent the run never
  // reached stage 1 at all, so claiming these ids "never ran against a topology" would understate it.
  const unreached =
    layerA === null
      ? 'not executed: the run ended before stage 1, so neither Layer A nor the topology checks ran. '
      : 'not executed: the run ended before the Layer B topology checks, so this check never ran ' +
        'against a topology. ';
  const outcomes = {};
  for (const id of ids) {
    if (layerA !== null && isBackendLaneCheck(id)) {
      outcomes[id] = classifyLayerAOutcomeFor(id, layerA);
      continue;
    }
    outcomes[id] = {
      status: RECORD_STATUS.SKIP,
      // NOT_EXECUTED is outside ENUMERATED_SKIP_REASONS on purpose: this run decided nothing here, so
      // the skip must block exit 0 rather than read as an accounted-for absence.
      skipReason: SKIP_REASON.NOT_EXECUTED,
      observation: `${unreached}Unexecuted, not passed (Req 5.10).`,
    };
  }
  return outcomes;
}

// Serialize an early-exit run report. Pure — returns `{ json, text, outcome }` — so the exit gate the
// report implies is assertable without writing a file. `setupFailure` is the run-level Property 9
// classification (null when the run ended on a Layer A check verdict instead, which is a falsified
// property rather than a setup failure).
// `ids` defaults to the ids the run's PROFILE selects (check-catalog.mjs), not to every catalog id: a
// collapsed run must not record the split-only checks as unexecuted skips, because it never claimed
// them. Under `split` the two sets are identical, so a split run is unchanged.
// `image` is the tested-image record when the run got past stage 2 before failing (a bad MONGO_URI, a
// bring-up timeout), or null when it failed before resolution (prepareSetup). It is threaded into the
// report's top-level `image` block, because a setup failure after image resolution still tested a
// resolved image (Req 5.12: "including on a run that later ends in the setup failure"), while a
// failure before resolution has no image to name.
export function buildEarlyRunReport({
  setupFailure = null,
  layerA = null,
  profile = 'split',
  startedAt = null,
  ids = checkIdsForProfile(profile),
  image = null,
} = {}) {
  const outcomes = buildEarlyRunOutcomes({ layerA, ids });
  const records = Object.entries(outcomes).map(([id, outcome]) => buildCheckRecord(id, outcome));
  return serializeRun(records, { profile, startedAt, setupFailure, image });
}

// Write the early-exit report to disk and print its human summary, so a run that never reached stage
// 11 still leaves the artifact stage 11 would have left. Injectable `write` and `stdout` keep it
// testable; the return value carries the serialized views so a caller can assert on them.
export async function writeEarlyRunReport({
  setupFailure = null,
  layerA = null,
  profile = 'split',
  startedAt = null,
  reportPath = RUN_REPORT_PATH,
  ids = checkIdsForProfile(profile),
  image = null,
  write = writeFile,
  stdout = process.stdout,
} = {}) {
  const { json, text, outcome } = buildEarlyRunReport({
    setupFailure,
    layerA,
    profile,
    startedAt,
    // Forwarded explicitly: the early report is built over the ids this profile selects, and letting
    // the callee re-derive them would leave a caller's override silently ignored.
    ids,
    // The tested-image block (null before image resolution, the record after), threaded through so a
    // setup-failure report names what it tested (Req 5.12).
    image,
  });
  await write(reportPath, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
  stdout.write(`\n${text}\n`);
  stdout.write(`\nCheck-record artifact written: ${path.relative(HERE, reportPath)}\n`);
  return { json, text, outcome, reportPath };
}

// The same write, but a failure to produce the artifact never masks the failure that made the run end
// early. The report is diagnostic; the setup failure or Layer A verdict already on stderr is the
// verdict. So a write error is reported and swallowed rather than unwinding over the thing it was
// describing.
export async function writeEarlyRunReportSafely(options = {}, { stderr = process.stderr } = {}) {
  try {
    return await writeEarlyRunReport(options);
  } catch (error) {
    stderr.write(
      `Could not write the early-exit run report: ${error.message}. The run's verdict is the ` +
        'failure reported above; only the artifact is missing.\n',
    );
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// The post-run validation of the artifact the stage-11 reporter wrote (RUN-REPORT-32, the half no
// check can decide).
//
// RUN-REPORT-32's live assertion used to be `existsSync(run-report.json)` INSIDE the Layer B Jest run.
// That is unsatisfiable by construction: the reporter writes the file from `onRunComplete`, after every
// test has finished, so no test can ever see its own run's artifact. (Deleting the previous run's
// report before stage 1 — which the runner does, so a reader can never take an old tally for this run's
// result — turned that assertion from luck-dependent into certainly-failing, which is how it surfaced.)
//
// The observation is real, it simply belongs to a different moment: right after stage 11 returns, when
// the artifact exists and the run is still in a position to act on it. So the runner reads it back here
// and decides the same two things the check decides over a synthesized report — well-formedness, and
// the catalog accounting rules — through the SAME deciders (report-artifact.mjs), plus the one thing
// only the runner can decide: that the artifact belongs to THIS run rather than being a survivor.
//
// Returns `{ ok, reason?, exitCode, tally }`; `exitCode` is the report's own, which the caller folds
// into the run's exit status.
// ---------------------------------------------------------------------------------------------
// `profile` decides which ids the completeness rule expects, because the reporter accounted for exactly
// the ids the profile selected. Validating a collapsed report against the FULL catalog would fail a
// correct report for eight ids the run never claimed — the split-only checks (check-catalog.mjs records
// why each does not apply under `collapsed`).
export async function validateWrittenRunReport({
  reportPath = RUN_REPORT_PATH,
  read = readFile,
  startedAt = null,
  profile = 'split',
  ids = checkIdsForProfile(profile),
} = {}) {
  let text;
  try {
    text = await read(reportPath, 'utf8');
  } catch (error) {
    return {
      ok: false,
      // A missing artifact after stage 11 means the reporter did not run or could not write: the run
      // executed checks and left no record of what they decided.
      reason:
        `the stage-11 reporter left no artifact at ${reportPath} (${error.code ?? error.message}). ` +
        'The run executed its checks and recorded nothing, so there is no per-check report to read ' +
        '(Req 5.3, 5.4).',
      exitCode: 1,
      tally: 'no artifact',
    };
  }

  const decision = decideArtifactWellFormed(text);
  if (!decision.ok) {
    return { ok: false, reason: decision.reason, exitCode: 1, tally: 'unreadable' };
  }
  const json = decision.json;
  const tally = Object.entries(json.outcome.tally ?? {})
    .map(([status, count]) => `${count} ${status}`)
    .join(', ');

  // Freshness: the reporter stamps `startedAt` when Jest instantiates it, which is inside this run. An
  // artifact stamped BEFORE this run began is a survivor of an earlier one, and reading it as this
  // run's result is the exact misreading the run-start deletion exists to prevent.
  if (startedAt !== null && typeof json.startedAt === 'string') {
    if (Date.parse(json.startedAt) < Date.parse(startedAt)) {
      return {
        ok: false,
        reason:
          `the artifact is stamped ${json.startedAt}, before this run started (${startedAt}), so it ` +
          'is a previous run\u2019s report rather than this one\u2019s.',
        exitCode: 1,
        tally,
      };
    }
  }

  const accounting = decideArtifactAccounting(json, { ids });
  if (!accounting.ok) {
    return { ok: false, reason: accounting.reason, exitCode: json.outcome.exitCode, tally };
  }
  return { ok: true, exitCode: json.outcome.exitCode, tally };
}

// ---------------------------------------------------------------------------------------------
// CLI argument parsing. Supports `--profile split|collapsed` (default split) and `--validate` (the
// no-Docker dry mode that exercises everything 7.1 owns). The parser still tolerates unknown flags
// rather than rejecting, so a flag a later task owns lands without a churn here — an unknown flag
// surfaces when the piece that owns it looks for it.
// ---------------------------------------------------------------------------------------------
export function parseArgs(argv) {
  const args = { profile: 'split', validate: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--validate') {
      args.validate = true;
    } else if (arg === '--profile') {
      args.profile = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--profile=')) {
      args.profile = arg.slice('--profile='.length);
    }
  }
  if (!PROFILES.includes(args.profile)) {
    throw new Error(
      `Unknown profile "${args.profile}". compose.harness.yml defines: ${PROFILES.join(', ')}.`,
    );
  }
  return args;
}

// ---------------------------------------------------------------------------------------------
// The no-Docker setup pipeline: everything that runs before bring-up. Ordered exactly as the
// design's sequence requires — generate, assert distinct, validate URIs, write the resolved env
// files, then scan those resolved files for the one fixture defect that kills a container at module
// load. Returns the artifacts so `--validate` and the full run share one path and cannot drift.
// Bring-up, provisioning, boot checks and teardown attach after this returns.
// ---------------------------------------------------------------------------------------------
export async function prepareSetup({ envDir = ENV_DIR } = {}) {
  const secrets = generateSecrets();
  assertGrantPasswordsDistinct(secrets);
  validateContainerUris(secrets);
  // No allowlist-digest guard here (Req 2.11): a moved path is caught by the checks themselves,
  // against the current allowlist and grant. Misattributed, it fails ROUTE-ALLOW-27 or
  // ROUTE-DEFAULT-28; routed to the Auth_Surface with needs outside the grant, PATH-EXERCISE-25
  // reports it `understated`. A pre-bring-up digest tripwire would instead fail the run on any
  // allowlist edit, moved path or not, which NG10 forbids.
  const envFiles = await writeResolvedEnvFiles(secrets, { envDir });
  // Read the resolved files back and refuse the run if one sets a math()-parsed key to an empty
  // value. The defect is invisible in the fixture and fatal in the container — the process throws at
  // module load, so it surfaces as an unhealthy service 300 seconds later with the cause buried in a
  // log tail. Scanning the fixture turns that into a named file and key before anything starts.
  await assertResolvedEnvFilesHaveNoEmptyMathValues(envFiles);
  // The Seeded_Account's identity and password, generated here beside every other per-run credential
  // (Req 5.6) so nothing about the fixture is committed. It is not written into any env file — no
  // container reads it — and it is not used until stage 6 inserts it under the Root_Credential.
  const seededAccount = generateSeededAccount();
  return {
    secrets,
    envFiles,
    uris: buildContainerUris(secrets),
    seededAccount,
  };
}

// =============================================================================================
// TASK 15.2 — the exec seam and the stages around it (Layer A through teardown).
//
// Everything above this line runs without Docker. Below it is the orchestration the design's "The
// Entry Command — One Invocation, Full Sequence" fixes: run Layer A, resolve the image, preflight
// the nine compose values, bring mongod up, provision, run the harness-owned root snippet, record
// the boot timestamp, bring up the containers + proxy, publish the harness context, run Layer B,
// report, and tear down. Layer A leads because it needs none of what follows it and because it is
// where a grant regression shows up; the design's "Layer A runs in the same sequence" calls that
// ordering a convenience, but a Layer A that runs after bring-up does not run at all when bring-up
// fails, which is the case the ordering exists for. Two disciplines keep it honest and testable:
//
//   * Every Docker/mongosh/jest touch goes through ONE injected `exec(command, args, opts)` that
//     resolves `{ status, stdout, stderr }`. The STAGE LOGIC — the image-resolution decision, the
//     nine-value preflight, readiness classification, the context-primitive assembly, and the
//     sequence with its SetupFailure branches — is pure over that exec, so it is unit-exercisable
//     without Docker exactly as the pure functions above are (the sibling *.test.mjs feeds a fake
//     exec), and `runHarness` below takes the exec as a parameter.
//   * A SetupFailure at any stage 1–10 ends the run non-zero and admits NO request-level check
//     (Property 9). Teardown is registered BEFORE bring-up (task 7.4) and runs from finally +
//     SIGINT/SIGTERM.
// =============================================================================================

// The compose file the runner drives. Passing it through the `COMPOSE_FILE` environment variable
// (which `docker compose` honours) rather than an `-f` argv keeps the teardown/observation/ps argv
// authored in tasks 7.4/7.6 untouched — those spell `['compose', ...]` with no `-f`, and this is the
// single place the file they resolve is named. Exported so a test reads one source.
export const COMPOSE_FILE_NAME = 'compose.harness.yml';
export const COMPOSE_FILE_PATH = path.join(HERE, COMPOSE_FILE_NAME);

// The default harness image tag. The harness is a sibling of docker-compose.yml (both container
// services derive `image` from ${HARNESS_IMAGE}); when HARNESS_IMAGE is unset the runner defaults to
// this tag and builds it from the repo Dockerfile's `node` target when it is absent from the local
// store. Exported so a test asserts the default without reading process.env.
export const DEFAULT_HARNESS_IMAGE = 'librechat-container-split:local';

// The repo root (three levels up from e2e/container-split), the build context for `docker build`.
export const REPO_ROOT = path.resolve(HERE, '..', '..');

// The context-bridge file the runner writes and the Jest bootstrap reads (stage 10). run.mjs and the
// Jest checks run in SEPARATE processes, so a literal `globalThis` assignment in run.mjs never
// reaches the Jest workers; the runner writes the context PRIMITIVES (ports, the observer URI, the
// boot timestamps, the profile) to this gitignored JSON file and points HARNESS_CONTEXT_FILE at it,
// and jest.setup.mjs reads it and constructs the clients + observerDb onto globalThis before the
// specs load. Exported so the bootstrap and a test read one path.
export const HARNESS_CONTEXT_ENV = 'HARNESS_CONTEXT_FILE';
export const HARNESS_CONTEXT_FILE = path.join(HERE, 'harness-context.json');

// The observer credential's loopback observation address (compose.harness.yml publishes mongod on
// 127.0.0.1:27019 for the read-only observer ONLY — not 27017/27018, which the two existing compose
// files bind). The bootstrap connects observerDb here under the observer credential.
export const OBSERVER_MONGO_HOST = '127.0.0.1';
export const OBSERVER_MONGO_PORT = 27019;

// Build the observer's MONGO connection URI: the observer user on admin, pointed at the loopback
// observation plane, with authSource=admin (roles and users live on admin). Read-only by grant
// (task 7.2 grants `find` and nothing else), so no write concern is expressed here. Pure over its
// inputs so a test asserts the shape without a live mongod.
export function buildObserverUri(observerPassword) {
  return (
    `mongodb://${IDENTITIES.observerUsername}:${observerPassword}@` +
    `${OBSERVER_MONGO_HOST}:${OBSERVER_MONGO_PORT}/${IDENTITIES.mongoDb}` +
    `?authSource=${IDENTITIES.authSource}&directConnection=true`
  );
}

// ---------------------------------------------------------------------------------------------
// The real exec seam. Spawns one command, captures stdout/stderr, resolves
// `{ status, stdout, stderr }` — never rejects on a non-zero exit, because the stage logic reads
// `status` to classify the outcome (a non-zero `docker compose up` is a bring-up failure to
// classify, not an exception to unwind). A spawn error (binary missing) rejects, which the callers
// wrap into the appropriate SetupFailure. `env` is merged over the process env so COMPOSE_FILE and
// the nine interpolation values reach `docker compose`; `cwd` defaults to the harness directory.
// `input` is written to stdin (mongosh reads a snippet from stdin). Not exported — the seam is an
// implementation detail; the stage logic that USES it is what is exported and tested.
// ---------------------------------------------------------------------------------------------
function makeRealExec({ baseEnv = process.env, forward = process.stderr } = {}) {
  return (command, args = [], { cwd = HERE, env = {}, input = null } = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        // Pipe stdin (the mongosh snippet arrives on it) and, crucially, DO NOT let docker attach to
        // a TTY: with `stdio` piped, `docker compose up --wait` cannot fall into an attached
        // log-follow that never returns, and its progress is captured rather than written straight to
        // the terminal. Forcing no color keeps the captured text parseable.
        env: { ...baseEnv, NO_COLOR: '1', ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
        // Forward progress live so a long build/bring-up is observable rather than looking hung.
        // stderr is where docker compose writes its progress; the parent's stdout carries the
        // runner's own stage lines, so the two do not interleave confusingly.
        if (forward && typeof forward.write === 'function') {
          forward.write(chunk);
        }
      });
      child.on('error', reject);
      child.on('close', (code) => {
        resolve({ status: code ?? 1, stdout, stderr });
      });
      if (input !== null) {
        child.stdin.write(input);
      }
      child.stdin.end();
    });
}

// The compose-interpolation environment: the nine values compose.harness.yml interpolates, plus the
// COMPOSE_FILE the runner drives. Pure over the resolved usernames/db and the generated secrets, so a
// test asserts the exact map without spawning anything. The five non-secret values come from the
// fixed IDENTITIES (the operator exports nothing, Req 5.8); the four passwords + the meili key come
// from generateSecrets. HARNESS_IMAGE is the resolved tag.
export function buildComposeEnv(secrets, { harnessImage }) {
  return {
    COMPOSE_FILE: COMPOSE_FILE_PATH,
    HARNESS_IMAGE: harnessImage,
    MONGO_ROOT_USERNAME: IDENTITIES.rootUsername,
    MONGO_ROOT_PASSWORD: secrets.MONGO_ROOT_PASSWORD,
    MONGO_DB: IDENTITIES.mongoDb,
    AUTH_MONGO_USERNAME: IDENTITIES.authUsername,
    AUTH_MONGO_PASSWORD: secrets.AUTH_MONGO_PASSWORD,
    API_MONGO_USERNAME: IDENTITIES.apiUsername,
    API_MONGO_PASSWORD: secrets.API_MONGO_PASSWORD,
    MEILI_MASTER_KEY: secrets.MEILI_MASTER_KEY,
  };
}

// The nine compose ${...} interpolation values, named. The compose file carries no defaults, so an
// unresolved value would resolve to empty and start a container that cannot authenticate — a failure
// that reads like a container problem rather than the harness bug it is. Exported so the preflight
// and a test read one source (design: "The Harness owns every compose interpolation value").
export const COMPOSE_INTERPOLATION_KEYS = Object.freeze([
  'HARNESS_IMAGE',
  'MONGO_ROOT_USERNAME',
  'MONGO_ROOT_PASSWORD',
  'MONGO_DB',
  'AUTH_MONGO_USERNAME',
  'AUTH_MONGO_PASSWORD',
  'API_MONGO_USERNAME',
  'API_MONGO_PASSWORD',
  'MEILI_MASTER_KEY',
]);

// Preflight the nine before spawning compose (stage 2 tail). Every key must be present and a
// non-empty string; any that is missing, empty, or non-string is named in a single
// INTERPOLATION_UNRESOLVED SetupFailure so the failure reads as a harness bug the runner caught
// rather than as a container that will not start. Pure over the compose-env map, so a test drives it
// with a map missing a key. Returns the map unchanged so a caller can chain.
export function preflightComposeInterpolation(composeEnv) {
  const unresolved = COMPOSE_INTERPOLATION_KEYS.filter((key) => {
    const value = composeEnv[key];
    return typeof value !== 'string' || value.trim() === '';
  });
  if (unresolved.length > 0) {
    throw new SetupFailure(
      SETUP_FAILURE_KINDS.INTERPOLATION_UNRESOLVED,
      `The runner failed to resolve ${unresolved.length} compose interpolation value(s) before ` +
        `bring-up: ${unresolved.join(', ')}. compose.harness.yml carries no defaults for these, so ` +
        'an unresolved value would start a container that cannot authenticate — this is a harness ' +
        'bug the runner caught, not a container that will not start. The operator exports nothing; ' +
        'the runner supplies all nine (Req 5.8).',
    );
  }
  return composeEnv;
}

// ---------------------------------------------------------------------------------------------
// Stage 1 — resolve the image. Decide, from `docker image inspect <tag>`'s exit status, whether the
// image is already present. Pure over the inspect result, so a test drives both branches without
// Docker. Returns `{ present }`; the caller builds when absent and throws IMAGE_UNRESOLVED when the
// build also fails.
// ---------------------------------------------------------------------------------------------
export function classifyImagePresence({ status }) {
  return { present: status === 0 };
}

// The `docker image inspect --format` template that returns the two identity fields task 17.5 reports
// on ONE line, tab-separated: the local image ID (the sha256 CONFIG digest a locally built image
// carries — NOT a repository digest, which a local build has none of) and the creation time from the
// image's own metadata. Spelled once so the inspect call and the parser cannot disagree about the
// field order. `\t` is a Go-template literal tab, so a repository:tag with no colon-free surprises is
// irrelevant — the two values never share a delimiter with each other.
export const IMAGE_IDENTITY_FORMAT = '{{.Id}}\t{{.Created}}';

// Parse the `docker image inspect --format IMAGE_IDENTITY_FORMAT` stdout into `{ id, createdAt }`.
// Pure over the captured string so a test drives it without Docker. `.Created` is normalized to ISO
// 8601 UTC via `Date`, because Docker prints it in an RFC3339 form with a nanosecond fraction Node's
// `Date` cannot round-trip losslessly; ISO 8601 UTC is what Req 5.12 asks the report to carry. A
// blank or unparseable line yields nulls rather than throwing — image identity is a report field, and
// losing it must not unwind the run past a resolved image.
export function parseImageIdentity(stdout) {
  const line = typeof stdout === 'string' ? stdout.trim() : '';
  if (line === '') {
    return { id: null, createdAt: null };
  }
  const [id = '', created = ''] = line.split('\t');
  const parsed = created.trim() === '' ? NaN : new Date(created.trim()).getTime();
  return {
    id: id.trim() === '' ? null : id.trim(),
    createdAt: Number.isNaN(parsed) ? null : new Date(parsed).toISOString(),
  };
}

// Read the image's identity fields (`id`, `createdAt`) off `docker image inspect <tag> --format`.
// A separate inspect from the presence probe: the presence probe reads only the exit STATUS (an
// absent image exits non-zero), and this one reads the metadata of an image now known to exist. `exec`
// is injected so a test drives it. Returns `{ id, createdAt }`, nulls when the inspect produced no
// usable line — the identity is reported, never gated on.
export async function readImageIdentity({ exec, harnessImage }) {
  const inspect = await exec('docker', [
    'image',
    'inspect',
    harnessImage,
    '--format',
    IMAGE_IDENTITY_FORMAT,
  ]);
  return parseImageIdentity(inspect?.stdout ?? '');
}

// Resolve the harness image: inspect the local store, build from the Dockerfile's `node` target when
// absent, and throw a named IMAGE_UNRESOLVED SetupFailure when it can be neither found nor built.
// `exec` is injected so a test drives the found / built / unbuildable branches with a fake exec.
//
// Returns the image IDENTITY RECORD task 17.5 reports (Req 5.12):
//
//   { reference, id, createdAt, provenance }
//
//   * reference  — the resolved tag (repository:tag), the value of `harnessImage`.
//   * id         — the LOCAL image ID both containers start from (sha256 config digest; a locally
//                  built image has no repository digest, so this is what is reported).
//   * createdAt  — the image's creation time from its metadata, ISO 8601 UTC.
//   * provenance — 'built' when THIS run invoked `docker build`, 'reused' when it did not. Decided by
//                  which code path ran, NEVER by comparing ids or timestamps: a fully cached build can
//                  return an existing id and an old creation time, so the timestamp cannot tell a build
//                  from a reuse (Req 5.12, and the design's note on it).
//
// Never proceeds silently past an unresolved image — a run against a stale or absent image is the one
// failure mode that produces confident nonsense. No comparison between the image and the source, and
// no git (NG9, NG11): the record REPORTS what was tested, it does not judge it against the code.
export async function resolveImage({ exec, harnessImage, buildContext = REPO_ROOT }) {
  const inspect = await exec('docker', ['image', 'inspect', harnessImage]);
  if (classifyImagePresence(inspect).present) {
    // Found in the local store — the run invokes no build, so provenance is 'reused'.
    const identity = await readImageIdentity({ exec, harnessImage });
    return { reference: harnessImage, ...identity, provenance: 'reused' };
  }
  // Absent from the local store — build it from the repo Dockerfile's `node` target (the
  // docker-compose.yml image family; the harness is a sibling of docker-compose.yml).
  const build = await exec(
    'docker',
    ['build', '-f', 'Dockerfile', '--target', 'node', '-t', harnessImage, '.'],
    { cwd: buildContext },
  );
  if (build.status === 0) {
    // THIS run invoked the build, so provenance is 'built' — regardless of whether the build was fully
    // cached and returned an existing id. The id/createdAt come from inspecting the now-present image.
    const identity = await readImageIdentity({ exec, harnessImage });
    return { reference: harnessImage, ...identity, provenance: 'built' };
  }
  throw new SetupFailure(
    SETUP_FAILURE_KINDS.IMAGE_UNRESOLVED,
    `Harness image "${harnessImage}" was not in the local Docker image store and could not be ` +
      `built. Build it manually with:\n` +
      `    docker build -f Dockerfile --target node -t ${harnessImage} .\n` +
      '  (run from the repository root), or set HARNESS_IMAGE to a tag that already exists. The ' +
      'run cannot proceed against an absent image.',
    { service: 'image', detail: build.stderr || build.stdout || null },
  );
}

// The exact command that rebuilds the reported tag, spelled once so the reuse notice and the
// IMAGE_UNRESOLVED failure name the same command for the same tag.
export function rebuildCommandFor(reference) {
  return `docker build -f Dockerfile --target node -t ${reference} .`;
}

// Decide the one-line reuse notice (Req 5.13). Returns the notice string for a 'reused' image and
// null for a 'built' one — pure over the image record so a test asserts presence on reuse and absence
// on build without a terminal. The notice is INFORMATION, not a verdict: it states the image may not
// match the current code and names the rebuild command for the reported tag, and it performs no
// comparison between the image and the code (NG9, NG11). Printed exactly once, before the first check.
export function reuseNoticeFor(image) {
  if (image === null || image === undefined || image.provenance !== 'reused') {
    return null;
  }
  return (
    `NOTICE: the harness reused the existing image "${image.reference}" and built nothing this ` +
    'run, so it may not match the current code. This fails nothing — no image-to-code comparison ' +
    'is performed. To test the current code, rebuild the tag first:\n' +
    `    ${rebuildCommandFor(image.reference)}`
  );
}

// Resolve the image tag from the environment, defaulting to DEFAULT_HARNESS_IMAGE when HARNESS_IMAGE
// is unset. Pure over the env map so a test asserts both the explicit and the default branch.
export function resolveHarnessImageTag({ env = process.env } = {}) {
  const configured = env.HARNESS_IMAGE;
  return typeof configured === 'string' && configured.trim() !== ''
    ? configured.trim()
    : DEFAULT_HARNESS_IMAGE;
}

// ---------------------------------------------------------------------------------------------
// Stage 5 — authenticated mongod readiness. `docker compose up --wait mongodb` blocks until the
// mongodb service is healthy or the wait times out; the compose healthcheck IS an authenticated
// ping (compose.harness.yml), so `--wait` returning 0 means mongod is accepting the root credential.
// This classifier reads that spawn result: exit 0 => ready, anything else => a MONGO_READINESS_TIMEOUT
// SetupFailure carrying the mongod log tail, and NO script runs. Pure over the captured result, so a
// test drives both branches.
// ---------------------------------------------------------------------------------------------
export function classifyMongoReadiness({ status, stderr = '', logTail = '' }) {
  if (status === 0) {
    return { ok: true };
  }
  throw new SetupFailure(
    SETUP_FAILURE_KINDS.MONGO_READINESS_TIMEOUT,
    `The Auth_Enabled_MongoDB did not reach AUTHENTICATED readiness within its healthcheck budget ` +
      `(~${MONGO_READINESS_TIMEOUT_MS / 1000}s). The compose healthcheck is an authenticated ping, ` +
      'so this means mongod never accepted the root credential. No provisioning script was run.',
    { service: 'mongodb', detail: logTail || stderr || null },
  );
}

// ---------------------------------------------------------------------------------------------
// Stage 9 — bring-up, and the two DIFFERENT failures a non-zero `up` can mean.
//
// `docker compose --profile <p> up --wait --wait-timeout 300` returns 0 when every selected service
// is healthy. A non-zero exit was previously reported one way — "did not reach a healthy topology
// within 300s", listing every service `ps` did not call healthy. Against a real failure that reading
// was wrong on three counts at once, and each one sent the reader somewhere unhelpful:
//
//   * It asserted an elapsed time the runner never observed. Compose aborted in about fourteen
//     seconds with `dependency failed to start: container harness-auth-surface exited (1)`; it never
//     waited the window out. "Within 300s" reads as "we gave it the full budget", which invites
//     raising a timeout that was never reached.
//   * It named the wrong failure mode. A container that EXITED has a log with a reason in it; a
//     container stuck `starting` is still running and needs a different look. Collapsing the two
//     hides which evidence to read first.
//   * It named services that had not failed. `harness-proxy` was listed as unhealthy when the proxy
//     never started at all — its dependency failed first, so compose left it `created`. A service
//     that never ran is a consequence, and listing it beside the real failure buries the one name
//     that matters.
//
// So the decision is split in two: a pure classifier (classifyBringupFailure) decides WHAT failed and
// WHICH mode from the captured compose output, and classifyBringup turns that into the SetupFailure.
// Both stay pure over already-captured strings, so every branch is exercisable without Docker.
//
// The SetupFailure SHAPE is unchanged (kind/service/detail) and Property 9 behavior is unchanged: a
// bring-up failure of either mode is a setup failure, nothing was falsified, and no request-level
// check is admitted.
// ---------------------------------------------------------------------------------------------

export const BRINGUP_FAILURE_MODES = Object.freeze({
  // A container exited non-zero or went `unhealthy`. Compose aborted; the window was not spent.
  CONTAINER_FAILED: 'container-failed',
  // Nothing failed outright; a service simply never reached a serving state inside the window.
  READINESS_TIMEOUT: 'readiness-timeout',
});

// The services that ACTUALLY FAILED, per `docker compose ps`: a container that exited non-zero, or
// one whose healthcheck reported `unhealthy`. Pure over the ps output (JSONL or a single array).
//
// This is deliberately narrower than findUnhealthyServices below. A service in state `created` or
// `paused`, or one whose health is still `starting`, has NOT failed — after a dependency failure that
// is every other service in the topology, and naming them buries the one that did fail. The narrow
// reading is what makes the failure list attributable.
export function findFailedServices(psOutput) {
  const failed = [];
  for (const entry of parseComposePs(psOutput)) {
    const health = entry.Health ?? '';
    const state = entry.State ?? '';
    const name = entry.Name ?? entry.Names ?? entry.Service ?? '(unnamed)';
    const exitedNonZero =
      state === 'exited' && typeof entry.ExitCode === 'number' && entry.ExitCode !== 0;
    if (exitedNonZero) {
      failed.push({
        name,
        service: entry.Service ?? null,
        health: `exited (${entry.ExitCode})`,
        state,
      });
      continue;
    }
    if (health === 'unhealthy') {
      failed.push({ name, service: entry.Service ?? null, health, state });
    }
  }
  return failed;
}

// Decide the bring-up failure mode and the services to name, from the captured compose output. Pure
// over `{ stderr, psOutput }` — no spawning — so both modes and the de-duplication are unit-testable.
//
// Both sources are consulted and UNIONED rather than one being preferred, because each sees a failure
// the other can miss: `ps -a` may already have swept an exited container (reporting nothing failed),
// while `up`'s stderr names only the container it tripped over and not a second one that also failed.
// Preferring `ps` was how `harness-proxy` came to be reported over the `harness-auth-surface` that
// stderr had named explicitly.
//
// Any definite failure makes the mode CONTAINER_FAILED, even if other services are also merely
// pending: a container that exited is the cause, and a pending sibling is its consequence. Only when
// NOTHING failed is the mode READINESS_TIMEOUT, and then the services named are the ones that never
// went healthy — which in that mode is the genuine finding.
export function classifyBringupFailure({ stderr = '', psOutput = '' } = {}) {
  const byName = new Map();
  for (const entry of [...parseFailedContainers(stderr), ...findFailedServices(psOutput)]) {
    if (!byName.has(entry.name)) {
      byName.set(entry.name, entry);
    }
  }
  const failed = [...byName.values()];
  if (failed.length > 0) {
    return { mode: BRINGUP_FAILURE_MODES.CONTAINER_FAILED, failed };
  }
  return {
    mode: BRINGUP_FAILURE_MODES.READINESS_TIMEOUT,
    failed: findUnhealthyServices(psOutput),
  };
}

// Turn a non-zero `up` into the right SetupFailure. `failure` is classifyBringupFailure's verdict;
// `elapsedMs` is the duration the runner MEASURED around the `up` spawn, and it is reported only when
// it was actually measured — the message asserts no elapsed time the runner did not observe.
//
// Pure over already-captured values. Exit 0 short-circuits to `{ ok: true }` as before.
export function classifyBringup(
  { status },
  { failure = null, logTail = '', elapsedMs = null } = {},
) {
  if (status === 0) {
    return { ok: true };
  }

  const { mode, failed } = failure ?? {
    mode: BRINGUP_FAILURE_MODES.READINESS_TIMEOUT,
    failed: [],
  };
  const observed = typeof elapsedMs === 'number' ? ` Observed elapsed: ${elapsedMs / 1000}s.` : '';

  if (mode === BRINGUP_FAILURE_MODES.CONTAINER_FAILED) {
    const named = failed.map((f) => `${f.name}${f.health ? ` (${f.health})` : ''}`).join(', ');
    throw new SetupFailure(
      SETUP_FAILURE_KINDS.BRINGUP_CONTAINER_FAILED,
      `Bring-up failed because a container did not stay up: ${named}. compose ABORTED the bring-up ` +
        'rather than waiting out the ' +
        `${BRINGUP_TIMEOUT_MS / 1000}s readiness budget, so this is a container/dependency failure, ` +
        `NOT a readiness timeout — read the named container's own log for why it exited, not the ` +
        'compose progress output.' +
        observed +
        ' Only services that actually failed are named: a service left `created` or `starting` ' +
        'because its dependency failed first is a consequence, not the cause. No request-level check ' +
        'is admitted (Property 9).',
      { service: failed[0]?.service ?? 'bringup', detail: logTail || null },
    );
  }

  const named =
    failed.length > 0
      ? failed.map((f) => `${f.name}${f.health ? ` (${f.health})` : ''}`).join(', ')
      : '(no container failed and docker compose ps named no pending service — read the log tail)';
  throw new SetupFailure(
    SETUP_FAILURE_KINDS.BRINGUP_TIMEOUT,
    `Bring-up did not reach a healthy topology inside its ${BRINGUP_TIMEOUT_MS / 1000}s readiness ` +
      `budget, and no container exited or reported unhealthy. Still not serving: ${named}.` +
      observed +
      ' No request-level check is admitted (Property 9).',
    { service: failed[0]?.service ?? 'bringup', detail: logTail || null },
  );
}

// Parse `docker compose ps --format json` and return the services that are not healthy/running, so
// classifyBringup can name them in the READINESS_TIMEOUT mode. Pure over the ps output string (JSONL
// or a single array), reusing parseComposePs. A service is "unhealthy" here in the WIDE sense — its
// Health is neither "healthy" nor empty-and-running — which includes a service that is merely pending;
// an exited one-shot (the provision service after it completes) is not flagged. Use findFailedServices
// above for the narrow "actually failed" reading. Returns `[{ name, service, health, state }]`.
export function findUnhealthyServices(psOutput) {
  const entries = parseComposePs(psOutput);
  const unhealthy = [];
  for (const entry of entries) {
    const health = entry.Health ?? '';
    const state = entry.State ?? '';
    const name = entry.Name ?? entry.Names ?? entry.Service ?? '(unnamed)';
    // A running service with a healthcheck that has not gone healthy, or a service that exited
    // non-zero, is unhealthy. A cleanly exited service (the provision one-shot) is fine.
    const exitedCleanly =
      state === 'exited' && (entry.ExitCode === 0 || entry.ExitCode === undefined);
    const healthyOrPending = health === 'healthy' || (health === '' && state === 'running');
    if (!healthyOrPending && !exitedCleanly) {
      unhealthy.push({ name, service: entry.Service ?? null, health: health || null, state });
    }
  }
  return unhealthy;
}

// Parse the container name(s) `docker compose up --wait` names when a service fails to become
// healthy, from its stderr — lines of the form
//   "dependency failed to start: container harness-api-container exited (1)"
//   "container harness-auth-surface is unhealthy"
// The compose container name is `harness-<service>` (compose.harness.yml sets container_name), so
// the service is recovered by stripping the `harness-` prefix. Pure over the stderr string, so a
// test drives it without Docker. This is the fallback when `ps -a` has already swept the exited
// container and so reports nothing unhealthy — which is exactly the case a failed boot produces.
export function parseFailedContainers(stderr) {
  const found = [];
  const re = /container (harness-[a-z0-9-]+) (?:exited \((\d+)\)|is unhealthy)/gi;
  let match;
  while ((match = re.exec(stderr)) !== null) {
    const name = match[1];
    const service = name.startsWith('harness-') ? name.slice('harness-'.length) : name;
    const exitCode = match[2] !== undefined ? Number(match[2]) : null;
    found.push({
      name,
      service,
      health: exitCode !== null ? `exited (${exitCode})` : 'unhealthy',
      state: exitCode !== null ? 'exited' : 'unhealthy',
    });
  }
  return found;
}

// ---------------------------------------------------------------------------------------------
// Stage 10 — the harness context PRIMITIVES the Jest bootstrap reconstructs the live context from.
// run.mjs and the Jest checks are SEPARATE processes, so this writes only serializable primitives —
// the ingress/observation base URLs are baked into the client factories, and the bootstrap builds the
// clients + connects observerDb from these. Pure over its inputs so a test asserts the exact shape.
//
//   * profile        — which compose profile is up (the reporter annotates the run with it)
//   * observerUri    — the read-only observer connection string (buildObserverUri)
//   * bootStart      — captureBootStart's { epochMs, iso }, the boot window's left edge
//   * readyAtMs      — epoch ms at which /readyz first returned 200 (the window's right edge is +60s)
//   * composeEnv     — the nine compose interpolation values (plus COMPOSE_FILE), so a check that
//                      spawns `docker compose` resolves the SAME project the runner brought up
//
// == Why composeEnv crosses the bridge (and why it must) ==
// Three checks read the live topology through `docker compose` themselves: TOPO-ENV-14 and
// MONGO-URI-19 spawn `config --format json` (the resolved container environment is the only place the
// env matrix and the MONGO_URI values can be read as the containers receive them), and
// TOPO-BRINGUP-16 / TOPO-INGRESS-17 / TOPO-IMAGE-13 spawn `ps`. compose.harness.yml interpolates nine
// values with NO defaults, deliberately, so an unresolved one fails loudly — and the Layer B Jest
// process is a CHILD of the runner that does not inherit them, because the runner passes them per
// compose invocation rather than exporting them. So every one of those reads failed with
// `The "HARNESS_IMAGE" variable is not set … invalid compose project` while the topology it was
// reading stood up healthy beside it. The values belong on the bridge for the same reason the observer
// URI does: they are per-run material the checks need and cannot reconstruct.
//
// They are per-run SECRETS (four passwords and the search master key), so they travel the way the
// observer credential already travels — inside harness-context.json, which the runner writes with mode
// 0600 and .gitignore excludes, never through a committed file and never printed. jest.setup.mjs
// applies them to the Jest process's environment without logging them.
// ---------------------------------------------------------------------------------------------
export function assembleContextPrimitives({
  profile,
  secrets,
  bootStart,
  readyAtMs,
  composeEnv = null,
  seededAccount = null,
}) {
  return {
    profile,
    observerUri: buildObserverUri(secrets.OBSERVER_MONGO_PASSWORD),
    bootStart,
    readyAtMs,
    // The Seeded_Account the root snippet inserted before the boot window opened (task 11.5). The
    // checks need its email, password and id: the recorded Path_Payloads reference all three through
    // SEED_PLACEHOLDERS, and the Session_Fixture is minted by posting the first two to
    // /api/auth/login through the ingress. The password is a per-run secret, so it travels the way the
    // observer credential and the nine compose values already travel — inside harness-context.json,
    // which the runner writes mode 0600, .gitignore excludes, and nothing prints.
    seededAccount,
    // The window's left edge as an ISO string, for `docker compose logs --since` (readiness-log).
    window: { since: bootStart?.iso ?? null },
    // The compose file the bootstrap's observation client must resolve for its log reads.
    composeFile: COMPOSE_FILE_PATH,
    // The nine interpolation values the checks' own `docker compose` reads need. Null only in a caller
    // that has none to publish (a test); the runner always passes the map it brought the topology up
    // with, so the checks read the same project rather than an uninterpolated one.
    composeEnv,
  };
}

// ---------------------------------------------------------------------------------------------
// The mongosh argv the runner uses to run the harness-owned root snippet (stage 7) against the
// loopback observation plane as root. The snippet is fed on stdin, so `--file /dev/stdin` reads it;
// `--quiet --norc` keep the output clean for classification. Pure builder so a test asserts the argv
// without spawning mongosh. The root credential authenticates on admin.
// ---------------------------------------------------------------------------------------------
export function buildRootMongoshArgs(secrets) {
  const rootUri =
    `mongodb://${IDENTITIES.rootUsername}:${secrets.MONGO_ROOT_PASSWORD}@` +
    `${OBSERVER_MONGO_HOST}:${OBSERVER_MONGO_PORT}/${IDENTITIES.mongoDb}` +
    `?authSource=${IDENTITIES.authSource}&directConnection=true`;
  return [rootUri, '--quiet', '--norc', '--file', '/dev/stdin'];
}

// Classify the harness-owned root snippet's outcome (stage 7). mongosh exits 0 on success; a
// non-zero exit is an OBSERVER_SNIPPET_FAILED SetupFailure carrying stderr. Pure over the captured
// result, so a test drives both branches.
export function classifyObserverSnippet({ status, stderr = '' }) {
  if (status === 0) {
    return { ok: true };
  }
  throw new SetupFailure(
    SETUP_FAILURE_KINDS.OBSERVER_SNIPPET_FAILED,
    'The harness-owned root snippet (observer credential + system.profile sizing + profiling + the ' +
      `Seeded_Account insert) failed (mongosh exited ${status}). This is harness machinery, not the ` +
      'provisioning script (NG2). Without it the observer credential and the sized profile the ' +
      'boot-write check depends on do not exist, and the Seeded_Account the session-gated path ' +
      'exercises need was not inserted before the boot window opened, so no request-level check is ' +
      'admitted.',
    { service: 'observer-snippet', detail: stderr || null },
  );
}

// ---------------------------------------------------------------------------------------------
// runHarness — the ordered sequence (Req 5.7), behind the injected `exec`.
//
// The thirteen stages, in the order the code performs them (the per-run secrets, the resolved env
// files and the pre-bring-up validation run in prepareSetup, before this):
//
//    1. Layer A grant-conformance checks       8. Bring up the containers + Front_Proxy (300s)
//    2. Resolve the image (build when absent)  9. Poll /readyz — the boot window's right edge
//    3. Preflight the nine compose values     10. Publish the harness context bridge
//    4. Bring up mongod, authenticated (60s)  11. Layer B topology checks
//    5. Provision the two grants              12. Tear down
//    6. Harness-owned root snippet            13. Confirm nothing remained
//    7. Record the boot-window start
//
// Stages 1–9 are this function's; 10–13 belong to the caller, which owns the context bridge, the
// Layer B spawn and the teardown registered BEFORE this runs.
//
// LAYER A IS STAGE 1, ahead of every Docker touch. It is in-process, hermetic and seconds-fast, and
// it is the surface a grant-shape regression shows up on, so running it first means such a
// regression costs seconds rather than an image build plus a 300-second bring-up. That ordering used
// to be claimed in a comment and contradicted by the code, which ran Layer A after bring-up — so a
// bring-up failure meant Layer A never ran at all and the cheap answer was never collected. A
// non-zero Layer A exit returns `abortedBeforeBringup` and no Docker command is issued.
//
// Returns `{ layerA, contextPrimitives, image, abortedBeforeBringup }`. `image` is the identity
// record resolveImage produced at stage 2 (reference/id/createdAt/provenance), or null when the run
// ended before stage 2 (`abortedBeforeBringup`), so the caller writes the report's `image` block only
// when an image was actually resolved (Req 5.12). On a Layer A failure `abortedBeforeBringup` is true
// and `contextPrimitives` is null — the caller ends the run non-zero on Layer A's own exit status,
// which is a CHECK failure (a property was falsified), not a setup failure. Any stage 2–9 that cannot
// complete throws a SetupFailure instead (Property 9); `observed.image` carries the resolved record so
// that failure's early-exit report can still name what it tested.
// `pollReadyz` polls /readyz to find the boot window's right edge; it is injected so a test drives it
// without a live proxy.
// ---------------------------------------------------------------------------------------------
export async function runHarness({
  exec,
  profile,
  secrets,
  harnessImage,
  pollReadyz,
  // The per-run Seeded_Account (task 11.5). Inserted as the LAST step of the stage-6 root snippet,
  // under the Root_Credential (Req 3.17) and ahead of the stage-7 boot-window timestamp (Req 3.18),
  // then published on the context bridge so the checks can resolve their recorded payloads and mint
  // the Session_Fixture. Defaulted to null so a caller that does not need the fixture — a test
  // exercising only the stage ordering — reads unchanged.
  seededAccount = null,
  now = Date.now,
  stdout = process.stdout,
  observed = {},
}) {
  const log = (line) => stdout.write(`${line}\n`);

  // Stage 1: Layer A, BEFORE any Docker spend. Cheap, hermetic, and it fails fast on a grant-shape
  // regression — so the expensive stages below are never spent on a run the grant has already
  // decided. Self-skips (exit 0, reason on stderr) where `mongosh` is absent, which is a reported
  // skip and neither a pass nor a failure, so an absent binary does not block bring-up.
  log('[1/13] Running Layer A (grant conformance) before any Docker work…');
  const layerA = await runLayerAChecks({ exec });
  // Published to the caller IMMEDIATELY, before any stage that can throw. A SetupFailure from stages
  // 2–9 unwinds past this function's return value, and Layer A's verdict would be lost with it — which
  // is how twelve decided catalog ids came to be discarded by a bring-up failure. The caller reads
  // `observed.layerA` in its catch and puts the verdict in the report (Req 5.10).
  observed.layerA = layerA;
  if (layerA.status !== 0) {
    log(
      `  Layer A exited ${layerA.status}. Ending the run here: the grant is the cheapest thing to ` +
        'get wrong and the most expensive to discover late, so no image is built and no topology ' +
        'is brought up.',
    );
    return {
      layerA,
      contextPrimitives: null,
      // No image: the run ended at stage 1, BEFORE image resolution, so there is nothing tested to
      // report. The report's `image` block is absent in this case (Req 5.12 distinction).
      image: null,
      abortedBeforeBringup: true,
    };
  }
  log('  Layer A passed (or self-skipped for want of mongosh).');

  // Stage 2: resolve the image. Never proceed silently past an unresolved image. The image record
  // (reference/id/createdAt/provenance) is published to the caller so it reaches BOTH report paths —
  // the stage-11 reporter here, and the early-exit report should a later stage fail (Req 5.12).
  log(`[2/13] Resolving harness image "${harnessImage}"…`);
  const image = await resolveImage({ exec, harnessImage });
  observed.image = image;
  log(
    image.provenance === 'built'
      ? `  built ${harnessImage} from Dockerfile (target node).`
      : `  found ${harnessImage}.`,
  );
  log(`  image: id ${image.id ?? '(unknown)'}, created ${image.createdAt ?? '(unknown)'}.`);
  // On reuse, print exactly one notice BEFORE the first check runs (Req 5.13). Nothing else prints it;
  // a built image prints none. The notice is information, not a verdict — it fails nothing.
  const reuseNotice = reuseNoticeFor(image);
  if (reuseNotice !== null) {
    log(reuseNotice);
  }

  // Stage 3: the nine compose interpolation values, preflighted before compose is spawned.
  const composeEnv = buildComposeEnv(secrets, { harnessImage });
  preflightComposeInterpolation(composeEnv);
  log('[3/13] Nine compose interpolation values resolved and preflighted.');

  const composeExec = (args, opts = {}) =>
    exec('docker', args, { ...opts, env: { ...composeEnv, ...(opts.env ?? {}) } });

  // Stage 4: bring mongod up and wait for AUTHENTICATED readiness (the compose healthcheck).
  log('[4/13] Bringing up the Auth_Enabled_MongoDB and waiting for authenticated readiness…');
  const mongoUp = await composeExec([
    'compose',
    '--profile',
    profile,
    'up',
    '-d',
    '--wait',
    '--wait-timeout',
    String(Math.ceil(MONGO_READINESS_TIMEOUT_MS / 1000)),
    'mongodb',
  ]);
  if (mongoUp.status !== 0) {
    const logs = await composeExec(['compose', 'logs', '--no-color', '--tail', '50', 'mongodb']);
    classifyMongoReadiness({
      status: mongoUp.status,
      stderr: mongoUp.stderr,
      logTail: logs.stdout,
    });
  }
  log('  mongod is accepting authenticated connections.');

  // Stage 5: run the UNMODIFIED provision.mongo.js through the one-shot provision service (NG2).
  log('[5/13] Provisioning the two grants (provision.mongo.js, unmodified)…');
  const provision = await composeExec([
    'compose',
    '--profile',
    profile,
    'run',
    '--rm',
    'provision',
  ]);
  classifyProvisionOutcome({
    status: provision.status,
    stdout: provision.stdout,
    stderr: provision.stderr,
  });
  log('  provisioning reported Done.');

  // Stage 6: the harness-owned root snippet — observer credential + profiling sizing + the
  // Seeded_Account insert, in that order (NG2). The seed is LAST in the snippet and the snippet is the
  // last thing before stage 7's timestamp, which is the only interval that satisfies Req 3.17 and
  // 3.18 together: the Root_Credential is in hand here, profiling is already on, and the boot window
  // has not opened yet.
  log(
    '[6/13] Applying the harness-owned root snippet (observer credential + 64MB profiling + ' +
      'Seeded_Account)…',
  );
  const snippet = buildObserverAndProfilingSnippet(
    IDENTITIES.mongoDb,
    secrets.OBSERVER_MONGO_PASSWORD,
    { seededAccount },
  );
  const snippetResult = await exec('mongosh', buildRootMongoshArgs(secrets), { input: snippet });
  classifyObserverSnippet(snippetResult);
  log('  observer credential created; system.profile sized to 64MB, profiling level 2.');
  if (seededAccount !== null) {
    // The email and the id, never the password: the credential is published on the mode-0600 context
    // bridge and is not printed anywhere.
    log(
      `  Seeded_Account inserted under the Root_Credential (${seededAccount.email}, ` +
        `_id ${seededAccount.id}) — before the boot window opens (Req 3.17, 3.18).`,
    );
  }

  // Stage 7: record the boot window's left edge BEFORE any container starts.
  const bootStart = captureBootStart({ now });
  log(`[7/13] Recorded Auth_Surface boot-window start: ${bootStart.iso}.`);

  // Stage 8: bring up both containers + the Front_Proxy within the 300s budget.
  log('[8/13] Bringing up the containers and the Front_Proxy…');
  // Measured around the spawn, so the failure message can report an elapsed time the runner actually
  // observed instead of implying the whole budget was spent. A container that exits early aborts the
  // bring-up in seconds; reporting that as "within 300s" invites raising a timeout nothing reached.
  const upStartedAtMs = now();
  const up = await composeExec([
    'compose',
    '--profile',
    profile,
    'up',
    '-d',
    '--wait',
    '--wait-timeout',
    String(Math.ceil(BRINGUP_TIMEOUT_MS / 1000)),
  ]);
  const upElapsedMs = now() - upStartedAtMs;
  if (up.status !== 0) {
    // Read `ps -a` (a failed container has already EXITED, so a plain `ps` would not list it) and
    // also parse the container `up` named in its "dependency failed to start: container … exited"
    // line. Both are handed to the classifier, which unions them: `ps -a` may have swept the exited
    // container, and stderr names only the one compose tripped over.
    const ps = await composeExec(['compose', '--profile', profile, 'ps', '-a', '--format', 'json']);
    const failure = classifyBringupFailure({ stderr: up.stderr ?? '', psOutput: ps.stdout ?? '' });
    // Tail the FAILED container's OWN log (its stderr on boot), not the compose progress: that is
    // what tells an operator why it exited. `logs` on a removed container returns nothing, so read it
    // before the finally tears down — this runs while the exited container still exists. The target is
    // the first service that actually failed, so a dependency failure tails the container that exited
    // rather than a sibling that never started.
    const tailTarget = failure.failed[0]?.service ?? failure.failed[0]?.name ?? null;
    const logs = tailTarget
      ? await composeExec([
          'compose',
          '--profile',
          profile,
          'logs',
          '--no-color',
          '--tail',
          '80',
          tailTarget,
        ])
      : { stdout: up.stderr };
    classifyBringup(
      { status: up.status },
      { failure, logTail: logs.stdout || up.stderr, elapsedMs: upElapsedMs },
    );
  }
  log('  every service is healthy.');

  // Stage 9: find the boot window's right edge — poll /readyz until 200.
  log('[9/13] Polling /readyz for the Auth_Surface to name the boot-window right edge…');
  const ready = await pollReadyz();
  const readyAtMs = ready?.readyAtMs ?? now();
  log('  /readyz answered 200.');

  const contextPrimitives = assembleContextPrimitives({
    profile,
    secrets,
    bootStart,
    readyAtMs,
    // The same nine values stage 3 preflighted and every compose invocation above ran with, handed to
    // the checks that spawn `docker compose` themselves (TOPO-ENV-14, MONGO-URI-19, the ps readers).
    composeEnv,
    // The account stage 6 inserted, so stage 11 can resolve its recorded payloads and mint the
    // Session_Fixture through the ingress once the boot window has closed.
    seededAccount,
  });
  return { layerA, contextPrimitives, image, abortedBeforeBringup: false };
}

// ---------------------------------------------------------------------------------------------
// The two check spawns, kept as separate functions because they run at OPPOSITE ENDS of the
// sequence: Layer A is stage 1, ahead of every Docker touch, and Layer B is stage 11, against the
// topology stages 8–10 stood up. One `runChecks` that spawned both could only ever place Layer A
// adjacent to Layer B, which is how Layer A came to run after bring-up and therefore not at all when
// bring-up failed. Both go through the injected exec, so the ordering is observable in a test.
// ---------------------------------------------------------------------------------------------

// Layer A (stage 1): the api workspace's Jest over test/container-split, run FROM the api workspace
// so its own config applies (mongodb-memory-server fixtures, mongosh spawns). Needs no image, no
// Docker and no topology — which is what lets it run before bring-up. It self-skips (exit 0, reason
// on stderr) where `mongosh` is absent, so a missing binary reads as reduced coverage rather than a
// failed grant and does not stop the run.
export const LAYER_A_JEST_ARGS = Object.freeze(['jest', '--runInBand', 'test/container-split']);

export async function runLayerAChecks({ exec }) {
  return exec('npx', [...LAYER_A_JEST_ARGS], { cwd: path.join(REPO_ROOT, 'api') });
}

// Layer B (stage 11): the topology checks, with the context bridge and the live gate. NODE_OPTIONS
// carries --experimental-vm-modules (native ESM), HARNESS_CONTEXT_FILE points the bootstrap at the
// bridge stage 10 wrote, HARNESS_LIVE=1 opens the live gate the specs read, HARNESS_PROFILE
// annotates the report, and HARNESS_LAYER_A_RESULT carries Layer A's verdict so the stage-11 reporter
// records what stage 1 actually decided instead of deriving an absence for twelve ids it cannot see.
// The Layer A value is a two-field summary (`{ status, selfSkipped }`), not the suite's stderr.
//
// == Why composeEnv is handed to the CHILD PROCESS and not applied by the bootstrap ==
// Several checks spawn `docker compose` themselves (TOPO-ENV-14 and MONGO-URI-19 read
// `config --format json`; the topology checks read `ps`), and compose.harness.yml interpolates its nine
// values with NO defaults, so those reads need them in the environment `docker` is spawned with.
// Their exec seams call `execFile('docker', argv, …)` with no `env`, which means the child inherits the
// REAL environment of the process that spawns it.
//
// An earlier fix tried to satisfy that from inside Jest: jest.setup.mjs read the values off the context
// bridge and assigned them to `process.env`. That cannot work, and did not. Jest gives each test
// environment a CLONE of `process` (jest-util's createProcessObject; `process.env` is a proxy over a
// per-test-file copy), while `node:child_process` is the real core module closing over the real
// `process`. So a spec's `process.env.HARNESS_IMAGE = …` lands in the sandbox copy and the docker child
// is spawned from the real environment, which never received it — `The "HARNESS_IMAGE" variable is not
// set … invalid compose project`, while the topology stood up healthy beside it. (`ps` tolerates blank
// interpolation and exits 0, which is why only the two `config` readers failed.)
//
// Putting the nine in THIS spawn's `env` puts them in the Layer B process's real environment, which is
// what every descendant — the Jest workers, and the `docker` each check spawns — inherits. No sandbox
// boundary is crossed, so there is nothing left to be defeated by one.
//
// These are per-run secrets. They travel process-to-process as spawn environment, the same channel the
// runner's own compose invocations use; nothing here logs them, and the caller must not print the map.
export async function runLayerBChecks({
  exec,
  contextFile,
  profile,
  layerA = null,
  composeEnv = null,
  image = null,
}) {
  const imageEnv = serializeImageRecord(image);
  return exec('npx', ['jest', '--config', path.join(HERE, 'jest.config.mjs')], {
    env: {
      // The nine (plus COMPOSE_FILE) first, so the harness's own four below can never be shadowed by
      // an interpolation key — the key sets are disjoint today and this keeps them ordered if they stop
      // being.
      ...(composeEnv ?? {}),
      NODE_OPTIONS: '--experimental-vm-modules',
      [HARNESS_CONTEXT_ENV]: contextFile,
      HARNESS_LIVE: '1',
      HARNESS_PROFILE: profile,
      ...(layerA === null ? {} : { [LAYER_A_RESULT_ENV]: serializeLayerASummary(layerA) }),
      // The tested-image record, so the stage-11 reporter writes the top-level `image` block (Req
      // 5.12). Omitted when no image was resolved, which cannot happen on the stage-11 path — by here
      // stage 2 ran — but keeps the hand-off honest if it ever changes.
      ...(imageEnv === null ? {} : { [IMAGE_RECORD_ENV]: imageEnv }),
    },
  });
}

// A real /readyz poller for stage 10: GET the Auth_Surface's loopback /readyz through the observation
// client until it answers 200 within the readiness window, and return the epoch ms it did. Built here
// (not in runHarness) so runHarness stays pure over an injected `pollReadyz` and a test drives it with
// a fake. Uses the observation client so it reaches the readiness plane by construction.
function makeReadyzPoller({ now = Date.now } = {}) {
  const observation = makeObservationClient({ fetch: globalThis.fetch });
  return async () => {
    const start = now();
    const deadline = start + MONGO_READINESS_TIMEOUT_MS;
    // Poll every second until /readyz answers 200 or the window closes. On timeout the boot window
    // still needs a right edge, so return now() and let the +60s tail be measured from here.
    let status = 0;
    while (status !== 200 && now() < deadline) {
      try {
        const res = await observation.ready('auth-surface', '/readyz');
        status = res.status;
      } catch {
        status = 0;
      }
      if (status !== 200) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
    return { readyAtMs: now() };
  };
}

// ---------------------------------------------------------------------------------------------
// Entry point. `--validate` runs the no-Docker pipeline and reports what it produced, then exits 0.
// Without `--validate`, the runner performs the full ordered sequence: run Layer A, resolve the
// image, preflight the nine, bring mongod up, provision, run the root snippet, record the boot
// timestamp, bring up the containers + proxy, publish the context bridge, run Layer B, then tear
// down and verify nothing remained. A SetupFailure at any stage exits non-zero (Property 9); a
// non-zero Layer A exit ends the run at stage 1, before any Docker work.
// ---------------------------------------------------------------------------------------------
async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }

  // The run's own timestamp, stamped before anything happens, so an early-exit report says when THIS
  // run started rather than inheriting a time from whatever wrote the artifact last.
  const runStartedAt = new Date().toISOString();

  // Layer A's verdict, published out of runHarness the moment it is known so a SetupFailure from a
  // later stage cannot discard it (see runHarness's `observed`).
  const observed = {};

  // Delete a previous run's report BEFORE stage 1. A failed run used to leave the last run's
  // run-report.json sitting on disk, and the next reader takes an hour-old tally for this run's
  // result — the same misreading Req 5.9/5.10 exist to prevent, arriving through the artifact instead
  // of the exit code. After this, the file's presence means this run wrote it: either the Layer B
  // reporter at stage 11, or the early-exit report below.
  //
  // `--validate` gets the same deletion, deliberately. It is an invocation of the entry command that
  // brings nothing up and writes no report, so leaving a stale one beside it is the same hazard.
  const staleReport = await removeStaleRunReport();
  if (staleReport.removed) {
    process.stdout.write(
      `Removed the previous run's report (${path.relative(HERE, staleReport.path)}) before stage 1.\n`,
    );
  }

  try {
    const { secrets, envFiles, uris, seededAccount } = await prepareSetup();
    process.stdout.write(`Harness setup prepared (profile: ${args.profile}).\n`);
    process.stdout.write('  Per-run secrets generated; resolved env files written:\n');
    for (const file of envFiles) {
      process.stdout.write(`    ${path.relative(HERE, file)}\n`);
    }
    process.stdout.write(
      '  MONGO_URI values validated (authSource=admin, LibreChat default db):\n',
    );
    // Redact credentials in the printed URIs — the value is confirmed valid, not disclosed.
    for (const [name, uri] of Object.entries(uris)) {
      const shape = uri.replace(/\/\/[^@]+@/, '//<credential>@');
      process.stdout.write(`    ${name}: ${shape}\n`);
    }
    // Identity only. The generated password is a per-run secret and is never printed; it reaches the
    // checks through the mode-0600 context bridge and nowhere else.
    process.stdout.write(
      `  Seeded_Account generated: ${seededAccount.email} (_id ${seededAccount.id}), inserted at ` +
        'stage 6 under the Root_Credential.\n',
    );

    if (args.validate) {
      process.stdout.write('\n--validate: no-Docker setup pipeline passed. Bring-up not run.\n');
      return;
    }

    // --- The full ordered sequence (task 15.2). ---
    const exec = makeRealExec();
    const harnessImage = resolveHarnessImageTag();

    // Teardown is REGISTERED BEFORE BRING-UP (Req 5.1), so an interrupt at any point during the
    // sequence below still releases what was created. It runs from the finally and from
    // SIGINT/SIGTERM; a `ran` guard collapses concurrent calls to one `down`. runTeardown spells
    // `docker compose ... down` with no `-f`, so it resolves the harness file only when COMPOSE_FILE
    // is set — the wrapper below injects the same compose env the bring-up used.
    const composeEnvForTeardown = buildComposeEnv(secrets, { harnessImage });
    const teardown = registerTeardown({
      exec: (command, execArgs, opts = {}) =>
        exec(command, execArgs, {
          ...opts,
          env: { ...composeEnvForTeardown, ...(opts.env ?? {}) },
        }),
    });
    let checksResult = null;
    let harnessResult = null;
    // The post-run verdict on the artifact stage 11's reporter wrote (null until stage 11 completes).
    let reportVerdict = null;
    try {
      harnessResult = await runHarness({
        exec,
        profile: args.profile,
        secrets,
        harnessImage,
        pollReadyz: makeReadyzPoller(),
        // Inserted by stage 6's root snippet and published on the stage-10 bridge (task 11.5).
        seededAccount,
        observed,
      });

      if (harnessResult.abortedBeforeBringup) {
        // Layer A (stage 1) failed, so nothing was brought up and there is no topology to check or
        // context to publish. Layer A's exit status is a CHECK verdict, not a setup failure: a
        // property was falsified, and it was falsified for the cost of a Jest run.
        process.stderr.write(
          `Layer A failed (exit ${harnessResult.layerA.status}). The grant conformance suites ` +
            'decide the run before any Docker work; no image was resolved and no topology was ' +
            'brought up. Read the Layer A output above.\n',
        );
        // Stage 11 was never reached, so the Jest reporter never ran — write the report here so the
        // run still leaves the artifact, carrying Layer A's fail and every unreached Layer B id as a
        // `skip`. No run-level setupFailure: a Layer A non-zero is a FALSIFIED PROPERTY, not a
        // topology that never came up, and the report must keep the two apart (Property 9).
        await writeEarlyRunReportSafely({
          layerA: harnessResult.layerA,
          profile: args.profile,
          startedAt: runStartedAt,
        });
        process.exitCode = harnessResult.layerA.status;
      } else {
        // Stage 10: run.mjs and the Jest workers are separate processes, so publish the context
        // PRIMITIVES to a gitignored JSON file and point HARNESS_CONTEXT_FILE at it. The Jest
        // bootstrap (jest.setup.mjs) reads it and constructs the ingress/observation clients + the
        // observer Db onto globalThis.__CONTAINER_SPLIT_HARNESS__ before the specs load.
        await writeFile(
          HARNESS_CONTEXT_FILE,
          `${JSON.stringify(harnessResult.contextPrimitives, null, 2)}\n`,
          {
            mode: 0o600,
          },
        );
        process.stdout.write(
          `[10/13] Harness context published: ${path.relative(HERE, HARNESS_CONTEXT_FILE)}\n`,
        );

        // Stage 11: the Layer B topology checks. Layer A already ran at stage 1, before the image
        // and the topology, so by here the cheap half of the run is decided. The Layer B reporter
        // writes run-report.json and prints the per-check summary; its exit status is the check
        // verdict.
        process.stdout.write('[11/13] Running Layer B (topology checks)…\n');
        const layerB = await runLayerBChecks({
          exec,
          contextFile: HARNESS_CONTEXT_FILE,
          profile: args.profile,
          // Layer A ran at stage 1 and decides twelve catalog ids that never register a result in the
          // Layer B aggregate. Hand its verdict to the reporter so the stage-11 report records what it
          // decided rather than deriving twelve absences (and inventing a missing `mongosh`).
          layerA: harnessResult.layerA,
          // The same nine values every compose invocation in the sequence ran with, placed in the Layer
          // B process's REAL environment so the `docker compose config`/`ps` a check spawns inherits
          // them at call time. Read off the published primitives rather than rebuilt, so the checks
          // cannot resolve a different project than the one that came up.
          composeEnv: harnessResult.contextPrimitives.composeEnv,
          // The tested-image record from stage 2, handed to the stage-11 reporter so its artifact
          // carries the top-level `image` block (Req 5.12).
          image: harnessResult.image,
        });
        checksResult = { layerA: harnessResult.layerA, layerB };
        process.stdout.write(
          `  Layer A exit ${checksResult.layerA.status}; Layer B exit ${layerB.status}.\n`,
        );

        // The artifact the stage-11 reporter just wrote is the run's only durable statement about what
        // it decided, and this is the first moment it exists — so validate it HERE rather than from a
        // check that would have to read its own run's output file. Well-formedness plus the catalog
        // accounting rules, through the same deciders RUN-REPORT-32 asserts over a synthesized report.
        reportVerdict = await validateWrittenRunReport({
          startedAt: runStartedAt,
          // The profile decides which ids the report had to account for; the reporter used the same
          // derivation, so the two agree by construction rather than by coincidence.
          profile: args.profile,
        });
        if (!reportVerdict.ok) {
          process.stderr.write(
            `RUN-REPORT-32 (post-run validation): ${reportVerdict.reason}\n` +
              `  artifact: ${path.relative(HERE, RUN_REPORT_PATH)}\n`,
          );
        } else {
          process.stdout.write(
            `  run report validated: ${reportVerdict.tally}; report exit code ` +
              `${reportVerdict.exitCode}.\n`,
          );
        }
      }
    } finally {
      // Stages 12 and 13: tear down and verify nothing remained (Req 5.1). Runs whether the sequence
      // succeeded, failed, or threw — a leaked resource is the next run's problem.
      //
      // The one case that skips it: Layer A ended the run at stage 1, so no compose command was ever
      // issued and there is nothing to release. Invoking `docker compose down` there would spend
      // Docker time on a project that was never created, and a Docker that is absent or unhealthy
      // would report a teardown failure over the Layer A verdict that actually decided the run.
      if (harnessResult?.abortedBeforeBringup) {
        teardown.dispose();
        process.stdout.write(
          '[12/13] Nothing was brought up (Layer A ended the run at stage 1) — no teardown needed.\n',
        );
      } else {
        process.stdout.write('[12/13] Tearing down and verifying nothing remained…\n');
        const teardownResult = await teardown.teardownOnce();
        teardown.dispose();
        if (!teardownResult.ok) {
          // A leak is a non-zero exit EVEN WHEN every check passed (Req 5.1).
          reportTeardownFailure(teardownResult.failure);
          process.exitCode = 1;
        } else {
          process.stdout.write('[13/13] Teardown clean — no container or network remained.\n');
        }
      }
    }

    // The exit code folds three things, in this order of precedence — any one of them non-zero makes
    // the run non-zero (Req 5.2, 5.9):
    //
    //   * a teardown leak, already set above;
    //   * the Layer B Jest exit status — a failed check, which the reporter detailed in the artifact
    //     (Layer A cannot fail here: a non-zero Layer A ends the run at stage 1 and never reaches
    //     Layer B);
    //   * THE REPORT'S OWN EXIT CODE, and the verdict on the artifact itself. This is what closes the
    //     last exit-honesty hole: a `skip` whose reason is not enumerated — a check that did not
    //     execute, or executed and could not observe its property — makes the report non-ok while
    //     leaving Jest's exit status at 0, because a check that registered no result fails no test. The
    //     report says exit 1 and the run must agree with it. A malformed or incomplete artifact is
    //     likewise non-zero: a run whose only durable statement cannot be trusted is not a clean run.
    if (checksResult && checksResult.layerB.status !== 0 && process.exitCode !== 1) {
      process.exitCode = checksResult.layerB.status;
    }
    if (reportVerdict && !process.exitCode && (!reportVerdict.ok || reportVerdict.exitCode !== 0)) {
      process.exitCode = 1;
    }
  } catch (error) {
    if (error instanceof SetupFailure) {
      // A setup failure is reported distinctly and never as a falsified property (Property 9).
      process.stderr.write(`SETUP FAILURE [${error.kind}]: ${error.message}\n`);
      if (error.service) {
        process.stderr.write(`  service: ${error.service}\n`);
      }
      if (error.detail) {
        process.stderr.write(`  detail:\n${error.detail}\n`);
      }
      // The run never reached stage 11, so the Jest reporter never wrote a report. Write it here
      // instead of discarding what the run DID decide: Layer A already ran at stage 1 (unless the
      // failure came from prepareSetup, before it, in which case observed.layerA is absent and the
      // backend-lane ids are recorded as unreached too), and every Layer B id is recorded as a `skip`
      // with the not-executed reason. The setup failure rides along as the run-level failure, so the
      // report's outcome line reads FAIL and names what could not be brought up — a report that
      // records Layer A passing cannot be mistaken for a successful run (Req 5.9, 5.10).
      await writeEarlyRunReportSafely({
        setupFailure: error,
        layerA: observed.layerA ?? null,
        profile: args.profile,
        startedAt: runStartedAt,
        // A setup failure AFTER image resolution (a bad MONGO_URI, a bring-up timeout) still tested a
        // resolved image, so the report carries its `image` block (Req 5.12: "including on a run that
        // later ends in the setup failure"). A failure BEFORE resolution — from prepareSetup — leaves
        // observed.image unset, so the block is absent (null). observed.image is published by stage 2
        // the moment resolveImage returns, so it survives the throw that unwinds past runHarness.
        image: observed.image ?? null,
      });
      process.exitCode = 1;
      return;
    }
    if (error instanceof TeardownFailure) {
      reportTeardownFailure(error);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

// Report a teardown failure to stderr, distinctly from a setup failure and a check failure (Req
// 5.1, teardown half of RUN-REPORT-32). Names each survivor so the operator sees what remained, and
// leaves the non-zero exit to the caller so this can be called from either the catch or the
// teardown `finally` without deciding the exit code twice.
export function reportTeardownFailure(failure, { stderr = process.stderr } = {}) {
  stderr.write(`TEARDOWN FAILURE [${failure.kind}]: ${failure.message}\n`);
  for (const remaining of failure.remaining ?? []) {
    const state = remaining.state ? ` (${remaining.state})` : '';
    stderr.write(`  remained: ${remaining.type} ${remaining.name}${state}\n`);
  }
  if (failure.detail) {
    stderr.write(`  detail:\n${failure.detail}\n`);
  }
}

// ---------------------------------------------------------------------------------------------
// The two HTTP clients — the routed-path split enforced BY CONSTRUCTION (Req 1.9, 1.10, 3.10;
// Property 11: the observation plane cannot be used as an ingress).
//
// Two clients, two disjoint address spaces, and the separation is structural rather than a
// convention a check is trusted to honor:
//
//   * The INGRESS client is built with the Front_Proxy's ingress address ONLY — the sole external
//     door in the split profile — and is the only client any path-exercise or routing check may
//     use. It reads X-Harness-Upstream from each response to attribute which container served the
//     request (design: "Primary observation: a proxy-set response header"). It has no notion of a
//     container address at all, so a check cannot aim it at a container's observation port and
//     bypass the proxy: there is nothing to aim.
//
//   * The OBSERVATION client is built with the two containers' loopback-published observation
//     addresses ONLY, keyed by container name, and serves /health, /livez, /readyz reads and log
//     reads and NOTHING else. It rejects any path outside that set and any container name it was
//     not built with, so it cannot be turned into a second ingress that quietly bypasses the proxy
//     — which is exactly what would undermine Requirement 1.10 and the routing result the
//     observation plane sits beside.
//
// The base URLs are BAKED IN: neither factory accepts a base address argument, so a caller cannot
// point the ingress client at a container's observation port or point the observation client at
// the ingress. `fetch` and (for logs) `exec` are injectable so the construction, the baked-in
// URLs, the header extraction and the guardrails are all unit-exercisable WITHOUT a live server or
// Docker — the actual HTTP calls run against the live topology in task 15.
//
// NG1/NG2/NG6 hold: this adds no application code, no route mount, no HTTP path, edits neither
// container-split script, and performs no credential validation — it is a harness-local HTTP
// client that reads a proxy-set header and reaches loopback health endpoints.
// ---------------------------------------------------------------------------------------------

// The one ingress address the Front_Proxy publishes in the split profile (compose.harness.yml:
// `127.0.0.1:8080:80`). Baked here so the ingress client's base URL matches the compose file's
// published port exactly; a check receives a client already pointed at it and cannot re-point it.
export const INGRESS_BASE_URL = 'http://127.0.0.1:8080';

// The response header the Front_Proxy sets to name the upstream that served each request
// (Caddyfile.split: `header X-Harness-Upstream ...`). One source for the name the ingress client
// extracts and the routing checks compare against, so the client and the proxy config cannot drift.
export const HARNESS_UPSTREAM_HEADER = 'X-Harness-Upstream';

// The two containers' loopback observation addresses, keyed by the compose SERVICE NAME
// (compose.harness.yml: auth-surface `127.0.0.1:3091:3080`, api-container `127.0.0.1:3092:3080`).
// Baked here, one entry per container, so the observation client reaches exactly these two and no
// third address. The keys are the same service names `docker compose logs <service>` takes, so the
// log-read side and the HTTP side name a container identically.
export const OBSERVATION_BASE_URLS = Object.freeze({
  'auth-surface': 'http://127.0.0.1:3091',
  'api-container': 'http://127.0.0.1:3092',
});

// The only paths the observation client may request — the infra-only readiness endpoints, and
// nothing else (Req 1.10, Property 11). Exact match, not prefix: `/livezxyz` is not `/livez`, and
// `/health/../api/config` is not on the list. Making the set exact is what stops the observation
// plane from being turned into a general-purpose ingress. Exported so a test asserts the set and
// the client reads one source.
export const OBSERVATION_ALLOWED_PATHS = Object.freeze(['/health', '/livez', '/readyz']);

// The `docker compose logs` argv prefix, spelled once and shared by the observation client's log
// reads. Both profiles are named for the same reason TEARDOWN_COMPOSE_ARGS names them: a log read
// under either profile resolves the same service. Exported so the client and any test read one
// source rather than restating the flags.
export const OBSERVATION_COMPOSE_BASE_ARGS = Object.freeze([
  'compose',
  '--profile',
  'split',
  '--profile',
  'collapsed',
]);

// Build the ingress client. Baked to INGRESS_BASE_URL — it takes NO base-address argument, so it
// is structurally impossible to aim off-ingress. `fetch` is injected (defaults to the global) so
// the request shape and the X-Harness-Upstream extraction are testable with a fake fetch, and so a
// test can confirm every request lands on the proxy's origin.
//
// `request(pathOrOptions)` performs one request through the proxy and returns
// `{ status, upstream, headers, body, url }` where `upstream` is the value of X-Harness-Upstream
// (or null if the proxy set none — a routing check treats a missing header as an attribution
// failure, not as either container). The path must be a proxy-relative path beginning with `/`; an
// absolute URL is rejected, because accepting one would reintroduce exactly the off-ingress escape
// hatch the baked-in base URL removes.
export function makeIngressClient({ fetch = globalThis.fetch } = {}) {
  if (typeof fetch !== 'function') {
    throw new TypeError('makeIngressClient requires a fetch implementation.');
  }

  const baseUrl = INGRESS_BASE_URL;

  const resolve = (path) => {
    if (typeof path !== 'string' || !path.startsWith('/')) {
      throw new TypeError(
        `Ingress request path must be a proxy-relative path beginning with "/", got ${JSON.stringify(
          path,
        )}. The ingress client is baked to ${baseUrl}; passing an absolute URL would let a check ` +
          'bypass the Front_Proxy, which the by-construction split forbids (Req 1.10).',
      );
    }
    // new URL(path, base) with a leading-slash path always yields base origin + path, and a path
    // like "//evil.example" is rejected above by the single-slash resolve check below.
    if (path.startsWith('//')) {
      throw new TypeError(
        `Ingress request path "${path}" is protocol-relative and would resolve off the proxy ` +
          'origin. Use a single leading slash.',
      );
    }
    return new URL(path, baseUrl);
  };

  return Object.freeze({
    baseUrl,
    async request(pathOrOptions) {
      const { path, ...init } =
        typeof pathOrOptions === 'string' ? { path: pathOrOptions } : pathOrOptions;
      const url = resolve(path);
      const response = await fetch(url.href, init);
      const upstream = response.headers.get(HARNESS_UPSTREAM_HEADER);
      return {
        status: response.status,
        // The attribution the routing checks decide on. Null when the proxy set no header — which a
        // check reports as an attribution failure rather than silently reading as one container.
        upstream: upstream ?? null,
        headers: response.headers,
        body: response,
        url: url.href,
      };
    },
  });
}

// Build the observation client. Baked to OBSERVATION_BASE_URLS — it takes NO base-address argument
// and its two upstreams are fixed at construction, so it cannot be aimed at the ingress or at any
// third address. It serves only OBSERVATION_ALLOWED_PATHS and only the two known containers;
// anything else throws at call time rather than reaching the network. `fetch` and `exec` are
// injected so the readiness reads and the `docker compose logs` reads are both testable without a
// live server or Docker.
//
//   * `ready(container, path)` — GET one readiness endpoint on one container's loopback address.
//     Rejects a path outside OBSERVATION_ALLOWED_PATHS and a container outside the two baked in.
//     Returns `{ status, headers, body, url }`.
//   * `logs(container, { since })` — `docker compose logs <container>` for one container, so a
//     routing check can ask whether the intended container logged the request at all (task 7.6
//     bullet: "Expose log reads through the observation side as docker compose logs per
//     container"). Rejects an unknown container. Returns the captured `{ status, stdout, stderr }`.
//
// There is deliberately no general `request(url)` or `get(path)` that would accept an arbitrary
// address — that absence is the by-construction guarantee. The observation plane is loopback-bound
// harness machinery for health and log reads; making it unusable as an ingress is what keeps it
// from undermining the routing result (Req 1.10, Property 11).
export function makeObservationClient({
  fetch = globalThis.fetch,
  exec,
  composeArgs = OBSERVATION_COMPOSE_BASE_ARGS,
} = {}) {
  if (typeof fetch !== 'function') {
    throw new TypeError('makeObservationClient requires a fetch implementation.');
  }

  const baseUrls = OBSERVATION_BASE_URLS;

  const baseUrlFor = (container) => {
    const base = baseUrls[container];
    if (base === undefined) {
      throw new TypeError(
        `Unknown observation container ${JSON.stringify(container)}. The observation client is ` +
          `baked to exactly: ${Object.keys(baseUrls).join(', ')}. It cannot be aimed at the ` +
          'ingress or any other address (Req 1.10).',
      );
    }
    return base;
  };

  const assertAllowedPath = (path) => {
    if (!OBSERVATION_ALLOWED_PATHS.includes(path)) {
      throw new TypeError(
        `Observation path ${JSON.stringify(path)} is not permitted. The observation client serves ` +
          `only ${OBSERVATION_ALLOWED_PATHS.join(', ')} — it is not an ingress and refuses any ` +
          'other path by construction (Req 1.10, Property 11).',
      );
    }
  };

  return Object.freeze({
    baseUrls,
    async ready(container, path) {
      const base = baseUrlFor(container);
      assertAllowedPath(path);
      const url = new URL(path, base);
      const response = await fetch(url.href, { method: 'GET' });
      return {
        status: response.status,
        headers: response.headers,
        body: response,
        url: url.href,
      };
    },
    async logs(container, { since = null } = {}) {
      // Validate the container name even though the log read does not use the base URL, so the
      // observation client names exactly the two containers on both its sides.
      baseUrlFor(container);
      if (typeof exec !== 'function') {
        throw new TypeError(
          'Observation log reads require an exec implementation (docker). Inject `exec` to read ' +
            'logs; it is deferred to the live topology in task 15.',
        );
      }
      const args = [...composeArgs, 'logs', '--no-color'];
      if (since !== null) {
        args.push('--since', since);
      }
      args.push(container);
      return exec('docker', args);
    },
  });
}

// Run only when invoked directly, so importing the module for its exports (tests, later 7.x
// pieces) has no side effects.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
