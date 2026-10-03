import { z } from 'zod';
import type { ToolApprovalGrantStorage, Agent } from 'librechat-data-provider';
import type { Request, Response } from 'express';

const resetSchema = z
  .object({ agentId: z.string().min(1).max(256), toolName: z.string().min(1).max(256) })
  .strict();

interface ResetDependencies {
  storage: ToolApprovalGrantStorage;
  getAgent: (filter: {
    id: string;
  }) => Promise<Pick<Agent, 'id' | 'tool_options'> | null | undefined>;
  canAccessAgent: (
    agent: Pick<Agent, 'id' | 'tool_options'>,
    user: { id: string; role?: string },
  ) => Promise<boolean>;
}

export function createResetToolApprovalController({
  storage,
  getAgent,
  canAccessAgent,
}: ResetDependencies): (
  req: Request & { user?: { id: string; role?: string } },
  res: Response,
) => Promise<void> {
  return async (
    req: Request & { user?: { id: string; role?: string } },
    res: Response,
  ): Promise<void> => {
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
      const { agentId, toolName } = parsed.data;
      const agent = await getAgent({ id: agentId });
      const mode = agent?.tool_options?.[toolName]?.approval_mode;
      if (
        !agent ||
        (mode !== 'chat' && mode !== 'always') ||
        !(await canAccessAgent(agent, req.user))
      ) {
        res.status(403).json({ code: 'APPROVAL_RESET_FORBIDDEN' });
        return;
      }
      await storage.resetToolApprovalGrants(req.user.id, parsed.data.agentId, parsed.data.toolName);
      res.status(200).json({ reset: true });
    } catch {
      res.status(503).json({ code: 'APPROVAL_RESET_FAILED' });
    }
  };
}
