import { getMediaConfig } from '@librechat/data-schemas';
import type {
  MediaConfig,
  MediaStartupConfig,
  MediaIntegration,
  MediaUserKey,
} from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { MediaEnvironment } from './credentials/config';
import { describeMediaUserKey } from './credentials/config';

export interface MediaRoleGrant {
  permissions?: { MEDIA?: { USE?: boolean; CREATE?: boolean } };
}
export interface MediaPermissions {
  canUse: boolean;
  canCreate: boolean;
}

/** Absent roles and absent grants both deny; only an explicit `true` opens a surface. */
export function resolveMediaPermissions(role: MediaRoleGrant | null | undefined): MediaPermissions {
  return {
    canUse: role?.permissions?.MEDIA?.USE === true,
    canCreate: role?.permissions?.MEDIA?.CREATE === true,
  };
}

/** Project capability hints from already-loaded policy; never resolve keys or discover models. */
export function sanitizeMediaStartupConfig({
  config,
  authenticated,
  canUse,
  canCreate,
  reconciliationAvailable = false,
  describeIntegration,
}: {
  config?: MediaConfig;
  authenticated: boolean;
  canUse: boolean;
  canCreate: boolean;
  reconciliationAvailable?: boolean;
  describeIntegration?: (integration: MediaIntegration) => MediaUserKey | undefined;
}): MediaStartupConfig | undefined {
  if (!authenticated) {
    return undefined;
  }
  const resolved = getMediaConfig({ media: config });
  const enabled = canUse && (resolved.enabled || reconciliationAvailable);
  return {
    enabled,
    studio: enabled && resolved.surfaces.studio,
    chat: enabled && resolved.surfaces.chat,
    tools: enabled && resolved.surfaces.tools,
    events: enabled && resolved.events.enabled,
    canCreate: enabled && resolved.enabled && canCreate,
    clientPollIntervalMs: resolved.polling.clientIntervalMs,
    clientCatchUpIntervalMs: resolved.polling.clientCatchUpIntervalMs,
    ...(enabled && resolved.enabled && describeIntegration
      ? {
          integrations: resolved.integrations
            .filter((integration) => integration.enabled !== false)
            .flatMap((integration) => {
              try {
                const userKey = describeIntegration(integration);
                return userKey
                  ? [
                      {
                        connectionId: integration.id,
                        connectionName: integration.label ?? integration.id,
                        userKey,
                      },
                    ]
                  : [];
              } catch {
                return [];
              }
            }),
        }
      : {}),
  };
}

/** Startup capabilities derive entirely from configuration already loaded for this request. */
export function resolveMediaStartupConfig({
  appConfig,
  authenticated,
  reconciliationAvailable,
  environment,
}: {
  appConfig: AppConfig;
  authenticated: boolean;
  reconciliationAvailable?: boolean;
  environment: MediaEnvironment;
}): MediaStartupConfig | undefined {
  return sanitizeMediaStartupConfig({
    config: appConfig.media,
    authenticated,
    canUse: true,
    canCreate: true,
    reconciliationAvailable,
    describeIntegration: (integration) =>
      describeMediaUserKey({ integration, appConfig }, environment),
  });
}
