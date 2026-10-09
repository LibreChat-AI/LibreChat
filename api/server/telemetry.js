require('dotenv').config();

function isTruthy(value) {
  return value?.trim().toLowerCase() === 'true';
}

function isTelemetryEnabled() {
  const signalEnabled =
    isTruthy(process.env.OTEL_TRACING_ENABLED) || isTruthy(process.env.OTEL_LOGS_ENABLED);
  return signalEnabled && !isTruthy(process.env.OTEL_SDK_DISABLED);
}

if (isTelemetryEnabled()) {
  const {
    initializeTelemetry,
    telemetryMiddleware,
    telemetryErrorMiddleware,
  } = require('@librechat/api/telemetry');
  const controller = initializeTelemetry();

  module.exports = {
    get enabled() {
      return controller.enabled;
    },
    get status() {
      return controller.status;
    },
    shutdown: controller.shutdown,
    telemetryMiddleware,
    telemetryErrorMiddleware,
  };
} else {
  module.exports = {
    enabled: false,
    get status() {
      return 'disabled';
    },
    shutdown: async () => {},
    telemetryMiddleware: (_req, _res, next) => next(),
    telemetryErrorMiddleware: (err, _req, _res, next) => next(err),
  };
}
