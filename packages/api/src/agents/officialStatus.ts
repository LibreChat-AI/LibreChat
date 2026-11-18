import { SystemCapabilities } from '@librechat/data-schemas';
import type { TStartupConfig } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { HasCapabilityFn, CapabilityUser } from '~/middleware/capabilities';
import type { SafeErrorMetadata } from '~/utils/errors';
import { getSafeErrorMetadata } from '~/utils/errors';

type OfficialStatusConfig = Pick<AppConfig, 'interfaceConfig'> | undefined;

/** Official status is opt-in: an absent or partial config block keeps it off. */
export function isAgentOfficialStatusEnabled(config: OfficialStatusConfig): boolean {
  return config?.interfaceConfig?.agentOfficialStatus?.enabled === true;
}

type OfficialStatusUser = {
  id?: string;
  _id?: { toString(): string };
  role?: string;
  tenantId?: string;
  idOnTheSource?: string | null;
};

function toCapabilityUser(user: OfficialStatusUser | undefined): CapabilityUser | null {
  const id = user?.id ?? user?._id?.toString();
  if (!id) {
    return null;
  }
  return {
    id,
    role: user?.role ?? '',
    tenantId: user?.tenantId,
    idOnTheSource: user?.idOnTheSource ?? null,
  };
}

export interface AgentOfficialStatusStartupDeps {
  hasCapability: HasCapabilityFn;
  logger: { warn: (message: string, metadata?: SafeErrorMetadata) => void };
}

/**
 * Startup fields for official status. The capability lookup only runs when the feature is
 * enabled, so a deployment that leaves it off pays no extra query on the startup path.
 */
export async function getAgentOfficialStatusStartupConfig(
  deps: AgentOfficialStatusStartupDeps,
  config: OfficialStatusConfig,
  user: OfficialStatusUser | undefined,
): Promise<Pick<TStartupConfig, 'canManageAgentOfficialStatus'>> {
  if (!isAgentOfficialStatusEnabled(config)) {
    return {};
  }
  const capabilityUser = toCapabilityUser(user);
  if (!capabilityUser) {
    return { canManageAgentOfficialStatus: false };
  }
  try {
    const canManage = await deps.hasCapability(capabilityUser, SystemCapabilities.MANAGE_AGENTS);
    return { canManageAgentOfficialStatus: canManage };
  } catch (error) {
    deps.logger.warn('[official-status] Capability check failed', getSafeErrorMetadata(error));
    return { canManageAgentOfficialStatus: false };
  }
}

export interface AgentOfficialStatusHandlerDeps {
  setAgentOfficialStatus: (
    id: string,
    isOfficial: boolean,
  ) => Promise<{ id: string; is_official: boolean } | null>;
  logger: { error: (message: string, metadata?: SafeErrorMetadata) => void };
}

type OfficialStatusRequest = Request & {
  config?: OfficialStatusConfig;
  user?: OfficialStatusUser;
};

/**
 * PUT /agents/:id/official-status. The route authorizes `manage:agents` before this runs; the
 * handler owns the config gate and the body contract.
 */
export function createAgentOfficialStatusHandler(
  deps: AgentOfficialStatusHandlerDeps,
): (req: OfficialStatusRequest, res: Response) => Promise<Response> {
  return async (req, res) => {
    if (!isAgentOfficialStatusEnabled(req.config)) {
      return res.status(404).json({ error: 'agent_official_status_disabled' });
    }
    const id = req.params.id;
    if (typeof id !== 'string' || id === '') {
      return res.status(400).json({ error: 'invalid_agent_id' });
    }
    const isOfficial = (req.body as { is_official?: unknown } | undefined)?.is_official;
    if (typeof isOfficial !== 'boolean') {
      return res.status(400).json({ error: 'is_official_must_be_boolean' });
    }

    try {
      const updated = await deps.setAgentOfficialStatus(id, isOfficial);
      if (!updated) {
        return res.status(404).json({ error: 'agent_not_found' });
      }
      return res.status(200).json(updated);
    } catch (error) {
      deps.logger.error('[official-status] Failed to update agent', getSafeErrorMetadata(error));
      return res.status(500).json({ error: 'agent_official_status_failed' });
    }
  };
}
