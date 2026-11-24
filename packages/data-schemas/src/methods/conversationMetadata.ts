import type { FilterQuery, Model, Types } from 'mongoose';
import type { IConversation } from '~/types';
import { buildRetentionVisibilityFilter } from '~/utils/retention';

export type ConversationMetadata = {
  id: string;
  title: string;
  createdAt: string | null;
  updatedAt: string | null;
  agent_id: string | null;
  tags: string[];
  isArchived: boolean;
  endpoint: string | null;
  model: string | null;
};

export type ConversationMetadataScope = { user: string; tenantId: string };
export type ConversationMetadataBoundary = { updatedAt: string | null; id: string };

type ListOptions = {
  limit: number;
  boundary?: ConversationMetadataBoundary;
  agent_id?: string;
  tags?: string[];
  isArchived?: boolean;
};

type Row = Pick<
  IConversation,
  | 'conversationId'
  | 'title'
  | 'createdAt'
  | 'updatedAt'
  | 'agent_id'
  | 'tags'
  | 'isArchived'
  | 'endpoint'
  | 'model'
> & { _id: Types.ObjectId };

const fields = 'conversationId title createdAt updatedAt agent_id tags isArchived endpoint model';

function visible(scope: ConversationMetadataScope): FilterQuery<IConversation> {
  return {
    user: scope.user,
    tenantId: scope.tenantId,
    subagentThread: { $exists: false },
    ...buildRetentionVisibilityFilter<IConversation>(),
  };
}

function timestamp(value?: Date): string | null {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function project(row: Row): ConversationMetadata {
  if (typeof row.conversationId !== 'string') throw new Error('Invalid stored conversation ID');
  return {
    id: row.conversationId,
    title: text(row.title) ?? '',
    createdAt: timestamp(row.createdAt),
    updatedAt: timestamp(row.updatedAt),
    agent_id: text(row.agent_id),
    tags: Array.isArray(row.tags) ? row.tags.filter((tag) => typeof tag === 'string') : [],
    isArchived: row.isArchived === true,
    endpoint: text(row.endpoint),
    model: text(row.model),
  };
}

export type ConversationMetadataMethods = {
  getConversationMetadata: (
    scope: ConversationMetadataScope,
    id: string,
  ) => Promise<ConversationMetadata | null>;
  listConversationMetadata: (
    scope: ConversationMetadataScope,
    options: ListOptions,
  ) => Promise<{ data: ConversationMetadata[]; next: ConversationMetadataBoundary | null }>;
};

export function createConversationMetadataMethods(
  mongoose: typeof import('mongoose'),
): ConversationMetadataMethods {
  async function getConversationMetadata(scope: ConversationMetadataScope, id: string) {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const row = await Conversation.findOne({ ...visible(scope), conversationId: id })
      .select(fields)
      .lean<Row>();
    return row ? project(row) : null;
  }

  async function listConversationMetadata(scope: ConversationMetadataScope, options: ListOptions) {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const { boundary, agent_id, tags, isArchived } = options;
    const limit = Math.max(1, Math.min(100, Math.trunc(options.limit) || 1));
    const base = {
      ...visible(scope),
      ...(agent_id != null && { agent_id }),
      ...(tags?.length && { tags: { $in: tags } }),
      ...(isArchived != null && { isArchived: isArchived ? true : { $ne: true } }),
    };
    const page = (seek: FilterQuery<IConversation>, size: number) =>
      Conversation.find({ $and: [base, seek] })
        .select(fields)
        .sort({ updatedAt: -1, _id: -1 })
        .limit(size)
        .lean<Row[]>();

    let rows: Row[];
    if (boundary == null) {
      rows = await page({}, limit + 1);
    } else {
      const id = new mongoose.Types.ObjectId(boundary.id);
      if (boundary.updatedAt == null) {
        rows = await page({ updatedAt: null, _id: { $lt: id } }, limit + 1);
      } else {
        const date = new Date(boundary.updatedAt);
        rows = await page(
          {
            updatedAt: { $lte: date },
            $or: [{ updatedAt: { $lt: date } }, { updatedAt: date, _id: { $lt: id } }],
          },
          limit + 1,
        );
        // BSON date comparison does not include the null/missing tail. Read it only if
        // the dated group cannot fill the page.
        if (rows.length <= limit) {
          rows.push(...(await page({ updatedAt: null }, limit + 1 - rows.length)));
        }
      }
    }

    const more = rows.length > limit;
    if (more) rows.pop();
    const last = rows[rows.length - 1];
    const next =
      more && last ? { updatedAt: timestamp(last.updatedAt), id: String(last._id) } : null;
    return { data: rows.map(project), next };
  }

  return { getConversationMetadata, listConversationMetadata };
}
