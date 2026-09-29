// topology.filter.mjs — the pure decision logic and constants behind this check's Layer B spec (task 14.6).
//
// The exported deciders and constants this check's spec relies on live here, in a non-spec sibling
// module, so the spec file (topology.spec.mjs) can import them and export NOTHING itself. jest.config.mjs's
// testMatch collects only `*.spec.mjs` / `*.test.mjs`, so a `.filter.mjs` is never collected as a
// test — the same shape boot-nowrite.filter.mjs establishes. This is a move, not a rewrite: the logic
// is identical to what previously lived in the spec, and the spec exercises it via the import.
//
// NG1/NG2 hold: this decides over the harness's own artifacts and touches no application code and
// neither container-split script.

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);

// This file's own directory, resolved from `import.meta.url`. The Layer B Jest config loads .mjs as
// native ES modules (jest.config.mjs: no babel-to-CommonJS transform), so `import.meta` is valid here
// under Jest exactly as it is under `node` — the same runtime run.mjs and reporter.mjs resolve their
// directories in. `__dirname` does not exist under native ESM, so it is deliberately not used.
const HERE = path.dirname(fileURLToPath(import.meta.url));

// The harness compose file lives one level up from checks/ (e2e/container-split/compose.harness.yml).
// Bound absolutely so a `docker compose` read observes the same topology regardless of the cwd the
// suite runs from.
const COMPOSE_FILE = path.join(HERE, '..', 'compose.harness.yml');

// The two container services whose image identity and librechat.yaml this task compares. These are
// the compose SERVICE names (compose.harness.yml: `auth-surface`, `api-container`) — the same names
// `docker compose ps` reports under `Service` and `docker compose exec <service>` takes. Named here
// so both checks read one source rather than restating the pair.
export const IMAGE_IDENTITY_SERVICES = Object.freeze(['auth-surface', 'api-container']);

// The path librechat.yaml is mounted to inside every container (compose.harness.yml:
// `target: /app/librechat.yaml`). Read back from here, inside each container, rather than from the
// host source — so the check decides what the container actually sees.
export const CONTAINER_LIBRECHAT_YAML_PATH = '/app/librechat.yaml';

// ---------------------------------------------------------------------------------------------
// The live Docker exec seam.
//
// A single injectable command runner isolates every Docker touch, so the parsing and comparison
// logic below is pure and unit-exercisable without Docker, and task 15 runs the same code against a
// live topology. The default runner spawns real `docker` with argv (execFile, not a shell string),
// so a value interpolated into an argument cannot be re-parsed as a shell token — there is no shell.
// It returns `{ status, stdout, stderr }` the way the runner's own classifiers expect, mapping a
// non-zero exit to a captured status rather than throwing, so a caller decides what a failure means.
// `encoding: 'buffer'` keeps stdout as raw bytes, which the librechat.yaml byte-identity read needs.
// ---------------------------------------------------------------------------------------------
export async function defaultDockerExec(args) {
  try {
    const { stdout, stderr } = await execFileAsync('docker', args, {
      // A digest read is tiny; a yaml read is a few KB. 256 KB is ample and caps a runaway.
      maxBuffer: 256 * 1024,
      encoding: 'buffer',
    });
    return { status: 0, stdout, stderr };
  } catch (error) {
    // execFile rejects on a non-zero exit or a missing binary. Surface both as a captured result so
    // the caller can classify "no topology" (skip) vs. "topology up but the read failed" (fail).
    return {
      status: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? Buffer.alloc(0),
      stderr: error.stderr ?? Buffer.from(String(error.message ?? error)),
    };
  }
}

// Coerce an exec result's stream (Buffer under the default seam, string under a test's fake) to a
// string, so parsers that read text do not depend on the seam's encoding.
function asText(stream) {
  if (Buffer.isBuffer(stream)) {
    return stream.toString('utf8');
  }
  return stream ?? '';
}

// The `docker compose -f <file> ps --format json` argv. Spelled once so the checks and any test read
// one source. `-f COMPOSE_FILE` binds the read to the harness compose file regardless of the cwd the
// suite runs from, so a check run from the repo root and one run from e2e/container-split observe the
// same topology. `-a` so a container that has exited is still listed: this read is the source of the
// container ids the digest read inspects, and a service whose container stopped must read as "present
// but not the same image we can vouch for" rather than silently vanishing.
export const PS_ARGS = Object.freeze([
  'compose',
  '-f',
  COMPOSE_FILE,
  'ps',
  '-a',
  '--format',
  'json',
]);

// The `docker inspect --format {{.Image}} <container>` argv — the actual source of a resolved image
// digest, and the reason this check failed on its first live run.
//
// `docker compose ps --format json` does NOT report one. Its record is compose's ContainerSummary,
// whose image field is `Image` — the image NAME/tag the compose file wrote (here the literal
// `${HARNESS_IMAGE}` value) — and it carries no `ImageID` key at all. So reading `ImageID` off a ps
// entry yielded null for both services on a perfectly healthy topology, and the check reported
// "no resolved image digest (ImageID) for: auth-surface, api-container" about two containers that were
// running the same image. The property held; the observation was looking in a field that does not
// exist.
//
// A container inspect's `.Image` IS the sha256 image id the container was created from — the identity
// Req 1.2 turns on, because two services can name one tag and still resolve to two different images if
// the tag was repointed or rebuilt between the two `up`s. Name equality proves nothing; this does.
export function inspectImageArgs(container) {
  return ['inspect', '--format', '{{.Image}}', container];
}

// The `docker compose -f <file> exec -T <service> cat <path>` argv for reading librechat.yaml back
// from inside one container. `-T` disables TTY allocation so the captured stdout is the file's raw
// bytes with no terminal framing — byte-identity would be meaningless if a pseudo-tty rewrote
// newlines. Built per service so the two reads name the same file inside each container.
export function catYamlArgs(service) {
  return [
    'compose',
    '-f',
    COMPOSE_FILE,
    'exec',
    '-T',
    service,
    'cat',
    CONTAINER_LIBRECHAT_YAML_PATH,
  ];
}

// ---------------------------------------------------------------------------------------------
// Pure parsing and comparison (no Docker) — the half a unit test exercises directly.
// ---------------------------------------------------------------------------------------------

// Parse `docker compose ps --format json` into an array of entries. The format is version-dependent:
// newer `docker compose` emits one JSON object per line (JSONL), older emits a single JSON array.
// Tolerate both, plus an empty string (nothing up — the caller reads that as "no topology"). A line
// that does not parse throws rather than being dropped, because a silently-dropped entry could hide
// a service and let an incomplete comparison read as agreement.
export function parseComposePs(psOutput) {
  const text = asText(psOutput).trim();
  if (text === '') {
    return [];
  }
  if (text.startsWith('[')) {
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) {
      throw new Error('docker compose ps --format json did not yield an array or JSONL.');
    }
    return arr;
  }
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));
}

// The container one `ps` entry names, as an argument `docker inspect` accepts. The id is preferred over
// the name because it is unambiguous; the name is the fallback for a compose version whose ps JSON
// omits `ID`. Returns null when the entry names neither, so the caller can tell "service present but
// unidentifiable" from "service absent".
export function containerRefOf(entry) {
  for (const value of [entry?.ID, entry?.Id, entry?.Name]) {
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
    }
  }
  return null;
}

// Index parsed `ps` entries by compose service name, keeping the container reference to inspect.
// Returns `{ [service]: containerRef|null }` for every entry that names a service. Pure over the
// parsed array.
export function containersByService(entries) {
  const byService = {};
  for (const entry of entries) {
    const service = entry.Service ?? null;
    if (service === null) {
      continue;
    }
    byService[service] = containerRefOf(entry);
  }
  return byService;
}

// The image id a `docker inspect --format {{.Image}}` read returned. `<no value>` is what the Go
// template prints when the field is absent, so it is treated as no digest rather than as one. Returns
// null for anything unusable, which the decider reports as "present but no resolved digest" — distinct
// from an absent service.
export function parseInspectedImageId(stdout) {
  const value = asText(stdout).trim();
  if (value === '' || value === '<no value>') {
    return null;
  }
  return value;
}

// Decide TOPO-IMAGE-13 from the two services' resolved digests. Pure. Returns
// `{ ok, digests, reason? }`: ok only when both services are present, each carries a non-null
// digest, and the two digests are equal. A missing service, a missing digest, or two differing
// digests is a fail with a reason naming what diverged — the observation the check reports.
export function decideImageIdentity(byService, services = IMAGE_IDENTITY_SERVICES) {
  const digests = {};
  for (const service of services) {
    digests[service] = byService[service] ?? null;
  }

  const missing = services.filter((s) => !(s in byService));
  if (missing.length > 0) {
    return {
      ok: false,
      digests,
      reason: `service(s) not present in \`docker compose ps\`: ${missing.join(', ')}.`,
    };
  }

  const noDigest = services.filter((s) => digests[s] === null);
  if (noDigest.length > 0) {
    return {
      ok: false,
      digests,
      reason: `no resolved image digest (ImageID) for: ${noDigest.join(', ')}.`,
    };
  }

  const values = services.map((s) => digests[s]);
  const allEqual = values.every((d) => d === values[0]);
  if (!allEqual) {
    const pairs = services.map((s) => `${s}=${digests[s]}`).join(', ');
    return {
      ok: false,
      digests,
      reason:
        'the two services resolved to DIFFERENT image digests, so they are not the same image: ' +
        `${pairs}. Digest equality — not name equality — is what Req 1.2 requires.`,
    };
  }

  return { ok: true, digests };
}

// The sha256 of a container's librechat.yaml bytes. Byte-identity is decided on the raw bytes cat
// returned, not on a parsed-then-reserialized form, because Req 1.6 says byte-identical: a
// reserialization could normalize whitespace and quoting and call two differing files equal. Hashing
// the exact bytes is the only reading that decides what the requirement states.
export function yamlDigest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// Whether a librechat.yaml's text sets `secureImageLinks: true` (Req 1.6). A minimal top-level-key
// check: the setting on its own line, `true` regardless of surrounding whitespace, not commented
// out. Deliberately not a full YAML parse — the byte-identity half already pins the exact content,
// so this only confirms the one setting the requirement names is present and enabled. Returns a
// boolean; the caller turns a false into the check's failure observation.
export function setsSecureImageLinksTrue(yamlText) {
  // Match a line whose first non-space content is `secureImageLinks:` followed by `true`. The `m`
  // flag anchors `^` per line so a commented `# secureImageLinks: true` (starts with `#`) does not
  // match, and a nested indented key with the same name is not what the top-level setting means —
  // but leading indentation is tolerated because YAML permits it at the document's top mapping.
  return /^[ \t]*secureImageLinks[ \t]*:[ \t]*true[ \t]*(#.*)?$/m.test(asText(yamlText));
}

// Decide TOPO-YAML-15 from the two containers' librechat.yaml bytes. Pure. Returns
// `{ ok, digests, secureImageLinks, reason? }`. ok only when the two byte-digests match AND the
// (identical) content sets secureImageLinks: true. Reports which half failed: a digest mismatch
// (the two containers see different files) or the setting missing/disabled.
export function decideYamlIdentity(bytesByService, services = IMAGE_IDENTITY_SERVICES) {
  const digests = {};
  for (const service of services) {
    digests[service] = yamlDigest(bytesByService[service]);
  }

  const values = services.map((s) => digests[s]);
  const allEqual = values.every((d) => d === values[0]);
  if (!allEqual) {
    const pairs = services.map((s) => `${s}=${digests[s].slice(0, 12)}…`).join(', ');
    return {
      ok: false,
      digests,
      secureImageLinks: null,
      reason:
        'librechat.yaml is NOT byte-identical across the two containers (sha256 differs): ' +
        `${pairs}. The one mounted file must be identical inside both (Req 1.6).`,
    };
  }

  // The content is identical, so read the setting off either container's bytes.
  const yamlText = asText(bytesByService[services[0]]);
  const secureImageLinks = setsSecureImageLinksTrue(yamlText);
  if (!secureImageLinks) {
    return {
      ok: false,
      digests,
      secureImageLinks,
      reason:
        'librechat.yaml is byte-identical across both containers but does NOT set ' +
        '`secureImageLinks: true` (Req 1.6).',
    };
  }

  return { ok: true, digests, secureImageLinks };
}

// ---------------------------------------------------------------------------------------------
// The live reads — thin wrappers over the exec seam that gather what the pure deciders consume.
// ---------------------------------------------------------------------------------------------

// Read the two services' resolved image digests from the live topology, in two steps: `compose ps` to
// learn each service's container, then `docker inspect --format {{.Image}}` on that container to learn
// the image id it was created from. Returns `{ up: boolean, byService }`, where `byService` is
// `{ [service]: digest|null }` — the shape decideImageIdentity consumes.
//
// The two steps are not incidental: ps knows which container belongs to which compose service and
// nothing about image ids; inspect knows the image id and nothing about compose services. Reading the
// digest off ps alone is what produced this check's first live failure — its JSON has no such field.
//
// `up` is false when `docker compose ps` reports no service (empty output) or the invocation itself
// failed to find a project, which is the signal the check reads as "no topology" rather than as a
// falsified property.
export async function readImageDigests({
  exec = defaultDockerExec,
  services = IMAGE_IDENTITY_SERVICES,
} = {}) {
  const result = await exec([...PS_ARGS]);
  // A non-zero exit with no stdout means compose could not read a project (no topology up, or docker
  // absent) — treat as "not up" so the check skips. A non-zero exit WITH stdout is unusual; parse it.
  if (result.status !== 0 && asText(result.stdout).trim() === '') {
    return { up: false, byService: {} };
  }
  const entries = parseComposePs(result.stdout);
  if (entries.length === 0) {
    return { up: false, byService: {} };
  }
  const containers = containersByService(entries);
  const byService = {};
  for (const service of services) {
    if (!(service in containers)) {
      // Absent from ps: leave it out of the map so decideImageIdentity reports it as a missing service
      // rather than as a present one with no digest.
      continue;
    }
    const container = containers[service];
    if (container === null) {
      byService[service] = null;
      continue;
    }
    const inspected = await exec(inspectImageArgs(container));
    byService[service] = inspected.status === 0 ? parseInspectedImageId(inspected.stdout) : null;
  }
  return { up: true, byService };
}

// Read librechat.yaml back from inside one container. Returns `{ up, bytes }`. `up` is false when
// the exec failed because the container is not running (nothing to read) — the skip signal. A
// running container that returns the file yields its raw bytes as a Buffer for byte-identity.
export async function readContainerYaml(service, { exec = defaultDockerExec } = {}) {
  const result = await exec(catYamlArgs(service));
  if (result.status !== 0) {
    return { up: false, bytes: null };
  }
  // stdout may arrive as a Buffer (default seam) or a string (a test's fake); normalize to a Buffer
  // so the digest is over exact bytes regardless of the seam's encoding.
  const bytes = Buffer.isBuffer(result.stdout)
    ? result.stdout
    : Buffer.from(result.stdout ?? '', 'utf8');
  return { up: true, bytes };
}

// Read librechat.yaml from both containers. Returns `{ up, bytesByService, downServices }`. `up` is
// false when ANY target container is not running, because a byte-identity comparison needs both
// files present — a comparison against one container is meaningless. The check skips in that case.
export async function readBothContainerYaml({
  exec = defaultDockerExec,
  services = IMAGE_IDENTITY_SERVICES,
} = {}) {
  const bytesByService = {};
  const downServices = [];
  for (const service of services) {
    const read = await readContainerYaml(service, { exec });
    if (!read.up) {
      downServices.push(service);
    } else {
      bytesByService[service] = read.bytes;
    }
  }
  return { up: downServices.length === 0, bytesByService, downServices };
}
