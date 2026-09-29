// checks/collapse.spec.mjs — PARITY-COLLAPSE-29, the single-container parity check (task 12.1).
//
// Property 4, single-container parity (parent P12, Req 4.2). The claim: collapsing the two-container
// split back into one container is an ENV-AND-CONFIG OVERLAY on the SAME image and the SAME service
// definition — not a third topology, not a source change, not a rebuild. The collapse uses exactly
// the three levers env-matrix.md names (environment values, the supplied credential, and the routing
// rules) and NOTHING else. This check decides that "nothing else" (design.md: "Single-Container
// Parity"; Check Catalog row `PARITY-COLLAPSE-29`).
//
// == What this check observes ==
// The committed artifacts, statically, with no topology and no Docker. The collapsed configuration is
// expressed as a reuse of the split's own machinery rather than a divergent copy: `PROFILES` carries
// 'collapsed' (run.mjs), Caddyfile.collapsed routes every path to the ONE container with no allowlist
// while still emitting X-Harness-Upstream (so the collapsed run reports attribution in the same shape
// the split run does), and compose.harness.yml's collapsed profile reuses the SAME `auth-surface`
// service and the SAME ${HARNESS_IMAGE} reference, adds no third container service, and carries no
// `build:` stanza. That is what makes "same image, same service definition, no rebuild" a property of
// the compose file rather than an assertion about one pair of invocations.
//
// == Why there is no live half (NG9) ==
// Req 4.2 is a STRUCTURAL claim, decidable by reading the artifacts. If the collapsed topology is a
// profile of the same compose file, reusing the same service definition and the same ${HARNESS_IMAGE}
// reference with a different Caddyfile mounted and an env overlay applied, then collapsing CANNOT
// require a source edit; and services that declare `image:` rather than `build:` have no rebuild step
// in the collapse path at all.
//
// An earlier revision decided the two halves empirically instead, and both observations tested
// operator discipline rather than the system. A `git status --porcelain` read measures the operator's
// workspace: it fails on any untracked scratch file, cannot run where there is no `.git`, and passes a
// dirty tree whose changes never reach a container — application source enters a container only
// through the image, so an unbuilt edit is irrelevant to the claim and flagging it is a false
// positive. And comparing the two runs' resolved image digests across two separate invocations asserts
// only that nobody rebuilt between two commands. Both are dropped, not replaced, and NG9 forbids their
// return: no check may invoke `git` or read `.git`.
//
// Task 15.5 still runs the collapsed profile, but for the different question these reads cannot answer
// — whether the profile they describe actually comes up and serves through the ingress. It decides
// nothing about this check's record.
//
// == The check-record tag convention ==
// Each test's title STARTS with its catalog id in brackets — `[PARITY-COLLAPSE-29] …` — which is what
// reporter.mjs parses to map the Jest result onto the check record (check-catalog.mjs owns the
// id → {layer, requirements, property} table: PARITY-COLLAPSE-29 → Layer B, Req 4.2, property P12).
//
// NG1/NG2 hold: this observes the harness's own compose file and Caddyfile.collapsed. It adds no
// application code, no route mount and no HTTP path (NG1), and edits neither container-split script
// (NG2). NG6 holds: no credential validation happens here — it reads two config files.

import { readFileSync } from 'node:fs';

// The exported constants and pure deciders live in collapse.filter.mjs (a non-spec sibling) so this
// spec file exports nothing (task 14.6). The spec imports what its checks exercise.
import {
  COMPOSE_FILE,
  CADDYFILE_COLLAPSED,
  CHECK_ID,
  decideProfileSupported,
  decideCollapsedRouting,
  decideCollapsedReuse,
  sliceServiceBlock,
} from './collapse.filter.mjs';

// ---------------------------------------------------------------------------------------------
// The checks. Every one runs now, on every run: they read committed files, so there is no gate and no
// topology to wait for. Every title starts with [PARITY-COLLAPSE-29] so reporter.mjs maps the result
// onto the check record.
// ---------------------------------------------------------------------------------------------

describe(`${CHECK_ID}: the collapse is an env-and-config overlay on one image and one service`, () => {
  test(`[${CHECK_ID}] PROFILES supports the collapsed profile`, () => {
    const decision = decideProfileSupported();
    expect(decision.ok ? '' : decision.reason).toBe('');
  });

  test(`[${CHECK_ID}] Caddyfile.collapsed routes every path to the one container with no allowlist and stamps X-Harness-Upstream`, () => {
    const caddyText = readFileSync(CADDYFILE_COLLAPSED, 'utf8');
    const decision = decideCollapsedRouting(caddyText);
    expect(decision.ok ? '' : decision.reason).toBe('');
  });

  test(`[${CHECK_ID}] compose reuses the same auth-surface service and ${'${HARNESS_IMAGE}'} reference with no third container and no build step`, () => {
    const composeText = readFileSync(COMPOSE_FILE, 'utf8');
    const decision = decideCollapsedReuse(composeText);
    expect(decision.ok ? '' : decision.reason).toBe('');
  });
});

// ---------------------------------------------------------------------------------------------
// Static unit exercises for the pure deciders, so the collapse-decision logic is exercised against
// both outcomes rather than only against the artifacts as they currently stand. Each asserts both a
// pass and a fail so no branch is vacuous.
// ---------------------------------------------------------------------------------------------

describe(`${CHECK_ID}: pure decider unit exercises`, () => {
  test('decideProfileSupported passes when collapsed is present and fails when absent', () => {
    expect(decideProfileSupported(['split', 'collapsed']).ok).toBe(true);
    expect(decideProfileSupported(['split']).ok).toBe(false);
  });

  test('decideCollapsedRouting requires one unconditional upstream, no route, and the header', () => {
    const good = `{
\tadmin off
}
:80 {
\thandle /__harness/health {
\t\trespond "OK" 200
\t}
\thandle {
\t\theader X-Harness-Upstream "auth-surface"
\t\treverse_proxy auth-surface:3080
\t}
}
`;
    expect(decideCollapsedRouting(good).ok).toBe(true);

    // An allowlist `route` block is the split's shape, not the collapse's.
    const withRoute = good.replace('\thandle {', '\troute {\n\t\thandle {');
    expect(decideCollapsedRouting(withRoute).ok).toBe(false);

    // No X-Harness-Upstream header: the collapsed run would not report attribution in the split's shape.
    const noHeader = good.replace('\t\theader X-Harness-Upstream "auth-surface"\n', '');
    expect(decideCollapsedRouting(noHeader).ok).toBe(false);

    // Wrong upstream target.
    expect(decideCollapsedRouting(good.replace('auth-surface:3080', 'other:3080')).ok).toBe(false);
  });

  test('decideCollapsedReuse requires the shared image, auth-surface in collapsed, api-container split-only, no build', () => {
    const good = `services:
  auth-surface:
    image: \${HARNESS_IMAGE}
    profiles: ["split", "collapsed"]
    env_file:
      - env/auth-surface.env
  api-container:
    image: \${HARNESS_IMAGE}
    profiles: ["split"]
    env_file:
      - env/api-container.env
networks:
  harness:
    driver: bridge
`;
    expect(decideCollapsedReuse(good).ok).toBe(true);

    // No shared image reference (both container services named their own image).
    expect(
      decideCollapsedReuse(good.replaceAll('image: ${HARNESS_IMAGE}', 'image: pinned:1')).ok,
    ).toBe(false);

    // auth-surface not in the collapsed profile.
    const authSplitOnly = good.replace(
      'auth-surface:\n    image: ${HARNESS_IMAGE}\n    profiles: ["split", "collapsed"]',
      'auth-surface:\n    image: ${HARNESS_IMAGE}\n    profiles: ["split"]',
    );
    expect(decideCollapsedReuse(authSplitOnly).ok).toBe(false);

    // api-container dragged into the collapsed profile — two containers, not one.
    const apiCollapsed = good.replace(
      'api-container:\n    image: ${HARNESS_IMAGE}\n    profiles: ["split"]',
      'api-container:\n    image: ${HARNESS_IMAGE}\n    profiles: ["split", "collapsed"]',
    );
    expect(decideCollapsedReuse(apiCollapsed).ok).toBe(false);

    // A `build:` stanza puts an image build inside `docker compose up` — the rebuild 4.2 forbids.
    const withBuild = good.replace(
      '  auth-surface:\n    image: ${HARNESS_IMAGE}',
      '  auth-surface:\n    build: ../..\n    image: ${HARNESS_IMAGE}',
    );
    expect(decideCollapsedReuse(withBuild).ok).toBe(false);
  });

  test('sliceServiceBlock extracts one service block and returns null for an absent service', () => {
    const compose = `services:
  auth-surface:
    image: x
    profiles: ["split", "collapsed"]
  api-container:
    image: y
networks:
  harness: {}
`;
    const block = sliceServiceBlock(compose, 'auth-surface');
    expect(block).toContain('auth-surface:');
    expect(block).toContain('collapsed');
    expect(block).not.toContain('api-container:');
    expect(sliceServiceBlock(compose, 'nonesuch')).toBeNull();
  });
});
