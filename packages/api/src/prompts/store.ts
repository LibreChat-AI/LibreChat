import type { StoredId, PromptStore, PromptDatabase } from './types';
import { toPromptGroupRecord, toPromptRecord } from './records';

function toIdString(id: StoredId): string {
  return typeof id === 'string' ? id : id.toString();
}

/** The AI-2272 partial unique index is defense in depth: this maps the resulting
 *  duplicate-key race to `createSourceGroup`'s `duplicate` outcome. */
function isDuplicateKeyError(error: unknown): boolean {
  return (error as { code?: number } | undefined)?.code === 11000;
}

/** A document validation failure, mapped to `createSourceGroup`'s `invalid` outcome. */
function isValidationError(error: unknown): boolean {
  return error instanceof Error && error.name === 'ValidationError';
}

/** Local storage for prompt groups and native revisions over the LibreChat prompt
 *  collections. */
export function createPromptStore(db: PromptDatabase): Required<PromptStore> {
  return {
    getPromptGroup: async (groupId) => {
      const record = await db.getPromptGroup({ _id: groupId });
      return record == null ? null : toPromptGroupRecord(record);
    },
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
    findSourceGroup: (identity) => db.findLangfusePromptGroup(identity),
    createSourceGroup: async (input) => {
      const { identity, name, author, authorName } = input;
      try {
        const value = await db.createLangfusePromptGroup({
          ...identity,
          name,
          author,
          authorName,
        });
        return { ok: true, value };
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          return { ok: false, error: { code: 'duplicate' } };
        }
        if (isValidationError(error)) {
          return { ok: false, error: { code: 'invalid', cause: error } };
        }
        throw error;
      }
    },
    getPrompt: async (promptId) => {
      const record = await db.getPrompt({ _id: promptId });
      return record == null ? null : toPromptRecord(record);
    },
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
