import { isValidMemoryKey } from '@librechat/data-schemas';
import { hasActivePiiPatterns } from 'librechat-data-provider';
import type { MemoryMethods } from '@librechat/data-schemas';
import type { FiltersConfig } from 'librechat-data-provider';
import type { Request, Response } from 'express';
import type { MemoryContentInput } from '../protection/adapters/submissions';
import type { ProjectedStoredMemory } from './protection';
import { extractMemoryContent } from '../protection/adapters/submissions';
import { contentFilterBlockResponse } from '../middleware/contentFilter';
import { inspectContent } from '../protection/runtime';

interface MemoryUpdateBody {
  key?: string;
  value?: string;
}

interface MemoryQuery {
  agentId?: string | string[];
}

interface MemoryRequestConfig {
  filters?: FiltersConfig;
  memory?: {
    charLimit?: number;
  };
}

type MemoryRequest = Request<{ id: string }, object, MemoryUpdateBody, MemoryQuery> & {
  user?: { id?: string };
  config?: MemoryRequestConfig;
};

type ProjectStoredMemories = <T extends MemoryContentInput>(
  memories: readonly T[],
  filters?: FiltersConfig,
) => ProjectedStoredMemory<T>[];

export interface MemoryManagementHandlersDeps
  extends Pick<MemoryMethods, 'setMemoryById' | 'deleteMemoryById'> {
  countTokens: (value: string) => number;
  projectStoredMemories: ProjectStoredMemories;
}

const getAgentId = (value?: string | string[]): string | undefined => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized ? normalized : undefined;
};

const getUserId = (req: MemoryRequest): string => req.user?.id ?? '';

export function blockFilteredMemoryContent(
  req: MemoryRequest,
  res: Response,
  memory: MemoryContentInput,
): boolean {
  const filters = req.config?.filters;
  if (!hasActivePiiPatterns(filters?.memories?.pii)) {
    return false;
  }
  const finding = inspectContent(extractMemoryContent(memory), { filters });
  if (finding == null) {
    return false;
  }
  res.status(400).json(contentFilterBlockResponse(finding));
  return true;
}

export function createMemoryManagementHandlers(deps: MemoryManagementHandlersDeps): {
  updateById: (req: MemoryRequest, res: Response) => Promise<Response>;
  deleteById: (req: MemoryRequest, res: Response) => Promise<Response>;
} {
  async function updateById(req: MemoryRequest, res: Response): Promise<Response> {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }

    const value = req.body?.value;
    if (typeof value !== 'string' || value.trim() === '') {
      return res.status(400).json({ error: 'Value is required and must be a non-empty string.' });
    }

    const submittedKey = req.body?.key;
    if (submittedKey != null && (typeof submittedKey !== 'string' || submittedKey.trim() === '')) {
      return res.status(400).json({ error: 'Key must be a non-empty string when provided.' });
    }

    const key = submittedKey?.trim();
    const charLimit = req.config?.memory?.charLimit || 10000;
    if (key != null && key.length > 1000) {
      return res.status(400).json({
        error: `Key exceeds maximum length of 1000 characters. Current length: ${key.length} characters.`,
      });
    }
    if (key != null && !isValidMemoryKey(key)) {
      return res
        .status(400)
        .json({ error: 'Key must only contain lowercase letters and underscores.' });
    }
    if (value.length > charLimit) {
      return res.status(400).json({
        error: `Value exceeds maximum length of ${charLimit} characters. Current length: ${value.length} characters.`,
      });
    }
    if (blockFilteredMemoryContent(req, res, { ...(key != null ? { key } : {}), value })) {
      return res;
    }

    try {
      const result = await deps.setMemoryById({
        userId,
        id: req.params.id,
        key,
        value,
        tokenCount: deps.countTokens(value),
        agentId: getAgentId(req.query.agentId),
      });
      if (result.conflict) {
        return res.status(409).json({ error: 'Memory with this key already exists.' });
      }
      if (!result.ok || !result.memory) {
        return res.status(404).json({ error: 'Memory not found.' });
      }

      const [memory] = deps.projectStoredMemories([result.memory], req.config?.filters);
      return res.status(200).json({ updated: true, memory });
    } catch (_error) {
      return res.status(500).json({ error: 'Failed to update memory.' });
    }
  }

  async function deleteById(req: MemoryRequest, res: Response): Promise<Response> {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }

    try {
      const result = await deps.deleteMemoryById({
        userId,
        id: req.params.id,
        agentId: getAgentId(req.query.agentId),
      });
      if (!result.ok) {
        return res.status(404).json({ error: 'Memory not found.' });
      }
      return res.status(200).json({ deleted: true });
    } catch (_error) {
      return res.status(500).json({ error: 'Failed to delete memory.' });
    }
  }

  return { updateById, deleteById };
}
