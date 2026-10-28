import type {
  PromptStore,
  PromptRecord,
  PromptSelection,
  PromptProjection,
  PromptGroupRecord,
  PromptSourceAdapter,
  NativeResolvedPrompt,
} from './types';

type ResolvablePrompt = Pick<PromptRecord, '_id' | 'groupId' | 'prompt' | 'type'>;
type NativeResolvedValue = Omit<NativeResolvedPrompt, 'source'>;

function isMatchingRevision(
  revision: PromptRecord | PromptProjection | null | undefined,
  groupId: string,
  promptId?: string,
): revision is ResolvablePrompt {
  return (
    revision != null &&
    revision._id != null &&
    revision.groupId === groupId &&
    (promptId == null || revision._id === promptId)
  );
}

/** A revision stored without a type is a text prompt, the same default the client uses. */
function resolveValue(revision: ResolvablePrompt): NativeResolvedValue {
  return {
    groupId: revision.groupId,
    promptId: revision._id,
    prompt: revision.prompt,
    type: revision.type ?? 'text',
  };
}

/** Resolves an exact revision, reading it when `loadedRevision` does not already
 *  match this group and promptId. */
async function resolveExact(
  store: Pick<PromptStore, 'getPrompt'>,
  groupId: string,
  promptId: string,
  loadedRevision?: PromptRecord | null,
): Promise<NativeResolvedValue | null> {
  let revision = loadedRevision;
  if (!isMatchingRevision(revision, groupId, promptId)) {
    revision = await store.getPrompt(promptId);
  }
  return isMatchingRevision(revision, groupId, promptId) ? resolveValue(revision) : null;
}

/**
 * Resolves a group's Production revision. The caller (the service) has already loaded
 * `group`, so this only re-reads the revision itself: when the group's inlined
 * `productionPrompt` is absent or stale it falls back to one `getPrompt` read.
 */
async function resolveProduction(
  store: Pick<PromptStore, 'getPrompt'>,
  group: PromptGroupRecord,
): Promise<NativeResolvedValue | null> {
  if (group.productionId == null) {
    return null;
  }
  if (isMatchingRevision(group.productionPrompt, group._id, group.productionId)) {
    return resolveValue(group.productionPrompt);
  }
  const revision = await store.getPrompt(group.productionId);
  return isMatchingRevision(revision, group._id, group.productionId)
    ? resolveValue(revision)
    : null;
}

export function selectionUnavailableReason(selection: PromptSelection): 'production' | 'revision' {
  return selection.type === 'production' ? 'production' : 'revision';
}

/** Native prompts stored in the LibreChat database; resolves content through the
 *  store's `getPrompt`. */
export function createNativePromptAdapter(
  store: Pick<PromptStore, 'getPrompt'>,
): PromptSourceAdapter {
  return {
    resolvePrompt: async ({ group, selection, loadedRevision }) => {
      if (selection.type === 'version') {
        return { ok: false, error: { type: 'unsupported_selection', source: 'native' } };
      }
      const resolved =
        selection.type === 'exact'
          ? await resolveExact(store, group._id, selection.promptId, loadedRevision)
          : await resolveProduction(store, group);
      if (resolved == null) {
        return {
          ok: false,
          error: { type: 'unavailable_selection', reason: selectionUnavailableReason(selection) },
        };
      }
      return { ok: true, value: { source: 'native', ...resolved } };
    },
  };
}
