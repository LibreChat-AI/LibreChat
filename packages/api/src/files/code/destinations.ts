import {
  appendLeafSuffix,
  flattenArtifactPath,
  deterministicHexSuffix,
  FILENAME_SEGMENT_MAX_BYTES,
} from '~/utils/files';

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
