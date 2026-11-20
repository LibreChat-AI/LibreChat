import type { TTelemetryConfig } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { Request, RequestHandler } from 'express';
import { isEnabled } from '~/utils';

export type RumRequest = Request & {
  config?: { config?: { telemetry?: TTelemetryConfig } };
};

export function resolveRumPolicy(
  telemetry: TTelemetryConfig | undefined,
  env: NodeJS.ProcessEnv,
): { enabled: boolean; sessionReplay: { enabled: boolean } } {
  const enabled = telemetry?.rum?.enabled ?? isEnabled(env.RUM_ENABLED);
  const replayConfig = telemetry?.rum?.sessionReplay;
  const configuredReplay = replayConfig == null ? undefined : (replayConfig.enabled ?? false);
  const positiveReplay = env.RUM_SESSION_REPLAY_ENABLED?.trim();
  const legacyReplay = env.RUM_DISABLE_REPLAY?.trim();
  const replayEnabled =
    configuredReplay ??
    (positiveReplay ? isEnabled(positiveReplay) : !!legacyReplay && !isEnabled(legacyReplay));
  return { enabled, sessionReplay: { enabled: enabled && replayEnabled } };
}

/** Deployment policy comes from the cached base config, never a browser payload or user override. */
export function loadRumConfig(
  getAppConfig: (options: { baseOnly: true }) => Promise<AppConfig>,
): RequestHandler {
  return async (req: RumRequest, _res, next) => {
    try {
      req.config = await getAppConfig({ baseOnly: true });
      next();
    } catch (error) {
      next(error);
    }
  };
}
