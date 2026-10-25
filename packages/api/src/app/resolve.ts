import { tenantStorage } from '@librechat/data-schemas';
import type { AppConfig } from '@librechat/data-schemas';
import type { GetAppConfigOptions } from './service';

interface UserForConfigResolution {
  tenantId?: string;
  role?: string;
}

type GetAppConfig = (opts: GetAppConfigOptions) => Promise<AppConfig>;

/**
 * Config for a sign-in decision made before the user is known, such as the
 * `registration.allowedDomains` check: librechat.yaml plus the `__base__` override of the
 * request's tenant, or of the deployment outside a tenant (tenant from ALS). No principal is
 * resolved, so nothing role-, group- or user-scoped is read.
 *
 * Fails closed: librechat.yaml alone can be broader than the policy an admin stored, so an
 * override read failure must not decide sign-in on the YAML.
 */
export function resolvePreAuthAppConfig(getAppConfig: GetAppConfig): Promise<AppConfig> {
  return getAppConfig({ skipRuntimeAugmentation: true, failClosed: true });
}

/**
 * Config for the signed-out startup payload (`GET /api/config` without a session): the
 * pre-auth config, falling back to librechat.yaml when overrides cannot be read, since it only
 * renders the sign-in pages. Turnstile comes from librechat.yaml here as everywhere, because
 * `turnstile` is a base-only section that no config document overrides.
 */
export function resolvePreLoginAppConfig(getAppConfig: GetAppConfig): Promise<AppConfig> {
  return getAppConfig({ skipRuntimeAugmentation: true });
}

/**
 * Resolves the config a sign-in continues under once the user is known: the pre-auth config
 * plus the user's role overrides, in the user's tenant when it has one. An account about to be
 * created is passed as its role alone and resolves in the request's tenant (ALS), the tenant it
 * will be created in. Without a user it is the pre-auth config. Fails closed like
 * `resolvePreAuthAppConfig`.
 *
 * Auth flows only apply role-level overrides (userId is not passed) because
 * user/group principal resolution requires heavier DB work that is deferred
 * to post-authentication config calls.
 *
 * `tenantId` is propagated through two channels that serve different purposes:
 * - `tenantStorage.run()` sets the ALS context so Mongoose's `applyTenantIsolation`
 *   plugin scopes any DB queries (e.g., `getApplicableConfigs`) to the tenant.
 * - The explicit `tenantId` parameter to `getAppConfig` is used for cache-key
 *   computation in `overrideCacheKey()`. Both channels are required.
 */
export async function resolveAppConfigForUser(
  getAppConfig: GetAppConfig,
  user: UserForConfigResolution | null | undefined,
): Promise<AppConfig> {
  if (!user) {
    return resolvePreAuthAppConfig(getAppConfig);
  }
  const options: GetAppConfigOptions = {
    role: user.role,
    skipRuntimeAugmentation: true,
    failClosed: true,
  };
  const { tenantId } = user;
  if (tenantId) {
    return tenantStorage.run({ tenantId }, async () => getAppConfig({ ...options, tenantId }));
  }
  return getAppConfig(options);
}
