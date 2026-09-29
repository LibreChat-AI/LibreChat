// boot-nowrite.spec.mjs — BOOT-NOWRITE-23, the boot-write check (task 10.3).
//
// Property 1 (parent P1): for every boot of the Auth_Surface under the Container_1_Grant, the number
// of Mongo write commands attributed to `librechat_auth_surface@admin` inside the boot window is
// exactly zero. Property 6: this check must not pass vacuously — an unusable observation (a rolled
// capped `system.profile`) is a FAILURE, not a silent "no writes found".
//
// == What the check observes ==
// Before the Auth_Surface starts, the runner (task 7.2) sized `system.profile` to 64 MB and set
// profiling to level 2, and recorded the Auth_Surface's process-start timestamp (captureBootStart).
// This check reads `system.profile` back UNDER THE READ-ONLY OBSERVER CREDENTIAL — a MongoClient the
// live topology (task 15) points at the observer plane on 127.0.0.1:27019 with the observer
// credential — filters the profile entries to write operations attributed to AUTH_SURFACE_PROFILE_USER
// (`librechat_auth_surface@admin`) inside the boot window, and asserts the count is exactly zero.
//
//   * Attribution by `user` is what makes the observation specific to the Auth_Surface. The
//     API_Container is writing the SAME database at the SAME time under its own credential; an
//     unattributed write count would be noise (design: Boot-Write Observation).
//   * The window opens at the process-start timestamp (captureBootStart's left edge) and closes
//     60 seconds after `/readyz` first returns 200. The tail is deliberate: the parent design's
//     post-listen block runs after `listen`, so a window closing at the readiness signal would miss
//     a late bootstrap writer — the exact class of defect this check exists to catch.
//   * Property 6 / no false pass: the check asserts the OLDEST SURVIVING `system.profile` entry
//     predates the container's start timestamp. A rolled capped collection discarded the earliest
//     entries and is an unusable observation; treating it as "no writes found" would be a false pass
//     on the one check whose failure mode is silence. The 64 MB sizing (task 7.2) removes the failure
//     mode; this assertion catches a roll that happened anyway.
//   * Request-path `createIndex` carve-out: `MONGO_AUTO_INDEX=false` suppresses Mongoose's automatic
//     build at model registration but NOT an explicit `Model.createIndexes()`, which the `sessions`,
//     `refreshtokenbridges` and `openidrefreshflights` method layers issue (memoized per process) on
//     login, refresh and logout — all paths routed to the Auth_Surface, so the Auth_Surface is the
//     container that indexes them by design and the grant carries `createIndex` for that reason. A
//     boot-write check that fires on a login is a broken check, not a finding. Two mechanisms keep it
//     from firing and BOTH live outside this file: the window ends on a boot event rather than a
//     wall-clock duration, and the runner issues no request through the ingress client until the boot
//     window has closed (Req 2.10). NC6 is the inverted control that proves it (task 13).
//
// == What runs now vs. against the live topology (task 15) ==
// The pure decision — the write-op filter predicate, the attribution and window filters, the count,
// and the Property-6 usability guard — lives in boot-nowrite.filter.mjs, importable and exercisable on
// its own (as serializer.mjs is), and is exercised in this file against synthetic `system.profile`
// documents a live boot could produce. The end-to-end read of `system.profile` under the observer
// credential needs the MongoClient the live topology supplies, so the live BOOT-NOWRITE-23 assertion
// runs there (task 15); absent it, the live test self-skips with a reason so a plain `jest` run
// reports a skip rather than a failure. The bracketed `[BOOT-NOWRITE-23]` tag stays on the title so
// the reporter records the check id either way.
//
// NG1/NG2 hold: this observes the harness's own boot window and touches no application code and
// neither container-split script.

import {
  AUTH_SURFACE_PROFILE_USER,
  BOOT_WINDOW_ANCHOR_COLLECTION,
  SYSTEM_PROFILE_COLLECTION,
  IDENTITIES,
  buildProfilingSnippet,
} from '../run.mjs';
import { ENUMERATED_SKIP_REASONS, SKIP_REASON } from '../serializer.mjs';
import { parseUndecided } from '../undecided.mjs';
import {
  isWriteProfileEntry,
  isAttributedToAuthSurface,
  isInBootWindow,
  countBootWrites,
  assessProfileUsability,
  bootWindowEnd,
  undecidedProfileObservation,
  BOOT_WINDOW_ANCHOR_NS,
  WRITE_COMMAND_NAMES,
  readTopologyContext,
} from './boot-nowrite.filter.mjs';

// ---------------------------------------------------------------------------------------------
// The live BOOT-NOWRITE-23 assertion.
//
// Reads `system.profile` under the observer credential (the MongoClient the live topology supplies),
// runs the pure decision, and asserts (1) the observation is usable — the profile did not roll past
// the window's left edge — and (2) the boot-write count is exactly zero. The harness (task 15)
// provides the observer client and the boot-window edges through a shared context; absent them, the
// check self-skips.
// ---------------------------------------------------------------------------------------------

// The `readTopologyContext` decision — reading the boot-window context the live topology publishes
// on globalThis — lives in boot-nowrite.filter.mjs (imported above) so this spec file exports nothing
// (task 14.6).

// Read `system.profile` under the observer credential, oldest-first. Kept thin so the live query is
// isolated from the pure decision: it fetches the documents and the filter module decides the
// outcome. The observer holds `find` only (task 7.2), so no write concern is in play.
async function readProfileEntries(observerDb) {
  return observerDb
    .collection(SYSTEM_PROFILE_COLLECTION)
    .find({}, { sort: { ts: 1 } })
    .toArray();
}

// Register the live BOOT-NOWRITE-23 assertion ONLY when the live topology is present. When it is
// absent (a plain `jest` invocation, or `--listTests`), the check cannot read a live `system.profile`,
// so it registers nothing — the reporter derives its `skip` record from the catalog (task 14.7).
// Task 15 supplies the observer client and boot-window edges that turn it live. A literal `describe`
// callee inside the guard is what lets eslint's jest plugin recognize the test block.
const bootNoWriteCtx = readTopologyContext();
if (bootNoWriteCtx) {
  describe('BOOT-NOWRITE-23 — zero boot-time writes on the Auth_Surface', () => {
    const ctx = bootNoWriteCtx;
    test(
      '[BOOT-NOWRITE-23] counts zero write commands attributed to ' +
        'librechat_auth_surface@admin in the boot window',
      async () => {
        const { observerDb, bootStart, readyAtMs } = ctx;
        const bootStartMs = bootStart.epochMs;
        const windowEndMs = bootWindowEnd(readyAtMs);

        const entries = await readProfileEntries(observerDb);

        // Property 6: the observation must be usable before its count can mean anything. Usability is
        // the boot-window anchor's presence — the runner's one profiled read, issued before any
        // container started — so while it survives, nothing has been discarded since profiling was
        // enabled and the profile covers the whole window.
        //
        // When it is absent the check has no observation to count over, so it reports an UNUSABLE
        // OBSERVATION rather than a verdict: reporter.mjs records that as a `skip` carrying
        // OBSERVATION_UNUSABLE, which is not a pass (P1 was not seen to hold), not a fail (nothing was
        // falsified), and not benign (the reason is outside the enumerated set, so the run still exits
        // non-zero). A zero count read off a rolled profile is silence, and this check's whole failure
        // mode is silence.
        const assessment = assessProfileUsability(entries, bootStartMs);
        if (!assessment.usable) {
          throw undecidedProfileObservation(assessment, { bootStartMs, windowEndMs });
        }

        // P1: exactly zero write operations attributed to the Auth_Surface inside the boot window.
        const writeCount = countBootWrites(entries, {
          bootStartMs,
          windowEndMs,
          profileUser: AUTH_SURFACE_PROFILE_USER,
        });
        expect(writeCount).toBe(0);
      },
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Unit exercise of the pure decision (Property 6 corollary: the check must not pass vacuously, so its
// deciding logic is checked against synthetic `system.profile` documents a live boot could produce).
// These run now, with no topology: a write op by the auth user in-window is counted; a read, an
// out-of-window op, or another user's write is not. They carry no `[CHECK-ID]` tag, so the reporter
// treats them as helper tests rather than catalog checks.
// ---------------------------------------------------------------------------------------------
describe('boot-write filter predicate (pure)', () => {
  const AUTH = AUTH_SURFACE_PROFILE_USER; // 'librechat_auth_surface@admin'
  const API = `${IDENTITIES.apiUsername}@${IDENTITIES.authSource}`; // the other container
  const bootStartMs = Date.parse('2024-01-01T00:00:00.000Z');
  const readyAtMs = bootStartMs + 20_000;
  const windowEndMs = bootWindowEnd(readyAtMs); // readyAt + 60s
  const inWindowMs = bootStartMs + 5_000;
  const afterWindowMs = windowEndMs + 5_000;
  const beforeWindowMs = bootStartMs - 5_000;

  const entry = (over) => ({ ts: new Date(inWindowMs), user: AUTH, ...over });

  describe('isWriteProfileEntry', () => {
    test('a CRUD insert/update/remove op is a write', () => {
      expect(isWriteProfileEntry(entry({ op: 'insert' }))).toBe(true);
      expect(isWriteProfileEntry(entry({ op: 'update' }))).toBe(true);
      expect(isWriteProfileEntry(entry({ op: 'remove' }))).toBe(true);
    });

    test('a command op naming a write command is a write', () => {
      for (const name of WRITE_COMMAND_NAMES) {
        expect(isWriteProfileEntry(entry({ op: 'command', command: { [name]: 'sessions' } }))).toBe(
          true,
        );
      }
    });

    test('command-name comparison is case-insensitive (findandmodify vs findAndModify)', () => {
      expect(
        isWriteProfileEntry(entry({ op: 'command', command: { findandmodify: 'users' } })),
      ).toBe(true);
    });

    test('a read is not a write', () => {
      expect(isWriteProfileEntry(entry({ op: 'query' }))).toBe(false);
      expect(isWriteProfileEntry(entry({ op: 'getmore' }))).toBe(false);
      expect(isWriteProfileEntry(entry({ op: 'command', command: { find: 'users' } }))).toBe(false);
      expect(isWriteProfileEntry(entry({ op: 'command', command: { aggregate: 'users' } }))).toBe(
        false,
      );
    });

    test('a null or malformed entry is not a write', () => {
      expect(isWriteProfileEntry(null)).toBe(false);
      expect(isWriteProfileEntry({})).toBe(false);
      expect(isWriteProfileEntry({ op: 'command' })).toBe(false);
    });
  });

  describe('isAttributedToAuthSurface', () => {
    test('a string user matching the Auth_Surface principal is attributed', () => {
      expect(isAttributedToAuthSurface(entry({ user: AUTH }))).toBe(true);
    });

    test('another container’s write is not attributed to the Auth_Surface', () => {
      expect(isAttributedToAuthSurface(entry({ user: API }))).toBe(false);
    });

    test('the allUsers array form is normalized to user@db', () => {
      expect(
        isAttributedToAuthSurface({
          ts: new Date(inWindowMs),
          allUsers: [{ user: IDENTITIES.authUsername, db: 'admin' }],
        }),
      ).toBe(true);
    });

    test('an unattributed (system) entry is not attributed to the Auth_Surface', () => {
      expect(isAttributedToAuthSurface({ ts: new Date(inWindowMs) })).toBe(false);
    });
  });

  describe('isInBootWindow', () => {
    test('an entry inside [bootStart, readyAt+60s] is in window', () => {
      expect(isInBootWindow(entry({ ts: new Date(inWindowMs) }), bootStartMs, windowEndMs)).toBe(
        true,
      );
    });

    test('an entry after the tail is out of window', () => {
      expect(isInBootWindow(entry({ ts: new Date(afterWindowMs) }), bootStartMs, windowEndMs)).toBe(
        false,
      );
    });

    test('an entry before boot start is out of window', () => {
      expect(
        isInBootWindow(entry({ ts: new Date(beforeWindowMs) }), bootStartMs, windowEndMs),
      ).toBe(false);
    });
  });

  describe('countBootWrites', () => {
    const opts = { bootStartMs, windowEndMs, profileUser: AUTH };

    test('a write op by the auth user in-window is counted', () => {
      const entries = [entry({ op: 'insert', ts: new Date(inWindowMs), user: AUTH })];
      expect(countBootWrites(entries, opts)).toBe(1);
    });

    test('a read, an out-of-window op, and another user’s write are all excluded', () => {
      const entries = [
        entry({ op: 'query', ts: new Date(inWindowMs), user: AUTH }), // read
        entry({ op: 'insert', ts: new Date(afterWindowMs), user: AUTH }), // out of window
        entry({ op: 'insert', ts: new Date(inWindowMs), user: API }), // other user
      ];
      expect(countBootWrites(entries, opts)).toBe(0);
    });

    test('a clean boot (reads only, in window) counts zero', () => {
      const entries = [
        entry({ op: 'query', ts: new Date(inWindowMs), user: AUTH }),
        entry({ op: 'command', command: { find: 'users' }, ts: new Date(inWindowMs), user: AUTH }),
      ];
      expect(countBootWrites(entries, opts)).toBe(0);
    });

    test('a request-path createIndexes OUTSIDE the window is not counted (the carve-out)', () => {
      // The window, not the vocabulary, protects the login-path build. An in-window createIndexes
      // WOULD count; the harness guarantees the login happens after the window closes.
      const login = entry({
        op: 'command',
        command: { createIndexes: 'sessions' },
        ts: new Date(afterWindowMs),
        user: AUTH,
      });
      expect(countBootWrites([login], opts)).toBe(0);
    });
  });

  describe('the boot-window anchor — the runner writes it, this check reads it', () => {
    // The anchor is a two-sided arrangement: the runner's root snippet produces the entry, this check
    // looks for it. A rename on either side would silently turn every boot into an "unusable
    // observation", so the pairing is asserted rather than assumed.
    const snippet = buildProfilingSnippet(IDENTITIES.mongoDb);

    test('the snippet creates the anchor collection BEFORE profiling and reads it AFTER', () => {
      const createAnchor = snippet.indexOf(`createCollection("${BOOT_WINDOW_ANCHOR_COLLECTION}")`);
      const enableProfiling = snippet.indexOf('setProfilingLevel(2)');
      const anchorRead = snippet.indexOf(`getCollection("${BOOT_WINDOW_ANCHOR_COLLECTION}")`);
      expect(createAnchor).toBeGreaterThan(-1);
      expect(anchorRead).toBeGreaterThan(-1);
      // Created first so the namespace exists and is not itself profiled; read after so the read IS.
      expect(createAnchor).toBeLessThan(enableProfiling);
      expect(enableProfiling).toBeLessThan(anchorRead);
    });

    test('the anchor operation is a read, so it can never count as a boot write', () => {
      const anchorLine = snippet
        .split('\n')
        .find((line) => line.includes(`getCollection("${BOOT_WINDOW_ANCHOR_COLLECTION}")`));
      expect(anchorLine).toContain('.find(');
      expect(isWriteProfileEntry({ op: 'query', ns: BOOT_WINDOW_ANCHOR_NS })).toBe(false);
      expect(
        isWriteProfileEntry({
          op: 'command',
          command: { find: BOOT_WINDOW_ANCHOR_COLLECTION },
          ns: BOOT_WINDOW_ANCHOR_NS,
        }),
      ).toBe(false);
    });

    test('the namespace the check looks for is the one the snippet touches', () => {
      expect(BOOT_WINDOW_ANCHOR_NS).toBe(`${IDENTITIES.mongoDb}.${BOOT_WINDOW_ANCHOR_COLLECTION}`);
      expect(snippet).toContain(JSON.stringify(BOOT_WINDOW_ANCHOR_COLLECTION));
    });
  });

  describe('assessProfileUsability (Property 6 — no vacuous pass)', () => {
    // The anchor entry the runner's profiling snippet produces: one profiled read of the anchor
    // namespace, issued as root after profiling was enabled and before any container started.
    const anchor = (over = {}) => ({
      ts: new Date(beforeWindowMs),
      ns: BOOT_WINDOW_ANCHOR_NS,
      op: 'query',
      user: 'harness_root@admin',
      ...over,
    });

    test('a surviving anchor entry is a usable observation', () => {
      const entries = [anchor(), entry({ ts: new Date(inWindowMs) })];
      const assessment = assessProfileUsability(entries, bootStartMs);
      expect(assessment.usable).toBe(true);
      expect(assessment.anchorPresent).toBe(true);
    });

    test('the anchor is recognized by the command.find spelling too', () => {
      const commandForm = anchor({
        ns: `${IDENTITIES.mongoDb}.$cmd`,
        op: 'command',
        command: { find: BOOT_WINDOW_ANCHOR_NS.split('.').slice(1).join('.') },
      });
      expect(assessProfileUsability([commandForm], bootStartMs).usable).toBe(true);
    });

    test('an absent anchor signals a rolled profile (unusable), even with entries present', () => {
      // Entries survive, but the anchor — the first thing written after profiling was enabled — is
      // gone, so the capped collection rolled and the earliest part of the window was discarded. That
      // an entry happens to predate boot start does not rescue it: a partial roll can leave one.
      const entries = [
        entry({ ts: new Date(beforeWindowMs) }),
        entry({ ts: new Date(inWindowMs) }),
      ];
      const assessment = assessProfileUsability(entries, bootStartMs);
      expect(assessment.usable).toBe(false);
      expect(assessment.oldestPredatesBootStart).toBe(true);
    });

    test('an empty profile is unusable (never a silent zero)', () => {
      const assessment = assessProfileUsability([], bootStartMs);
      expect(assessment.usable).toBe(false);
      expect(assessment.entryCount).toBe(0);
      expect(assessment.oldestMs).toBeNull();
    });

    test('an unusable observation is reported as an undecided skip, never as a pass or a fail', () => {
      const assessment = assessProfileUsability([], bootStartMs);
      const thrown = undecidedProfileObservation(assessment, {
        bootStartMs,
        windowEndMs,
      });
      // The signal reporter.mjs reads to record a `skip` with OBSERVATION_UNUSABLE rather than a fail.
      expect(parseUndecided(thrown.message)).toEqual({
        reason: SKIP_REASON.OBSERVATION_UNUSABLE,
        observation: expect.stringContaining('could not decide P1'),
      });
      // And that reason must never license exit 0 on its own.
      expect(ENUMERATED_SKIP_REASONS).not.toContain(SKIP_REASON.OBSERVATION_UNUSABLE);
    });
  });
});
