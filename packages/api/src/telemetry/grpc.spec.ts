import { trace } from '@opentelemetry/api';
import { logger } from '@librechat/data-schemas';
import { Server, ServerCredentials } from '@grpc/grpc-js';
import type { sendUnaryData, ServerUnaryCall, ServiceDefinition } from '@grpc/grpc-js';
import { initializeTelemetry, resetTelemetryForTests, shutdownTelemetry } from './sdk';

const LOGS_EXPORT_PATH = '/opentelemetry.proto.collector.logs.v1.LogsService/Export';
const TRACES_EXPORT_PATH = '/opentelemetry.proto.collector.trace.v1.TraceService/Export';
const SERVICE_NAME = 'librechat-grpc-spec';
const SPAN_NAME = 'grpc-spec-span';
const INFO_MESSAGE = 'grpc-spec-info-message';
const DEBUG_MESSAGE = 'grpc-spec-debug-message';
const SECRET_SUFFIX = 'GRPCSPECSECRET1234567890';
const EXPORTER_ENV_KEYS = [
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_PROTOCOL',
  'OTEL_METRICS_EXPORTER',
  'OTEL_NODE_RESOURCE_DETECTORS',
] as const;

type ExportHandler = (
  call: ServerUnaryCall<Buffer, Buffer>,
  callback: sendUnaryData<Buffer>,
) => void;

const identity = (value: Buffer): Buffer => value;

function createExportService(path: string): ServiceDefinition {
  return {
    Export: {
      path,
      requestStream: false,
      responseStream: false,
      requestSerialize: identity,
      requestDeserialize: identity,
      responseSerialize: identity,
      responseDeserialize: identity,
    },
  };
}

function createExportHandler(received: Buffer[]): ExportHandler {
  return (call, callback) => {
    received.push(call.request);
    callback(null, Buffer.alloc(0));
  };
}

function bindServer(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', ServerCredentials.createInsecure(), (error, port) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(port);
    });
  });
}

/**
 * Exercises the real Node SDK, OTLP/gRPC exporters and winston bridge against an
 * in-process gRPC collector, so the environment-driven protocol selection is
 * verified end to end rather than assumed.
 */
describe('OTLP/gRPC export', () => {
  const server = new Server();
  const receivedLogs: Buffer[] = [];
  const receivedTraces: Buffer[] = [];
  const previousEnv: Partial<Record<(typeof EXPORTER_ENV_KEYS)[number], string | undefined>> = {};
  let startedStatus = '';
  let traceId = '';

  beforeAll(async () => {
    server.addService(createExportService(LOGS_EXPORT_PATH), {
      Export: createExportHandler(receivedLogs),
    });
    server.addService(createExportService(TRACES_EXPORT_PATH), {
      Export: createExportHandler(receivedTraces),
    });
    const port = await bindServer(server);
    server.start();

    for (const key of EXPORTER_ENV_KEYS) {
      previousEnv[key] = process.env[key];
    }
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${port}`;
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'grpc';
    process.env.OTEL_METRICS_EXPORTER = 'none';
    process.env.OTEL_NODE_RESOURCE_DETECTORS = 'none';

    const controller = initializeTelemetry({
      OTEL_LOGS_ENABLED: 'true',
      OTEL_SERVICE_NAME: SERVICE_NAME,
      OTEL_TRACING_ENABLED: 'true',
    });
    startedStatus = controller.status;

    trace.getTracer('librechat.grpc.spec').startActiveSpan(SPAN_NAME, (span) => {
      traceId = span.spanContext().traceId;
      logger.info(`${INFO_MESSAGE} sk-${SECRET_SUFFIX}`);
      logger.debug(DEBUG_MESSAGE);
      span.end();
    });

    await shutdownTelemetry();
  });

  afterAll(async () => {
    await resetTelemetryForTests();
    for (const key of EXPORTER_ENV_KEYS) {
      const value = previousEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    server.forceShutdown();
  });

  it('starts the Node SDK with gRPC exporters', () => {
    expect(startedStatus).toBe('started');
  });

  it('exports winston records over gRPC, redacted and correlated with the active span', () => {
    const payload = Buffer.concat(receivedLogs);

    expect(receivedLogs.length).toBeGreaterThan(0);
    expect(payload.includes(INFO_MESSAGE)).toBe(true);
    expect(payload.includes(SERVICE_NAME)).toBe(true);
    expect(payload.includes(Buffer.from(traceId, 'hex'))).toBe(true);
    expect(payload.includes(SECRET_SUFFIX)).toBe(false);
    expect(payload.includes(DEBUG_MESSAGE)).toBe(false);
  });

  it('exports spans over gRPC', () => {
    const payload = Buffer.concat(receivedTraces);

    expect(receivedTraces.length).toBeGreaterThan(0);
    expect(payload.includes(SPAN_NAME)).toBe(true);
    expect(payload.includes(Buffer.from(traceId, 'hex'))).toBe(true);
  });
});
