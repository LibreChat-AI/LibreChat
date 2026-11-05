import { resolveMCPAppsPolicy } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { MCPAllowlistResolver } from './MCPServersRegistry';
import type { GetAppConfigOptions } from '~/app/service';

/**
 * Builds the registry's per-request MCP policy resolver from the merged, tenant-scoped config:
 * the `mcpSettings` allowlists, the apps policy, and the server names the principal's config
 * keeps, which decide the librechat.yaml servers hidden for that principal.
 *
 * The read is strict, so a principal or override failure rejects instead of answering with
 * the broader base config, and it skips runtime augmentation, which none of these values read.
 * A caller that supplies the role and `idOnTheSource` its request already loaded spares the read
 * a user lookup and shares the request's merged-config cache entry. Tenant comes from the ALS
 * context inside `getAppConfig`.
 */
export function createMCPPolicyResolver(
  getAppConfig: (options: GetAppConfigOptions) => Promise<AppConfig | undefined>,
): MCPAllowlistResolver {
  return async (ctx) => {
    const appConfig = await getAppConfig({
      role: ctx?.role,
      userId: ctx?.userId,
      idOnTheSource: ctx?.idOnTheSource,
      failClosed: true,
      skipRuntimeAugmentation: true,
    });
    const sandbox = appConfig?.mcpAppSandbox;
    return {
      serverNames: Object.keys(appConfig?.mcpConfig ?? {}),
      allowedDomains: appConfig?.mcpSettings?.allowedDomains,
      allowedAddresses: appConfig?.mcpSettings?.allowedAddresses,
      mcpApps: resolveMCPAppsPolicy(
        appConfig?.mcpSettings?.apps,
        undefined,
        sandbox?.maxPersistedAppBytes,
        sandbox?.maxAdmissionRequestsPerMinute,
        sandbox?.url,
        sandbox?.maxActiveViews,
        sandbox?.maxActionPreviewChars,
        sandbox?.operationLimits,
      ),
    };
  };
}
