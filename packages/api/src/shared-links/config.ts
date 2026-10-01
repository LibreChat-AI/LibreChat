import { deploymentThemeSchema } from 'librechat-data-provider';
import { tenantStorage, SYSTEM_TENANT_ID } from '@librechat/data-schemas';
import type { TSharedLinkStartupConfig } from 'librechat-data-provider';
import type { Request, Response, NextFunction } from 'express';
import type { AppConfig } from '@librechat/data-schemas';
import type { GetAppConfigOptions } from '../app/service';
import { isEnabled } from '~/utils';

type SharedLinkStartupEnv = NodeJS.ProcessEnv;

interface SharedLinkConfigRequest extends Request {
  config?: AppConfig;
  shareTenantId?: string;
}

interface SharedLinkConfigMiddlewareDeps {
  getAppConfig: (options?: GetAppConfigOptions) => Promise<AppConfig>;
  /** Reject instead of substituting the base config when the tenant's overrides fail to load. */
  failClosed?: boolean;
}

/** Resolve shared-link policy independently of the authenticated viewer. */
export async function resolveSharedLinkConfig(
  getAppConfig: SharedLinkConfigMiddlewareDeps['getAppConfig'],
  tenantId?: string,
  failClosed?: boolean,
): Promise<AppConfig> {
  if (tenantId && tenantId !== SYSTEM_TENANT_ID) {
    return tenantStorage.run({ tenantId }, () =>
      getAppConfig({ tenantId, ...(failClosed && { failClosed }) }),
    );
  }
  return getAppConfig({ baseOnly: true });
}

export function createSharedLinkConfigMiddleware({
  getAppConfig,
  failClosed,
}: SharedLinkConfigMiddlewareDeps) {
  return async function sharedLinkConfigMiddleware(
    req: SharedLinkConfigRequest,
    _res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      req.config = await resolveSharedLinkConfig(getAppConfig, req.shareTenantId, failClosed);
      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Whether shared links should snapshot the files referenced by the shared chat
 * snapshot. The `SHARED_LINKS_SNAPSHOT_FILES` env var overrides the yaml
 * `interface.sharedLinks.snapshotFiles` value; both default to enabled.
 */
export function isFileSnapshotEnabled(appConfig?: AppConfig): boolean {
  const envValue = process.env.SHARED_LINKS_SNAPSHOT_FILES;
  if (envValue !== undefined) {
    return isEnabled(envValue);
  }

  const sharedLinks = appConfig?.interfaceConfig?.sharedLinks;
  if (sharedLinks && typeof sharedLinks === 'object') {
    return sharedLinks.snapshotFiles !== false;
  }

  return true;
}

/**
 * Viewer-independent global kill switch for serving shared-link files. Reading
 * and serving must NOT depend on the viewer's resolved config (per-role/user
 * overrides) — only on the link's own stored choice plus this global env switch.
 * Active only when `SHARED_LINKS_SNAPSHOT_FILES` is explicitly set to a disabled
 * value; the creator's yaml choice is already captured per-link at share time.
 */
export function isFileSnapshotKillSwitchActive(): boolean {
  const envValue = process.env.SHARED_LINKS_SNAPSHOT_FILES;
  return envValue !== undefined && !isEnabled(envValue);
}

export function buildSharedLinkStartupPayload(
  appConfig?: AppConfig | null,
  env: SharedLinkStartupEnv = process.env,
): TSharedLinkStartupConfig {
  const payload: TSharedLinkStartupConfig = {
    appTitle: env.APP_TITLE || 'LibreChat',
  };

  if (typeof env.ANALYTICS_GTM_ID === 'string') {
    payload.analyticsGtmId = env.ANALYTICS_GTM_ID;
  }
  if (typeof env.SANDPACK_BUNDLER_URL === 'string') {
    payload.bundlerURL = env.SANDPACK_BUNDLER_URL;
  }
  if (typeof env.SANDPACK_STATIC_BUNDLER_URL === 'string') {
    payload.staticBundlerURL = env.SANDPACK_STATIC_BUNDLER_URL;
  }
  if (typeof env.CUSTOM_FOOTER === 'string') {
    payload.customFooter = env.CUSTOM_FOOTER;
  }

  const { privacyPolicy, termsOfService, codeHighlightThrottleMs } =
    appConfig?.interfaceConfig ?? {};
  const parsedTheme = deploymentThemeSchema.safeParse(appConfig?.interfaceConfig?.theme);
  const theme = parsedTheme.success ? parsedTheme.data : undefined;
  if (privacyPolicy || termsOfService || codeHighlightThrottleMs != null || theme) {
    payload.interface = {
      ...(codeHighlightThrottleMs != null ? { codeHighlightThrottleMs } : {}),
      ...(privacyPolicy ? { privacyPolicy } : {}),
      ...(termsOfService ? { termsOfService } : {}),
      ...(theme ? { theme } : {}),
    };
  }

  return payload;
}
