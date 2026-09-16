import { reasoningOverrideSchema, type TReasoningOverride } from 'librechat-data-provider';

export type PersistedReasoningOverrideInput = {
  rawReasoningOverride: unknown;
  isEdited?: boolean;
  isCompaction?: boolean;
};

export type PersistedReasoningOverride = TReasoningOverride | undefined;

/**
 * Resolves the validated request-scoped reasoning metadata for a user turn.
 * Existing messages and compaction anchors already represent persisted turns,
 * so only a fresh, non-compaction turn may carry the request override.
 */
export function resolvePersistedReasoningOverride({
  rawReasoningOverride,
  isEdited,
  isCompaction,
}: PersistedReasoningOverrideInput): PersistedReasoningOverride {
  if (isEdited || isCompaction) {
    return undefined;
  }

  const parsed = reasoningOverrideSchema.safeParse(rawReasoningOverride);
  return parsed.success ? parsed.data : undefined;
}

