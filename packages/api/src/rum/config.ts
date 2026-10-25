import { logger } from '@librechat/data-schemas';
import type { TRumConfig, TTelemetryConfig } from 'librechat-data-provider';
import { getRumProxyClientUrl, isRumProxyEnabled, isRumClientLogsEnabled } from './proxy';
import { resolveRumPolicy } from './policy';
import { isEnabled } from '~/utils';

function parseNumber(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseUrl(value: string | undefined): URL | undefined {
  try {
    return value ? new URL(value) : undefined;
  } catch {
    return undefined;
  }
}

function isSafeRumUrl(url: URL): boolean {
  if (url.username || url.password) return false;
  return (
    url.protocol === 'https:' ||
    (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  );
}

function isSafeTraceTarget(target: string): boolean {
  return !target.includes('*') && parseUrl(target)?.protocol === 'https:';
}

/** Publish only browser-safe settings; collector credentials stay server-side. */
export function getRumConfig(telemetry?: TTelemetryConfig): TRumConfig | undefined {
  const env = process.env;
  const policy = resolveRumPolicy(telemetry, env);
  if (!policy.enabled) return undefined;
  if (env.RUM_PROVIDER && env.RUM_PROVIDER !== 'hyperdx') {
    logger.warn(`[config] Unsupported RUM provider "${env.RUM_PROVIDER}", disabling RUM`);
    return undefined;
  }
  const authMode = env.RUM_AUTH_MODE || 'publicToken';
  if (authMode !== 'publicToken' && authMode !== 'proxy') {
    logger.warn(`[config] Unsupported RUM auth mode "${authMode}", disabling RUM`);
    return undefined;
  }

  let rumUrl: string;
  if (authMode === 'proxy') {
    if (!isRumProxyEnabled(telemetry)) {
      logger.warn('[config] RUM proxy mode requires RUM_PROXY_TARGET_URL, disabling RUM');
      return undefined;
    }
    rumUrl = getRumProxyClientUrl();
  } else {
    const url = parseUrl(env.RUM_URL);
    if (!url || !isSafeRumUrl(url)) {
      logger.warn('[config] Invalid RUM_URL, disabling RUM');
      return undefined;
    }
    if (!env.RUM_PUBLIC_TOKEN) {
      logger.warn('[config] RUM publicToken mode requires RUM_PUBLIC_TOKEN, disabling RUM');
      return undefined;
    }
    rumUrl = url.href.replace(/\/$/, '');
  }

  const rawTargets = (env.RUM_TRACE_PROPAGATION_TARGETS ?? '')
    .split(',')
    .map((target) => target.trim())
    .filter(Boolean);
  const tracePropagationTargets = rawTargets.filter(isSafeTraceTarget);
  if (rawTargets.length !== tracePropagationTargets.length) {
    logger.info('[config] Ignored unsafe RUM trace propagation targets');
  }
  const configuredSampleRate = parseNumber(env.RUM_SAMPLE_RATE);
  const sampleRate =
    configuredSampleRate != null && configuredSampleRate >= 0 && configuredSampleRate <= 1
      ? configuredSampleRate
      : undefined;
  const consoleCapture = isEnabled(env.RUM_CONSOLE_CAPTURE);
  const advancedNetworkCapture = isEnabled(env.RUM_ADVANCED_NETWORK_CAPTURE);
  if (consoleCapture) {
    logger.warn('[config] RUM console capture is enabled and may collect sensitive browser logs');
  }
  if (advancedNetworkCapture) {
    logger.warn('[config] RUM advanced network capture is enabled and may collect payload data');
  }

  return {
    provider: 'hyperdx',
    enabled: true,
    url: rumUrl,
    serviceName: env.RUM_SERVICE_NAME || 'librechat-web',
    authMode,
    ...(authMode === 'publicToken' ? { publicToken: env.RUM_PUBLIC_TOKEN } : {}),
    ...(tracePropagationTargets.length > 0 ? { tracePropagationTargets } : {}),
    consoleCapture,
    sessionReplay: policy.sessionReplay,
    disableReplay: !policy.sessionReplay.enabled,
    advancedNetworkCapture,
    ...(sampleRate != null ? { sampleRate } : {}),
    ...(env.RUM_ENVIRONMENT ? { environment: env.RUM_ENVIRONMENT } : {}),
    clientLogs: isRumClientLogsEnabled(telemetry),
  };
}
