import { Router } from 'express';
import { timingSafeEqual } from 'crypto';
import { Registry, collectDefaultMetrics, Counter, Gauge, Histogram } from 'prom-client';
import { logger, setAgentEventActorReceiptMetricObserver } from '@librechat/data-schemas';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { Mongoose } from 'mongoose';
import type { AgentStartupMilestone, AgentStartupResult } from '~/agents/phases';
import type { LocatorTraversalFailure } from '../protection/diagnostics';
import { agentStartupMilestones, agentStartupResults } from '~/agents/phases';

const PATH_NORMALIZATIONS: [RegExp, string][] = [
  [/^\/api\/agents\/chat\/stream\/[^/]+(?=\/|$)/, '/api/agents/chat/stream/#id'],
  [/^\/api\/agents\/chat\/status\/[^/]+(?=\/|$)/, '/api/agents/chat/status/#id'],
  [/^\/api\/files\/code\/download\/[^/]+\/[^/]+(?=\/|$)/, '/api/files/code/download/#id/#id'],
  [/^\/api\/files\/download-url\/[^/]+\/[^/]+(?=\/|$)/, '/api/files/download-url/#id/#id'],
  [/^\/api\/files\/download\/[^/]+\/[^/]+(?=\/|$)/, '/api/files/download/#id/#id'],
  [/^\/api\/files\/[^/]+\/preview(?=\/|$)/, '/api/files/#id/preview'],
  [/^\/api\/skills\/[^/]+\/files(?:\/.*)?(?=\/|$)/, '/api/skills/#id/files'],
  [/^\/api\/messages\/artifact\/[^/]+(?=\/|$)/, '/api/messages/artifact/#id'],
  [/^\/api\/messages\/[^/]+\/[^/]+(?=\/|$)/, '/api/messages/#id/#id'],
  [/^\/api\/convos\/[^/]+\/messages\/[^/]+(?=\/|$)/, '/api/convos/#id/messages/#id'],
  [/^\/api\/messages\/[^/]+(?=\/|$)/, '/api/messages/#id'],
  [/^\/api\/convos\/[^/]+(?=\/|$)/, '/api/convos/#id'],
  [/^\/api\/files\/[^/]+(?=\/|$)/, '/api/files/#id'],
  [/^\/api\/agents\/[^/]+(?=\/|$)/, '/api/agents/#id'],
  [/^\/api\/assistants\/[^/]+(?=\/|$)/, '/api/assistants/#id'],
  [/^\/api\/share\/[^/]+(?=\/|$)/, '/api/share/#token'],
  [/^\/share\/[^/]+(?=\/|$)/, '/share/#id'],
  [/^\/api\/(tags|tools|runs|sessions)\/[0-9a-f]{24}(?=\/|$)/i, '/api/$1/#id'],
  [
    /^\/api\/(tools|sessions)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/i,
    '/api/$1/#id',
  ],
];

const STATIC_PATHS = new Set([
  '/',
  '/health',
  '/metrics',
  '/api/auth/login',
  '/api/config',
  '/api/agents/chat/abort',
  '/api/agents/chat/active',
  '/api/agents/v1/chat/completions',
  '/api/agents/v1/responses',
  '/api/files',
  '/api/files/config',
  '/api/files/images',
  '/api/files/images/avatar',
  '/api/files/speech/stt',
]);

const UPLOAD_PATHS = new Set([
  '/api/files',
  '/api/files/images',
  '/api/files/images/avatar',
  '/api/files/speech/stt',
  '/api/skills/#id/files',
]);

const UPLOAD_METHODS = new Set(['POST', 'PUT', 'PATCH']);

const LOW_CARDINALITY_PATHS: RegExp[] = [
  /^\/api\/agents\/chat\/stream\/#id$/,
  /^\/api\/agents\/chat\/status\/#id$/,
  /^\/api\/files\/#id\/preview$/,
  /^\/api\/files\/(code\/download|download-url|download)\/#id\/#id$/,
  /^\/api\/skills\/#id\/files$/,
  /^\/api\/messages\/#id$/,
  /^\/api\/messages\/#id\/#id$/,
  /^\/api\/messages\/artifact\/#id$/,
  /^\/api\/convos\/#id$/,
  /^\/api\/convos\/#id\/messages\/#id$/,
  /^\/api\/(files|agents|assistants|tags|tools|runs|sessions)\/#id$/,
  /^\/api\/share\/#token$/,
  /^\/share\/#id(?:\/edit)?$/,
];

const isLowCardinalityPath = (path: string): boolean =>
  STATIC_PATHS.has(path) || LOW_CARDINALITY_PATHS.some((pattern) => pattern.test(path));

const normalizeKnownPath = (path: string): string => {
  for (const [pattern, replacement] of PATH_NORMALIZATIONS) {
    if (pattern.test(path)) {
      return path.replace(pattern, replacement);
    }
  }

  return path;
};

const normalizeUnknownPath = (path: string): string => {
  if (STATIC_PATHS.has(path)) {
    return path;
  }

  if (path === '/api' || path.startsWith('/api/')) {
    return '/api/#path';
  }

  if (path === '/images' || path.startsWith('/images/')) {
    return '/images/#path';
  }

  if (path === '/avatars' || path.startsWith('/avatars/')) {
    return '/avatars/#path';
  }

  if (path === '/t' || path.startsWith('/t/')) {
    return '/t/#path';
  }

  return '/#path';
};

export const normalizePath = (rawPath: string): string => {
  const [pathWithoutQuery] = rawPath.split('?');
  const path = pathWithoutQuery.startsWith('/') ? pathWithoutQuery : `/${pathWithoutQuery}`;
  const normalized = normalizeKnownPath(path || '/');

  if (isLowCardinalityPath(normalized)) {
    return normalized;
  }

  return normalizeUnknownPath(path);
};

export interface PrometheusMetrics {
  metricsMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  metricsRouter: Router;
}

export interface AgentEventActorStorageMetricsSnapshot {
  retainedByResolution: Record<
    'checkpoint_verified' | 'action_compensated' | 'history_repaired',
    number
  >;
  expiryEligible: number;
  retryDeliveries: number;
  deadDeliveries: number;
  pendingReconciliations: number;
  oldestPendingAgeSeconds: number;
}

export interface MetricsOptions {
  collectAgentEventActorStorageMetrics?: () => Promise<AgentEventActorStorageMetricsSnapshot>;
}

const AGENT_EVENT_ACTOR_STORAGE_METRICS_CACHE_MS = 60_000;

export type OpenIDUserLookupResult = 'found' | 'not_found' | 'migration' | 'auth_failed' | 'error';
export type GenerationJobStore = 'memory' | 'redis';
export type GenerationJobResult = 'created' | 'completed' | 'error' | 'aborted' | 'abort_failed';
export type GenerationStreamSubscriptionType = 'initial' | 'resume' | 'resume_state';
export type GenerationStreamSubscriptionResult =
  | 'success'
  | 'not_found'
  | 'error'
  | 'found'
  | 'missing';
export type GenerationStreamRecoveryMethod = 'redis' | 'snapshot';
export type GenerationStreamRecoveryOutcome = 'success' | 'failed' | 'not_required';
export type GenerationStreamAttachmentOutcome =
  | 'attached'
  | 'bootstrap_slow'
  | 'disconnected'
  | 'never_attached';
export type RumProxyEndpoint = 'traces' | 'logs' | 'unknown';
export type RumProxyResult =
  | 'success'
  | 'auth_drop'
  | 'auth_error'
  | 'bad_request'
  | 'not_configured'
  | 'collector_4xx'
  | 'collector_5xx'
  | 'collector_error'
  | 'collector_timeout';
export type ShareLinkOperation = 'create' | 'update';
export type ShareLinkRejectionCode = 'TARGET_MESSAGE_NOT_FOUND' | 'NO_MESSAGES';
export type RedisClient = 'ioredis' | 'keyv';
export type RedisOperationStatus = 'success' | 'error';

type OpenIDUserLookupMetrics = {
  recordLookup: (result: OpenIDUserLookupResult, durationSeconds: number) => void;
};

let openIDUserLookupMetrics: OpenIDUserLookupMetrics = {
  recordLookup: () => undefined,
};

export function recordOpenIDUserLookup(
  result: OpenIDUserLookupResult,
  durationSeconds: number,
): void {
  openIDUserLookupMetrics.recordLookup(result, durationSeconds);
}

type MongooseQueryMetrics = {
  recordQuery: (model: string, operation: string, status: string, durationSeconds: number) => void;
};

let mongooseQueryMetrics: MongooseQueryMetrics = {
  recordQuery: () => undefined,
};

type GenerationJobMetrics = {
  recordJob: (store: GenerationJobStore, result: GenerationJobResult) => void;
  setJobsInFlight: (store: GenerationJobStore, count: number) => void;
  recordSubscription: (
    store: GenerationJobStore,
    type: GenerationStreamSubscriptionType,
    result: GenerationStreamSubscriptionResult,
  ) => void;
  recordResumePendingEvents: (store: GenerationJobStore, count: number) => void;
  recordEarlyBufferOverflow: (store: GenerationJobStore) => void;
  recordRecovery: (
    store: GenerationJobStore,
    method: GenerationStreamRecoveryMethod,
    outcome: GenerationStreamRecoveryOutcome,
    durationSeconds: number,
    reconstructedEvents: number,
    reconstructedContent: number,
  ) => void;
  recordAttachment: (
    store: GenerationJobStore,
    outcome: GenerationStreamAttachmentOutcome,
    delaySeconds?: number,
  ) => void;
};

let generationJobMetrics: GenerationJobMetrics = {
  recordJob: () => undefined,
  setJobsInFlight: () => undefined,
  recordSubscription: () => undefined,
  recordResumePendingEvents: () => undefined,
  recordEarlyBufferOverflow: () => undefined,
  recordRecovery: () => undefined,
  recordAttachment: () => undefined,
};

type AgentStartupMetrics = {
  recordMilestone: (milestone: AgentStartupMilestone, durationSeconds: number) => void;
  recordResult: (result: AgentStartupResult) => void;
};

const agentStartupMilestoneSet = new Set<string>(agentStartupMilestones);
const agentStartupResultSet = new Set<string>(agentStartupResults);

let agentStartupMetrics: AgentStartupMetrics = {
  recordMilestone: () => undefined,
  recordResult: () => undefined,
};

type RumProxyMetrics = {
  recordRequest: (endpoint: RumProxyEndpoint, result: RumProxyResult) => void;
};

let rumProxyMetrics: RumProxyMetrics = {
  recordRequest: () => undefined,
};

type ShareLinkMetrics = {
  recordRejection: (operation: ShareLinkOperation, code: ShareLinkRejectionCode) => void;
};

let shareLinkMetrics: ShareLinkMetrics = {
  recordRejection: () => undefined,
};

type RedisOperationMetrics = {
  recordOperation: (
    client: RedisClient,
    useCase: string,
    operation: string,
    status: RedisOperationStatus,
    durationSeconds: number,
  ) => void;
};

let redisOperationMetrics: RedisOperationMetrics = {
  recordOperation: () => undefined,
};

let observeLocatorTraversal: (failure: LocatorTraversalFailure) => void = () => undefined;

/** Application sink supplied explicitly to content inspection callers. */
export function reportLocatorTraversalFailure(failure: LocatorTraversalFailure): void {
  logger.warn(`[content-filter] Locator traversal incomplete ${JSON.stringify(failure)}`, failure);
  observeLocatorTraversal(failure);
}

const resetMetricRecorders = (): void => {
  observeLocatorTraversal = () => undefined;
  openIDUserLookupMetrics = {
    recordLookup: () => undefined,
  };
  mongooseQueryMetrics = {
    recordQuery: () => undefined,
  };
  generationJobMetrics = {
    recordJob: () => undefined,
    setJobsInFlight: () => undefined,
    recordSubscription: () => undefined,
    recordResumePendingEvents: () => undefined,
    recordEarlyBufferOverflow: () => undefined,
    recordRecovery: () => undefined,
    recordAttachment: () => undefined,
  };
  agentStartupMetrics = {
    recordMilestone: () => undefined,
    recordResult: () => undefined,
  };
  rumProxyMetrics = {
    recordRequest: () => undefined,
  };
  shareLinkMetrics = {
    recordRejection: () => undefined,
  };
  redisOperationMetrics = {
    recordOperation: () => undefined,
  };
  setAgentEventActorReceiptMetricObserver();
};

export function recordGenerationJob(store: GenerationJobStore, result: GenerationJobResult): void {
  generationJobMetrics.recordJob(store, result);
}

export function setGenerationJobsInFlight(store: GenerationJobStore, count: number): void {
  generationJobMetrics.setJobsInFlight(store, count);
}

export function recordGenerationStreamSubscription(
  store: GenerationJobStore,
  type: GenerationStreamSubscriptionType,
  result: GenerationStreamSubscriptionResult,
): void {
  generationJobMetrics.recordSubscription(store, type, result);
}

export function recordGenerationStreamResumePendingEvents(
  store: GenerationJobStore,
  count: number,
): void {
  generationJobMetrics.recordResumePendingEvents(store, count);
}

export function recordGenerationStreamEarlyBufferOverflow(store: GenerationJobStore): void {
  generationJobMetrics.recordEarlyBufferOverflow(store);
}

export function recordGenerationStreamRecovery(
  store: GenerationJobStore,
  method: GenerationStreamRecoveryMethod,
  outcome: GenerationStreamRecoveryOutcome,
  durationSeconds: number,
  reconstructedEvents: number,
  reconstructedContent: number,
): void {
  generationJobMetrics.recordRecovery(
    store,
    method,
    outcome,
    durationSeconds,
    reconstructedEvents,
    reconstructedContent,
  );
}

export function recordGenerationStreamAttachment(
  store: GenerationJobStore,
  outcome: GenerationStreamAttachmentOutcome,
  delaySeconds?: number,
): void {
  generationJobMetrics.recordAttachment(store, outcome, delaySeconds);
}

export function recordAgentStartupMilestone(
  milestone: AgentStartupMilestone,
  durationSeconds: number,
): void {
  if (
    !agentStartupMilestoneSet.has(milestone) ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds < 0
  ) {
    return;
  }
  agentStartupMetrics.recordMilestone(milestone, durationSeconds);
}

export function recordAgentStartupResult(result: AgentStartupResult): void {
  if (!agentStartupResultSet.has(result)) {
    return;
  }
  agentStartupMetrics.recordResult(result);
}

export function recordRumProxyRequest(endpoint: RumProxyEndpoint, result: RumProxyResult): void {
  rumProxyMetrics.recordRequest(endpoint, result);
}

export function recordShareLinkRejection(
  operation: ShareLinkOperation,
  code: ShareLinkRejectionCode,
): void {
  shareLinkMetrics.recordRejection(operation, code);
}

export function recordRedisOperation(
  client: RedisClient,
  useCase: string,
  operation: string,
  status: RedisOperationStatus,
  durationSeconds: number,
): void {
  redisOperationMetrics.recordOperation(client, useCase, operation, status, durationSeconds);
}

const getElapsedSeconds = (startedAt: bigint): number =>
  Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;

export const isMetricsConfigured = (): boolean => Boolean(process.env.METRICS_SECRET);

const createUnauthorizedMetricsRouter = (): Router => {
  const metricsRouter = Router();
  metricsRouter.get('/', (_req, res) => {
    res.status(401).end();
  });
  return metricsRouter;
};

const normalizeMongooseLabel = (value: unknown): string => {
  if (typeof value !== 'string' || !value) return 'unknown';
  return value.replace(/[^a-zA-Z0-9_:-]/g, '_').slice(0, 64) || 'unknown';
};

const getHeader = (headers: Record<string, unknown>, name: string): unknown => {
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) return value;
  }
  return undefined;
};

const headerIncludes = (value: unknown, expected: string): boolean => {
  if (Array.isArray(value)) {
    return value.some((entry) => headerIncludes(entry, expected));
  }
  return typeof value === 'string' && value.toLowerCase().includes(expected);
};

const isEventStreamContentType = (value: unknown): boolean =>
  headerIncludes(value, 'text/event-stream');

const isMultipartContentType = (value: unknown): boolean =>
  headerIncludes(value, 'multipart/form-data');

const getRequestContentLength = (req: Request): number | null => {
  const contentLength = req.headers['content-length'];
  const rawContentLength = Array.isArray(contentLength) ? contentLength[0] : contentLength;
  const bodyBytes = rawContentLength == null ? NaN : Number(rawContentLength);
  return Number.isFinite(bodyBytes) && bodyBytes >= 0 ? bodyBytes : null;
};

const isUploadRequest = (req: Request, normalizedPath: string): boolean => {
  if (!UPLOAD_METHODS.has(req.method)) return false;
  if (isMultipartContentType(req.headers['content-type'])) return true;
  return UPLOAD_PATHS.has(normalizedPath);
};

export function recordMongooseQuery(
  model: string,
  operation: string,
  status: string,
  durationSeconds: number,
): void {
  mongooseQueryMetrics.recordQuery(
    normalizeMongooseLabel(model),
    normalizeMongooseLabel(operation),
    normalizeMongooseLabel(status),
    durationSeconds,
  );
}

export function instrumentMongooseQueryMetrics(mongoose: Mongoose): void {
  if (!isMetricsConfigured()) return;

  const instrumented = Symbol.for('librechat.mongooseQueryMetrics.instrumented');
  const queryPrototype = mongoose.Query?.prototype as
    | (typeof mongoose.Query.prototype & { [instrumented]?: boolean })
    | undefined;

  if (!queryPrototype || queryPrototype[instrumented]) return;

  const originalExec = queryPrototype.exec;
  queryPrototype.exec = function instrumentedExec(
    this: typeof queryPrototype & {
      model?: { modelName?: string };
      op?: string;
    },
    ...args: Parameters<typeof originalExec>
  ) {
    const startedAt = process.hrtime.bigint();
    const model = normalizeMongooseLabel(this.model?.modelName);
    const operation = normalizeMongooseLabel(this.op);

    let result: ReturnType<typeof originalExec>;
    try {
      result = originalExec.apply(this, args);
    } catch (error) {
      recordMongooseQuery(model, operation, 'error', getElapsedSeconds(startedAt));
      throw error;
    }

    return Promise.resolve(result).then(
      (result) => {
        recordMongooseQuery(model, operation, 'success', getElapsedSeconds(startedAt));
        return result;
      },
      (error) => {
        recordMongooseQuery(model, operation, 'error', getElapsedSeconds(startedAt));
        throw error;
      },
    );
  } as typeof originalExec;
  queryPrototype[instrumented] = true;
}

export function createMetrics(options: MetricsOptions = {}): PrometheusMetrics {
  if (!isMetricsConfigured()) {
    resetMetricRecorders();
    return {
      metricsMiddleware: (_req: Request, _res: Response, next: NextFunction) => next(),
      metricsRouter: createUnauthorizedMetricsRouter(),
    };
  }

  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  observeLocatorTraversal = () => undefined;
  const locatorTraversalFailuresTotal = new Counter({
    name: 'content_filter_locator_traversal_failures_total',
    help: 'Incomplete resolved file locator traversals',
    labelNames: ['operation', 'reason'] as const,
    registers: [registry],
  });
  const locatorTraversalSize = new Histogram({
    name: 'content_filter_locator_traversal_size',
    help: 'Structural counts at an incomplete resolved file locator traversal',
    labelNames: ['operation', 'reason', 'dimension'] as const,
    buckets: [0, 1, 8, 24, 64, 256, 1024, 4096, 16384],
    registers: [registry],
  });
  observeLocatorTraversal = (failure: LocatorTraversalFailure): void => {
    const labels = { operation: failure.operation, reason: failure.reason };
    locatorTraversalFailuresTotal.inc(labels);
    for (const dimension of [
      'visitedNodes',
      'depth',
      'messageCount',
      'resolvedFileCount',
    ] as const) {
      locatorTraversalSize.observe({ ...labels, dimension }, failure[dimension]);
    }
  };

  const httpRequests = new Counter({
    name: 'http_requests_total',
    help: 'Total HTTP requests',
    labelNames: ['method', 'path', 'status'] as const,
    registers: [registry],
  });

  const httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency in seconds',
    labelNames: ['method', 'path', 'status'] as const,
    buckets: [0.05, 0.1, 0.3, 0.5, 1, 2, 5],
    registers: [registry],
  });

  const httpRequestsInFlight = new Gauge({
    name: 'http_requests_in_flight',
    help: 'HTTP requests currently being handled',
    labelNames: ['method', 'path'] as const,
    registers: [registry],
  });

  const httpRequestBodyBytes = new Histogram({
    name: 'http_request_body_bytes',
    help: 'HTTP request body size in bytes from the Content-Length header',
    labelNames: ['method', 'path'] as const,
    buckets: [1_000, 10_000, 100_000, 1_000_000, 5_000_000, 10_000_000, 25_000_000, 50_000_000],
    registers: [registry],
  });

  const sseStreams = new Counter({
    name: 'sse_streams_total',
    help: 'Total SSE streams opened',
    labelNames: ['method', 'path', 'status'] as const,
    registers: [registry],
  });

  const sseStreamsInFlight = new Gauge({
    name: 'sse_streams_in_flight',
    help: 'SSE streams currently open',
    labelNames: ['method', 'path'] as const,
    registers: [registry],
  });

  const sseStreamDuration = new Histogram({
    name: 'sse_stream_duration_seconds',
    help: 'SSE stream open duration in seconds',
    labelNames: ['method', 'path', 'status'] as const,
    buckets: [1, 5, 10, 30, 60, 120, 300, 600, 1_200, 1_800],
    registers: [registry],
  });

  const uploadRequests = new Counter({
    name: 'upload_requests_total',
    help: 'Total upload requests',
    labelNames: ['method', 'path', 'status'] as const,
    registers: [registry],
  });

  const uploadRequestsInFlight = new Gauge({
    name: 'upload_requests_in_flight',
    help: 'Upload requests currently being handled',
    labelNames: ['method', 'path'] as const,
    registers: [registry],
  });

  const uploadRequestDuration = new Histogram({
    name: 'upload_request_duration_seconds',
    help: 'Upload request duration in seconds',
    labelNames: ['method', 'path', 'status'] as const,
    buckets: [0.1, 0.3, 0.5, 1, 2, 5, 10, 30, 60, 120, 300],
    registers: [registry],
  });

  const uploadBytes = new Counter({
    name: 'upload_bytes_total',
    help: 'Upload request bytes from the Content-Length header',
    labelNames: ['method', 'path'] as const,
    registers: [registry],
  });

  const openIDUserLookupTotal = new Counter({
    name: 'openid_user_lookup_total',
    help: 'OpenID user lookup attempts',
    labelNames: ['result'] as const,
    registers: [registry],
  });

  const openIDUserLookupDuration = new Histogram({
    name: 'openid_user_lookup_duration_seconds',
    help: 'OpenID user lookup latency in seconds',
    labelNames: ['result'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
    registers: [registry],
  });

  openIDUserLookupMetrics = {
    recordLookup: (result, durationSeconds) => {
      openIDUserLookupTotal.inc({ result });
      openIDUserLookupDuration.observe({ result }, durationSeconds);
    },
  };

  const mongooseQueries = new Counter({
    name: 'mongoose_queries_total',
    help: 'Mongoose queries by model, operation, and status',
    labelNames: ['model', 'operation', 'status'] as const,
    registers: [registry],
  });

  const mongooseQueryDuration = new Histogram({
    name: 'mongoose_query_duration_seconds',
    help: 'Mongoose query duration in seconds by model, operation, and status',
    labelNames: ['model', 'operation', 'status'] as const,
    buckets: [0.001, 0.003, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
    registers: [registry],
  });

  mongooseQueryMetrics = {
    recordQuery: (model, operation, status, durationSeconds) => {
      const labels = { model, operation, status };
      mongooseQueries.inc(labels);
      mongooseQueryDuration.observe(labels, durationSeconds);
    },
  };

  const generationJobs = new Counter({
    name: 'generation_jobs_total',
    help: 'Generation jobs by backing store and result',
    labelNames: ['store', 'result'] as const,
    registers: [registry],
  });

  const generationJobsInFlight = new Gauge({
    name: 'generation_jobs_in_flight',
    help: 'Generation jobs currently running in this process',
    labelNames: ['store'] as const,
    registers: [registry],
  });

  const generationStreamSubscriptions = new Counter({
    name: 'generation_stream_subscriptions_total',
    help: 'Generation stream subscription attempts by backing store, type, and result',
    labelNames: ['store', 'type', 'result'] as const,
    registers: [registry],
  });

  const generationStreamResumePendingEvents = new Counter({
    name: 'generation_stream_resume_pending_events_total',
    help: 'Pending events delivered while resuming generation streams',
    labelNames: ['store'] as const,
    registers: [registry],
  });

  const generationStreamEarlyBufferOverflows = new Counter({
    name: 'generation_stream_early_buffer_overflows_total',
    help: 'Early event replay buffers discarded after exceeding hard size bounds',
    labelNames: ['store'] as const,
    registers: [registry],
  });

  const generationStreamRecoveries = new Counter({
    name: 'generation_stream_recoveries_total',
    help: 'Early buffer recovery attempts by backing store, source, and outcome',
    labelNames: ['store', 'method', 'outcome'] as const,
    registers: [registry],
  });

  const generationStreamRecoveryDuration = new Histogram({
    name: 'generation_stream_recovery_duration_seconds',
    help: 'Time spent reconstructing an overflowed early generation stream',
    labelNames: ['store', 'method', 'outcome'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [registry],
  });

  const generationStreamRecoveryEvents = new Histogram({
    name: 'generation_stream_recovery_events',
    help: 'Event count reconstructed during early buffer recovery',
    labelNames: ['store', 'method', 'outcome'] as const,
    buckets: [1, 10, 100, 1_000, 5_000, 10_000, 50_000],
    registers: [registry],
  });

  const generationStreamRecoveryContent = new Histogram({
    name: 'generation_stream_recovery_content_parts',
    help: 'Content part count reconstructed during early buffer recovery',
    labelNames: ['store', 'method', 'outcome'] as const,
    buckets: [1, 5, 10, 25, 50, 100, 500, 1_000],
    registers: [registry],
  });

  const generationStreamAttachments = new Counter({
    name: 'generation_stream_attachment_outcomes_total',
    help: 'Generation stream attachment lifecycle outcomes',
    labelNames: ['store', 'outcome'] as const,
    registers: [registry],
  });

  const generationStreamFirstAttachmentDelay = new Histogram({
    name: 'generation_stream_first_attachment_delay_seconds',
    help: 'Time from generation creation to its first subscriber attachment',
    labelNames: ['store'] as const,
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
    registers: [registry],
  });

  const agentStartupMilestoneDuration = new Histogram({
    name: 'agent_startup_milestone_duration_seconds',
    help: 'Cumulative agent chat startup latency from request ingress to each milestone',
    labelNames: ['milestone'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
    registers: [registry],
  });

  const agentStartups = new Counter({
    name: 'agent_startups_total',
    help: 'Agent chat startup attempts by terminal result',
    labelNames: ['result'] as const,
    registers: [registry],
  });

  const rumProxyRequests = new Counter({
    name: 'rum_proxy_requests_total',
    help: 'RUM proxy requests by endpoint and result',
    labelNames: ['endpoint', 'result'] as const,
    registers: [registry],
  });

  const shareLinkRejections = new Counter({
    name: 'share_link_rejections_total',
    help: 'Shared link publication rejections by operation and bounded domain code',
    labelNames: ['operation', 'code'] as const,
    registers: [registry],
  });

  const redisOperations = new Counter({
    name: 'redis_operations_total',
    help: 'Logical Redis operations by client, use case, operation, and status',
    labelNames: ['client', 'use_case', 'operation', 'status'] as const,
    registers: [registry],
  });

  const redisOperationDuration = new Histogram({
    name: 'redis_operation_duration_seconds',
    help: 'Logical Redis operation latency in seconds',
    labelNames: ['client', 'use_case', 'operation', 'status'] as const,
    buckets: [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });

  const agentEventActorReceiptOperations = new Counter({
    name: 'agent_event_actor_receipt_operations_total',
    help: 'Event actor receipt storage operations by bounded outcome and resolution',
    labelNames: ['operation', 'outcome', 'resolution'] as const,
    registers: [registry],
  });

  const agentEventActorReceiptsRetained = new Gauge({
    name: 'agent_event_actor_receipts_retained',
    help: 'Delivery-owned event actor receipts currently retained for replay',
    labelNames: ['resolution'] as const,
    registers: [registry],
  });
  const agentEventActorReceiptsExpiryEligible = new Gauge({
    name: 'agent_event_actor_receipts_expiry_eligible',
    help: 'Retained event actor receipts whose Mongo TTL deadline has elapsed',
    registers: [registry],
  });
  const agentEventActorReconciliationsPending = new Gauge({
    name: 'agent_event_actor_reconciliations_pending',
    help: 'Active event actor reconciliation markers awaiting a terminal delivery receipt',
    registers: [registry],
  });
  const agentEventActorOldestReconciliationAge = new Gauge({
    name: 'agent_event_actor_oldest_reconciliation_age_seconds',
    help: 'Age in seconds of the oldest active event actor reconciliation marker',
    registers: [registry],
  });
  const agentEventActorDeliveries = new Gauge({
    name: 'agent_event_actor_deliveries',
    help: 'Current retrying and dead delivery rows visible to the receipt ledger',
    labelNames: ['state'] as const,
    registers: [registry],
  });

  setAgentEventActorReceiptMetricObserver(({ operation, outcome, resolution }) => {
    agentEventActorReceiptOperations.inc({
      operation,
      outcome,
      resolution: resolution ?? 'none',
    });
  });

  let actorStorageMetricsCache:
    | { snapshot: AgentEventActorStorageMetricsSnapshot; expiresAt: number }
    | undefined;
  let actorStorageMetricsCollection: Promise<
    AgentEventActorStorageMetricsSnapshot | undefined
  > | null = null;
  const collectActorStorageMetrics = async () => {
    const now = Date.now();
    if (actorStorageMetricsCache != null && actorStorageMetricsCache.expiresAt > now) {
      return actorStorageMetricsCache.snapshot;
    }
    actorStorageMetricsCollection ??= Promise.resolve(
      options.collectAgentEventActorStorageMetrics?.(),
    )
      .then((snapshot) => {
        if (snapshot != null) {
          actorStorageMetricsCache = {
            snapshot,
            expiresAt: Date.now() + AGENT_EVENT_ACTOR_STORAGE_METRICS_CACHE_MS,
          };
        }
        return snapshot;
      })
      .finally(() => {
        actorStorageMetricsCollection = null;
      });
    return actorStorageMetricsCollection;
  };

  generationJobMetrics = {
    recordJob: (store, result) => generationJobs.inc({ store, result }),
    setJobsInFlight: (store, count) => generationJobsInFlight.set({ store }, count),
    recordSubscription: (store, type, result) =>
      generationStreamSubscriptions.inc({ store, type, result }),
    recordResumePendingEvents: (store, count) =>
      generationStreamResumePendingEvents.inc({ store }, count),
    recordEarlyBufferOverflow: (store) => generationStreamEarlyBufferOverflows.inc({ store }),
    recordRecovery: (
      store,
      method,
      outcome,
      durationSeconds,
      reconstructedEvents,
      reconstructedContent,
    ) => {
      const labels = { store, method, outcome };
      generationStreamRecoveries.inc(labels);
      generationStreamRecoveryDuration.observe(labels, durationSeconds);
      generationStreamRecoveryEvents.observe(labels, reconstructedEvents);
      generationStreamRecoveryContent.observe(labels, reconstructedContent);
    },
    recordAttachment: (store, outcome, delaySeconds) => {
      generationStreamAttachments.inc({ store, outcome });
      if (outcome === 'attached' && delaySeconds != null) {
        generationStreamFirstAttachmentDelay.observe({ store }, delaySeconds);
      }
    },
  };

  agentStartupMetrics = {
    recordMilestone: (milestone, durationSeconds) =>
      agentStartupMilestoneDuration.observe({ milestone }, durationSeconds),
    recordResult: (result) => agentStartups.inc({ result }),
  };

  rumProxyMetrics = {
    recordRequest: (endpoint, result) => rumProxyRequests.inc({ endpoint, result }),
  };

  shareLinkMetrics = {
    recordRejection: (operation, code) => shareLinkRejections.inc({ operation, code }),
  };

  redisOperationMetrics = {
    recordOperation: (client, useCase, operation, status, durationSeconds) => {
      const labels = { client, use_case: useCase, operation, status };
      redisOperations.inc(labels);
      redisOperationDuration.observe(labels, durationSeconds);
    },
  };

  const metricsMiddleware = (req: Request, res: Response, next: NextFunction): void => {
    const end = httpDuration.startTimer();
    const labels = { method: req.method, path: normalizePath(req.path) };
    const uploadTracked = isUploadRequest(req, labels.path);
    const uploadStartedAt = uploadTracked ? process.hrtime.bigint() : null;
    let sseTracked = false;
    let sseStartedAt: bigint | null = null;
    let completed = false;

    const markSSEStream = () => {
      if (completed || res.writableEnded || res.destroyed) return;
      if (sseTracked) return;
      sseTracked = true;
      sseStartedAt = process.hrtime.bigint();
      sseStreamsInFlight.inc(labels);
    };

    const originalSetHeader = res.setHeader;
    res.setHeader = function setHeader(this: Response, ...args: Parameters<Response['setHeader']>) {
      const [name, value] = args;
      const result = originalSetHeader.apply(this, args);
      if (String(name).toLowerCase() === 'content-type' && isEventStreamContentType(value)) {
        markSSEStream();
      }
      return result;
    } as Response['setHeader'];

    const originalWriteHead = res.writeHead;
    res.writeHead = function writeHead(this: Response, ...args: [number, unknown?, unknown?]) {
      const [, reasonPhrase, headers] = args;
      const responseHeaders =
        typeof reasonPhrase === 'object' && reasonPhrase != null ? reasonPhrase : headers;
      if (
        isEventStreamContentType(
          getHeader((responseHeaders ?? {}) as Record<string, unknown>, 'content-type'),
        ) ||
        isEventStreamContentType(res.getHeader('content-type'))
      ) {
        markSSEStream();
      }
      return originalWriteHead.apply(this, args as Parameters<typeof originalWriteHead>);
    } as Response['writeHead'];

    httpRequestsInFlight.inc(labels);
    if (uploadTracked) {
      uploadRequestsInFlight.inc(labels);
    }

    const complete = (completedBy: 'finish' | 'close') => {
      if (completed) return;
      completed = true;

      const requestLabels = {
        ...labels,
        status: completedBy === 'close' ? 499 : res.statusCode,
      };
      httpRequests.inc(requestLabels);
      end(requestLabels);
      httpRequestsInFlight.dec(labels);

      const bodyBytes = getRequestContentLength(req);
      if (bodyBytes != null) {
        httpRequestBodyBytes.observe(labels, bodyBytes);
      }

      if (sseTracked) {
        sseStreams.inc(requestLabels);
        sseStreamsInFlight.dec(labels);
        if (sseStartedAt) {
          sseStreamDuration.observe(requestLabels, getElapsedSeconds(sseStartedAt));
        }
      }

      if (uploadTracked) {
        uploadRequests.inc(requestLabels);
        uploadRequestsInFlight.dec(labels);
        if (uploadStartedAt) {
          uploadRequestDuration.observe(requestLabels, getElapsedSeconds(uploadStartedAt));
        }
        if (bodyBytes != null) {
          uploadBytes.inc(labels, bodyBytes);
        }
      }
    };

    res.once('finish', () => complete('finish'));
    res.once('close', () => complete('close'));
    next();
  };

  const metricsRouter = Router();
  const metricsHandler: RequestHandler = (req, res): void => {
    const secret = process.env.METRICS_SECRET;
    const auth = req.headers['authorization'];
    if (!secret || !auth) {
      res.status(401).end();
      return;
    }
    const bearerToken = auth.match(/^bearer\s+(.+)$/i);
    if (!bearerToken) {
      res.status(401).end();
      return;
    }

    const token = bearerToken[1];
    const encode = (s: string) => new TextEncoder().encode(s);
    const expected = encode(secret);
    const actual = encode(token);
    if (expected.byteLength !== actual.byteLength || !timingSafeEqual(expected, actual)) {
      res.status(401).end();
      return;
    }

    void Promise.resolve()
      .then(async () => {
        const snapshot = await collectActorStorageMetrics();
        if (snapshot == null) {
          return;
        }
        for (const [resolution, count] of Object.entries(snapshot.retainedByResolution)) {
          agentEventActorReceiptsRetained.set({ resolution }, count);
        }
        agentEventActorReceiptsExpiryEligible.set(snapshot.expiryEligible);
        agentEventActorReconciliationsPending.set(snapshot.pendingReconciliations);
        agentEventActorOldestReconciliationAge.set(snapshot.oldestPendingAgeSeconds);
        agentEventActorDeliveries.set({ state: 'retry' }, snapshot.retryDeliveries);
        agentEventActorDeliveries.set({ state: 'dead' }, snapshot.deadDeliveries);
      })
      .then(() => registry.metrics())
      .then((metrics) => {
        res.set('Content-Type', registry.contentType);
        res.end(metrics);
      })
      .catch((err) => {
        logger.error('[metrics] Failed to collect metrics:', err);
        res.status(500).end();
      });
  };

  metricsRouter.get('/', metricsHandler);

  return { metricsMiddleware, metricsRouter };
}
