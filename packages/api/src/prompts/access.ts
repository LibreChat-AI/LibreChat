import { isValidObjectIdString } from '@librechat/data-schemas';
import type { PromptDatabase, PromptGroupRecord, PromptRecord } from './types';
import { toPromptGroupRecord, toPromptRecord } from './records';

export interface PromptViaGroupResource {
  /** The parent group ID, which the access check uses for the ACL lookup. */
  readonly _id: string;
  readonly prompt: PromptRecord;
}

/**
 * Resolvers for the prompt access middleware. A malformed ID or a missing record returns
 * null, so the access check sends its resource 404. A read failure throws, so the access
 * check sends its 500. On success the record becomes `req.resourceAccess.resourceInfo`,
 * which the handlers reuse.
 */
export function createPromptAccessResolvers(
  db: Pick<PromptDatabase, 'getPromptGroup' | 'getPrompt'>,
): {
  resolvePromptGroup(groupId: string): Promise<PromptGroupRecord | null>;
  resolvePromptViaGroup(promptId: string): Promise<PromptViaGroupResource | null>;
} {
  return {
    async resolvePromptGroup(groupId) {
      if (!isValidObjectIdString(groupId)) {
        return null;
      }
      const group = await db.getPromptGroup({ _id: groupId });
      return group == null ? null : toPromptGroupRecord(group);
    },
    async resolvePromptViaGroup(promptId) {
      if (!isValidObjectIdString(promptId)) {
        return null;
      }
      const record = await db.getPrompt({ _id: promptId });
      if (record == null) {
        return null;
      }
      const prompt = toPromptRecord(record);
      return prompt.groupId ? { _id: prompt.groupId, prompt } : null;
    },
  };
}
