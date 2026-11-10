import {
  FileContext,
  getCodeEnvRefForProfile,
  resolveSandboxFilename,
} from 'librechat-data-provider';
import type { CodeEnvReferenceSet } from 'librechat-data-provider';
import {
  appendLeafSuffix,
  flattenArtifactPath,
  deterministicHexSuffix,
  FILENAME_SEGMENT_MAX_BYTES,
} from '~/utils/files';
import { getCodeEnvUploadFilename } from './form';

/**
 * Sandbox input files mount at a destination derived from their `name`, and
 * codeapi rejects the whole `/exec` request when two entries resolve to the
 * same destination — or when one destination is a directory prefix of
 * another (`files contains duplicate destination "x"`, `files contains
 * conflicting destinations "a" and "a/b"`). A rejection is fatal for the
 * rest of the conversation: the request never reaches the sandbox, so no
 * result comes back to collapse the colliding refs, and every later turn
 * re-primes the same pair.
 *
 * Nothing about a LibreChat file record guarantees that uniqueness. Only
 * code-generated outputs are covered by the `(filename, conversationId,
 * context, tenantId)` partial unique index; user uploads carry
 * `context: message_attachment`, so one conversation can hold several
 * records sharing a `filename` — two uploads of `image.png`, or an upload
 * whose name a later execution wrote back in place.
 *
 * This module owns the name → destination mapping so every contributor to
 * an `/exec` file list agrees on it.
 */
export interface CodeDestinationSet {
  readonly names: Set<string>;
  readonly ancestors: Set<string>;
}

export function createCodeDestinationSet(): CodeDestinationSet {
  return { names: new Set<string>(), ancestors: new Set<string>() };
}

function collectAncestors(destination: string): string[] {
  const segments = destination.split('/');
  const ancestors: string[] = [];
  for (let i = 1; i < segments.length; i++) {
    ancestors.push(segments.slice(0, i).join('/'));
  }
  return ancestors;
}

/** True when a claimed file sits at one of `destination`'s parent
 *  directories, so every name under that directory conflicts. */
function hasTakenAncestor(set: CodeDestinationSet, destination: string): boolean {
  const ancestors = collectAncestors(destination);
  for (let i = 0; i < ancestors.length; i++) {
    if (set.names.has(ancestors[i])) {
      return true;
    }
  }
  return false;
}

/** Mirrors codeapi's `validateExecuteFiles` conflict rule: an exact match, or
 *  either destination being a directory prefix of the other. */
function isTaken(set: CodeDestinationSet, destination: string): boolean {
  if (set.names.has(destination) || set.ancestors.has(destination)) {
    return true;
  }
  return hasTakenAncestor(set, destination);
}

function take(set: CodeDestinationSet, destination: string): void {
  set.names.add(destination);
  const ancestors = collectAncestors(destination);
  for (let i = 0; i < ancestors.length; i++) {
    set.ancestors.add(ancestors[i]);
  }
}

/**
 * Inserts `suffix` before the leaf's extension, preserving directory
 * structure (`a/b/c.txt` -> `a/b/c-9f2a11.txt`). The leaf is held to the same
 * per-segment byte budget `sanitizeFilename` applies, since codeapi caps
 * whole-path length and a name already sitting at the cap would otherwise
 * grow past it. The suffix survives that trim, so distinct suffixes stay
 * distinct and the search below always terminates.
 */
function withSuffix(destination: string, suffix: string): string {
  const slash = destination.lastIndexOf('/');
  const dir = slash === -1 ? '' : destination.slice(0, slash + 1);
  const leaf = destination.slice(slash + 1);
  return `${dir}${appendLeafSuffix(leaf, suffix, FILENAME_SEGMENT_MAX_BYTES)}`;
}

/**
 * Claims a destination for `name`, falling back to `<stem>-<identity hash>`
 * when it is already spoken for. Callers that own what the model is told
 * about the sandbox use this: both files stay reachable, at names the caller
 * can echo into the tool context.
 *
 * The fallback hashes `identity` — a stable per-file value such as `file_id`
 * — rather than counting collisions, so a displaced file keeps the same
 * destination for the life of the conversation. A counter would be assigned
 * from the current set: a third file arriving under the literal name a
 * displaced file had been given would push that file along, and code the
 * model wrote in an earlier turn would silently start reading the newcomer.
 * The hash does not depend on what else is present, so a file that has been
 * told to the model at one path stays there.
 *
 * One case still moves it, and deliberately: when a *later* file is itself
 * named the alias, it takes it and the older file falls to a counter. In
 * practice that later file is the model's own in-place rewrite of the
 * displaced one — it was told `<stem>-<hash>.ext`, wrote back to it, and
 * `processCodeOutput` registered an output under that literal name — so the
 * path the model has been using keeps resolving to the newest content at
 * that path, which is the whole point of the recency ordering. Reserving the
 * alias against the newcomer instead would hand that path back to the
 * superseded original. An *unrelated* file reaching this branch would have
 * to be named for the hex digest of another file's `file_id`, which is not
 * a name a user can construct.
 */
export function claimCodeDestination(
  set: CodeDestinationSet,
  name: string,
  identity: string,
): string {
  /* A claimed file sitting at a parent directory makes every name beneath it
   * conflict, so suffixing the leaf can never clear it. Flattening lifts the
   * path out from under that directory and leaves only whole-name conflicts,
   * which the suffix does clear. */
  const base = hasTakenAncestor(set, name)
    ? flattenArtifactPath(name, FILENAME_SEGMENT_MAX_BYTES)
    : name;
  if (!isTaken(set, base)) {
    take(set, base);
    return base;
  }
  const identitySuffix = `-${deterministicHexSuffix(identity)}`;
  let destination = withSuffix(base, identitySuffix);
  for (let counter = 2; isTaken(set, destination); counter++) {
    destination = withSuffix(base, `${identitySuffix}-${counter}`);
  }
  take(set, destination);
  return destination;
}

/**
 * Reserves `name` only if it is free, reporting whether the caller may keep
 * the file. Merge points use this rather than {@link claimCodeDestination}:
 * a renamed destination there would be one the model was never told about,
 * and a conflict at that layer means the same logical file arrived twice
 * under different storage pointers, so dropping the later copy loses
 * nothing.
 */
export function reserveCodeDestination(set: CodeDestinationSet, name: string): boolean {
  if (isTaken(set, name)) {
    return false;
  }
  take(set, name);
  return true;
}

interface CodeDestinationCandidate {
  context?: string;
  file_id?: string;
  createdAt?: Date | string | number;
  /** Last content write for a reused code-output record. `processCodeOutput`
   *  claims one row per `(filename, conversationId)` and rewrites it in
   *  place, so `createdAt` marks when the name was first produced, not when
   *  the bytes behind it last changed. */
  metadata?: { sourceDispatchedAt?: number } | null;
}

function toTime(value: Date | string | number | undefined): number {
  if (value == null) {
    return 0;
  }
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function contentTime(file: CodeDestinationCandidate | null | undefined): number {
  if (
    file?.context === FileContext.execute_code_snapshot &&
    file.metadata?.sourceDispatchedAt != null
  ) {
    return toTime(file.metadata.sourceDispatchedAt);
  }
  return Math.max(toTime(file?.metadata?.sourceDispatchedAt), toTime(file?.createdAt));
}

/**
 * Orders files so the one holding the newest content claims the bare name and
 * the rest take an identity suffix. Newest-wins matches
 * `ToolNode.updateCodeSession`, which collapses by name the same way once
 * results come back, and it is the right answer when an execution rewrote an
 * uploaded file in place: the model's next read of that path gets its own
 * edit, not the superseded original.
 *
 * Recency is `max(metadata.sourceDispatchedAt, createdAt)`, never `updatedAt`.
 * `updatedAt` — the default `getFiles` sort — is bumped by usage accounting
 * and by re-upload, so destinations keyed on it would shuffle between turns
 * and silently repoint paths that code written in an earlier turn still
 * reads. `sourceDispatchedAt` moves only when a generated output's bytes are
 * rewritten, which is exactly when the ranking should change.
 *
 * `privateFileIds` names files that belong to a single contributor rather
 * than to the conversation, and sinks them below the shared ones. Each agent
 * in a run claims destinations over its own set — the conversation's files
 * plus its own — so without this a private file could take a bare name from a
 * shared file in one agent and not in another, leaving two agents advertising
 * different paths for the same file into one shared mount namespace.
 *
 * Holes are tolerated and preserved rather than filtered: callers hand this
 * a raw query result and keep their own per-entry guard.
 */
export function sortCodeFilesByDestinationPriority<T extends CodeDestinationCandidate>(
  files: Array<T | null | undefined>,
  privateFileIds?: ReadonlySet<string>,
): Array<T | null | undefined> {
  const isPrivate = (file: T | null | undefined): number =>
    privateFileIds != null && file?.file_id != null && privateFileIds.has(file.file_id) ? 1 : 0;
  return [...files].sort((a, b) => {
    const scope = isPrivate(a) - isPrivate(b);
    if (scope !== 0) {
      return scope;
    }
    const delta = contentTime(b) - contentTime(a);
    if (delta !== 0) {
      return delta;
    }
    return (a?.file_id ?? '').localeCompare(b?.file_id ?? '');
  });
}

type CodePathCandidate = CodeDestinationCandidate & {
  filename?: string;
  tenantId?: string;
  user?: { toString(): string };
  type?: string;
  metadata?: (CodeEnvReferenceSet & { sourceDispatchedAt?: number }) | null;
};

/** Mount naming only. Captured write paths, not converted names, identify versions. */
export function getCodeFileDestination(file: CodePathCandidate, routeKey = 'default'): string {
  if (
    file.context !== FileContext.execute_code_snapshot &&
    file.context !== FileContext.execute_code
  ) {
    const stored = getCodeEnvRefForProfile(file.metadata ?? undefined, routeKey)?.sandboxFilename;
    if (stored != null) return stored;
  }
  const normalized = getCodeEnvUploadFilename(
    resolveSandboxFilename(file.filename ?? '', file.type ?? ''),
  );
  // A converted artifact's receipt is a mount-name hint only, never byte equivalence.
  if (file.context === FileContext.execute_code_snapshot && normalized !== file.filename) {
    return (
      getCodeEnvRefForProfile(file.metadata ?? undefined, routeKey)?.sandboxFilename ?? normalized
    );
  }
  return normalized;
}

/** Select captured versions among code-eligible inputs before mount conversion. */
export function selectCodeFileGenerations<T extends CodePathCandidate>(
  files: Array<T | null | undefined>,
  privateFileIds?: ReadonlySet<string>,
  routeKey = 'default',
): { files: Array<T | null | undefined>; skippedSuperseded: number } {
  const destinations = new Map<string, T>();
  const generatedPaths = new Set<string>();
  let skippedSuperseded = 0;
  const ordered = sortCodeFilesByDestinationPriority(files, privateFileIds);
  const keyFor = (file: T): string => {
    const generated =
      file.context === FileContext.execute_code_snapshot ||
      file.context === FileContext.execute_code;
    const destination = generated
      ? file.filename
      : (getCodeEnvRefForProfile(file.metadata ?? undefined, routeKey)?.sandboxFilename ??
        getCodeEnvUploadFilename(resolveSandboxFilename(file.filename ?? '', file.type ?? '')));
    return JSON.stringify([
      privateFileIds?.has(file.file_id ?? '') ?? false,
      file.tenantId ?? null,
      file.user?.toString() ?? null,
      destination,
    ]);
  };
  for (const file of ordered) {
    if (!file) continue;
    const key = keyFor(file);
    if (!destinations.has(key)) destinations.set(key, file);
    if (
      file.context === FileContext.execute_code_snapshot ||
      file.context === FileContext.execute_code
    )
      generatedPaths.add(key);
  }
  const selected = ordered.filter((file) => {
    if (!file) return true;
    const key = keyFor(file);
    // Distinct uploads remain independent unless a generated write owns this path.
    if (!generatedPaths.has(key) || destinations.get(key) === file) return true;
    skippedSuperseded++;
    return false;
  });
  return { files: selected, skippedSuperseded };
}

/** Within each scope, literal snapshots precede legacy captures and converted snapshots. */
export function planCodeSnapshotMounts<T extends CodePathCandidate>(
  files: Array<T | null | undefined>,
  privateFileIds?: ReadonlySet<string>,
  routeKey = 'default',
  preferred?: ReadonlyMap<string, string>,
): Map<string, string> {
  const destinations = createCodeDestinationSet();
  const ordered = sortCodeFilesByDestinationPriority(files, privateFileIds);
  const snapshots: T[] = [];
  const receipts: T[] = [];
  const legacyCaptures: T[] = [];
  const isConverted = (file: T): boolean =>
    getCodeEnvUploadFilename(resolveSandboxFilename(file.filename ?? '', file.type ?? '')) !==
    file.filename;
  const seen = new Set<string>();
  for (const file of ordered) {
    if (!file || (file.file_id && seen.has(file.file_id))) continue;
    if (file.file_id) seen.add(file.file_id);
    if (file.context === FileContext.execute_code_snapshot) snapshots.push(file);
    else if (file.context === FileContext.execute_code) legacyCaptures.push(file);
    else receipts.push(file);
  }
  const priority = (file: T): number => {
    if (!isConverted(file)) return 0;
    const assigned =
      preferred?.has(file.file_id ?? '') ||
      getCodeEnvRefForProfile(file.metadata ?? undefined, routeKey)?.sandboxFilename;
    return assigned ? 1 : 2;
  };
  snapshots.sort((a, b) => priority(a) - priority(b));
  const names = new Map<string, string>();
  for (const privateScope of [false, true]) {
    const inScope = (file: T): boolean =>
      (privateFileIds?.has(file.file_id ?? '') ?? false) === privateScope;
    for (const file of receipts) {
      if (!inScope(file)) continue;
      const ref = getCodeEnvRefForProfile(file.metadata ?? undefined, routeKey);
      const name =
        ref?.sandboxFilename ??
        (privateScope && ref != null ? getCodeFileDestination(file, routeKey) : undefined);
      if (!name) continue;
      if (!privateScope) {
        reserveCodeDestination(destinations, name);
        continue;
      }
      const destination = claimCodeDestination(destinations, name, file.file_id ?? name);
      if (file.file_id && destination !== name) names.set(file.file_id, destination);
    }
    const claimSnapshot = (file: T): void => {
      if (!file.file_id || !inScope(file)) return;
      names.set(
        file.file_id,
        claimCodeDestination(
          destinations,
          preferred?.get(file.file_id) ?? getCodeFileDestination(file, routeKey),
          file.file_id,
        ),
      );
    };
    for (const file of snapshots) {
      if (!isConverted(file)) claimSnapshot(file);
    }
    for (const file of legacyCaptures) {
      if (!file.file_id || !inScope(file)) continue;
      // Retain this turn's admission plan, not an alias persisted on another branch.
      const name = preferred?.get(file.file_id) ?? getCodeFileDestination(file, routeKey);
      names.set(file.file_id, claimCodeDestination(destinations, name, file.file_id));
    }
    for (const file of snapshots) {
      if (isConverted(file)) claimSnapshot(file);
    }
  }
  return names;
}
