import { SystemCapabilities } from '@librechat/data-schemas';
import { channelConfigSchema } from 'librechat-data-provider';
import type { AppConfig, SlackWorkspaceStorage } from '@librechat/data-schemas';
import type { SlackWorkspacePrincipal, SlackWorkspaceFetch } from './workspaces';
import type { SlackWorkspaceHandlers } from './workspaceHttp';
import type { GetAppConfigOptions } from '~/app/service';
import {
  createSlackWorkspaceService,
  resolveSlackWorkspaceApp,
  SLACK_WORKSPACE_CALLBACK_PATH,
} from './workspaces';
import { createSlackWorkspaceHandlers } from './workspaceHttp';
import { encryptCredential } from '~/crypto/credentials';
import { getSafeErrorMetadata } from '~/utils/errors';
import { getOAuthCallbackUrl } from '~/oauth/url';

interface WorkspaceAdmin {
  role?: string | null;
  tenantId?: string | null;
  idOnTheSource?: string | null;
}

export function createSlackWorkspaceRuntime(deps: {
  storage: SlackWorkspaceStorage;
  readAppConfig: (options?: GetAppConfigOptions) => Promise<AppConfig>;
  findUser: (id: string) => Promise<WorkspaceAdmin | null>;
  isPrincipalActive: (id: string) => Promise<boolean>;
  hasCapability: (
    user: { id: string; role: string; tenantId?: string; idOnTheSource: string | null },
    capability: typeof SystemCapabilities.ACCESS_ADMIN | typeof SystemCapabilities.MANAGE_AGENTS,
  ) => Promise<boolean>;
  publicBaseUrl: string;
  fetch: SlackWorkspaceFetch;
  logError: (metadata: ReturnType<typeof getSafeErrorMetadata>) => void;
}): SlackWorkspaceHandlers {
  const policy = async () => {
    const app = await deps.readAppConfig({ baseOnly: true, failClosed: true });
    return channelConfigSchema.parse(app.endpoints?.agents?.channels ?? {});
  };
  const redirectUri = getOAuthCallbackUrl(deps.publicBaseUrl, SLACK_WORKSPACE_CALLBACK_PATH);
  const config = async () => resolveSlackWorkspaceApp(await policy(), redirectUri);
  const canManage = async (principal: SlackWorkspacePrincipal) => {
    const [user, active] = await Promise.all([
      deps.findUser(principal.id),
      deps.isPrincipalActive(principal.id),
    ]);
    if (!user || !active || (user.tenantId || undefined) !== principal.tenantId) return false;
    const subject = {
      id: principal.id,
      role: user.role || '',
      tenantId: principal.tenantId,
      idOnTheSource: user.idOnTheSource ?? null,
    };
    const permissions = await Promise.all([
      deps.hasCapability(subject, SystemCapabilities.ACCESS_ADMIN),
      deps.hasCapability(subject, SystemCapabilities.MANAGE_AGENTS),
    ]);
    return permissions.every(Boolean);
  };
  const service = createSlackWorkspaceService({
    ...deps,
    config,
    canManage,
    encrypt: encryptCredential,
  });
  return createSlackWorkspaceHandlers({
    ...deps,
    service,
    canManage,
    settings: async () => {
      const channels = await policy();
      return {
        configured: Boolean(resolveSlackWorkspaceApp(channels, redirectUri)),
        pageSize: channels.maxMetadataPageSize,
      };
    },
  });
}
