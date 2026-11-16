import { SystemCapabilities } from '@librechat/data-schemas';
import type { TStartupConfig } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { HasCapabilityFn, CapabilityUser } from '~/middleware/capabilities';
import type { SafeErrorMetadata } from '~/utils/errors';
import { getSafeErrorMetadata } from '~/utils/errors';

type CertificationConfig = Pick<AppConfig, 'interfaceConfig'> | undefined;

/** Certification is opt-in: an absent or partial config block keeps it off. */
export function isAgentCertificationEnabled(config: CertificationConfig): boolean {
  return config?.interfaceConfig?.agentCertification?.enabled === true;
}

type CertificationUser = {
  id?: string;
  _id?: { toString(): string };
  role?: string;
  tenantId?: string;
  idOnTheSource?: string | null;
};

function toCapabilityUser(user: CertificationUser | undefined): CapabilityUser | null {
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

export interface AgentCertificationStartupDeps {
  hasCapability: HasCapabilityFn;
  logger: { warn: (message: string, metadata?: SafeErrorMetadata) => void };
}

/**
 * Startup fields for certification. The capability lookup only runs when the feature is
 * enabled, so a deployment that leaves it off pays no extra query on the startup path.
 */
export async function getAgentCertificationStartupConfig(
  deps: AgentCertificationStartupDeps,
  config: CertificationConfig,
  user: CertificationUser | undefined,
): Promise<Pick<TStartupConfig, 'canManageAgentCertification'>> {
  if (!isAgentCertificationEnabled(config)) {
    return {};
  }
  const capabilityUser = toCapabilityUser(user);
  if (!capabilityUser) {
    return { canManageAgentCertification: false };
  }
  try {
    const canManage = await deps.hasCapability(capabilityUser, SystemCapabilities.MANAGE_AGENTS);
    return { canManageAgentCertification: canManage };
  } catch (error) {
    deps.logger.warn('[certification] Capability check failed', getSafeErrorMetadata(error));
    return { canManageAgentCertification: false };
  }
}

export interface AgentCertificationHandlerDeps {
  setAgentCertification: (
    id: string,
    isCertified: boolean,
  ) => Promise<{ id: string; is_certified: boolean } | null>;
  logger: { error: (message: string, metadata?: SafeErrorMetadata) => void };
}

type CertificationRequest = Request & {
  config?: CertificationConfig;
  user?: CertificationUser;
};

/**
 * PUT /agents/:id/certification. The route authorizes `manage:agents` before this runs; the
 * handler owns the config gate and the body contract.
 */
export function createAgentCertificationHandler(
  deps: AgentCertificationHandlerDeps,
): (req: CertificationRequest, res: Response) => Promise<Response> {
  return async (req, res) => {
    if (!isAgentCertificationEnabled(req.config)) {
      return res.status(404).json({ error: 'agent_certification_disabled' });
    }
    const id = req.params.id;
    if (typeof id !== 'string' || id === '') {
      return res.status(400).json({ error: 'invalid_agent_id' });
    }
    const isCertified = (req.body as { is_certified?: unknown } | undefined)?.is_certified;
    if (typeof isCertified !== 'boolean') {
      return res.status(400).json({ error: 'is_certified_must_be_boolean' });
    }

    try {
      const updated = await deps.setAgentCertification(id, isCertified);
      if (!updated) {
        return res.status(404).json({ error: 'agent_not_found' });
      }
      return res.status(200).json(updated);
    } catch (error) {
      deps.logger.error('[certification] Failed to update agent', getSafeErrorMetadata(error));
      return res.status(500).json({ error: 'agent_certification_failed' });
    }
  };
}
