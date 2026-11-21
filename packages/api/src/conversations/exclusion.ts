import { logger, MAX_EXCLUDED_FILES } from '@librechat/data-schemas';
import type { ConversationMethods } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types';

type ExclusionHandlerDependencies = Pick<ConversationMethods, 'setConvoFileExclusion'>;
type ExclusionReadDependencies = Pick<ConversationMethods, 'getConvoExcludedFiles'>;

/** Longer than any file id the app issues; keeps one id from being an arbitrary payload. */
const MAX_FILE_ID_LENGTH = 256;

type ExclusionChange = { fileIds: string[]; excluded: boolean };

function parseChange(body: unknown): ExclusionChange | null {
  const { fileIds, excluded } = (body ?? {}) as { fileIds?: unknown; excluded?: unknown };
  if (typeof excluded !== 'boolean' || !Array.isArray(fileIds)) {
    return null;
  }
  if (fileIds.length === 0 || fileIds.length > MAX_EXCLUDED_FILES) {
    return null;
  }
  const ids = new Set<string>();
  for (const fileId of fileIds) {
    if (typeof fileId !== 'string' || fileId.length === 0 || fileId.length > MAX_FILE_ID_LENGTH) {
      return null;
    }
    ids.add(fileId);
  }
  return { fileIds: [...ids], excluded };
}

/**
 * Leaves files out of a conversation's later turns, or takes them back in.
 *
 * The ids are not checked against the conversation: one that names no file of it changes nothing
 * a turn does, and the list is bounded either way. The conversation must be the caller's own,
 * which the write itself enforces, so another user's conversation reads as not found.
 */
export function createFileExclusionHandler(
  deps: ExclusionHandlerDependencies,
): (req: ServerRequest, res: Response) => Promise<Response> {
  return async function fileExclusionHandler(req: ServerRequest, res: Response) {
    const { conversationId } = req.params as { conversationId?: string };
    const change = parseChange(req.body);
    if (!conversationId || change == null) {
      return res.status(400).json({ error: 'fileIds and excluded are required' });
    }

    try {
      const result = await deps.setConvoFileExclusion(
        req.user!.id,
        conversationId,
        change.fileIds,
        change.excluded,
      );
      if (result.ok) {
        return res.status(200).json({ excludedFiles: result.value });
      }
      if (result.error.code === 'not_found') {
        return res.status(404).json({ error: 'Conversation not found', code: 'not_found' });
      }
      return res.status(409).json({ error: 'Too many files are left out', code: 'limit_exceeded' });
    } catch (error) {
      logger.error('Error updating excluded files', error);
      return res.status(500).json({ error: 'Error updating excluded files' });
    }
  };
}

/**
 * The files the caller's conversation leaves out. A conversation that is not theirs, or does not
 * exist, answers as one that leaves nothing out, so the route says nothing about what exists.
 */
export function createFileExclusionReadHandler(
  deps: ExclusionReadDependencies,
): (req: ServerRequest, res: Response) => Promise<Response> {
  return async function fileExclusionReadHandler(req: ServerRequest, res: Response) {
    const { conversationId } = req.params as { conversationId?: string };
    if (!conversationId) {
      return res.status(400).json({ error: 'conversationId is required' });
    }
    try {
      const excludedFiles = await deps.getConvoExcludedFiles(conversationId, req.user!.id);
      return res.status(200).json({ excludedFiles });
    } catch (error) {
      logger.error('Error reading excluded files', error);
      return res.status(500).json({ error: 'Error reading excluded files' });
    }
  };
}
