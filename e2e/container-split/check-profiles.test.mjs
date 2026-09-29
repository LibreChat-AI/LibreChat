// check-profiles.test.mjs — the Check Catalog's profile dimension, and the report it produces.
//
// A run names a compose profile, and not every check is a claim about both topologies: the collapsed
// profile runs ONE container behind one unconditional upstream, so a check comparing the two containers
// has no second operand, and a check the collapse satisfies for free would pass VACUOUSLY (Property 6).
// check-catalog.mjs records which profiles select each id and WHY each narrowing exists; this file pins
// the three things that classification has to make true:
//
//   1. `CHECK_IDS` still means EVERY id, so the serializer's id validation is untouched by the profile
//      dimension. Nothing is renumbered and nothing is deleted.
//   2. `checkIdsForProfile` selects the split set in full and the collapsed set minus exactly the
//      split-only ids — in catalog order, so a reader can still scan the report top to bottom.
//   3. The reporter ACCOUNTS FOR the profile's ids and no others: a split-only id gets no record under
//      `collapsed` (not a skip record — the run makes no claim), and a static pass carrying that id's
//      tag does not become a topology claim. The one thing that is never dropped quietly is a FAIL from
//      an unselected check, which is a gating bug in a spec file and blocks exit 0.
//
// No title here carries a bracketed `[CHECK-ID]` tag: these are unit tests over the catalog, not
// catalog checks, and a tag would have the reporter mint records for them.
//
// NG1/NG2 hold: this reads the harness's own catalog and reporter. No application code, no route mount,
// no HTTP path, neither container-split script.

import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  CHECK_CATALOG,
  CHECK_IDS,
  CHECK_PROFILES,
  DEFAULT_PROFILE,
  HARNESS_PROFILE_ENV,
  checkAppliesToProfile,
  checkIdsForProfile,
  profileFromEnv,
  profilesForCheck,
} from './check-catalog.mjs';
import ContainerSplitReporter, { UNSELECTED_CHECK_FAILED_KIND } from './reporter.mjs';
import { CHECK_STATUS } from './serializer.mjs';

// The eight ids the collapsed profile does not select, listed here INDEPENDENTLY of the catalog so this
// file is a check on the classification rather than a restatement of it. Each is either a comparison
// between the two containers, or a claim the collapse makes vacuous or false.
const SPLIT_ONLY_IDS = [
  'TOPO-IMAGE-13', // one digest compared against another
  'TOPO-ENV-14', // one resolved environment diffed against another
  'TOPO-YAML-15', // byte-identity across the two containers
  'BOOT-API-22', // a container the collapsed profile does not run
  'ROUTE-ALLOW-27', // vacuously true under one unconditional upstream
  'ROUTE-DEFAULT-28', // false on a correctly collapsed topology
];

describe('the Check Catalog carries a profile dimension without losing an id', () => {
  test('CHECK_IDS still means every id the catalog carries, under every profile', () => {
    expect(CHECK_IDS).toEqual(Object.keys(CHECK_CATALOG));
    // The vocabulary the serializer validates records against, and the one the design's
    // negative-control recipes name their targets in. Narrowing it to a profile would make a recipe
    // that targets a split-only check read as naming an unknown id.
    for (const id of SPLIT_ONLY_IDS) {
      expect(CHECK_IDS).toContain(id);
    }
  });

  test('every check applies to the split profile; the narrowings are all away from collapsed', () => {
    for (const id of CHECK_IDS) {
      const profiles = profilesForCheck(id);
      expect(profiles.length).toBeGreaterThan(0);
      for (const profile of profiles) {
        expect(CHECK_PROFILES).toContain(profile);
      }
      // Split is the full-topology profile: it is the run every check is written against, so a check
      // that no profile selected would be a check that never runs.
      expect(profiles).toContain('split');
    }
    expect(checkIdsForProfile('split')).toEqual([...CHECK_IDS]);
  });

  test('the collapsed profile selects every id except the ones a one-container topology cannot decide', () => {
    const collapsed = checkIdsForProfile('collapsed');
    for (const id of SPLIT_ONLY_IDS) {
      expect(collapsed).not.toContain(id);
      expect(checkAppliesToProfile(id, 'collapsed')).toBe(false);
    }
    expect(collapsed).toHaveLength(CHECK_IDS.length - SPLIT_ONLY_IDS.length);
    // Catalog order is preserved, so the report reads in the same order under either profile.
    expect(collapsed).toEqual(CHECK_IDS.filter((id) => !SPLIT_ONLY_IDS.includes(id)));
    // The checks kept under collapsed include the three that were parameterized rather than dropped:
    // the claim survives the collapse, only the expected service names change.
    expect(collapsed).toContain('TOPO-BRINGUP-16');
    expect(collapsed).toContain('TOPO-INGRESS-17');
    expect(collapsed).toContain('MONGO-URI-19');
  });

  test('an unknown profile throws rather than silently selecting nothing', () => {
    // An id set emptied by a typo would make every accounting rule pass over zero checks — the exact
    // false green the accounting exists to prevent.
    expect(() => checkIdsForProfile('collapsd')).toThrow(/Unknown harness profile/);
    expect(() => checkIdsForProfile(undefined)).toThrow(/Unknown harness profile/);
  });

  test('profileFromEnv reads the runner’s annotation and falls back to split', () => {
    expect(profileFromEnv({ [HARNESS_PROFILE_ENV]: 'collapsed' })).toBe('collapsed');
    expect(profileFromEnv({ [HARNESS_PROFILE_ENV]: 'split' })).toBe('split');
    // A bare `npx jest` sets nothing, and a reporting path must not lose the artifact over an env typo.
    expect(profileFromEnv({})).toBe(DEFAULT_PROFILE);
    expect(profileFromEnv({ [HARNESS_PROFILE_ENV]: 'nonsense' })).toBe(DEFAULT_PROFILE);
  });
});

describe('the reporter accounts for the profile’s ids and no others', () => {
  const reportIn = async (dir) =>
    JSON.parse(await readFile(path.join(dir, 'run-report.json'), 'utf8'));

  // Run a reporter over a synthetic aggregate and return the artifact it wrote. Its stdout summary and
  // stderr notices are CAPTURED, not emitted: these unit tests share a Jest invocation with the live
  // run (jest.config.mjs's testMatch collects both), so a `profile: 'collapsed'` reporter built here
  // would otherwise print "profile collapsed does not select …" and four full check summaries into a
  // SPLIT run's log, where they describe nothing that happened.
  const runReporter = async (profile, assertions) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'harness-profile-'));
    const reporter = new ContainerSplitReporter(
      {},
      {
        reportPath: path.join(dir, 'run-report.json'),
        profile,
        layerA: { status: 0, selfSkipped: false },
      },
    );
    const realStdout = process.stdout.write;
    const realStderr = process.stderr.write;
    process.stdout.write = () => true;
    process.stderr.write = () => true;
    try {
      await reporter.onRunComplete({}, { testResults: [{ testResults: assertions }] });
    } finally {
      process.stdout.write = realStdout;
      process.stderr.write = realStderr;
    }
    return reportIn(dir);
  };

  test('under collapsed a split-only id carries no record at all — not a skip', async () => {
    // A skip would say this run failed to decide something; it was never asked to. The distinction is
    // what keeps the collapsed report honest AND lets it reach exit 0.
    const report = await runReporter('collapsed', [
      { status: 'passed', fullName: 'bring-up [TOPO-BRINGUP-16] every service is healthy' },
    ]);
    for (const id of SPLIT_ONLY_IDS) {
      expect(report.checks[id]).toBeUndefined();
    }
    expect(report.checks['TOPO-BRINGUP-16'].status).toBe(CHECK_STATUS.PASS);
    expect(Object.keys(report.checks).sort()).toEqual([...checkIdsForProfile('collapsed')].sort());
  });

  test('a static pass tagged with a split-only id is dropped, not recorded as a topology claim', async () => {
    // Several spec files put a catalog id in a `describe` title for unit tests over pure functions
    // (`[TOPO-ENV-14] matrix parse and partition decider (static)`), and those run under every profile.
    // Recording them would report TOPO-ENV-14 as passed on the strength of a parser test.
    const report = await runReporter('collapsed', [
      { status: 'passed', fullName: '[TOPO-ENV-14] matrix parse and partition decider (static)' },
      { status: 'passed', fullName: '[TOPO-YAML-15] decideYamlIdentity over synthetic bytes' },
      // A selected id in the same aggregate still records, so the dropping is targeted rather than a
      // blanket refusal to record static results.
      { status: 'passed', fullName: 'bring-up [TOPO-BRINGUP-16] every service is healthy' },
    ]);
    expect(report.checks['TOPO-ENV-14']).toBeUndefined();
    expect(report.checks['TOPO-YAML-15']).toBeUndefined();
    expect(report.checks['TOPO-BRINGUP-16'].status).toBe(CHECK_STATUS.PASS);
  });

  test('an unselected check that RAN AND FAILED is reported, never dropped', async () => {
    // The one way this mechanism could produce a false green: a live check its profile does not select,
    // registered anyway by a spec file whose gate is wrong, going red. Dropping that would leave a
    // green run with a red check in it, so it is recorded as a run-level failure instead.
    const report = await runReporter('collapsed', [
      {
        status: 'failed',
        fullName: 'routing [ROUTE-DEFAULT-28] attributes /api/admin/roles to the API_Container',
        failureMessages: ['the proxy attributed it to "auth-surface"'],
      },
    ]);
    expect(report.checks['ROUTE-DEFAULT-28']).toBeUndefined();
    expect(report.setupFailure).toMatchObject({ kind: UNSELECTED_CHECK_FAILED_KIND });
    expect(report.setupFailure.message).toContain('ROUTE-DEFAULT-28');
    expect(report.outcome.ok).toBe(false);
    expect(report.outcome.exitCode).not.toBe(0);
  });

  test('under split every catalog id still carries a record', async () => {
    const report = await runReporter('split', [
      { status: 'passed', fullName: 'bring-up [TOPO-BRINGUP-16] every service is healthy' },
    ]);
    expect(Object.keys(report.checks).sort()).toEqual([...CHECK_IDS].sort());
  });
});
