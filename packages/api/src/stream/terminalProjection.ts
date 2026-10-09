import type {
  CreatedEvent,
  FinalEvent,
  FinalMessageFields,
  ServerSentEvent,
  StreamEvent,
} from '~/types/events';

/**
 * Transient prompt-building fields that must never reach a terminal cache,
 * durable terminal record, publication or replay.
 *
 * These carry model inputs assembled while building the prompt, not
 * authoritative final state:
 * - `fileContext`: text extracted from attachments for the prompt.
 * - `image_urls`: base64 image inputs accumulated during prompt building.
 *
 * Adding a field here is the deliberate decision to exclude it everywhere a
 * terminal event is stored or transmitted. `ProjectedMessageFields` keeps the
 * TypeScript contract aligned so a projected message cannot be read for one of
 * them without a type error.
 */
export const TRANSIENT_MESSAGE_FIELDS = ['fileContext', 'image_urls'] as const;

/**
 * Transient fields on a message's `files` entries. `files` carries the user's
 * uploads, whose `text` is the body extracted for the prompt, so it is excluded
 * along with the storage bookkeeping (`_id`, `__v`) that both collections share.
 * Every other property is display and download metadata the client needs to keep
 * rendering the attachment after FINAL, so entries are projected field-by-field
 * rather than dropped.
 *
 * Spelled out rather than composed from a shared bookkeeping tuple: `tsdown`
 * builds this package with `--isolatedDeclarations`, which rejects a spread
 * element in an inferred array type (TS9018).
 */
export const TRANSIENT_FILE_FIELDS = ['text', '_id', '__v'] as const;

/**
 * Transient fields on a message's `attachments` entries.
 *
 * `text` is deliberately absent here. `attachments` holds resolved
 * `artifactPromises` — `BaseClient` assigns them onto `responseMessage` — so its
 * `text` is model-generated output that `TextAttachment` renders inline from
 * `file.text ?? ''`. That is authoritative final content, not a prompt input.
 *
 * Excluding it would also be unrecoverable rather than merely lossy:
 * `useAttachmentPreviewSync` polls `GET /api/files/:file_id/preview` only while
 * `status === 'pending'`, and an absent status reads as `'ready'`, so a late or
 * cross-replica subscriber whose only source is the stored FINAL would render a
 * blank preview with no path back to the text.
 */
export const TRANSIENT_ATTACHMENT_FIELDS = ['_id', '__v'] as const;

/** Message-valued slots of a terminal event that can carry transient inputs. */
const MESSAGE_SLOTS = ['requestMessage', 'responseMessage'] as const;

/** Nested collections of file-like entries, each with its own exclusion set. */
const FILE_COLLECTIONS = [
  ['files', TRANSIENT_FILE_FIELDS],
  ['attachments', TRANSIENT_ATTACHMENT_FIELDS],
] as const;

export type TransientMessageField = (typeof TRANSIENT_MESSAGE_FIELDS)[number];

/**
 * A message whose transient prompt-building fields have been excluded.
 *
 * `FinalMessageFields` carries an index signature, so `Omit` alone cannot remove
 * anything from it — `keyof` is `string | number` and the literals are subsumed.
 * The `?: never` mapping is what makes the exclusion real: reading a transient
 * field off a projected message yields `undefined`, and assigning one is an
 * error, so a future field cannot silently pass through the boundary.
 */
export type ProjectedMessageFields = Omit<FinalMessageFields, TransientMessageField> & {
  [K in TransientMessageField]?: never;
};

/** A terminal event safe to cache, persist, publish and replay. */
export type ProjectedFinalEvent = Omit<
  FinalEvent,
  'requestMessage' | 'responseMessage' | 'runMessages'
> & {
  requestMessage?: ProjectedMessageFields | null;
  responseMessage?: ProjectedMessageFields | null;
  runMessages?: ProjectedMessageFields[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Project one file/attachment entry against that collection's exclusion set.
 * Returns the same reference when it carries no excluded field, so a clean event
 * allocates nothing.
 */
function projectFileEntry(entry: unknown, excluded: readonly string[]): unknown {
  if (!isRecord(entry)) {
    return entry;
  }
  let projected: Record<string, unknown> | undefined;
  for (const field of excluded) {
    if (field in entry) {
      projected ??= { ...entry };
      delete projected[field];
    }
  }
  return projected ?? entry;
}

function projectFileCollection(value: unknown, excluded: readonly string[]): unknown {
  if (!Array.isArray(value)) {
    return value;
  }
  let changed = false;
  const projected = value.map((entry) => {
    const next = projectFileEntry(entry, excluded);
    if (next !== entry) {
      changed = true;
    }
    return next;
  });
  return changed ? projected : value;
}

/**
 * Project a single message slot. Preserves `null` and `undefined` distinctly:
 * a caller that deliberately sent `requestMessage: null` (early abort) keeps
 * the null, and an absent slot stays absent.
 */
function projectMessage<T>(message: T): T {
  if (!isRecord(message)) {
    return message;
  }
  let projected: Record<string, unknown> | undefined;

  for (const field of TRANSIENT_MESSAGE_FIELDS) {
    if (field in message) {
      projected ??= { ...message };
      delete projected[field];
    }
  }

  for (const [collection, excluded] of FILE_COLLECTIONS) {
    const current = (projected ?? message)[collection];
    const next = projectFileCollection(current, excluded);
    if (next !== current) {
      projected ??= { ...message };
      projected[collection] = next;
    }
  }

  return (projected ?? message) as T;
}

function projectRunMessages(value: unknown): { value: unknown; changed: boolean } {
  if (!Array.isArray(value)) {
    return { value, changed: false };
  }
  let changed = false;
  const projected = value.map((entry) => {
    const next = projectMessage(entry);
    if (next !== entry) {
      changed = true;
    }
    return next;
  });
  return changed ? { value: projected, changed: true } : { value, changed: false };
}

/** A terminal event is the only kind that carries message payloads. */
function isFinalEvent(event: ServerSentEvent): event is FinalEvent {
  return isRecord(event) && (event as { final?: unknown }).final === true;
}

/**
 * Exclude transient prompt-building data from a terminal event before it is
 * cached, persisted, published or replayed.
 *
 * Selects fields rather than deep-cloning: only the containers along a path
 * that actually holds transient data are rebuilt, the excluded values are never
 * copied, and the input is never mutated (prompt processing, message
 * persistence and lifecycle code may still own those objects).
 *
 * Idempotent and allocation-free for an already-safe event: projecting a clean
 * event returns the identical reference.
 *
 * Non-terminal events (chunks, `created`) carry no message payload and are
 * returned unchanged.
 *
 * The overloads keep the declared return type honest about what the body does.
 * A known `FinalEvent` in yields the `ProjectedFinalEvent` contract out, so an
 * excluded field reads as `undefined` rather than as live data and cannot be
 * reintroduced; a known non-terminal event keeps its exact type; a
 * `ServerSentEvent` union — what every call site in the manager passes — stays a
 * `ServerSentEvent`.
 */
export function projectTerminalEvent(event: FinalEvent): ProjectedFinalEvent;
export function projectTerminalEvent<T extends StreamEvent | CreatedEvent>(event: T): T;
export function projectTerminalEvent(event: ServerSentEvent): ServerSentEvent;
export function projectTerminalEvent<T extends ServerSentEvent>(event: T): T {
  if (!isFinalEvent(event)) {
    return event;
  }

  let projected: Record<string, unknown> | undefined;

  for (const slot of MESSAGE_SLOTS) {
    const current = (event as Record<string, unknown>)[slot];
    const next = projectMessage(current);
    if (next !== current) {
      projected ??= { ...(event as Record<string, unknown>) };
      projected[slot] = next;
    }
  }

  const runMessages = projectRunMessages((event as Record<string, unknown>).runMessages);
  if (runMessages.changed) {
    projected ??= { ...(event as Record<string, unknown>) };
    projected.runMessages = runMessages.value;
  }

  return (projected ?? event) as T;
}
