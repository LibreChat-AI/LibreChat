import {
  FileContext,
  MAX_CHAT_PROJECT_FILES,
  MAX_CHAT_PROJECT_INSTRUCTIONS_LENGTH,
  MAX_CHAT_PROJECT_NAME_LENGTH,
  MAX_CHAT_PROJECT_DESCRIPTION_LENGTH,
} from 'librechat-data-provider';
import type { FilterQuery, Model, SortOrder, Types } from 'mongoose';
import type { TChatProjectsConfig } from 'librechat-data-provider';
import type { IChatProject, IChatProjectDocument, IConversation, IMongoFile } from '~/types';
import { buildRetentionVisibilityFilter } from '~/utils/retention';
import { isValidObjectIdString } from '~/utils/objectId';
import { escapeRegExp } from '~/utils/string';
import logger from '~/config/winston';

export type ChatProjectSortBy = 'name' | 'createdAt' | 'lastConversationAt';
export type ChatProjectSortDirection = 'asc' | 'desc';

export type CreateChatProjectInput = {
  name: string;
  description?: string | null;
  instructions?: string;
};

export type UpdateChatProjectInput = Partial<CreateChatProjectInput> & {
  contextRevision?: number;
};

export const CHAT_PROJECT_CONFLICT = 'Project revision conflict';

export type ListChatProjectsOptions = {
  cursor?: string | null;
  limit?: number;
  sortBy?: ChatProjectSortBy;
  sortDirection?: ChatProjectSortDirection;
  search?: string;
};

export type ListChatProjectsResult = {
  projects: IChatProject[];
  nextCursor: string | null;
};

export type DeleteChatProjectResult = {
  deletedCount: number;
  modifiedCount: number;
};

export type AssignConversationToProjectResult = {
  conversation: IConversation;
  previousProjectId: string | null;
  projectId: string | null;
};

export interface ChatProjectMethods {
  createChatProject(
    user: string,
    input: CreateChatProjectInput,
    limits?: Partial<ChatProjectLimits>,
  ): Promise<IChatProject>;
  getChatProject(user: string, projectId: string): Promise<IChatProject | null>;
  listChatProjects(
    user: string,
    options?: ListChatProjectsOptions,
  ): Promise<ListChatProjectsResult>;
  updateChatProject(
    user: string,
    projectId: string,
    input: UpdateChatProjectInput,
    limits?: Partial<ChatProjectLimits>,
  ): Promise<IChatProject | null>;
  deleteChatProject(user: string, projectId: string): Promise<DeleteChatProjectResult>;
  addChatProjectFile(
    user: string,
    projectId: string,
    fileId: string,
    limits?: Partial<ChatProjectLimits>,
  ): Promise<IChatProject | null>;
  removeChatProjectFile(
    user: string,
    projectId: string,
    fileId: string,
  ): Promise<IChatProject | null>;
  assignConversationToProject(
    user: string,
    conversationId: string,
    projectId: string | null,
  ): Promise<AssignConversationToProjectResult | null>;
  refreshChatProjectStats(user: string, projectId: string): Promise<IChatProject | null>;
}

type ProjectCursor = {
  primary: string | null;
  id: string;
};
export type ChatProjectLimits = Pick<
  TChatProjectsConfig,
  'maxFiles' | 'maxInstructionsLength' | 'maxDescriptionLength'
>;

type ProjectStatsSnapshot = Pick<
  IChatProject,
  'conversationCount' | 'lastConversationAt' | 'lastConversationId'
>;
type ProjectLean = IChatProject & { _id: Types.ObjectId };

const VALID_SORT_FIELDS = new Set<ChatProjectSortBy>(['name', 'createdAt', 'lastConversationAt']);
const PROJECT_STATS_REFRESH_MAX_ATTEMPTS = 8;

const resolveChatProjectLimits = (limits?: Partial<ChatProjectLimits>): ChatProjectLimits => ({
  maxFiles: limits?.maxFiles ?? MAX_CHAT_PROJECT_FILES,
  maxInstructionsLength: limits?.maxInstructionsLength ?? MAX_CHAT_PROJECT_INSTRUCTIONS_LENGTH,
  maxDescriptionLength: limits?.maxDescriptionLength ?? MAX_CHAT_PROJECT_DESCRIPTION_LENGTH,
});

function normalizeSortBy(sortBy?: string): ChatProjectSortBy {
  return VALID_SORT_FIELDS.has(sortBy as ChatProjectSortBy)
    ? (sortBy as ChatProjectSortBy)
    : 'lastConversationAt';
}

function normalizeSortDirection(sortDirection?: string): ChatProjectSortDirection {
  return sortDirection === 'asc' ? 'asc' : 'desc';
}

function normalizeLimit(limit?: number): number {
  if (!Number.isFinite(limit) || !limit) {
    return 25;
  }
  return Math.min(Math.max(Math.floor(limit), 1), 100);
}

function validateProjectInstructions(
  instructions: string | undefined,
  limits?: Partial<ChatProjectLimits>,
): string {
  if (instructions === undefined) {
    return '';
  }
  const { maxInstructionsLength } = resolveChatProjectLimits(limits);
  if (typeof instructions !== 'string' || instructions.length > maxInstructionsLength) {
    throw new Error('Invalid project instructions');
  }
  return instructions.trim();
}

function sanitizeProjectInput(
  input: CreateChatProjectInput,
  limits?: Partial<ChatProjectLimits>,
): CreateChatProjectInput {
  const { maxDescriptionLength } = resolveChatProjectLimits(limits);
  return {
    name: input.name.trim().slice(0, MAX_CHAT_PROJECT_NAME_LENGTH),
    description: input.description?.trim().slice(0, maxDescriptionLength) ?? '',
    instructions: validateProjectInstructions(input.instructions, limits),
  };
}

function parseCursor(cursor?: string | null): ProjectCursor | null {
  if (!cursor) {
    return null;
  }

  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64').toString()) as ProjectCursor;
    if (!decoded.id || !isValidObjectIdString(decoded.id)) {
      return null;
    }
    return {
      primary: decoded.primary ?? null,
      id: decoded.id,
    };
  } catch {
    logger.warn('[listChatProjects] Invalid cursor format, starting from beginning');
    return null;
  }
}

function encodeCursor(project: ProjectLean, sortBy: ChatProjectSortBy): string {
  let primary: string | null = null;
  if (sortBy === 'name') {
    primary = project.name;
  } else {
    const date = project[sortBy];
    primary = date instanceof Date ? date.toISOString() : null;
  }
  return Buffer.from(JSON.stringify({ primary, id: project._id.toString() })).toString('base64');
}

function cursorPrimaryValue(
  primary: string | null,
  sortBy: ChatProjectSortBy,
): string | Date | null | undefined {
  if (primary == null) {
    return sortBy === 'lastConversationAt' ? null : undefined;
  }

  if (sortBy === 'name') {
    return primary;
  }

  const date = new Date(primary);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function createCursorFilter(
  mongoose: typeof import('mongoose'),
  cursor: ProjectCursor | null,
  sortBy: ChatProjectSortBy,
  sortDirection: ChatProjectSortDirection,
): FilterQuery<IChatProjectDocument> | null {
  if (!cursor) {
    return null;
  }

  const op = sortDirection === 'asc' ? '$gt' : '$lt';
  const id = new mongoose.Types.ObjectId(cursor.id);
  const primary = cursorPrimaryValue(cursor.primary, sortBy);

  if (primary === undefined) {
    logger.warn('[listChatProjects] Invalid cursor primary value, starting from beginning');
    return null;
  }

  const branches: FilterQuery<IChatProjectDocument>[] = [
    { [sortBy]: { [op]: primary } },
    { [sortBy]: primary, _id: { [op]: id } },
  ];

  /**
   * Projects with no conversations have `lastConversationAt: null`, which sorts
   * after all dated projects in descending order. A `$lt: <date>` predicate does
   * not match null, so once the cursor moves past the dated projects we must
   * include the null bucket explicitly, otherwise empty projects never paginate.
   */
  if (sortBy === 'lastConversationAt' && sortDirection === 'desc' && primary instanceof Date) {
    branches.push({ lastConversationAt: null } as FilterQuery<IChatProjectDocument>);
  }

  return { $or: branches } as FilterQuery<IChatProjectDocument>;
}

function visibleProjectConversationFilter(
  user: string,
  projectId: string,
): FilterQuery<IConversation> {
  return {
    $and: [
      { user, chatProjectId: projectId },
      { $or: [{ isArchived: false }, { isArchived: { $exists: false } }] },
      buildRetentionVisibilityFilter<IConversation>(),
    ],
  } as FilterQuery<IConversation>;
}

function projectStatsSnapshotFilter(
  snapshot: ProjectStatsSnapshot,
): FilterQuery<IChatProjectDocument> {
  return {
    conversationCount:
      snapshot.conversationCount === undefined ? { $exists: false } : snapshot.conversationCount,
    lastConversationAt:
      snapshot.lastConversationAt === undefined ? { $exists: false } : snapshot.lastConversationAt,
    lastConversationId:
      snapshot.lastConversationId === undefined ? { $exists: false } : snapshot.lastConversationId,
  };
}

export async function refreshChatProjectStatsForUser(
  mongoose: typeof import('mongoose'),
  user: string,
  projectId: string,
): Promise<IChatProject | null> {
  if (!isValidObjectIdString(projectId)) {
    return null;
  }

  const ChatProject = mongoose.models.ChatProject as Model<IChatProjectDocument>;
  const Conversation = mongoose.models.Conversation as Model<IConversation>;
  const projectFilter = { _id: new mongoose.Types.ObjectId(projectId), user };
  const conversationFilter = visibleProjectConversationFilter(user, projectId);

  for (let attempt = 0; attempt < PROJECT_STATS_REFRESH_MAX_ATTEMPTS; attempt++) {
    const snapshot = await ChatProject.findOne(projectFilter)
      .select('conversationCount lastConversationAt lastConversationId')
      .lean<ProjectStatsSnapshot>();
    if (!snapshot) {
      return null;
    }

    const [conversationCount, latestConversation] = await Promise.all([
      Conversation.countDocuments(conversationFilter),
      Conversation.findOne(conversationFilter)
        .select('conversationId updatedAt createdAt')
        .sort({ updatedAt: -1, _id: -1 })
        .lean<IConversation>(),
    ]);

    const updatedProject = await ChatProject.findOneAndUpdate(
      { ...projectFilter, ...projectStatsSnapshotFilter(snapshot) },
      {
        $set: {
          conversationCount,
          lastConversationAt:
            latestConversation?.updatedAt ?? latestConversation?.createdAt ?? null,
          lastConversationId: latestConversation?.conversationId ?? null,
        },
      },
      { new: true },
    ).lean<IChatProject>();
    if (updatedProject) {
      return updatedProject;
    }
  }

  logger.warn('[refreshChatProjectStatsForUser] Stats changed during every refresh attempt', {
    user,
    projectId,
  });
  throw new Error('Failed to refresh chat project stats after concurrent updates');
}

export async function updateChatProjectLastConversationForUser(
  mongoose: typeof import('mongoose'),
  user: string,
  projectId: string,
  conversation: Pick<IConversation, 'conversationId' | 'createdAt' | 'updatedAt'>,
  incrementCount = false,
): Promise<void> {
  if (!isValidObjectIdString(projectId) || !conversation.conversationId) {
    return;
  }

  const lastConversationAt = conversation.updatedAt ?? conversation.createdAt ?? new Date();
  const lastConversationFields = {
    lastConversationAt,
    lastConversationId: conversation.conversationId,
  };
  const ChatProject = mongoose.models.ChatProject as Model<IChatProjectDocument>;
  const projectFilter = { _id: new mongoose.Types.ObjectId(projectId), user };
  const activityFilter = {
    ...projectFilter,
    $or: [{ lastConversationAt: null }, { lastConversationAt: { $lte: lastConversationAt } }],
  };

  if (!incrementCount) {
    await ChatProject.updateOne(activityFilter, { $set: lastConversationFields });
  } else {
    /**
     * A refresh may already have counted this conversation, or a newer reply may own the
     * activity pointer. Recount after a lost conditional update rather than double-counting
     * membership or walking the pointer backwards.
     */
    const incremented = await ChatProject.updateOne(
      { ...activityFilter, lastConversationId: { $ne: conversation.conversationId } },
      { $set: lastConversationFields, $inc: { conversationCount: 1 } },
    );
    if ((incremented.matchedCount ?? 0) === 0) {
      await refreshChatProjectStatsForUser(mongoose, user, projectId);
      return;
    }
  }
  /**
   * The chat can stop being visible while this pointer write is in flight: an archive-all
   * sweep, a single archive from another tab, or a retention flip, each of which has
   * already run its own stats refresh by the time this lands, leaving the project
   * advertising activity on a chat its workspace hides. Checking first would only move
   * that race earlier, so the pointer is verified after it is written and the project
   * recomputed when the chat it names turns out to be hidden. A sweep that lands later
   * still refreshes the project itself, and `refreshChatProjectStatsForUser` compare-and-
   * sets, so it cannot commit a count it read before this write. The read is a point
   * lookup on the unique `conversationId, user` index.
   */
  const Conversation = mongoose.models.Conversation as Model<IConversation>;
  const stillVisible = await Conversation.exists({
    ...visibleProjectConversationFilter(user, projectId),
    conversationId: conversation.conversationId,
  });
  if (!stillVisible) {
    await refreshChatProjectStatsForUser(mongoose, user, projectId);
  }
}

export function createChatProjectMethods(mongoose: typeof import('mongoose')): ChatProjectMethods {
  async function createChatProject(
    user: string,
    input: CreateChatProjectInput,
    limits?: Partial<ChatProjectLimits>,
  ): Promise<IChatProject> {
    const ChatProject = mongoose.models.ChatProject as Model<IChatProjectDocument>;
    const sanitized = sanitizeProjectInput(input, limits);
    if (!sanitized.name) {
      throw new Error('Project name is required');
    }

    const project = await ChatProject.create({
      ...sanitized,
      user,
      conversationCount: 0,
      lastConversationAt: null,
      lastConversationId: null,
    });
    return project.toObject() as IChatProject;
  }

  async function getChatProject(user: string, projectId: string): Promise<IChatProject | null> {
    if (!isValidObjectIdString(projectId)) {
      return null;
    }

    const ChatProject = mongoose.models.ChatProject as Model<IChatProjectDocument>;
    return await ChatProject.findOne({
      _id: new mongoose.Types.ObjectId(projectId),
      user,
    }).lean<IChatProject>();
  }

  async function listChatProjects(
    user: string,
    options: ListChatProjectsOptions = {},
  ): Promise<ListChatProjectsResult> {
    const ChatProject = mongoose.models.ChatProject as Model<IChatProjectDocument>;
    const limit = normalizeLimit(options.limit);
    const sortBy = normalizeSortBy(options.sortBy);
    const sortDirection = normalizeSortDirection(options.sortDirection);
    const sortOrder: SortOrder = sortDirection === 'asc' ? 1 : -1;
    const filters: FilterQuery<IChatProjectDocument>[] = [{ user }];

    if (options.search?.trim()) {
      const searchRegex = { $regex: escapeRegExp(options.search.trim()), $options: 'i' };
      filters.push({ $or: [{ name: searchRegex }, { description: searchRegex }] });
    }

    const cursorFilter = createCursorFilter(
      mongoose,
      parseCursor(options.cursor),
      sortBy,
      sortDirection,
    );
    if (cursorFilter) {
      filters.push(cursorFilter);
    }

    const query =
      filters.length === 1 ? filters[0] : ({ $and: filters } as FilterQuery<IChatProjectDocument>);
    const projects = await ChatProject.aggregate<ProjectLean>([
      { $match: query },
      { $sort: { [sortBy]: sortOrder, _id: sortOrder } },
      { $limit: limit + 1 },
      {
        $project: {
          name: 1,
          description: 1,
          user: 1,
          tenantId: 1,
          conversationCount: 1,
          lastConversationAt: 1,
          lastConversationId: 1,
          createdAt: 1,
          updatedAt: 1,
          contextRevision: 1,
          hasInstructions: { $ne: [{ $ifNull: ['$instructions', ''] }, ''] },
          fileCount: { $size: { $ifNull: ['$file_ids', []] } },
        },
      },
    ]);

    let nextCursor: string | null = null;
    if (projects.length > limit) {
      projects.pop();
      const lastProject = projects[projects.length - 1];
      if (lastProject) {
        nextCursor = encodeCursor(lastProject, sortBy);
      }
    }

    return { projects, nextCursor };
  }

  async function updateChatProject(
    user: string,
    projectId: string,
    input: UpdateChatProjectInput,
    limits?: Partial<ChatProjectLimits>,
  ): Promise<IChatProject | null> {
    if (!isValidObjectIdString(projectId)) {
      return null;
    }

    const ChatProject = mongoose.models.ChatProject as Model<IChatProjectDocument>;
    const update: Partial<Pick<IChatProject, 'name' | 'description' | 'instructions'>> = {};
    const { maxDescriptionLength } = resolveChatProjectLimits(limits);
    if (typeof input.name === 'string') {
      const name = input.name.trim().slice(0, MAX_CHAT_PROJECT_NAME_LENGTH);
      if (!name) {
        throw new Error('Project name is required');
      }
      update.name = name;
    }
    if (input.description !== undefined) {
      update.description = input.description?.trim().slice(0, maxDescriptionLength) ?? '';
    }
    const ownerFilter = { _id: new mongoose.Types.ObjectId(projectId), user };
    const expected = input.contextRevision;
    const hasExpected = typeof expected === 'number' && Number.isInteger(expected);
    const filter = hasExpected ? { ...ownerFilter, contextRevision: expected } : ownerFilter;
    const conflictOrNull = async (): Promise<IChatProject | null> => {
      if (!hasExpected) {
        return null;
      }
      const current = await getChatProject(user, projectId);
      if (current) {
        throw new Error(CHAT_PROJECT_CONFLICT);
      }
      return null;
    };
    if (input.instructions !== undefined) {
      const instructions = validateProjectInstructions(input.instructions, limits);
      const changed = await ChatProject.findOneAndUpdate(
        {
          ...filter,
          instructions: instructions === '' ? { $nin: ['', null] } : { $ne: instructions },
        },
        { $set: { ...update, instructions }, $inc: { contextRevision: 1 } },
        { new: true, runValidators: true },
      ).lean<IChatProject>();
      if (changed) {
        return changed;
      }
    }
    if (Object.keys(update).length === 0) {
      const current = await getChatProject(user, projectId);
      if (current && hasExpected && current.contextRevision !== expected) {
        throw new Error(CHAT_PROJECT_CONFLICT);
      }
      return current;
    }
    const saved = await ChatProject.findOneAndUpdate(
      filter,
      { $set: update },
      { new: true, runValidators: true },
    ).lean<IChatProject>();
    return saved ?? (await conflictOrNull());
  }

  async function addChatProjectFile(
    user: string,
    projectId: string,
    fileId: string,
    limits?: Partial<ChatProjectLimits>,
  ): Promise<IChatProject | null> {
    const { maxFiles } = resolveChatProjectLimits(limits);
    const project = await getChatProject(user, projectId);
    if (!project) {
      return null;
    }
    if (!fileId || typeof fileId !== 'string' || fileId.length > 128) {
      throw new Error('Project file unavailable');
    }
    const alreadyAttached = project.file_ids?.includes(fileId) === true;
    if (!alreadyAttached && (project.file_ids?.length ?? 0) >= maxFiles) {
      throw new Error('Project file limit reached');
    }

    const File = mongoose.models.File as Model<IMongoFile>;
    const file = await File.findOne({
      file_id: fileId,
      user,
      tenantId: project.tenantId ?? null,
      embedded: true,
      context: FileContext.message_attachment,
      $or: [{ expiredAt: null }, { expiredAt: { $gt: new Date() } }],
    })
      .select('_id file_id expiresAt temp_file_id')
      .lean();
    if (!file) {
      throw new Error('Project file unavailable');
    }

    const released = await File.updateOne(
      { _id: file._id, file_id: fileId, user, tenantId: project.tenantId ?? null },
      { $unset: { expiresAt: '', temp_file_id: '' } },
      { timestamps: false },
    );
    if (released.matchedCount === 0) {
      throw new Error('Project file unavailable');
    }
    const restoreTemporaryHold = async (): Promise<void> => {
      const hold = {
        ...(file.expiresAt != null ? { expiresAt: file.expiresAt } : {}),
        ...(file.temp_file_id != null ? { temp_file_id: file.temp_file_id } : {}),
      };
      if (Object.keys(hold).length === 0) {
        return;
      }
      try {
        await File.updateOne({ _id: file._id, user }, { $set: hold }, { timestamps: false });
      } catch (error) {
        logger.warn('[chatProject] Failed to restore temporary file hold', error);
      }
    };

    const ChatProject = mongoose.models.ChatProject as Model<IChatProjectDocument>;
    /** A file deleted between the release and the attach has already run its project
     *  cleanup, so the reference added after it would dangle; take it back out. */
    const dropIfFileDeleted = async (attached: IChatProject): Promise<IChatProject> => {
      if (await File.exists({ _id: file._id })) {
        return attached;
      }
      await ChatProject.updateOne(
        { _id: project._id, user, file_ids: fileId },
        { $pull: { file_ids: fileId }, $inc: { contextRevision: 1 } },
      );
      throw new Error('Project file unavailable');
    };
    try {
      const updated = await ChatProject.findOneAndUpdate(
        {
          _id: project._id,
          user,
          file_ids: { $ne: fileId },
          [`file_ids.${maxFiles - 1}`]: { $exists: false },
        },
        { $addToSet: { file_ids: fileId }, $inc: { contextRevision: 1 } },
        { new: true, runValidators: true },
      ).lean<IChatProject>();
      if (updated) {
        return await dropIfFileDeleted(updated);
      }
      const current = await getChatProject(user, projectId);
      if (current?.file_ids?.includes(fileId)) {
        return current;
      }
      await restoreTemporaryHold();
      if (!current) {
        return null;
      }
    } catch (error) {
      await restoreTemporaryHold();
      throw error;
    }
    throw new Error('Project file limit reached');
  }

  async function removeChatProjectFile(
    user: string,
    projectId: string,
    fileId: string,
  ): Promise<IChatProject | null> {
    if (!isValidObjectIdString(projectId)) {
      return null;
    }
    const ChatProject = mongoose.models.ChatProject as Model<IChatProjectDocument>;
    const project = await ChatProject.findOneAndUpdate(
      { _id: new mongoose.Types.ObjectId(projectId), user, file_ids: fileId },
      { $pull: { file_ids: fileId }, $inc: { contextRevision: 1 } },
      { new: true },
    ).lean<IChatProject>();
    return project ?? getChatProject(user, projectId);
  }

  async function deleteChatProject(
    user: string,
    projectId: string,
  ): Promise<DeleteChatProjectResult> {
    if (!isValidObjectIdString(projectId)) {
      return { deletedCount: 0, modifiedCount: 0 };
    }

    const ChatProject = mongoose.models.ChatProject as Model<IChatProjectDocument>;
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const projectFilter = { _id: new mongoose.Types.ObjectId(projectId), user };
    const project = await ChatProject.findOne(projectFilter).select('_id').lean<IChatProject>();
    if (!project) {
      return { deletedCount: 0, modifiedCount: 0 };
    }

    const conversationResult = await Conversation.updateMany(
      { user, chatProjectId: projectId },
      { $unset: { chatProjectId: '' } },
    );
    const deleteResult = await ChatProject.deleteOne(projectFilter);

    return {
      deletedCount: deleteResult.deletedCount ?? 0,
      modifiedCount: conversationResult.modifiedCount ?? 0,
    };
  }

  async function assignConversationToProject(
    user: string,
    conversationId: string,
    projectId: string | null,
  ): Promise<AssignConversationToProjectResult | null> {
    const ChatProject = mongoose.models.ChatProject as Model<IChatProjectDocument>;
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const conversation = await Conversation.findOne({ user, conversationId }).lean<IConversation>();
    if (!conversation) {
      return null;
    }

    const normalizedProjectId = projectId || null;
    if (normalizedProjectId) {
      if (!isValidObjectIdString(normalizedProjectId)) {
        throw new Error('Project not found');
      }
      const project = await ChatProject.findOne({
        _id: new mongoose.Types.ObjectId(normalizedProjectId),
        user,
      })
        .select('_id')
        .lean<IChatProject>();
      if (!project) {
        throw new Error('Project not found');
      }
    }

    const previousProjectId = conversation.chatProjectId ?? null;
    const update =
      normalizedProjectId == null
        ? { $unset: { chatProjectId: '' } }
        : { $set: { chatProjectId: normalizedProjectId } };
    const updatedConversation = await Conversation.findOneAndUpdate(
      { user, conversationId },
      update,
      { new: true },
    ).lean<IConversation>();

    if (!updatedConversation) {
      return null;
    }

    const projectIds = new Set(
      [previousProjectId, normalizedProjectId].filter((id): id is string => Boolean(id)),
    );
    await Promise.all(
      [...projectIds].map((id) => refreshChatProjectStatsForUser(mongoose, user, id)),
    );

    return {
      conversation: updatedConversation,
      previousProjectId,
      projectId: normalizedProjectId,
    };
  }

  async function refreshChatProjectStats(
    user: string,
    projectId: string,
  ): Promise<IChatProject | null> {
    return await refreshChatProjectStatsForUser(mongoose, user, projectId);
  }

  return {
    createChatProject,
    getChatProject,
    listChatProjects,
    updateChatProject,
    deleteChatProject,
    addChatProjectFile,
    removeChatProjectFile,
    assignConversationToProject,
    refreshChatProjectStats,
  };
}
