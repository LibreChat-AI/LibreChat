import { MEMORY_FILTER_FIELDS, hasActivePiiPatterns } from 'librechat-data-provider';
import type { FiltersConfig, MemoryFilterField } from 'librechat-data-provider';
import type { ContentTraversalLimitError } from '../protection/adapters/nested';
import type { MemoryContentInput } from '../protection/adapters/submissions';
import type { TextContentFragment } from '../protection/types';
import {
  getContentTraversalScopes,
  getContentTraversalFragments,
  isContentTraversalProtected,
  isContentTraversalLimitError,
} from '../protection/adapters/nested';
import { extractMemoryContent } from '../protection/adapters/submissions';
import { inspectContent } from '../protection/runtime';

export type ProjectedStoredMemory<T extends MemoryContentInput> = T & {
  readonly contentFilterBlocked?: true;
};

interface StoredMemoryProjectionDeps {
  readonly extract?: (memory: MemoryContentInput) => Iterable<TextContentFragment>;
}

interface ExtractedMemoryFragments {
  readonly fragments: readonly TextContentFragment[];
  readonly traversalError: ContentTraversalLimitError | null;
}

function extractStoredMemoryFragments(
  memory: MemoryContentInput,
  extract: StoredMemoryProjectionDeps['extract'],
): ExtractedMemoryFragments {
  try {
    return {
      fragments: [...(extract?.(memory) ?? extractMemoryContent(memory))],
      traversalError: null,
    };
  } catch (error) {
    if (!isContentTraversalLimitError(error)) {
      throw error;
    }
    return { fragments: getContentTraversalFragments(error), traversalError: error };
  }
}

function getBlockedMemoryFields(
  memory: MemoryContentInput,
  filters: FiltersConfig,
  extract: StoredMemoryProjectionDeps['extract'],
  selectedFields: readonly MemoryFilterField[],
  selectedFieldSet: ReadonlySet<MemoryFilterField>,
): ReadonlySet<MemoryFilterField> {
  const fragmentsByField = new Map<MemoryFilterField, TextContentFragment[]>();
  const blockedFields = new Set<MemoryFilterField>();
  const { fragments, traversalError } = extractStoredMemoryFragments(memory, extract);

  for (const fragment of fragments) {
    if (fragment.source !== 'memory' || !selectedFieldSet.has(fragment.field)) {
      continue;
    }
    const fieldFragments = fragmentsByField.get(fragment.field) ?? [];
    fieldFragments.push(fragment);
    fragmentsByField.set(fragment.field, fieldFragments);
  }

  for (const field of selectedFields) {
    if (inspectContent(fragmentsByField.get(field) ?? [], { filters }) != null) {
      blockedFields.add(field);
    }
  }

  if (traversalError != null && isContentTraversalProtected({ error: traversalError, filters })) {
    for (const scope of getContentTraversalScopes(traversalError)) {
      if (scope.source !== 'memory') {
        continue;
      }
      for (const field of scope.fields) {
        if (selectedFieldSet.has(field)) {
          blockedFields.add(field);
        }
      }
    }
  }

  return blockedFields;
}

function redactStoredMemory<T extends MemoryContentInput>(
  memory: T,
  blockedFields: ReadonlySet<MemoryFilterField>,
): ProjectedStoredMemory<T> {
  const redactKey = blockedFields.has('key');
  const redactValue = blockedFields.has('value');
  const redactSummary = blockedFields.has('summary') && memory.summary !== undefined;
  return {
    ...memory,
    ...(redactKey ? { key: '' } : {}),
    ...(redactValue ? { value: '' } : {}),
    ...(redactSummary ? { summary: '' } : {}),
    contentFilterBlocked: true,
  };
}

/** Reapplies current memory policy while preserving structural management fields. */
export function projectStoredMemories<T extends MemoryContentInput>(
  memories: readonly T[],
  filters?: FiltersConfig,
  deps: StoredMemoryProjectionDeps = {},
): ProjectedStoredMemory<T>[] {
  if (filters == null) {
    return [...memories];
  }
  const pii = filters.memories?.pii;
  if (pii == null || !hasActivePiiPatterns(pii) || pii.fields?.length === 0) {
    return [...memories];
  }

  const extract = deps.extract ?? extractMemoryContent;
  const selectedFieldSet = new Set<MemoryFilterField>(pii.fields ?? MEMORY_FILTER_FIELDS);
  const selectedFields = [...selectedFieldSet];
  return memories.map((memory) => {
    const blockedFields = getBlockedMemoryFields(
      memory,
      filters,
      extract,
      selectedFields,
      selectedFieldSet,
    );
    if (blockedFields.size === 0) {
      return memory;
    }
    return redactStoredMemory(memory, blockedFields);
  });
}
