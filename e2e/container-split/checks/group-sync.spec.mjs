// group-sync.spec.mjs — PATH-GROUPSYNC-26 (task 11.2).
//
// Property 2, bounded-below half: the Auth_Surface's grant is *sufficient* for the group-sync path,
// not merely *narrow*. With Entra group sync enabled (the six OPENID_ROLE_SYNC_* variables plus
// USE_ENTRA_ID_FOR_PEOPLE_SEARCH, all in common.env so both containers agree — design.md), an OpenID
// login routed to the Auth_Surface reconciles the caller's directory groups into the `groups`
// collection: members present in the assertion are added, members no longer asserted are removed, and
// a group the assertion names but the database lacks is created. Every one of those is a WRITE
// (`insert`, `update`, `remove`) on `groups` — one of the eight read-write collections the
// Container_1_Grant owns — so this path exercises the bounded-below claim on the sync writer, the
// half that is new (the grant's vocabulary was narrowed to the DocumentDB-portable intersection and
// nothing had run the group-sync writer under it before this harness).
//
// == Why this check asserts on DOCUMENTS, never on the response ==
// Group sync SWALLOWS ITS OWN ERRORS so that a directory hiccup cannot block authentication: a login
// that could not reconcile its groups still returns 200 and sets a session. So a successful login is
// worthless as evidence here — a `groups` write refused by the database (a grant too narrow) is
// caught, logged at most, and the response is indistinguishable from a clean sync. This is the
// QUIETEST failure surface in the split (design.md: "Group sync degrades silently"), and it is why
// this check's assertion is placed differently from every other path check: PATH-EXERCISE-25 and the
// routing checks read a status or a header; this one reads the resulting `groups` DOCUMENTS under the
// read-only observer credential and decides on them.
//
// The three document conditions the design enumerates, all asserted on the `groups` collection after
// the sync-triggering login:
//
//   1. Members ADDED — every member the directory assertion names is present in the synced group's
//      `memberIds`.
//   2. Members no longer asserted REMOVED — no member absent from the assertion survives in
//      `memberIds` (a stale membership the sync should have retracted).
//   3. Absent groups CREATED — a group the assertion names that the database lacked before the login
//      now exists, `source: 'entra'`, keyed by its `idOnTheSource`.
//
// == What the check reads, and under which credential ==
// It reads the `groups` collection UNDER THE READ-ONLY OBSERVER CREDENTIAL — a `mongodb` Db handle
// the live topology (task 15) connects to the observer plane on 127.0.0.1:27019 with the observer
// credential, which holds `find` only and is distinct from either container's grant (Req 3.9). Never
// either container's grant: the Auth_Surface's grant could read `groups` too, but reading under the
// grant whose sufficiency is being tested would let a refused write hide behind a readable-but-stale
// document. The observer is the neutral third credential that reports the documents as they actually
// stand (the same discipline BOOT-NOWRITE-23 uses to read system.profile and GRANT-DENY-WRITE-04 uses
// to confirm a refused write).
//
// == What runs now vs. against the live topology (task 15) ==
// The pure decision — the predicate over synced-group documents that decides all three conditions —
// is exported and exercised NOW against synthetic `groups` documents a live sync could produce
// (a clean sync passes; a missing member, a surviving stale member, and an uncreated group each
// fail). The end-to-end exercise (log in through the ingress to trigger the sync, then read `groups`
// under the observer) needs the live topology, so the live PATH-GROUPSYNC-26 assertion runs there
// (task 15). Absent it — a plain `jest`/`--listTests` invocation — the live test self-skips with a
// reason the reporter encodes, and the `[PATH-GROUPSYNC-26]` tag stays on the title so the reporter
// records the check id either way. The gate is HARNESS_LIVE=1 plus a harness context on globalThis,
// the same signal the sibling live checks use (routing.spec.mjs, boot-nowrite.spec.mjs), which
// run.mjs sets when it invokes Jest against a live topology.
//
// NG1/NG2/NG6 hold: this exercises the existing image through the commodity proxy, reads `groups`
// documents under the observer credential, and touches no application code, neither container-split
// script, and performs no credential validation of any kind (the sync-triggering login is driven
// through the ingress; the proxy does not emulate the Auth_Gate).

import { makeIngressClient } from '../run.mjs';
// The exported constants and pure deciders live in group-sync.filter.mjs (a non-spec sibling) so this
// spec file exports nothing (task 14.6). The spec imports what its checks exercise.
import {
  CHECK_ID,
  GROUPS_COLLECTION,
  ENTRA_SOURCE,
  GROUP_SYNC_LOGIN_PATH,
  decideGroupSync,
} from './group-sync.filter.mjs';

// ---------------------------------------------------------------------------------------------
// The live PATH-GROUPSYNC-26 assertion.
//
// Log in through the ingress to trigger group sync, then read `groups` under the observer credential
// and run the pure decider. The harness (task 15) supplies the ingress client (fetch reaching the
// live Front_Proxy), the observer Db handle (read-only, on the observer plane), and the directory
// assertion the login carried together with the pre-existing source-id set. Absent that context — a
// plain `jest` invocation with no topology up — the check self-skips.
// ---------------------------------------------------------------------------------------------

// Read the harness context task 15's runner populates before invoking Jest. It carries the live
// ingress client (or a `fetch` to build one), the observer Db handle (`observerDb`, a read-only
// `mongodb` Db on 127.0.0.1:27019 with the observer credential — never either container's grant, Req
// 3.9), the directory assertion the sync-triggering login carries (`groupSync.expected`), and the
// set of group idOnTheSource values that existed before the login (`groupSync.preexistingSourceIds`).
// Returns null when the topology is not present, which turns the check into a clean skip. Accepts
// either a ready-made ingress client or the `fetch` primitive to build one, matching the siblings.
function harnessContext(scope = globalThis) {
  const ctx = scope && scope.__CONTAINER_SPLIT_HARNESS__;
  if (!ctx || typeof ctx !== 'object') {
    return null;
  }
  const ingress =
    ctx.ingress ??
    (typeof ctx.fetch === 'function' ? makeIngressClient({ fetch: ctx.fetch }) : null);
  const observerDb = ctx.observerDb ?? null;
  const groupSync = ctx.groupSync ?? null;
  if (!ingress || !observerDb || !groupSync || typeof groupSync !== 'object') {
    return null;
  }
  return {
    ingress,
    observerDb,
    expected: groupSync.expected,
    preexistingSourceIds: groupSync.preexistingSourceIds ?? [],
    loginPath: groupSync.loginPath ?? GROUP_SYNC_LOGIN_PATH,
    loginMethod: groupSync.loginMethod ?? 'GET',
  };
}

// Read the `groups` documents under the observer credential, as plain typed objects. Kept thin so the
// live query is isolated from the pure decision: it fetches the documents and decideGroupSync decides
// the outcome. The observer holds `find` only, so no write concern is in play.
async function readGroupDocuments(observerDb) {
  return observerDb.collection(GROUPS_COLLECTION).find({}).toArray();
}

// Live gate. HARNESS_LIVE=1 is set by task 15's runner alongside the harness context; without it the
// live check is simply not registered (task 14.7) and the reporter derives its skip record from the
// catalog. Registration happens inside an `if (LIVE)` guard with a literal test callee.
const CTX = harnessContext();
const LIVE = process.env.HARNESS_LIVE === '1' && CTX !== null;

// The notice below must not conflate the two ways this check can fail to run, because on an ordinary
// harness run only ONE of them applies and it is not the one the wording used to blame. A bare
// `jest`/`--listTests` invocation has no topology at all; a real run.mjs run has the topology UP and
// HARNESS_LIVE=1, and the single thing missing is the `groupSync` context the bridge never publishes
// absent an identity provider. Blaming the topology in that case is false in the run log while the
// run-report artifact names the provider correctly. So the two causes are read apart here — the
// harness object and HARNESS_LIVE separately, not collapsed into LIVE — and the notice reports
// whichever actually applies. This changes no behaviour: the gate above is untouched.
const TOPOLOGY_LIVE =
  process.env.HARNESS_LIVE === '1' &&
  Boolean(globalThis.__CONTAINER_SPLIT_HARNESS__) &&
  typeof globalThis.__CONTAINER_SPLIT_HARNESS__ === 'object';

if (!LIVE) {
  // Written straight to process.stderr, not console.warn: Jest's default reporter discards the
  // console buffer of a file whose every test skipped, so the reason would otherwise vanish.
  process.stderr.write(
    TOPOLOGY_LIVE
      ? '[container-split] group-sync.spec.mjs: live topology is up, but no `groupSync` context was ' +
          'published — no identity provider is configured, so no membership sync happened for this ' +
          'run to assert on. PATH-GROUPSYNC-26 is recorded as a skip with the enumerated reason ' +
          '`external-provider-required` (serializer.mjs), and the check is RETAINED rather than ' +
          'removed because it is a valid instrument lacking an input. Pointing the harness at a real ' +
          'tenant publishes the `groupSync` context its gate waits for, at which point it decides at ' +
          'full strength.\n'
      : '[container-split] group-sync.spec.mjs: no live topology (HARNESS_LIVE!=1 or ' +
          'globalThis.__CONTAINER_SPLIT_HARNESS__ absent). PATH-GROUPSYNC-26 logs in through the ' +
          'Front_Proxy ingress to trigger group sync and reads the resulting `groups` documents under ' +
          'the observer credential, both of which only exist once run.mjs brings the topology up ' +
          '(task 15). Skipping the live assertion; the pure decider is exercised statically.\n',
  );
}

// Register the live group-sync assertion ONLY when a live topology is present. Absent it, nothing is
// registered and the reporter derives PATH-GROUPSYNC-26's `skip` record from the catalog (task 14.7);
// the stderr notice above keeps the run log honest. A literal `test` callee inside the `if (LIVE)`
// guard is what lets eslint's jest plugin recognize the test block.
if (LIVE) {
  describe(`${CHECK_ID}: Entra group sync reconciles the \`groups\` documents (asserted on documents, never the response)`, () => {
    test(`[${CHECK_ID}] a group-sync login reconciles the \`groups\` documents — members added, stale members removed, absent groups created`, async () => {
      // Trigger the sync by driving the group-sync login path through the ingress. The RESPONSE is
      // deliberately not asserted on — group sync swallows its own errors, so a 200 says nothing about
      // whether the `groups` writes persisted. The request is issued only to make the sync happen.
      await CTX.ingress.request({ path: CTX.loginPath, method: CTX.loginMethod });

      // Read the resulting `groups` documents under the observer credential and decide on them.
      const observed = await readGroupDocuments(CTX.observerDb);
      const { ok, observation } = decideGroupSync({
        expected: CTX.expected,
        observed,
        preexistingSourceIds: CTX.preexistingSourceIds,
      });
      if (!ok) {
        throw new Error(observation);
      }
      expect(ok).toBe(true);
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Static unit exercise of the pure decider — runs NOW, with no topology, so the group-sync decision
// is checked on every run rather than only once task 15 stands the topology up. Each case asserts a
// pass or a specific fail so no branch is vacuous. These carry no `[CHECK-ID]` tag, so the reporter
// treats them as helper tests rather than catalog checks.
// ---------------------------------------------------------------------------------------------
describe('group-sync document decider (pure)', () => {
  const entraGroup = (over) => ({
    idOnTheSource: 'grp-1',
    source: ENTRA_SOURCE,
    name: 'Engineering',
    memberIds: ['user-a', 'user-b'],
    ...over,
  });

  test('a clean sync — every asserted member present, no stale member, group created — passes', () => {
    const expected = [
      { idOnTheSource: 'grp-1', name: 'Engineering', memberIds: ['user-a', 'user-b'] },
    ];
    const observed = [entraGroup()];
    expect(decideGroupSync({ expected, observed, preexistingSourceIds: [] }).ok).toBe(true);
  });

  test('a member the directory asserted but the document lacks (member not added) fails', () => {
    const expected = [
      { idOnTheSource: 'grp-1', name: 'Engineering', memberIds: ['user-a', 'user-b', 'user-c'] },
    ];
    const observed = [entraGroup({ memberIds: ['user-a', 'user-b'] })];
    const result = decideGroupSync({ expected, observed, preexistingSourceIds: [] });
    expect(result.ok).toBe(false);
    expect(result.observation).toContain('MISSING asserted member');
    expect(result.observation).toContain('user-c');
  });

  test('a stale member the directory no longer asserts but the document keeps (not removed) fails', () => {
    const expected = [{ idOnTheSource: 'grp-1', name: 'Engineering', memberIds: ['user-a'] }];
    const observed = [entraGroup({ memberIds: ['user-a', 'user-b'] })];
    const result = decideGroupSync({ expected, observed, preexistingSourceIds: [] });
    expect(result.ok).toBe(false);
    expect(result.observation).toContain('STALE member');
    expect(result.observation).toContain('user-b');
  });

  test('an asserted group with no `entra`-sourced document (absent group not created) fails', () => {
    const expected = [{ idOnTheSource: 'grp-2', name: 'Design', memberIds: ['user-x'] }];
    const observed = []; // sync produced nothing
    const result = decideGroupSync({ expected, observed, preexistingSourceIds: [] });
    expect(result.ok).toBe(false);
    expect(result.observation).toContain('ABSENT after sync');
    expect(result.observation).toContain('grp-2');
  });

  test('a pre-existing group that vanished after sync fails as MISSING, distinct from ABSENT', () => {
    const expected = [{ idOnTheSource: 'grp-3', name: 'Ops', memberIds: ['user-y'] }];
    const observed = [];
    const result = decideGroupSync({ expected, observed, preexistingSourceIds: ['grp-3'] });
    expect(result.ok).toBe(false);
    expect(result.observation).toContain('MISSING after sync');
  });

  test('a local group sharing the idOnTheSource does not stand in for the synced Entra group', () => {
    const expected = [{ idOnTheSource: 'grp-1', name: 'Engineering', memberIds: ['user-a'] }];
    // A `local`-sourced document with the same id must not satisfy the assertion.
    const observed = [entraGroup({ source: 'local', memberIds: ['user-a'] })];
    const result = decideGroupSync({ expected, observed, preexistingSourceIds: ['grp-1'] });
    expect(result.ok).toBe(false);
    expect(result.observation).toContain('MISSING after sync');
  });

  test('an empty expected assertion fails rather than passing vacuously', () => {
    expect(decideGroupSync({ expected: [], observed: [] }).ok).toBe(false);
    expect(decideGroupSync({ expected: [], observed: [] }).observation).toContain(
      'no expected directory groups',
    );
  });

  test('an unreadable observed set (not an array) is an unusable observation, not a pass', () => {
    const expected = [{ idOnTheSource: 'grp-1', name: 'Engineering', memberIds: [] }];
    const result = decideGroupSync({ expected, observed: null });
    expect(result.ok).toBe(false);
    expect(result.observation).toContain('not readable as an array');
  });
});
