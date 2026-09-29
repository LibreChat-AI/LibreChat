// group-sync.filter.mjs — the pure decision logic and constants behind this check's Layer B spec (task 14.6).
//
// The exported deciders and constants this check's spec relies on live here, in a non-spec sibling
// module, so the spec file (group-sync.spec.mjs) can import them and export NOTHING itself. jest.config.mjs's
// testMatch collects only `*.spec.mjs` / `*.test.mjs`, so a `.filter.mjs` is never collected as a
// test — the same shape boot-nowrite.filter.mjs establishes. This is a move, not a rewrite: the logic
// is identical to what previously lived in the spec, and the spec exercises it via the import.
//
// NG1/NG2 hold: this decides over the harness's own artifacts and touches no application code and
// neither container-split script.

import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Native-ESM __dirname (the Layer B jest.config runs these under --experimental-vm-modules with
// transform: {}), kept for parity with the sibling specs even though this file needs no on-disk
// read; it documents that `import.meta` is the supported idiom here rather than a `__dirname` guard.
const HERE = path.dirname(fileURLToPath(import.meta.url));
void HERE;

// The check id this spec decides. The reporter parses it from each test title's leading `[CHECK-ID]`
// tag and the serializer looks it up in the Check Catalog for layer / requirements / property, so it
// is named once here and prefixed onto every title (reporter.mjs: parseCheckId).
export const CHECK_ID = 'PATH-GROUPSYNC-26';

// The `groups` collection the sync writer targets and the observer reads. The Container_1_Grant owns
// it read-write; the observer holds `find` on it (run.mjs: OBSERVER_INSPECTED_COLLECTIONS lists the
// refusal-read set, and the observer's grant covers every collection a check inspects). Named once
// so the read and the decider agree.
export const GROUPS_COLLECTION = 'groups';

// The `source` value the sync writer stamps on a group it materializes from the directory. The group
// schema's `source` enum is `['local', 'entra']` (packages/data-schemas/src/schema/group.ts); a group
// created by Entra sync carries `'entra'`, and the check keys on that to tell a synced group apart
// from a locally-created one that happens to share a name.
export const ENTRA_SOURCE = 'entra';

// The OpenID login path routed to the Auth_Surface that triggers group sync. It is one of the
// Auth_Surface_Allowlist entries (`/oauth/*`); initiating the OpenID handshake here drives the
// provider callback far enough to reconcile the directory groups. Named once so the exercise and the
// observation window read one source. The concrete provider segment is `openid`, the social provider
// whose OPENID_ROLE_SYNC_* machinery this check exercises.
export const GROUP_SYNC_LOGIN_PATH = '/oauth/openid';

// ---------------------------------------------------------------------------------------------
// The pure decider: does the post-sync `groups` state satisfy the three document conditions the
// design enumerates? Pure over its inputs (an expected directory assertion and the observed `groups`
// documents), so it is exercisable NOW with synthetic documents and reused by the live run (task 15)
// with what the observer reads back. Returns `{ ok, observation }`: `ok` true means every asserted
// group reconciled correctly; false carries an observation naming the first failing condition and the
// group it failed on, so the run report (RUN-REPORT-32) reads it without a second lookup.
//
// `expected` is the directory assertion the login carried: an array of
// `{ idOnTheSource, name, memberIds }` — the groups Entra asserted for the caller, each with the
// exact membership that should hold after sync. `observed` is the `groups` documents the observer
// read back after the login, each a `{ idOnTheSource, source, memberIds, name }` shape (the group
// schema's fields). `preexistingSourceIds` is the set of `idOnTheSource` values that existed BEFORE
// the login, so "absent groups created" can distinguish a group the sync created from one that was
// already there — passed as an array or a Set.
// ---------------------------------------------------------------------------------------------
export function decideGroupSync({ expected, observed, preexistingSourceIds = [] } = {}) {
  if (!Array.isArray(expected) || expected.length === 0) {
    return {
      ok: false,
      observation:
        `${CHECK_ID}: no expected directory groups supplied to the decider. The check cannot pass ` +
        'vacuously — a group-sync assertion with nothing to reconcile proves nothing about the ' +
        "sync writer's grant sufficiency.",
    };
  }
  if (!Array.isArray(observed)) {
    return {
      ok: false,
      observation:
        `${CHECK_ID}: the observed \`groups\` documents were not readable as an array under the ` +
        'observer credential. The observation is unusable, which is a failure, not a silent pass.',
    };
  }

  // Index the observed Entra-sourced groups by idOnTheSource so each asserted group is matched to the
  // document the sync produced. Only `source: 'entra'` documents count — a local group that shares an
  // idOnTheSource is not the sync writer's output and must not stand in for it.
  const observedBySourceId = new Map();
  for (const doc of observed) {
    if (doc && doc.source === ENTRA_SOURCE && typeof doc.idOnTheSource === 'string') {
      observedBySourceId.set(doc.idOnTheSource, doc);
    }
  }

  const preexisting = new Set(preexistingSourceIds);

  for (const group of expected) {
    const { idOnTheSource, name, memberIds: assertedMembers } = group;
    const doc = observedBySourceId.get(idOnTheSource);

    // Condition 3: absent groups created. A group the assertion names that did not exist before the
    // login must now exist as an Entra-sourced document. (A pre-existing group need not have been
    // "created" this run, but it must still be present to satisfy the membership conditions below,
    // which the missing-document branch also catches.)
    if (!doc) {
      // ABSENT: the directory asserted a group that never existed and the sync did not create it.
      // MISSING: a group that existed before the login is now gone. Both are the same document-level
      // evidence — a `groups` write that did not persist — distinguished only for the report.
      const state = preexisting.has(idOnTheSource)
        ? 'MISSING after sync — a pre-existing group the directory still asserts is no longer present'
        : 'ABSENT after sync — the directory asserted it but no `entra`-sourced `groups` document was created';
      return {
        ok: false,
        observation:
          `${CHECK_ID}: group ${JSON.stringify(name)} (idOnTheSource ${JSON.stringify(
            idOnTheSource,
          )}) is ${state}. Group sync swallows its own errors, so the login returned 200 ` +
          'regardless; the missing document is the evidence a `groups` write was refused (a grant ' +
          'too narrow for the sync path) or otherwise did not persist. Recompute the ' +
          "Container_1_Grant from this path's actual collection needs — do not widen blindly and do " +
          'not re-run the provisioning script unchanged.',
      };
    }

    const observedMembers = Array.isArray(doc.memberIds) ? doc.memberIds : [];
    const observedSet = new Set(observedMembers);
    const assertedSet = new Set(Array.isArray(assertedMembers) ? assertedMembers : []);

    // Condition 1: members added. Every member the directory asserted must be present in the synced
    // group's memberIds.
    for (const member of assertedSet) {
      if (!observedSet.has(member)) {
        return {
          ok: false,
          observation:
            `${CHECK_ID}: group ${JSON.stringify(name)} (idOnTheSource ${JSON.stringify(
              idOnTheSource,
            )}) is MISSING asserted member ${JSON.stringify(member)} after sync — the directory ` +
            'asserted the membership but the synced document does not carry it. A swallowed `groups` ' +
            'write is the quiet failure this check exists to catch; the login returned 200 either way.',
        };
      }
    }

    // Condition 2: members no longer asserted removed. No member absent from the assertion may survive
    // in the synced group's memberIds — a stale membership the sync should have retracted.
    for (const member of observedSet) {
      if (!assertedSet.has(member)) {
        return {
          ok: false,
          observation:
            `${CHECK_ID}: group ${JSON.stringify(name)} (idOnTheSource ${JSON.stringify(
              idOnTheSource,
            )}) still carries STALE member ${JSON.stringify(member)} after sync — the directory no ` +
            'longer asserts this membership but the synced document did not retract it. The retracting ' +
            '`update`/`remove` write did not persist; group sync swallows the error, so the login ' +
            'returned 200 regardless.',
        };
      }
    }
  }

  return { ok: true };
}
