// checks/topology.spec.mjs — the image-identity and librechat.yaml checks (task 9.1).
//
// Two Layer B checks live here, both reading the LIVE topology compose.harness.yml stands up:
//
//   * TOPO-IMAGE-13 — the Auth_Surface and the API_Container resolve to the SAME image digest.
//     Digest equality, not image-name equality: the name is what the compose file says
//     (${HARNESS_IMAGE}, one variable inherited by both services), and the digest is what actually
//     ran. Two services can name one tag and still resolve to two different digests if the tag was
//     repointed between the two `up`s or if one was pulled from a stale local cache, so the name
//     agreeing proves nothing — the digest is the identity Req 1.2 turns on.
//
//   * TOPO-YAML-15 — librechat.yaml is byte-identical inside both containers AND sets
//     secureImageLinks: true. compose.harness.yml mounts one host librechat.yaml read-only into both
//     services (Req 1.6), so byte-identity is a property of the compose file — but this check reads
//     the file back FROM INSIDE each running container rather than trusting the mount, because a
//     divergent build-baked copy, a stray overlay, or a mount that silently failed would all defeat
//     the intent while the compose file still "looks" right. The sha256 of the two containers' bytes
//     must match, and the resolved content must set secureImageLinks: true.
//
// == Why these read the live topology, and how they behave without one ==
// Both observations are Docker facts: an image digest Docker resolved, and a file inside a running
// container. Neither can be decided from `docker compose config` alone — config reports the image
// NAME the compose file wrote and the mount SOURCE, not the digest Docker resolved or the bytes that
// ended up inside the container — so both are honestly Layer B checks that need the topology up
// (task 15 brings it up and runs them). To keep this spec LOADABLE and structurally valid now (task
// 7.5's jest.config.mjs must discover it; `node --check` must pass), the live Docker reads are
// behind an injectable `exec` that defaults to a real `docker` spawn, and the checks are gated on
// HARNESS_LIVE=1 — the same signal the sibling live checks use (mongo.spec.mjs, readiness.spec.mjs),
// which run.mjs sets when it invokes Jest against a live topology. Absent it, each check is simply not
// registered (task 14.7) and the run report shows it as `skip` — a record the reporter derives from
// the catalog for any id with no result; task 15's live run is where it decides pass or fail. A skip
// is never a pass (serializer.mjs enforces that).
//
// == The check-record tag convention ==
// Each test's title STARTS with its catalog id in brackets — `[TOPO-IMAGE-13] …`,
// `[TOPO-YAML-15] …` — which is what reporter.mjs parses to map the Jest result onto the check
// record (check-catalog.mjs owns the id → {layer, requirements, property} table). A check that did
// not run registers no test, and the reporter derives its skip observation from the catalog,
// satisfying the serializer's "skip requires an observation" invariant.
//
// NG1/NG2 hold: this observes the harness's own topology and touches no application code and neither
// container-split script. NG6 holds: no credential validation happens here — these read a digest and
// a file.

// The exported constants and pure deciders live in topology.filter.mjs (a non-spec sibling) so this
// spec file exports nothing (task 14.6). The spec imports what its checks exercise.
import {
  IMAGE_IDENTITY_SERVICES,
  parseComposePs,
  containerRefOf,
  containersByService,
  parseInspectedImageId,
  inspectImageArgs,
  decideImageIdentity,
  yamlDigest,
  setsSecureImageLinksTrue,
  decideYamlIdentity,
  readImageDigests,
  readBothContainerYaml,
} from './topology.filter.mjs';
// The profile dimension of the Check Catalog: which checks THIS run's profile selects.
import { checkAppliesToProfile, profileFromEnv } from '../check-catalog.mjs';

// ---------------------------------------------------------------------------------------------
// The checks. Each test's TITLE starts with its catalog id so reporter.mjs maps the result onto the
// check record. Both need a live topology, so both are gated on HARNESS_LIVE=1 — the same signal
// the sibling live checks (mongo.spec.mjs, readiness.spec.mjs) use, which run.mjs sets when it
// invokes Jest against a live topology (task 15). Absent it, neither check is registered (task 14.7);
// the reporter derives a `skip` record from the catalog for any id with no result (serializer.mjs:
// skip requires an observation). Registering a live check only when live — rather than a
// definition-time skip binding — is what makes an unexecuted check leave no test behind to mark, so
// absence is derived by the reporter rather than announced by the spec.
// ---------------------------------------------------------------------------------------------

// A live topology exists only when run.mjs brought it up (task 15). HARNESS_LIVE=1 is the signal;
// without it the live-only checks are not registered rather than failing (Property 9: a topology that
// is not up has falsified nothing).
// Both checks here are SPLIT-ONLY (check-catalog.mjs): each compares the two containers to each other
// — one image digest, one byte-identical librechat.yaml — and the collapsed profile runs one container,
// so neither comparison has a second operand. The gate therefore asks the catalog whether the RUN'S
// PROFILE selects the check, instead of registering a live read that could only report the absence of a
// service the profile deliberately does not run. A check a profile does not select is not a skip
// record: the run makes no claim about it (the reporter accounts for the profile's ids only).
const PROFILE = profileFromEnv(process.env);
const SELECTED =
  checkAppliesToProfile('TOPO-IMAGE-13', PROFILE) && checkAppliesToProfile('TOPO-YAML-15', PROFILE);
const LIVE = process.env.HARNESS_LIVE === '1' && SELECTED;

// Register the two live checks ONLY when a live topology is present AND this profile selects them.
// Absent it (HARNESS_LIVE unset), nothing is registered and the reporter derives TOPO-IMAGE-13 /
// TOPO-YAML-15's `skip` records from the catalog (task 14.7) — a check that did not run leaves no test
// behind to mark. A literal `test` callee inside the `if (LIVE)` guard is what lets eslint's jest
// plugin recognize the test blocks.
if (LIVE) {
  describe('two-container topology: image identity and librechat.yaml', () => {
    test('[TOPO-IMAGE-13] both containers resolve to the same image digest', async () => {
      const { up, byService } = await readImageDigests();
      // Under the live gate the topology is up; a race that tore it down between the gate and this
      // read is itself a failure worth reporting, not a silent skip.
      expect(up).toBe(true);
      const decision = decideImageIdentity(byService);
      // The observation on failure is the reason string, which reporter.mjs captures from the Jest
      // failure message and puts on the check record. On pass both sides are the empty string.
      expect(decision.ok ? '' : decision.reason).toBe('');
    });

    test('[TOPO-YAML-15] librechat.yaml is byte-identical in both containers and sets secureImageLinks: true', async () => {
      const { up, bytesByService, downServices } = await readBothContainerYaml();
      expect(up ? '' : `containers not running: ${downServices.join(', ')}`).toBe('');
      const decision = decideYamlIdentity(bytesByService);
      expect(decision.ok ? '' : decision.reason).toBe('');
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Static, no-topology assertions — so this file is not vacuous while the live reads are deferred to
// task 15. These decide nothing about a running container; they exercise the pure ps-parse, digest
// and yaml deciders directly, locking the invariants the live checks depend on so a change that would
// silently break the deferred reads fails now instead. They carry no `[CHECK-ID]` tag, so the reporter
// treats them as helper tests rather than catalog checks; TOPO-IMAGE-13 / TOPO-YAML-15 are recorded
// as derived skips by the reporter when the live checks do not run.
// ---------------------------------------------------------------------------------------------
describe('image-identity and librechat.yaml deciders (static)', () => {
  test('parseComposePs tolerates JSONL and a JSON array, and reads empty as no topology', () => {
    const jsonl = '{"Service":"auth-surface","ID":"c1"}\n{"Service":"api-container","ID":"c2"}';
    expect(parseComposePs(jsonl).map((e) => e.Service)).toEqual(['auth-surface', 'api-container']);
    const arr = '[{"Service":"auth-surface","ID":"c1"}]';
    expect(parseComposePs(arr).map((e) => e.Service)).toEqual(['auth-surface']);
    expect(parseComposePs('')).toEqual([]);
    expect(parseComposePs('   ')).toEqual([]);
  });

  test('containerRefOf prefers the id, falls back to the name, and is null with neither', () => {
    expect(containerRefOf({ ID: 'c1', Name: 'harness-auth-surface' })).toBe('c1');
    expect(containerRefOf({ Name: '  harness-auth-surface  ' })).toBe('harness-auth-surface');
    expect(containerRefOf({ Service: 'auth-surface' })).toBeNull();
    expect(containerRefOf({ ID: '' })).toBeNull();
  });

  test('parseInspectedImageId reads the inspected image id and rejects the empty template value', () => {
    // `docker compose ps --format json` carries the image NAME (`Image`) and no image id at all, which
    // is why the digest comes from a container inspect instead. `<no value>` is what the Go template
    // prints for an absent field and must not be mistaken for a digest.
    expect(parseInspectedImageId('sha256:abc\n')).toBe('sha256:abc');
    expect(parseInspectedImageId(Buffer.from('  sha256:def \n', 'utf8'))).toBe('sha256:def');
    expect(parseInspectedImageId('<no value>\n')).toBeNull();
    expect(parseInspectedImageId('')).toBeNull();
  });

  test('inspectImageArgs asks docker for the image the container was created from', () => {
    expect(inspectImageArgs('harness-auth-surface')).toEqual([
      'inspect',
      '--format',
      '{{.Image}}',
      'harness-auth-surface',
    ]);
  });

  test('containersByService maps each compose service to the container to inspect', () => {
    expect(
      containersByService([
        { Service: 'auth-surface', ID: 'c1' },
        { Service: 'api-container', Name: 'harness-api-container' },
        { ID: 'orphan-with-no-service' },
      ]),
    ).toEqual({ 'auth-surface': 'c1', 'api-container': 'harness-api-container' });
  });

  test('decideImageIdentity passes when both services resolve to one digest, fails otherwise', () => {
    const equal = { 'auth-surface': 'sha256:abc', 'api-container': 'sha256:abc' };
    expect(decideImageIdentity(equal).ok).toBe(true);

    // Two different digests: not the same image, even though the tag/name could match.
    const differDecision = decideImageIdentity({
      'auth-surface': 'sha256:abc',
      'api-container': 'sha256:def',
    });
    expect(differDecision.ok).toBe(false);
    expect(differDecision.reason).toMatch(/DIFFERENT image digests/);

    // A missing service is named.
    const missingDecision = decideImageIdentity({ 'auth-surface': 'sha256:abc' });
    expect(missingDecision.ok).toBe(false);
    expect(missingDecision.reason).toMatch(/api-container/);

    // Present service with no resolved digest is a fail, distinct from an absent service.
    const noDigestDecision = decideImageIdentity({
      'auth-surface': 'sha256:abc',
      'api-container': null,
    });
    expect(noDigestDecision.ok).toBe(false);
    expect(noDigestDecision.reason).toMatch(/no resolved image digest/);
  });

  test('readImageDigests reads ps for the containers and inspect for each digest', async () => {
    const calls = [];
    const exec = async (args) => {
      calls.push(args.join(' '));
      if (args.includes('ps')) {
        return {
          status: 0,
          stdout:
            '{"Service":"auth-surface","ID":"c1"}\n{"Service":"api-container","ID":"c2"}\n' +
            '{"Service":"proxy","ID":"c3"}',
          stderr: '',
        };
      }
      return { status: 0, stdout: 'sha256:same\n', stderr: '' };
    };
    const { up, byService } = await readImageDigests({ exec });
    expect(up).toBe(true);
    expect(byService).toEqual({ 'auth-surface': 'sha256:same', 'api-container': 'sha256:same' });
    expect(decideImageIdentity(byService).ok).toBe(true);
    // One ps read, then one inspect per compared service — and no inspect for services this check
    // does not compare (the proxy is in the ps output and is not inspected).
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatch(/^compose -f .*compose\.harness\.yml ps -a --format json$/);
    expect(calls.slice(1)).toEqual([
      'inspect --format {{.Image}} c1',
      'inspect --format {{.Image}} c2',
    ]);
  });

  test('readImageDigests reads an empty ps as no topology, and a failed inspect as no digest', async () => {
    const noTopology = await readImageDigests({
      exec: async () => ({ status: 1, stdout: '', stderr: 'no configuration file provided' }),
    });
    expect(noTopology).toEqual({ up: false, byService: {} });

    const inspectFails = await readImageDigests({
      exec: async (args) =>
        args.includes('ps')
          ? { status: 0, stdout: '{"Service":"auth-surface","ID":"c1"}', stderr: '' }
          : { status: 1, stdout: '', stderr: 'No such object' },
    });
    expect(inspectFails.up).toBe(true);
    expect(inspectFails.byService).toEqual({ 'auth-surface': null });
    expect(decideImageIdentity(inspectFails.byService).ok).toBe(false);
  });

  test('setsSecureImageLinksTrue matches the enabled setting and rejects commented/absent forms', () => {
    expect(setsSecureImageLinksTrue('secureImageLinks: true')).toBe(true);
    expect(setsSecureImageLinksTrue('  secureImageLinks:   true  ')).toBe(true);
    expect(setsSecureImageLinksTrue('# secureImageLinks: true')).toBe(false);
    expect(setsSecureImageLinksTrue('secureImageLinks: false')).toBe(false);
    expect(setsSecureImageLinksTrue('somethingElse: true')).toBe(false);
  });

  test('decideYamlIdentity passes on byte-identical content that enables secureImageLinks, fails otherwise', () => {
    const yaml = Buffer.from('version: 1.2.8\nsecureImageLinks: true\n', 'utf8');
    const identical = { 'auth-surface': yaml, 'api-container': Buffer.from(yaml) };
    expect(decideYamlIdentity(identical).ok).toBe(true);

    // Byte-different content: not identical, even if both enable the setting.
    const different = {
      'auth-surface': yaml,
      'api-container': Buffer.from('version: 1.2.8\nsecureImageLinks: true\n# drift\n', 'utf8'),
    };
    const diffDecision = decideYamlIdentity(different);
    expect(diffDecision.ok).toBe(false);
    expect(diffDecision.reason).toMatch(/NOT byte-identical/);

    // Identical but secureImageLinks not enabled.
    const noSecure = Buffer.from('version: 1.2.8\n', 'utf8');
    const noSecureBoth = { 'auth-surface': noSecure, 'api-container': Buffer.from(noSecure) };
    const noSecureDecision = decideYamlIdentity(noSecureBoth);
    expect(noSecureDecision.ok).toBe(false);
    expect(noSecureDecision.reason).toMatch(/secureImageLinks: true/);
  });

  test('yamlDigest is stable over identical bytes and differs on any change', () => {
    const a = Buffer.from('secureImageLinks: true\n', 'utf8');
    const b = Buffer.from('secureImageLinks: true\n', 'utf8');
    const c = Buffer.from('secureImageLinks: false\n', 'utf8');
    expect(yamlDigest(a)).toBe(yamlDigest(b));
    expect(yamlDigest(a)).not.toBe(yamlDigest(c));
  });

  test('the two compared services are the compose service names', () => {
    expect([...IMAGE_IDENTITY_SERVICES]).toEqual(['auth-surface', 'api-container']);
  });
});
