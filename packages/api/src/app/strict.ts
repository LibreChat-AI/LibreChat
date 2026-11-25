import type { AppConfig } from '@librechat/data-schemas';
import type { AppConfigUserLike, GetAppConfigOptions } from './service';
import { getAppConfigOptionsFromUser, resolveStrictAppConfig } from './service';

const strictConfig: unique symbol = Symbol('strictAppConfig');
const identityKeys = ['userId', 'role', 'tenantId', 'idOnTheSource'] as const;

type StrictConfigRequest = {
  user?: AppConfigUserLike | null;
  config?: AppConfig;
  [strictConfig]?: {
    request: StrictConfigRequest;
    options: GetAppConfigOptions;
    config: AppConfig;
  };
};

/** Reuse only a successful strict read for the same request identity and config object. */
export async function loadStrictAppConfig(
  req: StrictConfigRequest,
  getAppConfig: (options: GetAppConfigOptions) => Promise<AppConfig | undefined>,
): Promise<AppConfig> {
  const options = getAppConfigOptionsFromUser(req.user);
  const cached = req[strictConfig];
  if (
    cached &&
    cached.request === req &&
    cached.config === req.config &&
    identityKeys.every((key) => cached.options[key] === options[key])
  ) {
    return cached.config;
  }
  const config = await resolveStrictAppConfig(getAppConfig, req.user);
  if (!config) throw new Error('Effective app configuration unavailable');
  req[strictConfig] = { request: req, options, config };
  return config;
}
