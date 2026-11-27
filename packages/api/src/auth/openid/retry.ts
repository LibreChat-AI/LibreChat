import { logger } from '@librechat/data-schemas';
import { openIdDiscoverySchema } from 'librechat-data-provider';
import type { TOpenIdDiscoveryConfig } from 'librechat-data-provider';

type DiscoveryField = 'startupAttempts' | 'retryDelayMs';

export type OpenIdDiscoveryEnv = {
  startupAttempts?: string;
  retryDelayMs?: string;
};

export type OpenIdRegistrationOptions<TConfig> = {
  /** Runs discovery and registers the `openid` strategy; resolves `null` when discovery fails. */
  setupOpenId: () => Promise<TConfig | null>;
  /** Registers the `openidJwt` strategy for a discovered configuration. */
  registerJwtStrategy: (config: TConfig) => void;
  reuseTokens: boolean;
  /** Settings from `registration.openidDiscovery` in `librechat.yaml`. */
  discovery?: Partial<TOpenIdDiscoveryConfig>;
  /** Raw `OPENID_DISCOVERY_RETRY_*` values, used for fields the YAML leaves unset. */
  env?: OpenIdDiscoveryEnv;
};

function resolveField(
  field: DiscoveryField,
  configured: number | undefined,
  raw: string | undefined,
): number {
  const fieldSchema = openIdDiscoverySchema.shape[field];
  if (configured != null) {
    return configured;
  }
  if (raw == null || raw.trim() === '') {
    return fieldSchema.parse(undefined);
  }
  const parsed = fieldSchema.safeParse(Number(raw));
  if (parsed.success) {
    return parsed.data;
  }
  const fallback = fieldSchema.parse(undefined);
  logger.warn(`[OpenID] Ignoring invalid discovery ${field} "${raw}"; using ${fallback}.`);
  return fallback;
}

/** Resolves discovery retry settings: YAML first, then environment, then the schema defaults. */
export function resolveOpenIdDiscovery(
  discovery?: Partial<TOpenIdDiscoveryConfig>,
  env: OpenIdDiscoveryEnv = {},
): TOpenIdDiscoveryConfig {
  return {
    startupAttempts: resolveField(
      'startupAttempts',
      discovery?.startupAttempts,
      env.startupAttempts,
    ),
    retryDelayMs: resolveField('retryDelayMs', discovery?.retryDelayMs, env.retryDelayMs),
  };
}

const wait = (delay: number) => new Promise<void>((resolve) => setTimeout(resolve, delay));

/**
 * Registers the OpenID strategies, retrying discovery during startup and then in the
 * background until the provider becomes reachable.
 */
export async function registerOpenIdWithRetry<TConfig>({
  setupOpenId,
  registerJwtStrategy,
  reuseTokens,
  discovery,
  env,
}: OpenIdRegistrationOptions<TConfig>): Promise<void> {
  const { startupAttempts, retryDelayMs } = resolveOpenIdDiscovery(discovery, env);

  const tryRegistration = async (): Promise<boolean> => {
    try {
      const config = await setupOpenId();
      if (!config) {
        return false;
      }
      if (reuseTokens) {
        logger.info('OpenID token reuse is enabled.');
        registerJwtStrategy(config);
      }
      logger.info('OpenID Connect configured successfully.');
      return true;
    } catch (error) {
      logger.error('OpenID Connect strategy registration failed.', error);
      return false;
    }
  };

  for (let attempt = 1; attempt <= startupAttempts; attempt++) {
    if (await tryRegistration()) {
      return;
    }
    if (attempt < startupAttempts) {
      logger.warn(
        `OpenID Connect setup attempt ${attempt}/${startupAttempts} failed. Retrying in ${retryDelayMs}ms.`,
      );
      await wait(retryDelayMs);
    }
  }

  logger.error('OpenID Connect configuration failed - strategy not registered.');

  const scheduleRetry = () => {
    logger.warn(`OpenID Connect configuration is unavailable. Retrying in ${retryDelayMs}ms.`);
    const timer = setTimeout(async () => {
      if (!(await tryRegistration())) {
        scheduleRetry();
      }
    }, retryDelayMs);
    timer.unref?.();
  };

  scheduleRetry();
}
