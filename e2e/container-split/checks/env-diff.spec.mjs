// checks/env-diff.spec.mjs — the resolved-environment difference check (task 9.2).
//
// One Layer B check lives here, keyed to the design's Check Catalog (design.md: "## Check Catalog"):
//
//   [TOPO-ENV-14]  Read the RESOLVED environment of both containers and assert every difference
//                  between them falls into one of the three buckets scripts/container-split/env-matrix.md
//                  records — environment values, the MongoDB credential, the routed paths — and that
//                  every setting the matrix marks `identical` is identical BY PRESENCE AND BY VALUE,
//                  not merely by value where both happen to be set (Req 1.3–1.5, 1.7, 1.8).
//
// == env-matrix.md is the authority; this check READS it, it does not restate it ==
// The task and the design are explicit: scripts/container-split/env-matrix.md owns the identical/differ
// partition, and TOPO-ENV-14 reads its table rather than carrying a second copy — so a change to the
// matrix flows into the check without a second edit here (design.md, task 6.2 / 9.2). This file parses
// the matrix's two `Compare`-column tables at run time and derives the partition from them:
//
//   * The IDENTICAL set — every row whose Compare cell is `identical`. That covers CREDS_KEY, the six
//     OPENID_ROLE_SYNC_*, USE_ENTRA_ID_FOR_PEOPLE_SEARCH, JWT_SECRET, JWT_REFRESH_SECRET,
//     ALLOW_SHARED_LINKS_PUBLIC, FORCED_IN_MEMORY_CACHE_NAMESPACES, the Redis block, and the OAuth
//     flow-window pair (MCP_OAUTH_HANDLING_TIMEOUT, MCP_OAUTH_FLOW_TTL). A setting in this set is a
//     FINDING if its resolved value differs between the two containers OR if it is present on one and
//     absent on the other — the matrix's own definition of "identical": "differing if its resolved
//     value differs between the two containers, or if it is present on one and absent on the other."
//
//   * The DIFFER set — every row whose Compare cell is `differs` (or `may differ`). That covers
//     DISABLE_STARTUP_TASKS, MONGO_AUTO_INDEX, MONGO_AUTO_CREATE, SEARCH, MEILI_HOST,
//     MEILI_MASTER_KEY, MONGO_URI, and RAG_API_URL. A difference on one of these keys is an ACCEPTED
//     variant — one of the matrix's three buckets — not a finding.
//
// Some matrix rows name a family rather than a single variable (`OPENID_ROLE_SYNC_* (all six)`,
// `Redis block (see below)`, a settings that live in librechat.yaml rather than the environment). The
// parser expands the families this check can observe in the resolved environment into their concrete
// keys and drops the rows that name no environment variable (the librechat.yaml row `secureImageLinks`
// is TOPO-YAML-15's, not this check's). The expansion table is the one bridge between the matrix's
// prose shorthand and the concrete env keys; it is kept small, documented, and asserted against the
// matrix so it cannot silently fall out of step.
//
// == The three buckets ==
// The matrix says a configuration comparison "enumerates each container's resolved environment, its
// provisioned grant, and its routing rules, then places every observed difference in one of those
// three buckets. A difference that fits none of them is a defect." The two Docker facts this check can
// read are the resolved environments; the grant and the routing rules are decided elsewhere (the Layer
// A grant checks; ROUTE-ALLOW-27 / ROUTE-DEFAULT-28). So within the environment this check enumerates,
// a difference is acceptable iff its key is in the matrix's DIFFER set — that is the environment-values
// bucket — OR the key is MONGO_URI, the credential bucket. A differing key that the matrix marks
// `identical`, or a differing key the matrix names nowhere at all, is the "fits none of them" defect
// the check reports. Routed paths are not an environment key, so no env difference maps to that bucket.
//
// == MEILI_HOST / MEILI_MASTER_KEY: absent, not present-and-empty ==
// The task calls this out specifically (Req 1.4, 1.8): the Auth_Surface must carry MEILI_HOST and
// MEILI_MASTER_KEY ABSENT rather than present-and-empty, because their PRESENCE — not their
// truthiness — is what attaches the search plugin (env-matrix.md, "MEILI_HOST and MEILI_MASTER_KEY").
// A present-but-empty MEILI_HOST on the auth surface would attach the plugin and defeat the clean
// boot, so the check asserts absence explicitly on the Auth_Surface side, separately from the
// partition comparison.
//
// == What runs where ==
//   * The MATRIX PARSE and the PARTITION DECIDER are pure. They run now, under the Layer B config,
//     with static unit tests that feed synthetic resolved-env maps and the committed matrix text.
//   * The RESOLVED-ENVIRONMENT read pulls each service's interpolated `environment` out of
//     `docker compose config --format json` — the value the container actually receives once the
//     per-run env files run.mjs writes are resolved (the same read shape mongo.spec.mjs uses for
//     MONGO_URI). It needs a resolvable compose file, so it is gated on a live topology and exercised
//     in task 15.
//
// == The live-topology gate ==
// A live topology exists only once run.mjs brings it up (task 15). HARNESS_LIVE=1 is the signal;
// without it the live check self-skips loudly rather than fails — a topology that is not up has
// falsified nothing (Property 9). Absent the gate the live check is not registered (task 14.7);
// reporter.mjs derives a `skip` record for TOPO-ENV-14 — a catalog id with no Jest result — carrying
// a "not executed this run" observation (serializer.mjs: skip requires an observation). Registering a
// live check only when live, rather than a definition-time skip, is what yields a genuine skip rather
// than a hollow pass, since a check that did not run leaves no test behind to mark.
//
// NG1/NG2 hold: this reads the harness's own compose file and the committed env matrix. It adds no
// application code, no route mount and no HTTP path, and edits neither container-split script. NG6
// holds: no credential validation happens here — it compares resolved environment maps.

// The exported constants and pure deciders live in env-diff.filter.mjs (a non-spec sibling) so this
// spec file exports nothing (task 14.6). The spec imports what its checks exercise.
import {
  loadMatrixPartition,
  decideEnvDiff,
  decideMeiliAbsentOnAuthSurface,
  readResolvedEnvironments,
} from './env-diff.filter.mjs';
// The profile dimension of the Check Catalog: which checks THIS run's profile selects.
import { checkAppliesToProfile, profileFromEnv } from '../check-catalog.mjs';

// ---------------------------------------------------------------------------------------------
// The check. Its title starts with the catalog id so reporter.mjs maps the result onto the check
// record. The live read needs a topology, so it is gated on HARNESS_LIVE=1 — the same signal the
// sibling live checks use (mongo.spec.mjs, topology.spec.mjs), which run.mjs sets when it invokes Jest
// against a live topology (task 15). Absent it, the live check is not registered (task 14.7) and the
// reporter derives its `skip` record from the catalog. The static tests below carry the same
// [TOPO-ENV-14] tag and run now, so the parser and the partition decider are exercised without a
// topology.
// ---------------------------------------------------------------------------------------------

// TOPO-ENV-14 is SPLIT-ONLY (check-catalog.mjs): it DIFFS the two containers' resolved environments
// against env-matrix.md's buckets, and the collapsed profile runs one container — there is no second
// environment to diff, and every `identical` row would be a map compared with itself. So the live read
// is registered only when the RUN'S PROFILE selects the check, rather than reading one environment and
// reporting the other as undefined.
const PROFILE = profileFromEnv(process.env);
const LIVE = process.env.HARNESS_LIVE === '1' && checkAppliesToProfile('TOPO-ENV-14', PROFILE);

// Register the live resolved-env read ONLY when a live topology is present and this profile selects the
// check. Absent it, nothing is registered and the reporter derives TOPO-ENV-14's `skip` record from the
// catalog (task 14.7) — or, under a profile that does not select it, accounts for the id not at all. The
// static [TOPO-ENV-14] matrix-parse/partition tests below run regardless; they are profile-independent
// unit tests over pure functions, and under a profile that does not select the check the reporter drops
// their result rather than recording a topology claim on the strength of a parser test. A literal `test`
// callee inside the `if (LIVE)` guard is what lets eslint's jest plugin recognize the test block.
if (LIVE) {
  describe('[TOPO-ENV-14] resolved-environment difference check (live topology)', () => {
    test('[TOPO-ENV-14] resolved env differs only where env-matrix.md allows and is identical where it requires', async () => {
      const partition = loadMatrixPartition();
      const resolved = await readResolvedEnvironments();
      const authEnv = resolved['auth-surface'];
      const apiEnv = resolved['api-container'];

      // Both container services must be present in the resolved split config; a race that tore the
      // topology down between the gate and this read is a failure worth reporting, not a silent skip.
      expect(authEnv).toBeDefined();
      expect(apiEnv).toBeDefined();

      // The partition comparison: identical rows identical by presence and value, and every difference
      // in one of the three buckets.
      const partitionDecision = decideEnvDiff(authEnv, apiEnv, partition);
      expect(partitionDecision.ok ? '' : partitionDecision.reason).toBe('');

      // MEILI_HOST / MEILI_MASTER_KEY absent — not present-and-empty — on the auth surface (Req 1.4, 1.8).
      const meiliDecision = decideMeiliAbsentOnAuthSurface(authEnv);
      expect(meiliDecision.ok ? '' : meiliDecision.reason).toBe('');
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Static tests — exercise the matrix parse and the partition decider now, so a regression that would
// break the deferred live read fails here rather than surviving to task 15. All carry the
// [TOPO-ENV-14] tag; the reporter keeps the most severe outcome across tests sharing an id, so these
// passing does not mask the live skip and vice versa.
// ---------------------------------------------------------------------------------------------
describe('[TOPO-ENV-14] matrix parse and partition decider (static)', () => {
  test("the committed env-matrix.md yields a partition naming the design's identical rows", () => {
    const partition = loadMatrixPartition();

    // The identical set must carry every concrete key the task's prose names: CREDS_KEY, the six
    // OPENID_ROLE_SYNC_*, USE_ENTRA_ID_FOR_PEOPLE_SEARCH, JWT_SECRET, JWT_REFRESH_SECRET,
    // ALLOW_SHARED_LINKS_PUBLIC, and the Redis block. Reading the real matrix (not a synthetic one) is
    // what makes this assert the authority the live check reads.
    const expectedIdentical = [
      'ALLOW_SHARED_LINKS_PUBLIC',
      'CREDS_KEY',
      'JWT_REFRESH_SECRET',
      'JWT_SECRET',
      'OPENID_ROLE_SYNC_API_ENABLED',
      'OPENID_ROLE_SYNC_CLAIM',
      'OPENID_ROLE_SYNC_ENABLED',
      'OPENID_ROLE_SYNC_FALLBACK_ROLE',
      'OPENID_ROLE_SYNC_ROLE_PRIORITY',
      'OPENID_ROLE_SYNC_SOURCE',
      'USE_ENTRA_ID_FOR_PEOPLE_SEARCH',
      'USE_REDIS',
      'REDIS_URI',
    ];
    for (const key of expectedIdentical) {
      expect(partition.identical).toContain(key);
    }

    // The differ set must carry the env-values-bucket keys the matrix marks `differs`/`may differ`.
    for (const key of [
      'DISABLE_STARTUP_TASKS',
      'MONGO_AUTO_INDEX',
      'MONGO_AUTO_CREATE',
      'SEARCH',
      'MEILI_HOST',
      'MEILI_MASTER_KEY',
      'RAG_API_URL',
    ]) {
      expect(partition.differ).toContain(key);
    }

    // No key may sit in both halves of the partition — a drift guard on the parse.
    const differSet = new Set(partition.differ);
    for (const key of partition.identical) {
      expect(differSet.has(key)).toBe(false);
    }

    // The librechat.yaml row is dropped, not partitioned — it is TOPO-YAML-15's, not this check's.
    expect(partition.identical).not.toContain('secureImageLinks');
    expect(partition.differ).not.toContain('secureImageLinks');
  });

  test('decideEnvDiff passes the values env-matrix.md prescribes for the two containers', () => {
    const partition = loadMatrixPartition();
    // Resolved environments matching the committed env examples: common.env identical on both, the
    // per-service files differing exactly on the differ-set keys, MONGO_URI carrying each credential.
    const authEnv = {
      CREDS_KEY: 'shared-key',
      JWT_SECRET: 'shared-jwt',
      JWT_REFRESH_SECRET: 'shared-refresh',
      OPENID_ROLE_SYNC_ENABLED: 'false',
      USE_REDIS: 'true',
      REDIS_URI: 'redis://redis:6379',
      ALLOW_SHARED_LINKS_PUBLIC: 'false',
      DISABLE_STARTUP_TASKS: 'true',
      MONGO_AUTO_INDEX: 'false',
      MONGO_AUTO_CREATE: 'false',
      SEARCH: 'false',
      MONGO_URI: 'mongodb://auth:pw@mongodb:27017/LibreChat?authSource=admin',
    };
    const apiEnv = {
      CREDS_KEY: 'shared-key',
      JWT_SECRET: 'shared-jwt',
      JWT_REFRESH_SECRET: 'shared-refresh',
      OPENID_ROLE_SYNC_ENABLED: 'false',
      USE_REDIS: 'true',
      REDIS_URI: 'redis://redis:6379',
      ALLOW_SHARED_LINKS_PUBLIC: 'false',
      MONGO_AUTO_INDEX: 'true',
      MONGO_AUTO_CREATE: 'true',
      SEARCH: 'true',
      MEILI_HOST: 'http://meilisearch:7700',
      MEILI_MASTER_KEY: 'meili-key',
      MONGO_URI: 'mongodb://api:pw@mongodb:27017/LibreChat?authSource=admin',
    };
    const decision = decideEnvDiff(authEnv, apiEnv, partition);
    expect(decision.ok ? '' : decision.reason).toBe('');
  });

  test('decideEnvDiff flags an identical-set value that differs between the containers', () => {
    const partition = loadMatrixPartition();
    const authEnv = { CREDS_KEY: 'key-a', USE_REDIS: 'true' };
    const apiEnv = { CREDS_KEY: 'key-b', USE_REDIS: 'true' };
    const decision = decideEnvDiff(authEnv, apiEnv, partition);
    expect(decision.ok).toBe(false);
    expect(
      decision.findings.some((f) => f.kind === 'identical-mismatch' && f.key === 'CREDS_KEY'),
    ).toBe(true);
  });

  test('decideEnvDiff flags an identical-set key present on one container and absent on the other', () => {
    const partition = loadMatrixPartition();
    const authEnv = { JWT_SECRET: 'shared' };
    const apiEnv = {};
    const decision = decideEnvDiff(authEnv, apiEnv, partition);
    expect(decision.ok).toBe(false);
    expect(
      decision.findings.some((f) => f.kind === 'identical-mismatch' && f.key === 'JWT_SECRET'),
    ).toBe(true);
  });

  test('decideEnvDiff accepts a MONGO_URI difference as the credential bucket, not a defect', () => {
    const partition = loadMatrixPartition();
    const authEnv = { MONGO_URI: 'mongodb://auth:pw@mongodb:27017/LibreChat?authSource=admin' };
    const apiEnv = { MONGO_URI: 'mongodb://api:pw@mongodb:27017/LibreChat?authSource=admin' };
    const decision = decideEnvDiff(authEnv, apiEnv, partition);
    expect(decision.ok ? '' : decision.reason).toBe('');
  });

  test('decideEnvDiff flags a difference on a key the matrix names nowhere as an unaccounted defect', () => {
    const partition = loadMatrixPartition();
    // A stray key in neither the identical set nor the differ set nor the credential bucket: the
    // matrix's "a difference that fits none of the three buckets is a defect."
    const authEnv = { SOME_UNLISTED_FLAG: 'on' };
    const apiEnv = { SOME_UNLISTED_FLAG: 'off' };
    const decision = decideEnvDiff(authEnv, apiEnv, partition);
    expect(decision.ok).toBe(false);
    expect(
      decision.findings.some(
        (f) => f.kind === 'unaccounted-difference' && f.key === 'SOME_UNLISTED_FLAG',
      ),
    ).toBe(true);
  });

  test('decideMeiliAbsentOnAuthSurface fails on a present-and-empty MEILI_HOST', () => {
    // Present-and-empty still attaches the search plugin, so absence — not emptiness — is the rule.
    const decision = decideMeiliAbsentOnAuthSurface({ MEILI_HOST: '' });
    expect(decision.ok).toBe(false);
    expect(decision.reason).toMatch(/MEILI_HOST/);
  });

  test('decideMeiliAbsentOnAuthSurface passes when both MEILI keys are absent', () => {
    const decision = decideMeiliAbsentOnAuthSurface({ SEARCH: 'false' });
    expect(decision.ok).toBe(true);
  });

  test('readResolvedEnvironments reads each service environment from an injected compose config', async () => {
    // A fake exec returning a synthetic `docker compose config --format json` payload, so the read is
    // exercised without Docker. Under the collapsed profile the api-container is absent; here both
    // are present (split).
    const fakeConfig = JSON.stringify({
      services: {
        'auth-surface': { environment: { CREDS_KEY: 'k', DISABLE_STARTUP_TASKS: 'true' } },
        'api-container': { environment: { CREDS_KEY: 'k', SEARCH: 'true' } },
      },
    });
    const resolved = await readResolvedEnvironments({ exec: async () => fakeConfig });
    expect(resolved['auth-surface']).toEqual({ CREDS_KEY: 'k', DISABLE_STARTUP_TASKS: 'true' });
    expect(resolved['api-container']).toEqual({ CREDS_KEY: 'k', SEARCH: 'true' });
  });

  test('readResolvedEnvironments omits a service absent from the resolved config (collapsed profile)', async () => {
    const fakeConfig = JSON.stringify({
      services: { 'auth-surface': { environment: { CREDS_KEY: 'k' } } },
    });
    const resolved = await readResolvedEnvironments({ exec: async () => fakeConfig });
    expect(resolved['auth-surface']).toBeDefined();
    expect(resolved['api-container']).toBeUndefined();
  });
});
