import type { FilterQuery, Model, ProjectionType } from 'mongoose';
import type { AssistantQuery, IAssistant } from '~/types';
import { buildFilter, type FieldMap } from '~/utils/criteria';
import { createIndexesWithRetry } from '~/utils/retry';

const ASSISTANT_FIELDS: FieldMap<AssistantQuery> = {
  assistantId: 'assistant_id',
  user: 'user',
  avatarFilepath: 'avatar.filepath',
};

/** Translates domain assistant criteria into a Mongo filter. */
function assistantFilter(query: AssistantQuery): FilterQuery<IAssistant> {
  return buildFilter<AssistantQuery, FilterQuery<IAssistant>>(query, ASSISTANT_FIELDS);
}

export function createAssistantMethods(mongoose: typeof import('mongoose')): {
  updateAssistantDoc: (
    query: AssistantQuery,
    updateData: Partial<IAssistant>,
  ) => Promise<IAssistant | null>;
  deleteAssistant: (query: AssistantQuery) => Promise<IAssistant | null>;
  deleteAssistants: (query: AssistantQuery) => Promise<number>;
  getAssistants: (
    query: AssistantQuery,
    select?: string | Record<string, number> | null,
  ) => Promise<IAssistant[]>;
  getAssistant: (
    query: AssistantQuery,
    projection?: ProjectionType<IAssistant>,
  ) => Promise<IAssistant | null>;
  ensureAssistantIndexes: () => Promise<void>;
} {
  const Assistant = () => mongoose.models.Assistant as Model<IAssistant>;
  let assistantIndexesPromise: Promise<void> | null = null;

  function ensureAssistantIndexes(): Promise<void> {
    if (!assistantIndexesPromise) {
      assistantIndexesPromise = createIndexesWithRetry(Assistant()).catch((error) => {
        assistantIndexesPromise = null;
        throw error;
      });
    }
    return assistantIndexesPromise;
  }

  /**
   * Update an assistant with new data without overwriting existing properties,
   * or create a new assistant if it doesn't exist.
   */
  async function updateAssistantDoc(
    query: AssistantQuery,
    updateData: Partial<IAssistant>,
  ): Promise<IAssistant | null> {
    const options = { new: true, upsert: true };
    return await Assistant()
      .findOneAndUpdate(assistantFilter(query), updateData, options)
      .lean<IAssistant>();
  }

  /**
   * Retrieves an assistant document based on the provided search params.
   */
  async function getAssistant(
    query: AssistantQuery,
    projection?: ProjectionType<IAssistant>,
  ): Promise<IAssistant | null> {
    await ensureAssistantIndexes();
    return await Assistant().findOne(assistantFilter(query), projection).lean<IAssistant>();
  }

  /**
   * Retrieves all assistants that match the given search parameters.
   */
  async function getAssistants(
    query: AssistantQuery,
    select: string | Record<string, number> | null = null,
  ): Promise<IAssistant[]> {
    const search = Assistant().find(assistantFilter(query));

    return await (select ? search.select(select) : search).lean<IAssistant[]>();
  }

  /**
   * Deletes an assistant based on the provided search params.
   */
  async function deleteAssistant(query: AssistantQuery): Promise<IAssistant | null> {
    return await Assistant().findOneAndDelete(assistantFilter(query));
  }

  /**
   * Deletes all assistants matching the given search parameters.
   */
  async function deleteAssistants(query: AssistantQuery): Promise<number> {
    const result = await Assistant().deleteMany(assistantFilter(query));
    return result.deletedCount;
  }

  return {
    updateAssistantDoc,
    deleteAssistant,
    deleteAssistants,
    getAssistants,
    getAssistant,
    ensureAssistantIndexes,
  };
}

export type AssistantMethods = ReturnType<typeof createAssistantMethods>;
