// boot-nowrite.filter.mjs — the pure decision logic behind BOOT-NOWRITE-23 (task 10.3).
//
// The boot-write check's whole judgement — which `system.profile` entries are writes, which are
// attributed to the Auth_Surface, which fall inside the boot window, and whether the observation is
// even usable — is expressed here as pure functions over plain profile documents. No Jest, no
// `mongodb`, no live topology: this module is importable and exercisable on its own, the same shape
// serializer.mjs takes so it can be unit-checked without dragging the runner in. The spec
// (boot-nowrite.spec.mjs) imports these and adds the two assertions (Property 6 usability, P1 zero
// count); the live read of `system.profile` under the observer credential is supplied by the live
// topology (task 15).
//
// Attribution and the profile-entry shape follow mongod's own recording (design: "Boot-Write
// Observation"): a CRUD write is a top-level `op` of insert/update/remove; a write command is an
// `op: "command"` naming the command under `command.<name>`; the authenticated principal is
// `user@authSource`; the entry's time is under `ts`.
//
// NG1/NG2 hold: this decides over the harness's own boot observation and touches no application code
// and neither container-split script.

import { AUTH_SURFACE_PROFILE_USER, BOOT_WINDOW_ANCHOR_COLLECTION, IDENTITIES } from '../run.mjs';
import { SKIP_REASON } from '../serializer.mjs';
import { UndecidedObservation } from '../undecided.mjs';

// The `op` values that ARE writes. mongod spells a delete `remove` and an update `update`; an insert
// `insert`. A `query`/`getmore`/`count` is a read and is deliberately absent — that is what makes a
// boot's reads not count as writes.
export const WRITE_OPS = Object.freeze(['insert', 'update', 'remove']);

// The command names that ARE writes when they appear under a `command`-op entry — the design's list
// verbatim: the CRUD write commands (`insert`, `update`, `delete`, `findAndModify`) plus the DDL a
// boot could issue (`createIndexes`, `create`, `drop`, `dropIndexes`). `createIndexes` is on the list
// because it is the one a legitimate request-path build issues — but the carve-out that keeps a
// login's build from tripping the check is the WINDOW, not the vocabulary: an in-window createIndexes
// attributed to the Auth_Surface IS a boot write and IS counted; the harness guarantees a login
// happens outside the window (task 7.2 records the left edge; the runner issues no ingress request
// until the window closes, Req 2.10). `find`/`aggregate`/`count` are reads and absent.
export const WRITE_COMMAND_NAMES = Object.freeze([
  'insert',
  'update',
  'delete',
  'findAndModify',
  'createIndexes',
  'create',
  'drop',
  'dropIndexes',
]);

const WRITE_COMMAND_NAMES_LOWER = Object.freeze(WRITE_COMMAND_NAMES.map((n) => n.toLowerCase()));

// The command name a `command`-op profile entry records. mongod stores the command document under
// `command`, and the command's NAME is that document's first key (`{ createIndexes: "sessions", … }`
// → `createIndexes`). Returns null when the entry names no command.
export function commandNameOf(entry) {
  const command = entry && entry.command;
  if (command === null || typeof command !== 'object') {
    return null;
  }
  const keys = Object.keys(command);
  return keys.length > 0 ? keys[0] : null;
}

// Is this `system.profile` entry a WRITE operation? True when either the top-level `op` is one of the
// CRUD write verbs, OR the entry is a `command` op naming one of the write commands. Comparison of
// the command name is case-insensitive because mongod normalizes `findandmodify` vs `findAndModify`
// inconsistently across versions. A read (`op: "query"`, or `command: { find: … }`) returns false —
// counting reads as writes would fail every clean boot.
export function isWriteProfileEntry(entry) {
  if (entry === null || typeof entry !== 'object') {
    return false;
  }
  if (WRITE_OPS.includes(entry.op)) {
    return true;
  }
  if (entry.op === 'command') {
    const name = commandNameOf(entry);
    return name !== null && WRITE_COMMAND_NAMES_LOWER.includes(name.toLowerCase());
  }
  return false;
}

// The principals mongod attributes an operation to, normalized to `user@authSource` strings. A
// profile entry records the authenticated user under `user` (a string) on newer mongod, or under
// `allUsers`/`users` (an array of `{ user, db }`) on some versions; both are normalized so
// attribution reads one shape. Returns [] when the entry names no user (a system/internal op).
export function profileEntryUsers(entry) {
  if (entry === null || typeof entry !== 'object') {
    return [];
  }
  if (typeof entry.user === 'string' && entry.user !== '') {
    return [entry.user];
  }
  const arr = entry.allUsers ?? entry.users;
  if (Array.isArray(arr)) {
    return arr
      .filter((u) => u && typeof u.user === 'string')
      .map((u) => `${u.user}@${u.db ?? IDENTITIES.authSource}`);
  }
  return [];
}

// Is this entry attributed to the Auth_Surface (`librechat_auth_surface@admin`)? Attribution is what
// makes the count specific: the API_Container writes the same database at the same time under its own
// credential, and only the Auth_Surface's writes falsify P1.
export function isAttributedToAuthSurface(entry, profileUser = AUTH_SURFACE_PROFILE_USER) {
  return profileEntryUsers(entry).includes(profileUser);
}

// The timestamp a `system.profile` entry carries under `ts` (a Date on a live read, or an ISO string
// / epoch millis in a synthetic doc), as epoch millis. Returns null when the entry has no usable
// timestamp.
export function entryEpochMs(entry) {
  const ts = entry && entry.ts;
  if (ts instanceof Date) {
    return ts.getTime();
  }
  if (typeof ts === 'number') {
    return ts;
  }
  if (typeof ts === 'string') {
    const parsed = Date.parse(ts);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

// Is the entry inside the boot window [bootStartMs, windowEndMs] (inclusive)? The window opens at the
// Auth_Surface's process start (captureBootStart's left edge) and closes 60s after `/readyz` first
// returned 200 — both supplied by the harness. An entry with no timestamp is treated as OUT of window
// (the observation-usability guard, not a silent count, is what catches a lost window).
export function isInBootWindow(entry, bootStartMs, windowEndMs) {
  const ms = entryEpochMs(entry);
  if (ms === null) {
    return false;
  }
  return ms >= bootStartMs && ms <= windowEndMs;
}

// The seconds the window's tail extends past the first `/readyz` 200 (design: "closes 60 seconds
// after /readyz first returns 200"). One source so the check and the harness cannot disagree.
export const BOOT_WINDOW_TAIL_MS = 60_000;

// Compute the boot window's right edge from the moment `/readyz` first returned 200.
export function bootWindowEnd(readyAtMs, tailMs = BOOT_WINDOW_TAIL_MS) {
  return readyAtMs + tailMs;
}

// Count the write operations attributed to the Auth_Surface inside the boot window. Pure over an array
// of `system.profile` documents: a write op by the auth user in-window is counted; a read, an
// out-of-window op, or another user's write is not. This is the number BOOT-NOWRITE-23 asserts is
// exactly zero.
export function countBootWrites(profileEntries, { bootStartMs, windowEndMs, profileUser } = {}) {
  return profileEntries.filter(
    (entry) =>
      isWriteProfileEntry(entry) &&
      isAttributedToAuthSurface(entry, profileUser ?? AUTH_SURFACE_PROFILE_USER) &&
      isInBootWindow(entry, bootStartMs, windowEndMs),
  ).length;
}

// The boot-window ANCHOR's namespace: the collection the runner reads once, as root, after enabling
// profiling and before any container starts (run.mjs: BOOT_WINDOW_ANCHOR_COLLECTION). Its entry is the
// first in the freshly recreated `system.profile`, and it sits before the boot window opens.
export const BOOT_WINDOW_ANCHOR_NS = `${IDENTITIES.mongoDb}.${BOOT_WINDOW_ANCHOR_COLLECTION}`;

// Is this profile entry the boot-window anchor? Matched on the namespace mongod records under `ns`,
// with the `command.find` spelling accepted too, since a `command`-op entry names its collection there.
export function isBootWindowAnchorEntry(entry, anchorNs = BOOT_WINDOW_ANCHOR_NS) {
  if (entry === null || typeof entry !== 'object') {
    return false;
  }
  if (entry.ns === anchorNs) {
    return true;
  }
  const collection = entry.command?.find;
  return typeof collection === 'string' && `${IDENTITIES.mongoDb}.${collection}` === anchorNs;
}

// The observation-usability guard (Property 6 — no vacuous pass). A capped `system.profile` that rolled
// discarded its oldest entries, and a zero write count read off a rolled profile is silence mistaken
// for evidence. The guard decides usability on the ANCHOR's presence: the runner issues one profiled
// read before any container starts, so while that entry survives, NOTHING has been discarded since
// profiling was enabled and the profile demonstrably covers the whole boot window.
//
// This replaces "the oldest surviving entry predates the container's start timestamp", which could not
// hold on a healthy run: the profile is dropped and recreated EMPTY milliseconds before the start
// timestamp is recorded, so on every real boot the oldest surviving entry was inside the window and the
// check reported `usable: false` while the observation was in fact intact. Anchor presence is both
// satisfiable and strictly stronger — a partial roll can still leave some entry predating boot start,
// but it cannot leave the anchor. It also does not compare a container-clock timestamp against a
// host-clock one, so clock skew between the two cannot decide it.
//
// Returns `{ usable, anchorPresent, anchorMs, oldestMs, entryCount, oldestPredatesBootStart }` —
// usable is anchorPresent; the rest is diagnostic context the check puts in its observation.
export function assessProfileUsability(profileEntries, bootStartMs, { anchorNs } = {}) {
  const entries = Array.isArray(profileEntries) ? profileEntries : [];
  const timestamps = entries
    .map(entryEpochMs)
    .filter((ms) => ms !== null)
    .sort((a, b) => a - b);
  const oldestMs = timestamps.length > 0 ? timestamps[0] : null;
  const anchors = entries.filter((entry) =>
    isBootWindowAnchorEntry(entry, anchorNs ?? BOOT_WINDOW_ANCHOR_NS),
  );
  const anchorMs = anchors.length > 0 ? entryEpochMs(anchors[0]) : null;
  return {
    usable: anchors.length > 0,
    anchorPresent: anchors.length > 0,
    anchorMs,
    oldestMs,
    entryCount: entries.length,
    oldestPredatesBootStart: oldestMs !== null && oldestMs < bootStartMs,
  };
}

// The observation a check reports when the profile cannot be trusted to cover the boot window. Built
// here, beside the guard that decides it, so the prose and the decision stay together.
//
// It is thrown as an UndecidedObservation, which reporter.mjs records as a `skip` carrying
// OBSERVATION_UNUSABLE — not a pass (the property was not observed to hold) and not a fail (nothing
// was falsified). The reason is outside ENUMERATED_SKIP_REASONS, so the run still exits non-zero: an
// undecided P1 is not a green run. This is the one honest reading of a rolled profile, and it is why
// the design's "a rolled profile fails rather than passing" is implemented as "fails to decide" rather
// than "reports a violation" — the count it would report was never observed.
export function undecidedProfileObservation(assessment, { bootStartMs, windowEndMs }) {
  return new UndecidedObservation(
    SKIP_REASON.OBSERVATION_UNUSABLE,
    'BOOT-NOWRITE-23 could not decide P1: the boot-window anchor is absent from `system.profile`, so ' +
      'the profile cannot be shown to cover the window it must be counted over. The runner issues one ' +
      `profiled read of ${BOOT_WINDOW_ANCHOR_NS} as root after enabling profiling and before any ` +
      'container starts; its absence means the capped collection rolled past the window\u2019s left ' +
      'edge (raise SYSTEM_PROFILE_CAP_BYTES or lower the profiling level) or profiling recorded ' +
      `nothing at all. Observed: ${assessment.entryCount} profile entr${
        assessment.entryCount === 1 ? 'y' : 'ies'
      }, oldest ts ${assessment.oldestMs === null ? 'none' : new Date(assessment.oldestMs).toISOString()}, ` +
      `boot window [${new Date(bootStartMs).toISOString()}, ${new Date(windowEndMs).toISOString()}]. ` +
      'Reported as an unusable observation rather than a pass or a fail: a zero write count read off a ' +
      'rolled profile is silence, and a check that cannot see its property must not report a verdict ' +
      'it did not earn (Property 6).',
  );
}

// Read the boot-window context the live topology publishes for BOOT-NOWRITE-23. The runner (task 15)
// attaches it to globalThis so the Jest worker — which shares the runner's process under
// --runInBand — reaches the observer client and the recorded window edges without a module-level side
// effect. Returns null when no live topology is present (a plain `jest` invocation), which is what
// turns the check into a clean skip. `observerDb` is a read-only `mongodb` Db handle the runner
// connected to the observer plane (127.0.0.1:27019) with the observer credential — never either
// container's grant (Req 3.9); `bootStart` is captureBootStart's `{ epochMs, iso }`; `readyAtMs` is
// the epoch-millis moment `/readyz` first returned 200. Kept here beside the pure decision so the
// spec file exports nothing (task 14.6).
export function readTopologyContext(scope = globalThis) {
  const ctx = scope && scope.__CONTAINER_SPLIT_HARNESS__;
  if (!ctx || typeof ctx !== 'object') {
    return null;
  }
  const { observerDb, bootStart, readyAtMs } = ctx;
  if (!observerDb || typeof bootStart !== 'object' || typeof readyAtMs !== 'number') {
    return null;
  }
  return ctx;
}
