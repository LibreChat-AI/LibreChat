// env-diff.filter.mjs — the pure decision logic and constants behind this check's Layer B spec (task 14.6).
//
// The exported deciders and constants this check's spec relies on live here, in a non-spec sibling
// module, so the spec file (env-diff.spec.mjs) can import them and export NOTHING itself. jest.config.mjs's
// testMatch collects only `*.spec.mjs` / `*.test.mjs`, so a `.filter.mjs` is never collected as a
// test — the same shape boot-nowrite.filter.mjs establishes. This is a move, not a rewrite: the logic
// is identical to what previously lived in the spec, and the spec exercises it via the import.
//
// NG1/NG2 hold: this decides over the harness's own artifacts and touches no application code and
// neither container-split script.

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);

// This file's own directory, resolved from `import.meta.url`. The Layer B Jest config loads .mjs as
// native ES modules (jest.config.mjs: no babel-to-CommonJS transform), so `import.meta` is valid here
// under Jest exactly as it is under `node`. `__dirname` does not exist under native ESM, so it is
// deliberately not used.
const HERE = path.dirname(fileURLToPath(import.meta.url));

// The harness compose file lives one level up from checks/ (e2e/container-split/compose.harness.yml).
// Bound absolutely so a `docker compose config` read observes the same topology regardless of the cwd
// the suite runs from.
const COMPOSE_FILE = path.join(HERE, '..', 'compose.harness.yml');

// The env matrix — the AUTHORITY on the identical/differ partition. Resolved relative to this file's
// directory (../../../scripts/container-split/env-matrix.md from e2e/container-split/checks/), so the
// check reads the one committed matrix rather than a copy. Task 9.2 / TOPO-ENV-14 explicitly want the
// matrix to be the source; parsing it here is what makes a change there flow into the check.
export const ENV_MATRIX_PATH = path.join(
  HERE,
  '..',
  '..',
  '..',
  'scripts',
  'container-split',
  'env-matrix.md',
);

// The two compose service names whose resolved environments this check compares. These are the
// service keys in compose.harness.yml; the api-container is absent under the collapsed profile, which
// the read tolerates. Named once so the deciders and the live read share one source.
export const ENV_DIFF_SERVICES = Object.freeze(['auth-surface', 'api-container']);

// ---------------------------------------------------------------------------------------------
// Bridging the matrix's prose shorthand to concrete environment keys.
//
// A few matrix rows name a FAMILY or a shorthand rather than one variable. Expanding them is the only
// place this check restates anything from the matrix, so the expansion is kept small, documented per
// entry with the matrix row it stands for, and ASSERTED against the matrix text (below) so it cannot
// drift out of step. A row that names no environment variable — the librechat.yaml `secureImageLinks`
// row, which is TOPO-YAML-15's — is dropped by the parser rather than expanded.
// ---------------------------------------------------------------------------------------------

// Matrix-cell text -> the concrete env keys it denotes. Only rows whose `Setting` cell is not already
// a bare env key need an entry; a row like `CREDS_KEY` denotes exactly itself and needs none.
export const MATRIX_KEY_EXPANSIONS = Object.freeze({
  // env-matrix.md, "OPENID_ROLE_SYNC_* (all six)" — the row names the six explicitly in its prose.
  'OPENID_ROLE_SYNC_* (all six)': [
    'OPENID_ROLE_SYNC_ENABLED',
    'OPENID_ROLE_SYNC_API_ENABLED',
    'OPENID_ROLE_SYNC_SOURCE',
    'OPENID_ROLE_SYNC_CLAIM',
    'OPENID_ROLE_SYNC_ROLE_PRIORITY',
    'OPENID_ROLE_SYNC_FALLBACK_ROLE',
  ],
  // env-matrix.md, "Redis block (see below)" — USE_REDIS, REDIS_URI and the keyspace prefix. The
  // prefix is one of two spellings; both are covered so either resolves as identical.
  'Redis block (see below)': ['USE_REDIS', 'REDIS_URI', 'REDIS_KEY_PREFIX', 'REDIS_KEY_PREFIX_VAR'],
});

// Matrix `Setting` cells whose row is NOT an environment variable and must be dropped from the
// partition — the check reads the environment, not librechat.yaml. Each maps to the check that owns
// it, recorded so a reader knows it is deliberately excluded rather than forgotten.
export const NON_ENV_MATRIX_SETTINGS = Object.freeze({
  'secureImageLinks (`librechat.yaml`)': 'TOPO-YAML-15 owns librechat.yaml (Req 1.6)',
});

// MEILI_HOST and MEILI_MASTER_KEY share one matrix row (`MEILI_HOST, MEILI_MASTER_KEY`). Named here so
// the absent-on-auth-surface assertion (Req 1.4, 1.8) reads one source.
export const MEILI_KEYS = Object.freeze(['MEILI_HOST', 'MEILI_MASTER_KEY']);

// ---------------------------------------------------------------------------------------------
// Parsing env-matrix.md — the authority read (pure over the matrix text).
// ---------------------------------------------------------------------------------------------

// Strip a markdown table cell of surrounding whitespace and inline `code` backticks, leaving the bare
// setting name or compare verdict. `MONGO_URI` and `` `MONGO_URI (authSource=admin)` `` both reduce to
// their leading token; the compare column reduces to `identical`, `differs` or `may differ`.
function cleanCell(cell) {
  return cell.replace(/`/g, '').trim();
}

// The Setting cell can carry a qualifier after the bare key — `MONGO_URI (authSource=admin)`,
// `secureImageLinks (librechat.yaml)`. Reduce it to the token this check keys on: for an env row that
// is the leading identifier; for a non-env row it is matched whole against NON_ENV_MATRIX_SETTINGS.
// Returns the cleaned cell verbatim so the caller can consult both the expansion and the drop tables.
function settingCellKey(settingCell) {
  return cleanCell(settingCell);
}

// Parse every `| Setting | … | Compare |` row out of the matrix's markdown tables. Returns an array of
// `{ setting, compare }` for each data row, skipping the header row and the `---` separator. Pure over
// the text. A malformed row (fewer than the Setting and Compare columns) is skipped rather than
// throwing, because the matrix carries prose tables elsewhere that are not the partition; only rows
// whose last column is a recognized compare verdict are kept (below, in buildPartition).
export function parseMatrixRows(matrixText) {
  const rows = [];
  for (const rawLine of matrixText.split('\n')) {
    const line = rawLine.trim();
    // A table data row starts and ends with a pipe and carries at least the Setting and Compare cells.
    if (!line.startsWith('|') || !line.endsWith('|')) {
      continue;
    }
    // Split on unescaped pipes and drop the empty leading/trailing cells the outer pipes produce.
    const cells = line
      .slice(1, -1)
      .split('|')
      .map((cell) => cell.trim());
    if (cells.length < 2) {
      continue;
    }
    const setting = cells[0];
    const compare = cleanCell(cells[cells.length - 1]).toLowerCase();
    // Skip the header (`Setting`) and the `---`/`:---` separator row.
    if (/^-+$/.test(setting.replace(/[:\s]/g, '')) || setting.toLowerCase() === 'setting') {
      continue;
    }
    rows.push({ setting, compare });
  }
  return rows;
}

// The compare verdicts the matrix uses. `identical` places a row in the identical set; `differs` and
// `may differ` place it in the differ set (both are accepted variants — an env-values-bucket
// difference). Any other last-column value means the row is not a partition row (a prose table that
// happens to be pipe-delimited) and is dropped.
const COMPARE_IDENTICAL = 'identical';
const COMPARE_DIFFERS = new Set(['differs', 'may differ']);

// Build the identical/differ partition from the parsed matrix rows. Returns
// `{ identical: string[], differ: string[], dropped: {setting, reason}[] }`, each list a set of
// concrete ENV KEYS (families expanded, non-env rows dropped). Pure. This is the single derivation of
// the partition the decider consumes — the matrix is read once, here, and nowhere restated.
export function buildPartition(rows) {
  const identical = new Set();
  const differ = new Set();
  const dropped = [];

  for (const { setting, compare } of rows) {
    const key = settingCellKey(setting);

    // Drop rows that name no environment variable (librechat.yaml settings owned by another check).
    if (key in NON_ENV_MATRIX_SETTINGS) {
      dropped.push({ setting: key, reason: NON_ENV_MATRIX_SETTINGS[key] });
      continue;
    }

    // Only the recognized compare verdicts define the partition; anything else is not a partition row.
    let target = null;
    if (compare === COMPARE_IDENTICAL) {
      target = identical;
    } else if (COMPARE_DIFFERS.has(compare)) {
      target = differ;
    }
    if (target === null) {
      continue;
    }

    // Expand a family shorthand into its concrete keys; a plain cell yields every env-style token it
    // names — a Setting cell can list two (`JWT_SECRET, JWT_REFRESH_SECRET`; `MEILI_HOST,
    // MEILI_MASTER_KEY`), so all are added, not just the first.
    const keys = MATRIX_KEY_EXPANSIONS[key] ?? envKeysIn(key);
    for (const concrete of keys) {
      target.add(concrete);
    }
  }

  return {
    identical: Object.freeze([...identical].sort()),
    differ: Object.freeze([...differ].sort()),
    dropped: Object.freeze(dropped),
  };
}

// Every ENV-style identifier a cleaned setting cell names. An env var is UPPERCASE letters, digits and
// underscores, so a `MONGO_URI (authSource=admin)` cell yields only `MONGO_URI` (the lowercase
// `authSource`/`admin` qualifier is not a match), and a `JWT_SECRET, JWT_REFRESH_SECRET` cell yields
// both. Returns [] for a cell with no identifier token, so a non-key row contributes nothing rather
// than a bogus key. A leading uppercase letter anchors each token so a bare `_FOO` is not matched.
export function envKeysIn(cleanedCell) {
  return cleanedCell.match(/\b[A-Z][A-Z0-9_]*\b/g) ?? [];
}

// Read and parse the committed env matrix into the partition. Kept as its own function so a test can
// exercise the real committed matrix (not a synthetic one) and assert the concrete partition it
// yields matches what the design's prose names.
export function loadMatrixPartition({ matrixPath = ENV_MATRIX_PATH } = {}) {
  const text = readFileSync(matrixPath, 'utf8');
  return buildPartition(parseMatrixRows(text));
}

// ---------------------------------------------------------------------------------------------
// The partition decider (pure over two resolved-env maps and a partition).
// ---------------------------------------------------------------------------------------------

// Whether a resolved-env map holds a key with a defined value. Presence — not truthiness — is the
// test the matrix specifies for the identical set ("present on one container and absent on the
// other" is a difference). An empty-string value is PRESENT.
function isPresent(env, key) {
  return env[key] !== undefined && env[key] !== null;
}

// Decide TOPO-ENV-14 from the two containers' resolved environments and the matrix partition. Pure.
// Returns `{ ok, findings, reason? }`. A finding is one of:
//
//   * identical-mismatch — a key the matrix marks `identical` whose value differs between the two
//     containers, or which is present on one and absent on the other. This is the matrix's own
//     definition of a violated `identical` row.
//   * unaccounted-difference — a key that differs between the two containers and is in NEITHER the
//     identical set nor the differ set nor the credential bucket (MONGO_URI). This is the matrix's
//     "a difference that fits none of the three buckets is a defect."
//
// A difference on a differ-set key, or on MONGO_URI (the credential bucket), is NOT a finding: it is
// an accepted variant. `ok` is true only when there are no findings.
export function decideEnvDiff(authEnv, apiEnv, partition) {
  const findings = [];
  const identicalSet = new Set(partition.identical);
  const differSet = new Set(partition.differ);

  // 1. Every identical-set key must be identical by presence AND by value.
  for (const key of partition.identical) {
    const inAuth = isPresent(authEnv, key);
    const inApi = isPresent(apiEnv, key);
    if (inAuth !== inApi) {
      findings.push({
        kind: 'identical-mismatch',
        key,
        detail: `matrix marks \`${key}\` identical, but it is ${
          inAuth
            ? 'present on auth-surface and absent on api-container'
            : 'absent on auth-surface and present on api-container'
        } — presence, not value, is the test.`,
      });
      continue;
    }
    if (inAuth && inApi && authEnv[key] !== apiEnv[key]) {
      findings.push({
        kind: 'identical-mismatch',
        key,
        detail: `matrix marks \`${key}\` identical, but its resolved value differs: auth-surface=${JSON.stringify(
          authEnv[key],
        )}, api-container=${JSON.stringify(apiEnv[key])}.`,
      });
    }
  }

  // 2. Every key that DIFFERS between the two containers must be accounted for by one of the buckets:
  //    the env-values bucket (the matrix differ set) or the credential bucket (MONGO_URI). A differing
  //    key in neither — including one the matrix names nowhere — is an unaccounted difference.
  const allKeys = new Set([...Object.keys(authEnv), ...Object.keys(apiEnv)]);
  for (const key of allKeys) {
    const inAuth = isPresent(authEnv, key);
    const inApi = isPresent(apiEnv, key);
    const differs = inAuth !== inApi || (inAuth && inApi && authEnv[key] !== apiEnv[key]);
    if (!differs) {
      continue;
    }
    // Accounted for: the credential bucket, or the matrix's differ set (env-values bucket).
    if (key === 'MONGO_URI' || differSet.has(key)) {
      continue;
    }
    // An identical-set key that differs is already reported as an identical-mismatch above; do not
    // double-count it here as unaccounted.
    if (identicalSet.has(key)) {
      continue;
    }
    findings.push({
      kind: 'unaccounted-difference',
      key,
      detail: `\`${key}\` differs between the containers but the matrix names it in neither the identical set nor the differ set, and it is not the MongoDB credential — a difference that fits none of the three buckets is a defect (env-matrix.md).`,
    });
  }

  if (findings.length > 0) {
    return {
      ok: false,
      findings,
      reason: findings.map((f) => `[${f.kind}] ${f.detail}`).join(' '),
    };
  }
  return { ok: true, findings: [] };
}

// Decide the MEILI absence rule (Req 1.4, 1.8): MEILI_HOST and MEILI_MASTER_KEY must be ABSENT on the
// Auth_Surface — not present-and-empty — because their presence is what attaches the search plugin.
// Pure over the auth-surface resolved env. Returns `{ ok, reason? }`.
export function decideMeiliAbsentOnAuthSurface(authEnv) {
  const present = MEILI_KEYS.filter((key) => isPresent(authEnv, key));
  if (present.length > 0) {
    return {
      ok: false,
      reason: `${present.join(
        ' and ',
      )} must be ABSENT on the auth-surface (present-and-empty still attaches the search plugin), but resolved present: ${present
        .map((k) => `${k}=${JSON.stringify(authEnv[k])}`)
        .join(', ')} (Req 1.4, 1.8; env-matrix.md).`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// The live resolved-environment read — thin wrapper over `docker compose config`.
// ---------------------------------------------------------------------------------------------

// The `docker compose -f <file> --profile <profile> config --format json` argv. `config` resolves the
// compose file's ${...} interpolation from the per-run env files run.mjs writes, so what it reports is
// the environment the container actually receives — the "resolved container environment" the task
// calls for. Built once so the read and any test share one shape.
export function configArgs(profile) {
  return ['compose', '-f', COMPOSE_FILE, '--profile', profile, 'config', '--format', 'json'];
}

// The default Docker exec seam: spawn real `docker` with argv (execFile, not a shell string), so a
// value interpolated into an argument cannot be re-parsed as a shell token — there is no shell. Injected
// so the pure deciders above are exercised without Docker and task 15 runs the same code live.
export async function defaultDockerExec(args) {
  const { stdout } = await execFileAsync('docker', args, {
    // The resolved compose config for this project is a few tens of KB; 16 MB is ample headroom.
    maxBuffer: 16 * 1024 * 1024,
    encoding: 'utf8',
  });
  return stdout;
}

// Read each container service's resolved `environment` map out of `docker compose config`. Returns
// `{ [service]: envMap }` for each service present in the resolved config; a service absent (the
// api-container under the collapsed profile) is simply absent from the result. `docker compose config`
// normalizes `environment:` to an object map, which is the shape the deciders consume directly.
export async function readResolvedEnvironments({
  exec = defaultDockerExec,
  profile = process.env.HARNESS_PROFILE ?? 'split',
  services = ENV_DIFF_SERVICES,
} = {}) {
  const stdout = await exec(configArgs(profile));
  const config = JSON.parse(stdout);
  const defs = config.services ?? {};
  const result = {};
  for (const service of services) {
    const def = defs[service];
    if (def === undefined) {
      continue;
    }
    result[service] = def.environment ?? {};
  }
  return result;
}
