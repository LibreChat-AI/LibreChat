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

/**
 * The same resolution shaped as message fields, so a caller spreads or assigns
 * the result instead of branching on whether the turn carries an override.
 */
export function persistedReasoningOverrideFields(input: PersistedReasoningOverrideInput): {
  reasoningOverride?: TReasoningOverride;
} {
  const reasoningOverride = resolvePersistedReasoningOverride(input);
  return reasoningOverride === undefined ? {} : { reasoningOverride };
}
