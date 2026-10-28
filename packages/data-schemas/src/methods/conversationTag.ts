import type { Model } from 'mongoose';
import { tenantSafeBulkWrite } from '~/utils/tenantBulkWrite';
import logger from '~/config/winston';

interface IConversationTag {
  user: string;
  tag: string;
  description?: string;
  position: number;
  count: number;
  createdAt?: Date;
  [key: string]: unknown;
}

/**
 * Atomically decrements tag counts for a user. Each entry in `tags` counts as a
 * single decrement, so callers must dedupe tags per conversation before flattening
 * to avoid double-decrementing a conversation's duplicate tag entries. Counts are
 * clamped at zero to tolerate any pre-existing drift.
 *
 * Each tag emits three ops in one ordered bulkWrite instead of a
 * `$max`/`$subtract` aggregation-pipeline update (which Amazon DocumentDB
 * rejects): normalize a null/missing count to zero, apply the `$inc`, then
 * clamp a negative result back to zero. The clamp keys on `count < 0` rather
 * than `count < amount` so it composes with concurrent decrements of the same
 * tag: increments commute and every interleaved call ends with its own clamp,
 * so the count still converges on `max(0, ...)` exactly as the serialized
 * pipeline did. The only trade-off is a transiently negative count between an
 * op pair, which readers already tolerate.
 */
export async function decrementTagCounts(
  mongoose: typeof import('mongoose'),
  user: string,
  tags: string[],
): Promise<void> {
  if (!tags.length) {
    return;
  }

  const decrementByTag = new Map<string, number>();
  for (const tag of tags) {
    if (!tag) {
      continue;
    }
    decrementByTag.set(tag, (decrementByTag.get(tag) ?? 0) + 1);
  }

  if (decrementByTag.size === 0) {
    return;
  }

  try {
    const ConversationTag = mongoose.models.ConversationTag as Model<IConversationTag>;
    const bulkOps = [...decrementByTag.entries()].flatMap(([tag, amount]) => [
      {
        updateOne: {
          filter: { user, tag, count: null },
          update: { $set: { count: 0 } },
        },
      },
      {
        updateOne: {
          filter: { user, tag },
          update: { $inc: { count: -amount } },
        },
      },
      {
        updateOne: {
          filter: { user, tag, count: { $lt: 0 } },
          update: { $set: { count: 0 } },
        },
      },
    ]);

    await tenantSafeBulkWrite(ConversationTag, bulkOps);
  } catch (error) {
    logger.error('[decrementTagCounts] Error decrementing tag counts', error);
  }
}

export function createConversationTagMethods(mongoose: typeof import('mongoose')): {
  getConversationTags: (user: string) => Promise<
    (import('mongoose').FlattenMaps<{
      [x: string]: unknown;
      user: string;
      tag: string;
      description?: string | undefined;
      position: number;
      count: number;
      createdAt?: Date | undefined;
    }> & {
      _id: import('mongoose').Types.ObjectId;
    } & {
      __v: number;
    })[]
  >;
  createConversationTag: (
    user: string,
    data: {
      tag: string;
      description?: string;
      addToConversation?: boolean;
      conversationId?: string;
    },
  ) => Promise<
    | (import('mongoose').FlattenMaps<{
        [x: string]: unknown;
        user: string;
        tag: string;
        description?: string | undefined;
        position: number;
        count: number;
        createdAt?: Date | undefined;
      }> & {
        _id: import('mongoose').Types.ObjectId;
      } & {
        __v: number;
      })
    | null
  >;
  updateConversationTag: (
    user: string,
    oldTag: string,
    data: { tag?: string; description?: string; position?: number },
  ) => Promise<
    | (import('mongoose').FlattenMaps<{
        [x: string]: unknown;
        user: string;
        tag: string;
        description?: string | undefined;
        position: number;
        count: number;
        createdAt?: Date | undefined;
      }> & {
        _id: import('mongoose').Types.ObjectId;
      } & {
        __v: number;
      })
    | null
  >;
  deleteConversationTag: (
    user: string,
    tag: string,
  ) => Promise<
    | (import('mongoose').FlattenMaps<{
        [x: string]: unknown;
        user: string;
        tag: string;
        description?: string | undefined;
        position: number;
        count: number;
        createdAt?: Date | undefined;
      }> & {
        _id: import('mongoose').Types.ObjectId;
      } & {
        __v: number;
      })
    | null
  >;
  deleteConversationTags: (filter: Record<string, unknown>) => Promise<number>;
  bulkIncrementTagCounts: (user: string, tags: string[]) => Promise<void>;
  updateTagsForConversation: (
    user: string,
    conversationId: string,
    tags: string[],
  ) => Promise<string[]>;
} {
  /**
   * Retrieves all conversation tags for a user.
   */
  async function getConversationTags(user: string): Promise<
    (import('mongoose').FlattenMaps<{
      [x: string]: unknown;
      user: string;
      tag: string;
      description?: string | undefined;
      position: number;
      count: number;
      createdAt?: Date | undefined;
    }> & {
      _id: import('mongoose').Types.ObjectId;
    } & {
      __v: number;
    })[]
  > {
    try {
      const ConversationTag = mongoose.models.ConversationTag as Model<IConversationTag>;
      return await ConversationTag.find({ user }).sort({ position: 1 }).lean();
    } catch (error) {
      logger.error('[getConversationTags] Error getting conversation tags', error);
      throw new Error('Error getting conversation tags');
    }
  }

  /**
   * Creates a new conversation tag.
   */
  async function createConversationTag(
    user: string,
    data: {
      tag: string;
      description?: string;
      addToConversation?: boolean;
      conversationId?: string;
    },
  ): Promise<
    | (import('mongoose').FlattenMaps<{
        [x: string]: unknown;
        user: string;
        tag: string;
        description?: string | undefined;
        position: number;
        count: number;
        createdAt?: Date | undefined;
      }> & {
        _id: import('mongoose').Types.ObjectId;
      } & {
        __v: number;
      })
    | null
  > {
    try {
      const ConversationTag = mongoose.models.ConversationTag as Model<IConversationTag>;
      const Conversation = mongoose.models.Conversation;
      const { tag, description, addToConversation, conversationId } = data;

      const existingTag = await ConversationTag.findOne({ user, tag }).lean();
      if (existingTag) {
        return existingTag;
      }

      const maxPosition = await ConversationTag.findOne({ user }).sort('-position').lean();
      const position = (maxPosition?.position || 0) + 1;

      const newTag = await ConversationTag.findOneAndUpdate(
        { tag, user },
        {
          tag,
          user,
          count: addToConversation ? 1 : 0,
          position,
          description,
          $setOnInsert: { createdAt: new Date() },
        },
        {
          new: true,
          upsert: true,
          lean: true,
        },
      );

      if (addToConversation && conversationId) {
        await Conversation.findOneAndUpdate(
          { user, conversationId },
          { $addToSet: { tags: tag } },
          { new: true },
        );
      }

      return newTag;
    } catch (error) {
      logger.error('[createConversationTag] Error creating conversation tag', error);
      throw new Error('Error creating conversation tag');
    }
  }

  /**
   * Adjusts positions of tags when a tag's position is changed.
   */
  async function adjustPositions(user: string, oldPosition: number, newPosition: number) {
    if (oldPosition === newPosition) {
      return;
    }

    const ConversationTag = mongoose.models.ConversationTag as Model<IConversationTag>;

    const update =
      oldPosition < newPosition ? { $inc: { position: -1 } } : { $inc: { position: 1 } };
    const position =
      oldPosition < newPosition
        ? {
            $gt: Math.min(oldPosition, newPosition),
            $lte: Math.max(oldPosition, newPosition),
          }
        : {
            $gte: Math.min(oldPosition, newPosition),
            $lt: Math.max(oldPosition, newPosition),
          };

    await ConversationTag.updateMany({ user, position }, update);
  }

  /**
   * Updates an existing conversation tag.
   */
  async function updateConversationTag(
    user: string,
    oldTag: string,
    data: { tag?: string; description?: string; position?: number },
  ): Promise<
    | (import('mongoose').FlattenMaps<{
        [x: string]: unknown;
        user: string;
        tag: string;
        description?: string | undefined;
        position: number;
        count: number;
        createdAt?: Date | undefined;
      }> & {
        _id: import('mongoose').Types.ObjectId;
      } & {
        __v: number;
      })
    | null
  > {
    try {
      const ConversationTag = mongoose.models.ConversationTag as Model<IConversationTag>;
      const Conversation = mongoose.models.Conversation;
      const { tag: newTag, description, position } = data;

      const existingTag = await ConversationTag.findOne({ user, tag: oldTag }).lean();
      if (!existingTag) {
        return null;
      }

      if (newTag && newTag !== oldTag) {
        const tagAlreadyExists = await ConversationTag.findOne({ user, tag: newTag }).lean();
        if (tagAlreadyExists) {
          throw new Error('Tag already exists');
        }

        await Conversation.updateMany({ user, tags: oldTag }, { $set: { 'tags.$': newTag } });
      }

      const updateData: Record<string, unknown> = {};
      if (newTag) {
        updateData.tag = newTag;
      }
      if (description !== undefined) {
        updateData.description = description;
      }
      if (position !== undefined) {
        await adjustPositions(user, existingTag.position, position);
        updateData.position = position;
      }

      return await ConversationTag.findOneAndUpdate({ user, tag: oldTag }, updateData, {
        new: true,
        lean: true,
      });
    } catch (error) {
      logger.error('[updateConversationTag] Error updating conversation tag', error);
      throw new Error('Error updating conversation tag');
    }
  }

  /**
   * Deletes a conversation tag.
   */
  async function deleteConversationTag(
    user: string,
    tag: string,
  ): Promise<
    | (import('mongoose').FlattenMaps<{
        [x: string]: unknown;
        user: string;
        tag: string;
        description?: string | undefined;
        position: number;
        count: number;
        createdAt?: Date | undefined;
      }> & {
        _id: import('mongoose').Types.ObjectId;
      } & {
        __v: number;
      })
    | null
  > {
    try {
      const ConversationTag = mongoose.models.ConversationTag as Model<IConversationTag>;
      const Conversation = mongoose.models.Conversation;

      const deletedTag = await ConversationTag.findOneAndDelete({ user, tag }).lean();
      if (!deletedTag) {
        return null;
      }

      await Conversation.updateMany({ user, tags: tag }, { $pullAll: { tags: [tag] } });

      await ConversationTag.updateMany(
        { user, position: { $gt: deletedTag.position } },
        { $inc: { position: -1 } },
      );

      return deletedTag;
    } catch (error) {
      logger.error('[deleteConversationTag] Error deleting conversation tag', error);
      throw new Error('Error deleting conversation tag');
    }
  }

  /**
   * Updates tags for a specific conversation.
   */
  async function updateTagsForConversation(
    user: string,
    conversationId: string,
    tags: string[],
  ): Promise<string[]> {
    try {
      const ConversationTag = mongoose.models.ConversationTag as Model<IConversationTag>;
      const Conversation = mongoose.models.Conversation;

      const conversation = await Conversation.findOne({ user, conversationId }, 'tags').lean();
      if (!conversation) {
        throw new Error('Conversation not found');
      }

      const oldTags = new Set<string>(
        ((conversation as Record<string, unknown>).tags as string[]) ?? [],
      );
      const newTags = new Set(tags);

      const addedTags = [...newTags].filter((tag) => !oldTags.has(tag));
      const removedTags = [...oldTags].filter((tag) => !newTags.has(tag));

      const bulkOps: Array<{
        updateOne: {
          filter: Record<string, unknown>;
          update: Record<string, unknown>;
          upsert?: boolean;
        };
      }> = [];

      for (const tag of addedTags) {
        bulkOps.push({
          updateOne: {
            filter: { user, tag },
            update: { $inc: { count: 1 } },
            upsert: true,
          },
        });
      }

      for (const tag of removedTags) {
        bulkOps.push({
          updateOne: {
            filter: { user, tag },
            update: { $inc: { count: -1 } },
          },
        });
      }

      if (bulkOps.length > 0) {
        await tenantSafeBulkWrite(ConversationTag, bulkOps);
      }

      const updatedConversation = await Conversation.findOneAndUpdate(
        { user, conversationId },
        { $set: { tags: [...newTags] } },
        { new: true, projection: { tags: 1 } },
      ).lean<{ tags: string[] }>();

      return (updatedConversation as { tags: string[] }).tags;
    } catch (error) {
      logger.error('[updateTagsForConversation] Error updating tags', error);
      throw new Error('Error updating tags for conversation');
    }
  }

  /**
   * Increments tag counts for existing tags only.
   */
  async function bulkIncrementTagCounts(user: string, tags: string[]): Promise<void> {
    if (!tags || tags.length === 0) {
      return;
    }

    try {
      const ConversationTag = mongoose.models.ConversationTag as Model<IConversationTag>;
      const uniqueTags = [...new Set(tags.filter(Boolean))];
      if (uniqueTags.length === 0) {
        return;
      }

      const bulkOps = uniqueTags.map((tag) => ({
        updateOne: {
          filter: { user, tag },
          update: { $inc: { count: 1 } },
        },
      }));

      const result = await tenantSafeBulkWrite(ConversationTag, bulkOps);
      if (result && result.modifiedCount > 0) {
        logger.debug(
          `user: ${user} | Incremented tag counts - modified ${result.modifiedCount} tags`,
        );
      }
    } catch (error) {
      logger.error('[bulkIncrementTagCounts] Error incrementing tag counts', error);
    }
  }

  /**
   * Deletes all conversation tags matching the given filter.
   */
  async function deleteConversationTags(filter: Record<string, unknown>): Promise<number> {
    try {
      const ConversationTag = mongoose.models.ConversationTag as Model<IConversationTag>;
      const result = await ConversationTag.deleteMany(filter);
      return result.deletedCount;
    } catch (error) {
      logger.error('[deleteConversationTags] Error deleting conversation tags', error);
      throw new Error('Error deleting conversation tags');
    }
  }

  return {
    getConversationTags,
    createConversationTag,
    updateConversationTag,
    deleteConversationTag,
    deleteConversationTags,
    bulkIncrementTagCounts,
    updateTagsForConversation,
  };
}

export type ConversationTagMethods = ReturnType<typeof createConversationTagMethods>;
