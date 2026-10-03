import { z } from 'zod';
import type { ToolApprovalGrantStorage } from 'librechat-data-provider';
import type { Request, Response } from 'express';

const resetSchema = z
  .object({ agentId: z.string().min(1).max(256), toolName: z.string().min(1).max(256) })
  .strict();

export function createResetToolApprovalController(
  storage: ToolApprovalGrantStorage,
): (req: Request & { user?: { id: string } }, res: Response) => Promise<void> {
  return async (req: Request & { user?: { id: string } }, res: Response): Promise<void> => {
    if (!req.user?.id) {
      res.status(401).json({ code: 'UNAUTHORIZED' });
      return;
    }
    const parsed = resetSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ code: 'INVALID_APPROVAL_RESET' });
      return;
    }
    try {
      await storage.resetToolApprovalGrants(req.user.id, parsed.data.agentId, parsed.data.toolName);
      res.status(200).json({ reset: true });
    } catch {
      res.status(503).json({ code: 'APPROVAL_RESET_FAILED' });
    }
  };
}
