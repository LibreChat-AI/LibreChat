// collapse.filter.mjs — the pure decision logic and constants behind this check's Layer B spec (task 14.6).
//
// The exported deciders and constants this check's spec relies on live here, in a non-spec sibling
// module, so the spec file (collapse.spec.mjs) can import them and export NOTHING itself. jest.config.mjs's
// testMatch collects only `*.spec.mjs` / `*.test.mjs`, so a `.filter.mjs` is never collected as a
// test — the same shape boot-nowrite.filter.mjs establishes. This is a move, not a rewrite: the logic
// is identical to what previously lived in the spec, and the spec exercises it via the import.
//
// NG1/NG2 hold: this decides over the harness's own artifacts and touches no application code and
// neither container-split script. NG9 holds: nothing here invokes `git` or reads `.git` — Req 4.2 is a
// STRUCTURAL claim about how the collapse is expressed, and a working-tree read answers a question
// about the operator's workspace instead.

import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { PROFILES } from '../run.mjs';

// This file's own directory, resolved from `import.meta.url`. The Layer B Jest config loads .mjs as
// native ES modules (jest.config.mjs: no babel-to-CommonJS transform), so `import.meta` is valid here
// under Jest exactly as it is under `node`. `__dirname` does not exist under native ESM, so it is
// deliberately not used.
const HERE = path.dirname(fileURLToPath(import.meta.url));

// The harness artifacts this check reads statically, bound absolutely from HERE so a read observes
// the committed files regardless of the cwd the suite runs from. checks/ sits one level below
// e2e/container-split/.
export const COMPOSE_FILE = path.join(HERE, '..', 'compose.harness.yml');
export const CADDYFILE_COLLAPSED = path.join(HERE, '..', 'Caddyfile.collapsed');

// The check id this spec decides, named once and prefixed onto every title so reporter.mjs maps each
// Jest result onto the PARITY-COLLAPSE-29 record.
export const CHECK_ID = 'PARITY-COLLAPSE-29';

// The single container the collapsed topology runs. The collapse reuses the split's `auth-surface`
// service (compose.harness.yml), and Caddyfile.collapsed routes every path to it — so this is both
// the compose SERVICE name the collapsed profile keeps and the X-Harness-Upstream value the collapsed
// proxy stamps. Named here so the routing and attribution assertions read one source.
export const COLLAPSED_UPSTREAM = 'auth-surface';

// The profile name the collapse runs under, and the container service the split adds that the
// collapse must NOT keep as a second container. compose.harness.yml gives the API_Container
// `profiles: ["split"]` only, so the collapsed profile resolves to the single reused auth-surface.
export const COLLAPSED_PROFILE = 'collapsed';
export const SPLIT_ONLY_CONTAINER_SERVICE = 'api-container';

// ---------------------------------------------------------------------------------------------
// Pure deciders over the committed artifacts — the whole check, exercisable without Docker and
// without a topology. Each returns `{ ok, reason? }`; a false carries the observation the check
// reports.
//
// There is no live half. Req 4.2 asks whether the collapse is EXPRESSIBLE as an env-and-config
// overlay, and that is settled by reading compose.harness.yml and the Caddyfiles: a profile of the
// same compose file, reusing the same service definition and the same ${HARNESS_IMAGE} reference with
// a different Caddyfile mounted, cannot require a source edit, and services that declare `image:`
// rather than `build:` have no rebuild step in the collapse path at all.
// ---------------------------------------------------------------------------------------------

// Whether the supported-profile list carries the collapsed profile. The collapse is a profile of the
// one compose file, not a separate topology; a `collapsed` profile absent from PROFILES would mean
// run.mjs cannot bring it up at all, which is the first thing that must hold for the property.
export function decideProfileSupported(profiles = PROFILES) {
  if (!Array.isArray(profiles) || !profiles.includes(COLLAPSED_PROFILE)) {
    return {
      ok: false,
      reason:
        `PROFILES does not include ${JSON.stringify(COLLAPSED_PROFILE)} (got ` +
        `${JSON.stringify(profiles)}). The collapse is a profile of the one compose file; without ` +
        'it run.mjs cannot bring the collapsed topology up, so single-container parity cannot be ' +
        'observed (Req 4.2).',
    };
  }
  return { ok: true };
}

// Whether Caddyfile.collapsed expresses ONE unconditional upstream with NO allowlist, still stamping
// X-Harness-Upstream with the collapsed container's name. Pure over the Caddyfile text. This is the
// routing half of "the collapse needed nothing else": the split's allowlist (an ordered `route` with
// the Auth_Surface_Allowlist first) is GONE, replaced by a single `handle` that reverse-proxies every
// path to the one container — and the header is set in that same block so attribution reports in the
// split's shape.
export function decideCollapsedRouting(caddyText) {
  const text = typeof caddyText === 'string' ? caddyText : '';

  // No allowlist: the split partitions with an ordered `route { … }`. Its absence is what makes the
  // collapse "one unconditional upstream" rather than a second partition that could drift. A `route`
  // directive block would reintroduce ordered matching the collapse must not have.
  if (/^\s*route\b/m.test(text)) {
    return {
      ok: false,
      reason:
        'Caddyfile.collapsed contains a `route` block; the collapsed topology must route every ' +
        'path to the one container with NO allowlist (Caddyfile.collapsed). A partition here would ' +
        'make the collapse a second routing topology rather than an env-and-config overlay (Req 4.2).',
    };
  }

  // One unconditional upstream: a reverse_proxy to the single container. The exercised paths all
  // resolve to it, so the upstream address must name the reused auth-surface service.
  const proxiesToCollapsed = new RegExp(`reverse_proxy\\s+${COLLAPSED_UPSTREAM}:\\d+`).test(text);
  if (!proxiesToCollapsed) {
    return {
      ok: false,
      reason:
        `Caddyfile.collapsed does not reverse_proxy to the single ${JSON.stringify(
          COLLAPSED_UPSTREAM,
        )} upstream. The collapse runs one container (the reused auth-surface service), so every ` +
        'path must resolve to it (Req 4.2).',
    };
  }

  // Still stamps X-Harness-Upstream with the collapsed container, so the collapsed run reports
  // attribution in the SAME shape the split run does — the parity checks read one header on both
  // topologies rather than a header on one and its absence on the other (Caddyfile.collapsed header).
  const stampsHeader = new RegExp(`header\\s+X-Harness-Upstream\\s+"?${COLLAPSED_UPSTREAM}"?`).test(
    text,
  );
  if (!stampsHeader) {
    return {
      ok: false,
      reason:
        `Caddyfile.collapsed does not set \`header X-Harness-Upstream "${COLLAPSED_UPSTREAM}"\`; ` +
        'the collapsed run must report attribution in the same shape as the split run so the ' +
        'parity checks read one header on both topologies (Caddyfile.collapsed).',
    };
  }

  return { ok: true };
}

// Whether compose.harness.yml expresses the collapse as a REUSE of the split's own machinery: the
// `auth-surface` service is in the collapsed profile, it derives `image` from the shared
// ${HARNESS_IMAGE} reference (via the container-common anchor, so the two containers cannot drift
// into different images), and NO third container service exists for the collapse — the API_Container
// is split-only. Pure over the compose text.
//
// This is a deliberately lightweight textual read rather than a YAML parse: it confirms the four
// structural facts the property turns on (shared image reference, auth-surface in the collapsed
// profile, api-container split-only, no `build:` anywhere) without depending on a YAML library the
// Layer B lane does not otherwise carry. Those four ARE the claim: they are what makes "same image,
// same service definition, no rebuild" a property of the compose file rather than an assertion about
// one particular pair of invocations.
export function decideCollapsedReuse(composeText) {
  const text = typeof composeText === 'string' ? composeText : '';

  // The shared image reference is written ONCE (the container-common anchor: `image: ${HARNESS_IMAGE}`)
  // and inherited by both container services, so a collapse cannot name a different image. Assert the
  // shared reference is present and no per-service `image:` line names a different value for a
  // container. (mongo/redis/meilisearch/caddy name their own pinned images; those are infra, not the
  // application container, and are not ${HARNESS_IMAGE}.)
  if (!/image:\s*\$\{HARNESS_IMAGE\}/.test(text)) {
    return {
      ok: false,
      reason:
        'compose.harness.yml does not reference the shared ${HARNESS_IMAGE} for the container ' +
        'services. Same image is what "no rebuild" turns on; the collapse must reuse the one ' +
        'image reference rather than name its own (Req 4.2 / PARITY-COLLAPSE-29).',
    };
  }

  // The reused service is in the collapsed profile. It is named twice (a service key and a
  // container_name); anchor on the service key line carrying the collapsed profile nearby is fragile,
  // so instead assert the auth-surface service block declares the collapsed profile. The block runs
  // from its `auth-surface:` key to the next top-level service key; a `profiles:` line naming
  // "collapsed" must appear within it.
  const authBlock = sliceServiceBlock(text, 'auth-surface');
  if (authBlock === null || !/profiles:\s*\[[^\]]*"collapsed"[^\]]*\]/.test(authBlock)) {
    return {
      ok: false,
      reason:
        'compose.harness.yml does not place the reused `auth-surface` service in the "collapsed" ' +
        'profile. The collapse must REUSE the same service definition rather than add a third ' +
        'service that could drift (Req 4.2 / PARITY-COLLAPSE-29).',
    };
  }

  // No third container service: the API_Container is split-only, so the collapsed profile resolves to
  // the single reused container. A collapsed (or shared) profile on api-container would make the
  // collapse two containers, defeating single-container parity.
  const apiBlock = sliceServiceBlock(text, SPLIT_ONLY_CONTAINER_SERVICE);
  if (apiBlock === null) {
    return {
      ok: false,
      reason:
        `compose.harness.yml has no ${JSON.stringify(SPLIT_ONLY_CONTAINER_SERVICE)} service to ` +
        'confirm the collapse keeps a single container.',
    };
  }
  if (/profiles:\s*\[[^\]]*"collapsed"[^\]]*\]/.test(apiBlock)) {
    return {
      ok: false,
      reason:
        `compose.harness.yml places ${JSON.stringify(SPLIT_ONLY_CONTAINER_SERVICE)} in the ` +
        '"collapsed" profile; the collapsed topology must be a SINGLE container (the reused ' +
        'auth-surface). A second application container defeats single-container parity (Req 4.2).',
    };
  }

  // No build step exists in the collapse path. Every service names a pre-existing `image:`; a `build:`
  // stanza anywhere in the compose file would put an image build inside `docker compose up`, which is
  // precisely the rebuild 4.2 forbids. This is the assertion that replaces the struck cross-run digest
  // comparison: a compose file with no `build:` cannot rebuild, whoever runs it and in whatever order.
  if (/^\s*build:/m.test(text)) {
    return {
      ok: false,
      reason:
        'compose.harness.yml carries a `build:` stanza; the collapse must be an env-and-config ' +
        'overlay on an already-resolved image, so every service names a pre-existing `image:`. A ' +
        'build inside `docker compose up` is the rebuild Req 4.2 forbids (PARITY-COLLAPSE-29).',
    };
  }

  return { ok: true };
}

// Extract one service's YAML block from the compose text: from the service's two-space-indented key
// line to the next two-space-indented key (or the next top-level key, or EOF). Returns null when the
// service is absent. A blunt indentation slice, adequate for the presence-of-a-line assertions above
// and free of a YAML dependency; it is not a general YAML reader.
export function sliceServiceBlock(composeText, service) {
  const text = typeof composeText === 'string' ? composeText : '';
  const lines = text.split('\n');
  const keyRe = new RegExp(`^ {2}${service}:\\s*$`);
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (keyRe.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) {
    return null;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    // A new service key is two-space indented and ends in a colon; a top-level key (e.g. `networks:`)
    // has zero indent. Either ends this block.
    if (/^ {2}\S.*:\s*$/.test(line) || /^\S.*:\s*$/.test(line)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

// There is deliberately nothing below this line. An earlier revision carried a live half here — an
// injectable exec seam over `docker`/`git`, a `decideDigestParity` comparing the two runs' resolved
// image digests, and a `decideCleanWorkingTree` over `git status --porcelain`. Both deciders and the
// seam are removed and must not return (NG9). The porcelain read measured the operator's workspace
// rather than the system: it failed on any untracked scratch file, could not run without a `.git`, and
// passed a dirty tree whose edits never reached a container, because application source enters a
// container only through the image. The digest comparison across two separate invocations asserted
// only that nobody rebuilt between two commands. What 4.2 claims is decided above, by reading the
// artifacts.
