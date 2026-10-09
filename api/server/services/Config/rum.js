const {
  isEnabled,
  isRumProxyEnabled,
  getRumProxyClientUrl,
  isRumClientLogsEnabled,
} = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');

const DEFAULT_RUM_SERVICE_NAME = 'librechat-web';

function parseBooleanEnv(value, defaultValue = false) {
  if (value == null || value === '') {
    return defaultValue;
  }

  return isEnabled(value);
}

function parseNumberEnv(value) {
  if (value == null || value === '') {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseCsvEnv(value) {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function isLocalhost(url) {
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
}

function isSafeRumUrl(url) {
  if (url.username || url.password) {
    return false;
  }

  if (url.protocol === 'https:') {
    return true;
  }

  return url.protocol === 'http:' && isLocalhost(url);
}

function isSafeTraceTarget(target) {
  if (target.includes('*')) {
    return false;
  }

  const url = parseUrl(target);
  if (!url || url.protocol !== 'https:') {
    return false;
  }

  return true;
}

function getRumConfig() {
  if (!parseBooleanEnv(process.env.RUM_ENABLED)) {
    return undefined;
  }

  const provider = process.env.RUM_PROVIDER || 'hyperdx';
  if (provider !== 'hyperdx') {
    logger.warn(`[config] Unsupported RUM provider "${provider}", disabling RUM`);
    return undefined;
  }

  const authMode = process.env.RUM_AUTH_MODE || 'publicToken';
  if (authMode !== 'publicToken' && authMode !== 'proxy') {
    logger.warn(`[config] Unsupported RUM auth mode "${authMode}", disabling RUM`);
    return undefined;
  }

  let rumUrl;
  if (authMode === 'proxy') {
    rumUrl = getRumProxyClientUrl();

    if (!isRumProxyEnabled()) {
      logger.warn('[config] RUM proxy mode requires RUM_PROXY_TARGET_URL, disabling RUM');
      return undefined;
    }
  } else {
    rumUrl = process.env.RUM_URL;
    const parsedUrl = rumUrl ? parseUrl(rumUrl) : undefined;

    if (!parsedUrl || !isSafeRumUrl(parsedUrl)) {
      logger.warn('[config] Invalid RUM_URL, disabling RUM');
      return undefined;
    }

    if (!process.env.RUM_PUBLIC_TOKEN) {
      logger.warn('[config] RUM publicToken mode requires RUM_PUBLIC_TOKEN, disabling RUM');
      return undefined;
    }

    rumUrl = parsedUrl.href.replace(/\/$/, '');
  }

  const rawTracePropagationTargets = parseCsvEnv(process.env.RUM_TRACE_PROPAGATION_TARGETS);
  const tracePropagationTargets = rawTracePropagationTargets.filter(isSafeTraceTarget);
  if (rawTracePropagationTargets.length !== tracePropagationTargets.length) {
    logger.info('[config] Ignored unsafe RUM trace propagation targets');
  }

  const configuredSampleRate = parseNumberEnv(process.env.RUM_SAMPLE_RATE);
  const sampleRate =
    configuredSampleRate != null && configuredSampleRate >= 0 && configuredSampleRate <= 1
      ? configuredSampleRate
      : undefined;
  const consoleCapture = parseBooleanEnv(process.env.RUM_CONSOLE_CAPTURE);
  const advancedNetworkCapture = parseBooleanEnv(process.env.RUM_ADVANCED_NETWORK_CAPTURE);

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
    serviceName: process.env.RUM_SERVICE_NAME || DEFAULT_RUM_SERVICE_NAME,
    authMode,
    ...(authMode === 'publicToken' ? { publicToken: process.env.RUM_PUBLIC_TOKEN } : {}),
    ...(tracePropagationTargets.length > 0 ? { tracePropagationTargets } : {}),
    consoleCapture,
    disableReplay: parseBooleanEnv(process.env.RUM_DISABLE_REPLAY, true),
    advancedNetworkCapture,
    ...(sampleRate != null ? { sampleRate } : {}),
    ...(process.env.RUM_ENVIRONMENT ? { environment: process.env.RUM_ENVIRONMENT } : {}),
    clientLogs: isRumClientLogsEnabled(),
  };
}

module.exports = { getRumConfig };
