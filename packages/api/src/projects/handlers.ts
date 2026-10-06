import {
  MAX_CHAT_PROJECT_DESCRIPTION_LENGTH,
  MAX_CHAT_PROJECT_INSTRUCTIONS_LENGTH,
} from 'librechat-data-provider';
import {
  DEFAULT_AVAILABLE_PROJECT_FILES_LIMIT,
  InvalidAvailableProjectFilesCursorError,
  MAX_AVAILABLE_PROJECT_FILES_LIMIT,
  parseAvailableProjectFilesCursor,
  logger,
  isValidObjectIdString,
} from '@librechat/data-schemas';
import type {
  AppConfig,
  AvailableProjectFilesOptions,
  AvailableProjectFilesResult,
  ChatProjectMethods,
  ChatProjectSortBy,
  ChatProjectSortDirection,
  CreateChatProjectInput,
  UpdateChatProjectInput,
} from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { GetProjectFiles } from './resources';
import { toRuntimeFile, listChatProjectFileViews } from './resources';
import { normalizeLimit, queryString } from '~/utils';
import { isSameChatProjectTenant } from './context';

const CHAT_PROJECT_CONFLICT = 'Project revision conflict';
const PROJECT_NOT_FOUND = 'Project not found';
const CONVERSATION_NOT_FOUND = 'Conversation not found';
const PROJECT_FILE_UNAVAILABLE = 'Project file unavailable';
const PROJECT_FILE_LIMIT_REACHED = 'Project file limit reached';

const PROJECT_SORT_FIELDS = new Set<ChatProjectSortBy>(['name', 'createdAt', 'lastConversationAt']);

interface ProjectUser {
  id: string;
  tenantId?: string;
  _id?: {
    toString(): string;
  };
}
interface ProjectRequest extends Request {
  user?: ProjectUser;
  config?: AppConfig;
}

type ProjectHandlerDependencies = Pick<
  ChatProjectMethods,
  | 'listChatProjects'
  | 'createChatProject'
  | 'getChatProject'
  | 'updateChatProject'
  | 'deleteChatProject'
  | 'assignConversationToProject'
  | 'addChatProjectFile'
  | 'removeChatProjectFile'
> & {
  getProjectFiles: GetProjectFiles;
  getAvailableProjectFiles: (
    options: AvailableProjectFilesOptions,
  ) => Promise<AvailableProjectFilesResult>;
};

const getUserId = (req: ProjectRequest): string => req.user?.id ?? req.user?._id?.toString() ?? '';

const normalizeString = (value: string | null | undefined): string =>
  typeof value === 'string' ? value.trim() : '';

const parseAvailableProjectFilesLimit = (value: Request['query'][string]): number | null => {
  const raw = queryString(value);
  if (raw === undefined) {
    return DEFAULT_AVAILABLE_PROJECT_FILES_LIMIT;
  }
  if (!/^[1-9]\d*$/.test(raw)) {
    return null;
  }
  const limit = Number(raw);
  return Number.isSafeInteger(limit) && limit <= MAX_AVAILABLE_PROJECT_FILES_LIMIT ? limit : null;
};

const normalizeSortBy = (value: Request['query'][string]): ChatProjectSortBy | undefined => {
  const sortBy = queryString(value);
  return PROJECT_SORT_FIELDS.has(sortBy as ChatProjectSortBy)
    ? (sortBy as ChatProjectSortBy)
    : undefined;
};

const normalizeSortDirection = (
  value: Request['query'][string],
): ChatProjectSortDirection | undefined => {
  const sortDirection = queryString(value);
  return sortDirection === 'asc' || sortDirection === 'desc' ? sortDirection : undefined;
};
const instructionValidationError = (
  value: unknown,
  maxInstructionsLength: number = MAX_CHAT_PROJECT_INSTRUCTIONS_LENGTH,
): string | null => {
  if (typeof value !== 'string') {
    return 'instructions must be a string';
  }
  if (value.length > maxInstructionsLength) {
    return `instructions must be at most ${maxInstructionsLength} characters`;
  }
  return null;
};
const createProjectInput = (
  req: ProjectRequest,
  maxInstructionsLength?: number,
  maxDescriptionLength: number = MAX_CHAT_PROJECT_DESCRIPTION_LENGTH,
): { input: CreateChatProjectInput; error?: never } | { input?: never; error: string } => {
  const name = normalizeString(req.body?.name);
  if (!name) {
    return { error: 'name is required' };
  }
  if (req.body?.instructions !== undefined) {
    const error = instructionValidationError(req.body.instructions, maxInstructionsLength);
    if (error) {
      return { error };
    }
  }
  const description = typeof req.body?.description === 'string' ? req.body.description : '';
  /* Refuse an over-long description rather than storing a silently shortened one, the way
   * instructions already answer. */
  if (description.trim().length > maxDescriptionLength) {
    return { error: `description must be at most ${maxDescriptionLength} characters` };
  }

  return {
    input: {
      name,
      description,
      ...(req.body?.instructions !== undefined && { instructions: req.body.instructions }),
    },
  };
};

export function createProjectHandlers(deps: ProjectHandlerDependencies): {
  listProjects: (req: ProjectRequest, res: Response) => Promise<Response>;
  createProject: (req: ProjectRequest, res: Response) => Promise<Response>;
  assignConversationToProject: (req: ProjectRequest, res: Response) => Promise<Response>;
  getProject: (req: ProjectRequest, res: Response) => Promise<Response>;
  updateProject: (req: ProjectRequest, res: Response) => Promise<Response>;
  deleteProject: (req: ProjectRequest, res: Response) => Promise<Response>;
  listProjectFiles: (req: ProjectRequest, res: Response) => Promise<Response>;
  listAvailableProjectFiles: (req: ProjectRequest, res: Response) => Promise<Response>;
  addProjectFile: (req: ProjectRequest, res: Response) => Promise<Response>;
  removeProjectFile: (req: ProjectRequest, res: Response) => Promise<Response>;
} {
  async function listProjects(req: ProjectRequest, res: Response): Promise<Response> {
    try {
      const result = await deps.listChatProjects(getUserId(req), {
        cursor: queryString(req.query.cursor),
        limit: normalizeLimit(req.query.limit),
        sortBy: normalizeSortBy(req.query.sortBy),
        sortDirection: normalizeSortDirection(req.query.sortDirection),
        search: queryString(req.query.search),
      });
      return res.status(200).json(result);
    } catch (error) {
      logger.error('[projects] Error listing projects', error);
      return res.status(500).json({ error: 'Error listing projects' });
    }
  }

  async function createProject(req: ProjectRequest, res: Response): Promise<Response> {
    const parsed = createProjectInput(
      req,
      req.config?.projects?.maxInstructionsLength,
      req.config?.projects?.maxDescriptionLength,
    );
    if ('error' in parsed) {
      return res.status(400).json({ error: parsed.error });
    }

    try {
      const project = await deps.createChatProject(
        getUserId(req),
        parsed.input,
        req.config?.projects,
      );
      return res.status(201).json(project);
    } catch (error) {
      logger.error('[projects] Error creating project', error);
      return res.status(500).json({ error: 'Error creating project' });
    }
  }

  async function assignConversationToProject(
    req: ProjectRequest,
    res: Response,
  ): Promise<Response> {
    const { conversationId } = req.params;
    const projectId = req.body?.projectId ?? null;

    if (projectId !== null && typeof projectId !== 'string') {
      return res.status(400).json({ error: 'projectId must be a string or null' });
    }

    try {
      const result = await deps.assignConversationToProject(
        getUserId(req),
        conversationId,
        projectId,
      );
      if (!result) {
        return res.status(404).json({ error: CONVERSATION_NOT_FOUND });
      }
      return res.status(200).json(result);
    } catch (error) {
      if (error instanceof Error && error.message === PROJECT_NOT_FOUND) {
        return res.status(404).json({ error: PROJECT_NOT_FOUND });
      }
      logger.error('[projects] Error assigning conversation to project', error);
      return res.status(500).json({ error: 'Error assigning conversation to project' });
    }
  }

  async function getProject(req: ProjectRequest, res: Response): Promise<Response> {
    const { projectId } = req.params;
    if (!isValidObjectIdString(projectId)) {
      return res.status(404).json({ error: PROJECT_NOT_FOUND });
    }

    try {
      const project = await deps.getChatProject(getUserId(req), projectId);
      if (!project) {
        return res.status(404).json({ error: PROJECT_NOT_FOUND });
      }
      return res.status(200).json(project);
    } catch (error) {
      logger.error('[projects] Error getting project', error);
      return res.status(500).json({ error: 'Error getting project' });
    }
  }

  async function updateProject(req: ProjectRequest, res: Response): Promise<Response> {
    const { projectId } = req.params;
    if (!isValidObjectIdString(projectId)) {
      return res.status(404).json({ error: PROJECT_NOT_FOUND });
    }

    const input: UpdateChatProjectInput = {};
    if (req.body?.name !== undefined) {
      const name = normalizeString(req.body.name);
      if (!name) {
        return res.status(400).json({ error: 'name is required' });
      }
      input.name = name;
    }
    if (req.body?.description !== undefined) {
      const description = typeof req.body.description === 'string' ? req.body.description : '';
      const maxDescriptionLength =
        req.config?.projects?.maxDescriptionLength ?? MAX_CHAT_PROJECT_DESCRIPTION_LENGTH;
      if (description.trim().length > maxDescriptionLength) {
        return res
          .status(400)
          .json({ error: `description must be at most ${maxDescriptionLength} characters` });
      }
      input.description = description;
    }
    if (req.body?.instructions !== undefined) {
      const error = instructionValidationError(
        req.body.instructions,
        req.config?.projects?.maxInstructionsLength,
      );
      if (error) {
        return res.status(400).json({ error });
      }
      input.instructions = req.body.instructions;
    }
    if (req.body?.contextRevision !== undefined) {
      const revision = req.body.contextRevision;
      if (!Number.isInteger(revision) || revision < 0) {
        return res.status(400).json({ error: 'contextRevision must be a non-negative integer' });
      }
      input.contextRevision = revision;
    }

    try {
      const project = await deps.updateChatProject(
        getUserId(req),
        projectId,
        input,
        req.config?.projects,
      );
      if (!project) {
        return res.status(404).json({ error: PROJECT_NOT_FOUND });
      }
      return res.status(200).json(project);
    } catch (error) {
      if (error instanceof Error && error.message === CHAT_PROJECT_CONFLICT) {
        return res.status(409).json({
          message: 'Project was changed by another session',
          code: 'CHAT_PROJECT_CONFLICT',
        });
      }
      logger.error('[projects] Error updating project', error);
      return res.status(500).json({ error: 'Error updating project' });
    }
  }
  async function listProjectFiles(req: ProjectRequest, res: Response): Promise<Response> {
    const { projectId } = req.params;
    if (!isValidObjectIdString(projectId)) {
      return res.status(404).json({ error: PROJECT_NOT_FOUND });
    }

    try {
      const project = await deps.getChatProject(getUserId(req), projectId);
      if (!project || !isSameChatProjectTenant(project.tenantId, req.user?.tenantId)) {
        return res.status(404).json({ error: PROJECT_NOT_FOUND });
      }
      const files = await listChatProjectFileViews({
        project,
        userId: getUserId(req),
        tenantId: project.tenantId,
        getProjectFiles: deps.getProjectFiles,
      });
      return res.status(200).json(files);
    } catch (error) {
      logger.error('[projects] Error listing project files', error);
      return res.status(500).json({ error: 'Error listing project files' });
    }
  }

  async function listAvailableProjectFiles(req: ProjectRequest, res: Response): Promise<Response> {
    const { projectId } = req.params;
    if (!isValidObjectIdString(projectId)) {
      return res.status(404).json({ error: PROJECT_NOT_FOUND });
    }

    const limit = parseAvailableProjectFilesLimit(req.query.limit);
    const cursor = queryString(req.query.cursor);
    if (limit == null || cursor === '') {
      return res.status(400).json({ error: 'Invalid project file pagination' });
    }

    try {
      parseAvailableProjectFilesCursor(cursor);
      const userId = getUserId(req);
      const project = await deps.getChatProject(userId, projectId);
      if (!project || !isSameChatProjectTenant(project.tenantId, req.user?.tenantId)) {
        return res.status(404).json({ error: PROJECT_NOT_FOUND });
      }
      const result = await deps.getAvailableProjectFiles({
        userId,
        tenantId: project.tenantId ?? null,
        excludedFileIds: project.file_ids ?? [],
        limit,
        cursor: cursor ?? null,
        search: queryString(req.query.search),
      });
      return res.status(200).json({
        files: result.files.map(toRuntimeFile),
        nextCursor: result.nextCursor,
      });
    } catch (error) {
      if (error instanceof InvalidAvailableProjectFilesCursorError || error instanceof RangeError) {
        return res.status(400).json({ error: 'Invalid project file pagination' });
      }
      logger.error('[projects] Error listing available project files', error);
      return res.status(500).json({ error: 'Error listing available project files' });
    }
  }

  async function addProjectFile(req: ProjectRequest, res: Response): Promise<Response> {
    const { projectId } = req.params;
    if (!isValidObjectIdString(projectId)) {
      return res.status(404).json({ error: PROJECT_NOT_FOUND });
    }
    const fileId = req.body?.file_id;
    if (typeof fileId !== 'string' || fileId.length === 0) {
      return res.status(400).json({ error: 'file_id must be a string' });
    }

    try {
      const project = await deps.addChatProjectFile(
        getUserId(req),
        projectId,
        fileId,
        req.config?.projects,
      );
      if (!project) {
        return res.status(404).json({ error: PROJECT_NOT_FOUND });
      }
      return res.status(200).json(project);
    } catch (error) {
      if (error instanceof Error && error.message === PROJECT_FILE_UNAVAILABLE) {
        return res.status(400).json({ error: PROJECT_FILE_UNAVAILABLE });
      }
      if (error instanceof Error && error.message === PROJECT_FILE_LIMIT_REACHED) {
        return res.status(409).json({ error: PROJECT_FILE_LIMIT_REACHED });
      }
      logger.error('[projects] Error adding project file', error);
      return res.status(500).json({ error: 'Error adding project file' });
    }
  }

  async function removeProjectFile(req: ProjectRequest, res: Response): Promise<Response> {
    const { projectId, fileId } = req.params;
    if (!isValidObjectIdString(projectId)) {
      return res.status(404).json({ error: PROJECT_NOT_FOUND });
    }
    if (typeof fileId !== 'string' || fileId.length === 0) {
      return res.status(400).json({ error: 'fileId must be a string' });
    }

    try {
      const project = await deps.removeChatProjectFile(getUserId(req), projectId, fileId);
      if (!project) {
        return res.status(404).json({ error: PROJECT_NOT_FOUND });
      }
      return res.status(200).json(project);
    } catch (error) {
      logger.error('[projects] Error removing project file', error);
      return res.status(500).json({ error: 'Error removing project file' });
    }
  }

  async function deleteProject(req: ProjectRequest, res: Response): Promise<Response> {
    const { projectId } = req.params;
    if (!isValidObjectIdString(projectId)) {
      return res.status(404).json({ error: PROJECT_NOT_FOUND });
    }

    try {
      const result = await deps.deleteChatProject(getUserId(req), projectId);
      if (!result.deletedCount) {
        return res.status(404).json({ error: PROJECT_NOT_FOUND });
      }
      return res.status(200).json(result);
    } catch (error) {
      logger.error('[projects] Error deleting project', error);
      return res.status(500).json({ error: 'Error deleting project' });
    }
  }

  return {
    listProjects,
    createProject,
    assignConversationToProject,
    getProject,
    updateProject,
    deleteProject,
    listProjectFiles,
    listAvailableProjectFiles,
    addProjectFile,
    removeProjectFile,
  };
}
