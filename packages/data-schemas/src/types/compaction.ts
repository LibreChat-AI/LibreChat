export const COMPACTION_SEMANTIC_INDEX_PROJECTION_VERSION = 1 as const;
export const MAX_COMPACTION_SEMANTIC_INDEX_ENTRIES = 256;
export const MAX_COMPACTION_SEMANTIC_INDEX_TEXT_LENGTH = 4_096;
export const MAX_COMPACTION_SEMANTIC_INDEX_IDENTITY_LENGTH = 512;
export const MAX_COMPACTION_SEMANTIC_INDEX_SOURCE_CONTENT_INDEX = 4_095;

export type TCompactionSemanticIndexStatus = 'committed' | 'pending';

interface ICompactionSemanticIndexEntryBase {
  type: 'tool_intent' | 'tool_outcome' | 'activity_phase' | 'reasoning_label';
  sourceMessageId: string;
  sourceContentIndex: number;
  revision: number;
  status: TCompactionSemanticIndexStatus;
  text: string;
  redacted?: boolean;
}

export interface ICompactionToolSemanticIndexEntry extends ICompactionSemanticIndexEntryBase {
  type: 'tool_intent' | 'tool_outcome';
  toolCallId: string;
}

export interface ICompactionActivitySemanticIndexEntry extends ICompactionSemanticIndexEntryBase {
  type: 'activity_phase';
}

export interface ICompactionReasoningSemanticIndexEntry extends ICompactionSemanticIndexEntryBase {
  type: 'reasoning_label';
  reasoningStepId: string;
}

export type TCompactionSemanticIndexEntry =
  | ICompactionToolSemanticIndexEntry
  | ICompactionActivitySemanticIndexEntry
  | ICompactionReasoningSemanticIndexEntry;

/** Versioned, JSON-safe continuation projection of SDK compaction guidance. */
export interface ICompactionSemanticIndexProjection {
  version: typeof COMPACTION_SEMANTIC_INDEX_PROJECTION_VERSION;
  entries: TCompactionSemanticIndexEntry[];
  /** Cumulative entries supplied before bounded retention. Absent on legacy snapshots. */
  providedEntryCount?: number;
}

function isBoundedIdentity(value: string | undefined): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_COMPACTION_SEMANTIC_INDEX_IDENTITY_LENGTH
  );
}

function isValidCompactionSemanticIndexEntry(
  entry: Partial<TCompactionSemanticIndexEntry> | null | undefined,
): entry is TCompactionSemanticIndexEntry {
  if (
    entry == null ||
    !isBoundedIdentity(entry.sourceMessageId) ||
    typeof entry.sourceContentIndex !== 'number' ||
    !Number.isSafeInteger(entry.sourceContentIndex) ||
    entry.sourceContentIndex < 0 ||
    entry.sourceContentIndex > MAX_COMPACTION_SEMANTIC_INDEX_SOURCE_CONTENT_INDEX ||
    typeof entry.revision !== 'number' ||
    !Number.isSafeInteger(entry.revision) ||
    entry.revision < 0 ||
    (entry.status !== 'committed' && entry.status !== 'pending') ||
    typeof entry.text !== 'string' ||
    entry.text.length > MAX_COMPACTION_SEMANTIC_INDEX_TEXT_LENGTH ||
    (entry.redacted !== undefined && typeof entry.redacted !== 'boolean') ||
    ((entry.status === 'pending' || entry.redacted === true) && entry.text !== '')
  ) {
    return false;
  }
  if (entry.type === 'activity_phase') {
    return true;
  }
  if (entry.type === 'reasoning_label') {
    return isBoundedIdentity(entry.reasoningStepId);
  }
  if (entry.type === 'tool_intent' || entry.type === 'tool_outcome') {
    return isBoundedIdentity(entry.toolCallId);
  }
  return false;
}

export function isCompactionSemanticIndexProjection(
  projection: Partial<ICompactionSemanticIndexProjection> | null | undefined,
): projection is ICompactionSemanticIndexProjection {
  if (
    projection?.version !== COMPACTION_SEMANTIC_INDEX_PROJECTION_VERSION ||
    !Array.isArray(projection.entries) ||
    projection.entries.length === 0 ||
    projection.entries.length > MAX_COMPACTION_SEMANTIC_INDEX_ENTRIES ||
    (projection.providedEntryCount !== undefined &&
      (!Number.isSafeInteger(projection.providedEntryCount) ||
        projection.providedEntryCount < projection.entries.length))
  ) {
    return false;
  }
  for (const entry of projection.entries) {
    if (!isValidCompactionSemanticIndexEntry(entry)) {
      return false;
    }
  }
  return true;
}
