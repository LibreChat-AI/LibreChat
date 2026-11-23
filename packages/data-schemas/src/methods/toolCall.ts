import type { Model } from 'mongoose';

interface IToolCallData {
  messageId?: string;
  conversationId?: string;
  user?: string;
  [key: string]: unknown;
}

export function createToolCallMethods(mongoose: typeof import('mongoose')): {
  createToolCall: (toolCallData: IToolCallData) => Promise<IToolCallData>;
  deleteToolCalls: (
    userId: string,
    conversationId?: string,
  ) => Promise<import('mongodb').DeleteResult>;
  getToolCallsByConvo: (
    conversationId: string,
    userId: string,
  ) => Promise<
    (import('mongoose').FlattenMaps<{
      [x: string]: unknown;
      messageId?: string | undefined;
      conversationId?: string | undefined;
      user?: string | undefined;
    }> & {
      _id: import('mongoose').Types.ObjectId;
    } & {
      __v: number;
    })[]
  >;
} {
  /**
   * Create a new tool call
   */
  async function createToolCall(toolCallData: IToolCallData): Promise<IToolCallData> {
    try {
      const ToolCall = mongoose.models.ToolCall as Model<IToolCallData>;
      return await ToolCall.create(toolCallData);
    } catch (error) {
      throw new Error(`Error creating tool call: ${(error as Error).message}`);
    }
  }

  /**
   * Get tool calls by conversation ID and user
   */
  async function getToolCallsByConvo(
    conversationId: string,
    userId: string,
  ): Promise<
    (import('mongoose').FlattenMaps<{
      [x: string]: unknown;
      messageId?: string | undefined;
      conversationId?: string | undefined;
      user?: string | undefined;
    }> & {
      _id: import('mongoose').Types.ObjectId;
    } & {
      __v: number;
    })[]
  > {
    try {
      const ToolCall = mongoose.models.ToolCall as Model<IToolCallData>;
      return await ToolCall.find({ conversationId, user: userId }).lean();
    } catch (error) {
      throw new Error(`Error fetching tool calls: ${(error as Error).message}`);
    }
  }

  /**
   * Delete tool calls by user and optionally conversation
   */
  async function deleteToolCalls(
    userId: string,
    conversationId?: string,
  ): Promise<import('mongodb').DeleteResult> {
    try {
      const ToolCall = mongoose.models.ToolCall as Model<IToolCallData>;
      const query: Record<string, string> = { user: userId };
      if (conversationId) {
        query.conversationId = conversationId;
      }
      return await ToolCall.deleteMany(query);
    } catch (error) {
      throw new Error(`Error deleting tool call: ${(error as Error).message}`);
    }
  }

  return {
    createToolCall,
    deleteToolCalls,
    getToolCallsByConvo,
  };
}

export type ToolCallMethods = ReturnType<typeof createToolCallMethods>;
