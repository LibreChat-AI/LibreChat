import { isValidObjectIdString, logger } from '@librechat/data-schemas';

import type {
  ChatProjectMethods,
  ChatProjectSortBy,
  ChatProjectSortDirection,
  CreateChatProjectInput,
  UpdateChatProjectInput,
} from '@librechat/data-schemas';
import type { Request, Response } from 'express';

import { normalizeLimit, queryString } from '~/utils';

const PROJECT_NOT_FOUND = 'Project not found';
const CONVERSATION_NOT_FOUND = 'Conversation not found';

const PROJECT_SORT_FIELDS = new Set<ChatProjectSortBy>(['name', 'createdAt', 'lastConversationAt']);

interface ProjectUser {
  id: string;
  _id?: {
    toString(): string;
  };
}

interface ProjectRequest extends Request {
  user?: ProjectUser;
}

type ProjectHandlerDependencies = Pick<
  ChatProjectMethods,
  | 'listChatProjects'
  | 'createChatProject'
  | 'getChatProject'
  | 'updateChatProject'
  | 'deleteChatProject'
  | 'assignConversationToProject'
>;

const getUserId = (req: ProjectRequest): string => req.user?.id ?? req.user?._id?.toString() ?? '';

const normalizeString = (value: string | null | undefined): string =>
  typeof value === 'string' ? value.trim() : '';

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

const createProjectInput = (req: ProjectRequest): CreateChatProjectInput | null => {
  const name = normalizeString(req.body?.name);
  if (!name) {
    return null;
  }

  return {
    name,
    description: typeof req.body?.description === 'string' ? req.body.description : '',
  };
};

export function createProjectHandlers(deps: ProjectHandlerDependencies): {
  listProjects: (req: ProjectRequest, res: Response) => Promise<Response>;
  createProject: (req: ProjectRequest, res: Response) => Promise<Response>;
  assignConversationToProject: (req: ProjectRequest, res: Response) => Promise<Response>;
  getProject: (req: ProjectRequest, res: Response) => Promise<Response>;
  updateProject: (req: ProjectRequest, res: Response) => Promise<Response>;
  deleteProject: (req: ProjectRequest, res: Response) => Promise<Response>;
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
    const input = createProjectInput(req);
    if (!input) {
      return res.status(400).json({ error: 'name is required' });
    }

    try {
      const project = await deps.createChatProject(getUserId(req), input);
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
      input.description = typeof req.body.description === 'string' ? req.body.description : '';
    }

    try {
      const project = await deps.updateChatProject(getUserId(req), projectId, input);
      if (!project) {
        return res.status(404).json({ error: PROJECT_NOT_FOUND });
      }
      return res.status(200).json(project);
    } catch (error) {
      logger.error('[projects] Error updating project', error);
      return res.status(500).json({ error: 'Error updating project' });
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
  };
}
