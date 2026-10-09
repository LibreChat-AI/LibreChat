import { configCapability, SYSTEM_TENANT_ID, SystemCapabilities } from '@librechat/data-schemas';
import type { TCustomConfig } from 'librechat-data-provider';
import type { CapabilityUser, GetHeldCapabilitiesFn } from '~/middleware/capabilities';
import type { LangfuseSessionLinkParams } from '~/langfuse/session';
import { resolveLangfuseSessionUrl } from '~/langfuse/session';

interface SharedSessionViewer {
  id?: string;
  _id?: { toString(): string };
  role?: string;
  tenantId?: string;
  idOnTheSource?: string | null;
}

export interface SharedLangfuseSessionParams {
  viewer?: SharedSessionViewer;
  shareTenantId?: string;
  shareConversationId?: string;
  shareOwnerId?: string;
  config: TCustomConfig['langfuse'];
}

export interface SharedLangfuseSessionDeps {
  getHeldCapabilities: GetHeldCapabilitiesFn;
  getMessages: LangfuseSessionLinkParams['getMessages'];
  resolveSessionUrl?: (params: LangfuseSessionLinkParams) => Promise<string | null>;
}

function normalizeTenantId(tenantId?: string): string | undefined {
  return tenantId && tenantId !== SYSTEM_TENANT_ID ? tenantId : undefined;
}

export function createSharedLangfuseSessionResolver(deps: SharedLangfuseSessionDeps) {
  const resolveSessionUrl = deps.resolveSessionUrl ?? resolveLangfuseSessionUrl;

  return async function getSharedLangfuseSessionUrl({
    viewer,
    shareTenantId,
    shareConversationId,
    shareOwnerId,
    config,
  }: SharedLangfuseSessionParams): Promise<string | null> {
    const userId = viewer?.id ?? viewer?._id?.toString();
    if (
      !viewer ||
      !userId ||
      normalizeTenantId(viewer?.tenantId) !== normalizeTenantId(shareTenantId) ||
      !shareOwnerId ||
      !shareConversationId
    ) {
      return null;
    }

    const capabilityUser: CapabilityUser = {
      id: userId,
      role: viewer.role ?? '',
      tenantId: viewer.tenantId,
      idOnTheSource: viewer.idOnTheSource ?? null,
    };
    const langfuseConfigCapability = configCapability('langfuse');
    const heldCapabilities = await deps.getHeldCapabilities(capabilityUser, [
      SystemCapabilities.ACCESS_ADMIN,
      SystemCapabilities.MANAGE_CONFIGS,
      langfuseConfigCapability,
    ]);
    if (
      !heldCapabilities.has(SystemCapabilities.ACCESS_ADMIN) ||
      (!heldCapabilities.has(SystemCapabilities.MANAGE_CONFIGS) &&
        !heldCapabilities.has(langfuseConfigCapability))
    ) {
      return null;
    }

    return resolveSessionUrl({
      config,
      conversationId: shareConversationId,
      userId: shareOwnerId,
      getMessages: deps.getMessages,
    });
  };
}
