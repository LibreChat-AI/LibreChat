import { z } from 'zod';
import { logger, ResourceCapabilityMap } from '@librechat/data-schemas';
import {
  Constants,
  ResourceType,
  splitMCPToolKey,
  normalizeServerName,
  buildServerNameAliases,
} from 'librechat-data-provider';
import type { ToolApprovalGrantStorage, Agent } from 'librechat-data-provider';
import type { Request, Response } from 'express';
import type { HasCapabilityFn } from '~/middleware/capabilities';
import type { MCPServerTools } from '~/tools/definitions';
import type { ParsedServerConfig } from '~/mcp/types';
import { collectMCPToolAliases, aliasMCPToolOptions } from '~/tools/classification';

const resetSchema = z
  .object({ agentId: z.string().min(1).max(256), toolName: z.string().min(1).max(256).optional() })
  .strict();

interface ResetDependencies {
  storage: ToolApprovalGrantStorage;
  hasCapability?: HasCapabilityFn;
  getMCPServerConfigs?: (
    userId: string,
    user: { id: string; role?: string },
  ) => Promise<Record<string, ParsedServerConfig>>;
  getMCPServerTools?: (
    userId: string,
    serverName: string,
    config: ParsedServerConfig,
  ) => Promise<MCPServerTools | null>;
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
  hasCapability,
  getMCPServerConfigs,
  getMCPServerTools,
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
      if (!agent) {
        res.status(403).json({ code: 'APPROVAL_RESET_FORBIDDEN' });
        return;
      }
      let managesAgents = false;
      const capability = ResourceCapabilityMap[ResourceType.AGENT];
      try {
        managesAgents =
          capability != null &&
          req.user.role != null &&
          (await hasCapability?.({ ...req.user, role: req.user.role }, capability)) === true;
      } catch {
        logger.warn('[Tool approvals] Capability lookup failed; checking resource access.');
      }
      if (!managesAgents && !(await canAccessAgent(agent, req.user))) {
        res.status(403).json({ code: 'APPROVAL_RESET_FORBIDDEN' });
        return;
      }
      let resetToolName = toolName;
      let options = agent.tool_options;
      if (toolName != null && getMCPServerConfigs && getMCPServerTools) {
        const configs = await getMCPServerConfigs(req.user.id, req.user);
        const names = Object.keys(configs);
        const serverAliases = buildServerNameAliases(names);
        const boundaries = [...names, ...serverAliases.keys()];
        const [toolPart, parsedServer] = splitMCPToolKey(toolName, boundaries);
        const serverName =
          parsedServer == null ? undefined : (serverAliases.get(parsedServer) ?? parsedServer);
        if (serverName && serverAliases.get(normalizeServerName(serverName)) === serverName) {
          const catalog = await getMCPServerTools(req.user.id, serverName, configs[serverName]);
          if (catalog) {
            const suffix = `${Constants.mcp_delimiter}${normalizeServerName(serverName)}`;
            const aliases = collectMCPToolAliases(
              Object.entries(catalog)
                .filter(([, entry]) => entry.function != null)
                .map(([name, entry]) => ({
                  name,
                  serverName,
                  serverToolName: entry.serverToolName,
                })),
            );
            const requested = `${toolPart}${suffix}`;
            resetToolName = catalog[requested]?.function
              ? requested
              : (aliases.find(({ aliasName }) => aliasName === requested)?.name ?? toolName);
            // Match the editor's unsaved migration. Explicit current options win.
            options = { ...options };
            for (const [name, value] of Object.entries(agent.tool_options ?? {})) {
              const [part, parsed] = splitMCPToolKey(name, boundaries);
              if (parsed !== serverName && serverAliases.get(parsed ?? '') !== serverName) continue;
              const normalized = `${part}${suffix}`;
              if (options[normalized] == null) options[normalized] = value;
            }
            aliasMCPToolOptions(aliases, options);
          }
        }
      }
      const mode = resetToolName == null ? undefined : options?.[resetToolName]?.approval_mode;
      if (resetToolName != null && mode !== 'chat' && mode !== 'always') {
        res.status(403).json({ code: 'APPROVAL_RESET_FORBIDDEN' });
        return;
      }
      await storage.resetToolApprovalGrants(req.user.id, agentId, resetToolName);
      res.status(200).json({ reset: true });
    } catch {
      res.status(503).json({ code: 'APPROVAL_RESET_FAILED' });
    }
  };
}
