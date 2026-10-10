import type {
  PromptRecord,
  StoredId,
  PromptDatabase,
  ResolvedPrompt,
  PromptProjection,
  PromptSelection,
  PromptGroupRecord,
  PromptCatalogStore,
  PromptSourceAdapter,
} from './types';
import { toPromptGroupRecord, toPromptRecord } from './records';

type ResolvablePrompt = Pick<PromptRecord, '_id' | 'groupId' | 'prompt' | 'type'>;

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
function resolveValue(revision: ResolvablePrompt): ResolvedPrompt {
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

async function resolveExact(
  db: PromptDatabase,
  groupId: string,
  promptId: string,
  loadedRevision?: PromptRecord | null,
): Promise<ResolvedPrompt | null> {
  let revision = loadedRevision;
  if (!isMatchingRevision(revision, groupId, promptId)) {
    revision = await getPrompt(db, promptId);
  }
  return isMatchingRevision(revision, groupId, promptId) ? resolveValue(revision) : null;
}

async function resolveProduction(
  db: PromptDatabase,
  groupId: string,
  loadedGroup?: PromptGroupRecord | null,
): Promise<ResolvedPrompt | null> {
  let group = loadedGroup;
  if (group?._id !== groupId) {
    group = await getPromptGroup(db, groupId);
  }
  if (group == null || group.productionId == null) {
    return null;
  }
  if (isMatchingRevision(group.productionPrompt, groupId, group.productionId)) {
    return resolveValue(group.productionPrompt);
  }
  const revision = await getPrompt(db, group.productionId);
  return isMatchingRevision(revision, groupId, group.productionId) ? resolveValue(revision) : null;
}

function toIdString(id: StoredId): string {
  return typeof id === 'string' ? id : id.toString();
}

/** Native prompts stored in the LibreChat database. */
export function createNativePromptAdapter(db: PromptDatabase): PromptSourceAdapter {
  return {
    resolvePrompt: ({ groupId, selection, loadedGroup, loadedRevision }) => {
      if (selection.type === 'exact') {
        return resolveExact(db, groupId, selection.promptId, loadedRevision);
      }
      return resolveProduction(db, groupId, loadedGroup);
    },
    getPromptGroup: (groupId) => getPromptGroup(db, groupId),
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

export function selectionUnavailableReason(selection: PromptSelection): 'production' | 'revision' {
  return selection.type === 'production' ? 'production' : 'revision';
}
