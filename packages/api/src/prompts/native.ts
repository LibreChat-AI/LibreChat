import type {
  StoredId,
  PromptRecord,
  PromptDatabase,
  PromptSelection,
  PromptProjection,
  PromptGroupRecord,
  PromptCatalogStore,
  NativePromptAdapter,
  NativeResolvedPrompt,
} from './types';
import { toPromptGroupRecord, toPromptRecord } from './records';

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

async function getPrompt(db: PromptDatabase, promptId: string): Promise<PromptRecord | null> {
  const record = await db.getPrompt({ _id: promptId });
  return record == null ? null : toPromptRecord(record);
}

async function getPromptGroup(
  db: PromptDatabase,
  groupId: string,
): Promise<PromptGroupRecord | null> {
  const record = await db.getPromptGroup({ _id: groupId });
  return record == null ? null : toPromptGroupRecord(record);
}

/** Resolves an exact revision, reading it when `loadedRevision` does not already
 *  match this group and promptId. */
async function resolveExact(
  db: PromptDatabase,
  groupId: string,
  promptId: string,
  loadedRevision?: PromptRecord | null,
): Promise<NativeResolvedValue | null> {
  let revision = loadedRevision;
  if (!isMatchingRevision(revision, groupId, promptId)) {
    revision = await getPrompt(db, promptId);
  }
  return isMatchingRevision(revision, groupId, promptId) ? resolveValue(revision) : null;
}

/**
 * Resolves a group's Production revision. The caller (the service) has already loaded
 * `group`, so this only re-reads the revision itself: when the group's inlined
 * `productionPrompt` is absent or stale it falls back to one `getPrompt` read.
 */
async function resolveProduction(
  db: PromptDatabase,
  group: PromptGroupRecord,
): Promise<NativeResolvedValue | null> {
  if (group.productionId == null) {
    return null;
  }
  if (isMatchingRevision(group.productionPrompt, group._id, group.productionId)) {
    return resolveValue(group.productionPrompt);
  }
  const revision = await getPrompt(db, group.productionId);
  return isMatchingRevision(revision, group._id, group.productionId)
    ? resolveValue(revision)
    : null;
}

function toIdString(id: StoredId): string {
  return typeof id === 'string' ? id : id.toString();
}

export function selectionUnavailableReason(selection: PromptSelection): 'production' | 'revision' {
  return selection.type === 'production' ? 'production' : 'revision';
}

/** Native prompts stored in the LibreChat database. */
export function createNativePromptAdapter(db: PromptDatabase): NativePromptAdapter {
  return {
    resolvePrompt: async ({ group, selection, loadedRevision }) => {
      if (selection.type === 'version') {
        return { ok: false, error: { type: 'unsupported_selection', source: 'native' } };
      }
      const resolved =
        selection.type === 'exact'
          ? await resolveExact(db, group._id, selection.promptId, loadedRevision)
          : await resolveProduction(db, group);
      if (resolved == null) {
        return {
          ok: false,
          error: { type: 'unavailable_selection', reason: selectionUnavailableReason(selection) },
        };
      }
      return { ok: true, value: { source: 'native', ...resolved } };
    },
    getPrompt: (promptId) => getPrompt(db, promptId),
    getPrompts: async (groupId) => (await db.getPrompts({ groupId })).map(toPromptRecord),
    createPromptGroup: async ({ prompt, group = {}, author, authorName }) => {
      const result = await db.createPromptGroup({ prompt, group, author, authorName });
      return {
        prompt: result.prompt == null ? null : toPromptRecord(result.prompt),
        group: toPromptGroupRecord(result.group),
      };
    },
    savePrompt: async ({ groupId, prompt, author }) => {
      const result = await db.savePrompt({ prompt: { ...prompt, groupId }, author });
      return { prompt: toPromptRecord(result.prompt) };
    },
    makePromptProduction: (promptId) => db.makePromptProduction(promptId),
    deletePrompt: async ({ groupId, promptId }) => {
      const result = await db.deletePrompt({ groupId, promptId });
      if (result.promptGroup == null) {
        return { prompt: result.prompt };
      }
      return {
        prompt: result.prompt,
        promptGroup: { message: result.promptGroup.message, id: toIdString(result.promptGroup.id) },
      };
    },
  };
}

/** Local catalog operations over the LibreChat prompt group collection. */
export function createPromptCatalogStore(db: PromptDatabase): PromptCatalogStore {
  return {
    getPromptGroup: (groupId) => getPromptGroup(db, groupId),
    getListPromptGroupsByAccess: async ({ accessibleIds, name, category, limit, after }) => {
      const result = await db.getListPromptGroupsByAccess({
        accessibleIds: [...accessibleIds],
        name,
        category,
        limit,
        after,
      });
      return {
        data: result.data.map(toPromptGroupRecord),
        has_more: result.has_more,
        after: result.after,
      };
    },
    updatePromptGroup: async (groupId, updates) =>
      toPromptGroupRecord(await db.updatePromptGroup({ _id: groupId }, updates)),
    incrementPromptGroupUsage: (groupId) => db.incrementPromptGroupUsage(groupId),
    deletePromptGroup: (groupId) => db.deletePromptGroup({ _id: groupId }),
  };
}
