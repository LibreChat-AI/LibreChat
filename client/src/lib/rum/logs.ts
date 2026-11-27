import { RUM_COLLECTOR_ACK_HEADER } from 'librechat-data-provider';
import type { TraceContext } from './trace';
import {
  truncate,
  scrubField,
  isErrorLike,
  summarizeError,
  MAX_NAME_LENGTH,
  getClientPlatform,
  MAX_MESSAGE_LENGTH,
} from './redact';
import { setRemoteLogSink } from '~/utils/logger';
import { getActiveTraceContext } from './trace';
import { normalizeRumPath } from './routes';

export type ClientLogLevel = 'info' | 'warn' | 'error';
type AttributeValue = string | number | boolean;
type DeliveryCallback = (delivered: boolean) => void;

/** The only attribute keys a client log record may carry; anything else is dropped. */
const ATTRIBUTE_KEYS = [
  'log.source',
  'logger.name',
  'event.name',
  'exception.type',
  'exception.message',
  'exception.stacktrace',
  'http.response.status_code',
  'error.boundary',
  'error.chunk_load',
  'asset.path',
  'asset.tag',
  'asset.optional',
  'event.build_id',
  'url.template',
  'session.id',
  'log.repeat_count',
  'log.deduplicated',
] as const;
type AttributeKey = (typeof ATTRIBUTE_KEYS)[number];
type LogAttributes = Partial<Record<AttributeKey, AttributeValue>>;

export const CLIENT_LOG_LIMITS = {
  flushIntervalMs: 5_000,
  maxBatchRecords: 20,
  maxQueuedRecords: 100,
  /** Below the 64 KiB in-flight cap browsers enforce on `keepalive` requests. */
  maxPayloadBytes: 60_000,
  maxStringLength: 2_048,
  recordsPerMinute: 30,
  recordsPerPage: 300,
  dedupeWindowMs: 60_000,
  maxDedupeKeys: 200,
  maxAttempts: 3,
  baseBackoffMs: 5_000,
  maxBackoffMs: 60_000,
  maxConsecutiveFailures: 5,
} as const;

function createPageState() {
  return {
    windowStart: 0,
    windowCount: 0,
    pageCount: 0,
    shutdown: false,
    backoffUntil: 0,
    consecutiveFailures: 0,
    keepaliveBytes: 0,
  };
}

/** Document budgets and fatal shutdown outlive authenticated-layout mounts and exporters. */
const pageState = createPageState();

export const testExports = {
  resetPageState: () => Object.assign(pageState, createPageState()),
};

const SEVERITY: Record<ClientLogLevel, { number: number; text: string }> = {
  info: { number: 9, text: 'INFO' },
  warn: { number: 13, text: 'WARN' },
  error: { number: 17, text: 'ERROR' },
};

const ASSET_EVENTS = new Map<string, { name: string; level: ClientLogLevel }>([
  ['stale-asset-recovery-start', { name: 'stale_asset.recovery_start', level: 'info' }],
  ['stale-asset-recovery-reload', { name: 'stale_asset.recovery_reload', level: 'info' }],
  ['stale-asset-recovery-declined', { name: 'stale_asset.recovery_declined', level: 'warn' }],
  ['asset-load-error', { name: 'asset.load_error', level: 'warn' }],
  ['dynamic-import-error', { name: 'asset.dynamic_import_error', level: 'warn' }],
]);

const RECORDS_PLACEHOLDER = '__librechat_log_records__';
const encoder = new TextEncoder();

function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/** Statuses that drop the batch and stop exporting for this page (proxy off or not allowed). */
const FATAL_STATUSES = new Set([401, 403, 404, 405]);

type LogEntry = {
  key: string;
  level: ClientLogLevel;
  body: string;
  attributes: LogAttributes;
  timeMs: number;
  count: number;
  attempts: number;
  state: 'queued' | 'sending' | 'done';
  /** The request currently carrying this record; responses to older requests ignore it. */
  sendId: number;
  trace?: TraceContext;
  onSettled: DeliveryCallback[];
};

type Batch = { entries: LogEntry[]; body: string };

type DedupeEntry = {
  expiresAt: number;
  entry: LogEntry;
  suppressed: number;
  suppressedCallbacks: DeliveryCallback[];
};

type OtlpAnyValue = { stringValue: string } | { boolValue: boolean } | { intValue: string };
type OtlpKeyValue = { key: string; value: OtlpAnyValue };
type LogTransport = (
  url: string,
  init: RequestInit,
) => Promise<Pick<Response, 'status'> & { headers?: Pick<Headers, 'get'> }>;
type OtlpLogRecord = {
  timeUnixNano: string;
  observedTimeUnixNano: string;
  severityNumber: number;
  severityText: string;
  body: { stringValue: string };
  attributes: OtlpKeyValue[];
  traceId?: string;
  spanId?: string;
};

/** Fields read from a queued diagnostic event; everything else on it is ignored. */
type ClientEventAttributes = {
  assetPath?: unknown;
  tagName?: unknown;
  optional?: unknown;
  clientBuildId?: unknown;
};

export type ClientLogsOptions = {
  /** Same-origin authenticated proxy path, e.g. `/api/rum/v1/logs`. */
  endpoint: string;
  serviceName: string;
  environment?: string;
  buildId: string;
  getToken: () => string | undefined;
  getSessionId?: () => string | undefined;
  /** Defaults to `window.fetch`; only the response status is read. */
  fetch?: LogTransport;
};

export type ClientLogExporter = {
  log: (level: 'warn' | 'error', args: unknown[]) => void;
  event: (
    type: string,
    attributes?: ClientEventAttributes,
    onDelivered?: () => void,
    onDropped?: () => void,
  ) => boolean;
  boundary: (boundary: string, error: unknown, chunkLoad: boolean) => void;
  flush: (keepalive: boolean) => void;
  dispose: () => void;
};

function randomSessionId(): string {
  try {
    return crypto.randomUUID().replace(/-/g, '');
  } catch {
    return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  }
}

function toAnyValue(value: AttributeValue): OtlpAnyValue {
  if (typeof value === 'boolean') {
    return { boolValue: value };
  }
  if (typeof value === 'number' && Number.isInteger(value)) {
    return { intValue: String(value) };
  }
  return { stringValue: truncate(String(value), CLIENT_LOG_LIMITS.maxStringLength) };
}

function toKeyValues(attributes: Record<string, AttributeValue | undefined>): OtlpKeyValue[] {
  return Object.entries(attributes).flatMap(([key, value]) =>
    value === undefined || value === '' ? [] : [{ key, value: toAnyValue(value) }],
  );
}

function pickAttributes(attributes: LogAttributes): LogAttributes {
  return ATTRIBUTE_KEYS.reduce<LogAttributes>((picked, key) => {
    const value = attributes[key];
    if (value !== undefined && value !== '') {
      picked[key] = value;
    }
    return picked;
  }, {});
}

function toOtlpRecord(entry: LogEntry): OtlpLogRecord {
  const attributes = pickAttributes({
    ...entry.attributes,
    ...(entry.count > 1 ? { 'log.repeat_count': entry.count } : {}),
  });
  return {
    timeUnixNano: `${entry.timeMs}000000`,
    observedTimeUnixNano: `${entry.timeMs}000000`,
    severityNumber: SEVERITY[entry.level].number,
    severityText: SEVERITY[entry.level].text,
    body: { stringValue: entry.body },
    attributes: toKeyValues(attributes),
    ...(entry.trace ? { traceId: entry.trace.traceId, spanId: entry.trace.spanId } : {}),
  };
}

function isSameOriginPath(endpoint: string): boolean {
  try {
    return new URL(endpoint, window.location.origin).origin === window.location.origin;
  } catch {
    return false;
  }
}

function currentRouteTemplate(): string {
  try {
    return normalizeRumPath(window.location.pathname);
  } catch {
    return '/';
  }
}

function stringAttribute(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value !== '' ? scrubField(value, maxLength) : undefined;
}

function errorAttributes(error: unknown): LogAttributes {
  const summary = summarizeError(error);
  if (!summary) {
    return {};
  }
  return {
    'exception.type': summary.type,
    'exception.message': summary.message,
    'exception.stacktrace': summary.stacktrace,
    'http.response.status_code': summary.statusCode,
  };
}

/**
 * Batches client log records and ships them as OTLP/JSON to the authenticated RUM proxy.
 * Records are allowlisted and scrubbed at creation, duplicates within a window collapse into a
 * count, a per-minute and per-page budget caps volume, failed sends back off and are dropped
 * after a few attempts, and repeated failures turn the exporter off for the rest of the page.
 */
export function createClientLogExporter(options: ClientLogsOptions): ClientLogExporter {
  const limits = CLIENT_LOG_LIMITS;
  const send = options.fetch ?? window.fetch.bind(window);
  const fallbackSessionId = randomSessionId();
  const platform = getClientPlatform(navigator.userAgent);
  const resource = {
    resource: {
      attributes: toKeyValues({
        'service.name': options.serviceName,
        'service.version': options.buildId,
        'deployment.environment': options.environment,
        'browser.name': platform.browser,
        'os.type': platform.os,
        'telemetry.sdk.name': 'librechat-client-logs',
        'telemetry.sdk.language': 'webjs',
      }),
    },
  };

  const [envelopeHead, envelopeTail] = JSON.stringify({
    resourceLogs: [
      {
        ...resource,
        scopeLogs: [
          {
            scope: { name: 'librechat.client', version: '1' },
            logRecords: [RECORDS_PLACEHOLDER],
          },
        ],
      },
    ],
  }).split(JSON.stringify(RECORDS_PLACEHOLDER));
  const envelopeBytes = byteLength(envelopeHead) + byteLength(envelopeTail);

  let queue: LogEntry[] = [];
  const pendingDeliveries = new Set<DeliveryCallback>();
  const dedupe = new Map<string, DedupeEntry>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timerAt = Number.POSITIVE_INFINITY;
  let inFlight = false;
  /** Records of the regular request in flight, re-sent by the page-hide flush if unanswered. */
  let activeBatch: LogEntry[] = [];
  let sendSeq = 0;
  let disabled = pageState.shutdown;

  const sessionId = (): string => {
    try {
      return options.getSessionId?.() || fallbackSessionId;
    } catch {
      return fallbackSessionId;
    }
  };

  const consumeBudget = (now: number): boolean => {
    if (pageState.pageCount >= limits.recordsPerPage) {
      return false;
    }
    if (now - pageState.windowStart >= 60_000) {
      pageState.windowStart = now;
      pageState.windowCount = 0;
    }
    if (pageState.windowCount >= limits.recordsPerMinute) {
      return false;
    }
    pageState.windowCount += 1;
    pageState.pageCount += 1;
    return true;
  };

  const clearTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = undefined;
    timerAt = Number.POSITIVE_INFINITY;
  };

  const schedule = (at: number) => {
    if (disabled || pageState.shutdown || (timer !== undefined && timerAt <= at)) {
      return;
    }
    clearTimer();
    timerAt = at;
    timer = setTimeout(tick, Math.max(0, at - Date.now()));
  };

  const settle = (entry: LogEntry, delivered: boolean) => {
    entry.state = 'done';
    entry.sendId = 0;
    entry.onSettled.splice(0).forEach((callback) => callback(delivered));
  };

  const enqueue = (entry: LogEntry, now: number) => {
    queue.push(entry);
    while (queue.length > limits.maxQueuedRecords) {
      const dropped = queue.shift();
      if (dropped) {
        settle(dropped, false);
      }
    }
    schedule(queue.length >= limits.maxBatchRecords ? now : now + limits.flushIntervalMs);
  };

  const collectExpiredDuplicates = (now: number) => {
    for (const [key, item] of dedupe) {
      if (item.expiresAt > now) {
        continue;
      }
      dedupe.delete(key);
      if (item.suppressed > 0 && consumeBudget(now)) {
        enqueue(
          {
            ...item.entry,
            attributes: { ...item.entry.attributes, 'log.deduplicated': true },
            timeMs: now,
            count: item.suppressed,
            attempts: 0,
            state: 'queued',
            sendId: 0,
            onSettled: item.suppressedCallbacks,
          },
          now,
        );
      } else {
        item.suppressedCallbacks.forEach((callback) => callback(false));
      }
    }
  };

  const nextDedupeExpiry = (): number => {
    let next = Number.POSITIVE_INFINITY;
    for (const item of dedupe.values()) {
      if (item.suppressed > 0 && item.expiresAt < next) {
        next = item.expiresAt;
      }
    }
    return next;
  };

  const add = (entry: LogEntry): boolean => {
    if (disabled || pageState.shutdown) {
      settle(entry, false);
      return false;
    }
    const now = entry.timeMs;
    collectExpiredDuplicates(now);
    const existing = dedupe.get(entry.key);
    if (existing) {
      if (existing.entry.state === 'queued') {
        existing.entry.count += 1;
        existing.entry.onSettled.push(...entry.onSettled);
      } else {
        existing.suppressed += 1;
        existing.suppressedCallbacks.push(...entry.onSettled);
        schedule(existing.expiresAt);
      }
      return true;
    }
    if (!consumeBudget(now)) {
      settle(entry, false);
      return false;
    }
    if (dedupe.size >= limits.maxDedupeKeys) {
      const oldest = dedupe.keys().next().value;
      if (oldest !== undefined) {
        dedupe.get(oldest)?.suppressedCallbacks.forEach((callback) => callback(false));
        dedupe.delete(oldest);
      }
    }
    dedupe.set(entry.key, {
      expiresAt: now + limits.dedupeWindowMs,
      entry,
      suppressed: 0,
      suppressedCallbacks: [],
    });
    enqueue(entry, now);
    return true;
  };

  /**
   * Takes the queued records that fit one request, measured in encoded UTF-8 bytes of the exact
   * body that will be sent, so a `keepalive` request never exceeds the browser's quota.
   */
  const takeBatch = (maxRecords: number, maxBytes: number = limits.maxPayloadBytes): Batch => {
    const entries: LogEntry[] = [];
    const records: string[] = [];
    let bytes = envelopeBytes;
    let taken = 0;
    for (const entry of queue) {
      if (entries.length >= maxRecords) {
        break;
      }
      const record = JSON.stringify(toOtlpRecord(entry));
      const size = byteLength(record) + (records.length > 0 ? 1 : 0);
      if (bytes + size > maxBytes) {
        if (entries.length > 0 || envelopeBytes + size <= limits.maxPayloadBytes) {
          break;
        }
        settle(entry, false);
        taken += 1;
        continue;
      }
      bytes += size;
      taken += 1;
      entry.state = 'sending';
      entries.push(entry);
      records.push(record);
    }
    queue = queue.slice(taken);
    return { entries, body: `${envelopeHead}${records.join(',')}${envelopeTail}` };
  };

  const discard = () => {
    disabled = true;
    pendingDeliveries.forEach((callback) => callback(false));
    activeBatch.forEach((entry) => settle(entry, false));
    activeBatch = [];
    queue = [];
    dedupe.clear();
    clearTimer();
  };

  const onFailure = (batch: LogEntry[], retryable: boolean) => {
    pageState.consecutiveFailures += 1;
    if (pageState.consecutiveFailures >= limits.maxConsecutiveFailures) {
      pageState.shutdown = true;
      discard();
      return;
    }
    const retry = batch.filter((entry) => {
      entry.attempts += 1;
      if (!retryable || entry.attempts >= limits.maxAttempts) {
        settle(entry, false);
        return false;
      }
      entry.state = 'queued';
      return true;
    });
    queue = [...retry, ...queue];
    queue.splice(limits.maxQueuedRecords).forEach((entry) => settle(entry, false));
    const delay = Math.min(
      limits.baseBackoffMs * 2 ** (pageState.consecutiveFailures - 1),
      limits.maxBackoffMs,
    );
    pageState.backoffUntil = Date.now() + delay;
  };

  const handleStatus = (batch: LogEntry[], status: number) => {
    if (status >= 200 && status < 300) {
      pageState.consecutiveFailures = 0;
      batch.forEach((entry) => settle(entry, true));
      return;
    }
    if (FATAL_STATUSES.has(status)) {
      pageState.shutdown = true;
      discard();
      return;
    }
    onFailure(batch, status === 408 || status === 429 || status >= 500);
  };

  const transmit = async ({ entries, body }: Batch, keepalive: boolean): Promise<void> => {
    const token = options.getToken();
    if (!token || entries.length === 0) {
      entries.forEach((entry) => {
        settle(entry, false);
      });
      return Promise.resolve();
    }
    sendSeq += 1;
    const sendId = sendSeq;
    entries.forEach((entry) => {
      entry.sendId = sendId;
    });
    /** A record re-sent by a later request (the page-hide flush) belongs to that request. */
    const owned = () =>
      entries.filter((entry) => !disabled && !pageState.shutdown && entry.sendId === sendId);
    const handleResponse = (status?: number) => {
      const batch = owned();
      if (batch.length === 0) {
        return;
      }
      if (status === undefined) {
        onFailure(batch, true);
      } else {
        handleStatus(batch, status);
      }
    };
    const requestBytes = keepalive ? byteLength(body) : 0;
    pageState.keepaliveBytes += requestBytes;
    try {
      const response = await send(options.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body,
        keepalive,
        credentials: 'same-origin',
      });
      if (response.status === 204 && response.headers?.get(RUM_COLLECTOR_ACK_HEADER) !== 'true') {
        owned().forEach((entry) => settle(entry, false));
      } else {
        handleResponse(response.status);
      }
    } catch {
      handleResponse();
    } finally {
      pageState.keepaliveBytes -= requestBytes;
      if (keepalive && queue.length > 0) {
        schedule(Math.max(Date.now() + limits.flushIntervalMs, pageState.backoffUntil));
      }
    }
  };

  const flush = (keepalive: boolean) => {
    if (disabled || pageState.shutdown) {
      return;
    }
    const now = Date.now();
    collectExpiredDuplicates(now);
    if (keepalive) {
      const unacknowledged = activeBatch.filter((entry) => entry.state === 'sending');
      activeBatch = [];
      inFlight = false;
      unacknowledged.forEach((entry) => {
        entry.state = 'queued';
        entry.sendId = 0;
      });
      queue = [...unacknowledged, ...queue];
      void transmit(
        takeBatch(Number.POSITIVE_INFINITY, limits.maxPayloadBytes - pageState.keepaliveBytes),
        true,
      ).catch(() => undefined);
      return;
    }
    if (inFlight || queue.length === 0) {
      return;
    }
    if (pageState.backoffUntil > now) {
      schedule(pageState.backoffUntil);
      return;
    }
    inFlight = true;
    const batch = takeBatch(limits.maxBatchRecords);
    activeBatch = batch.entries;
    transmit(batch, false)
      .catch(() => undefined)
      .finally(() => {
        if (activeBatch !== batch.entries) {
          return;
        }
        inFlight = false;
        activeBatch = [];
        if (queue.length > 0) {
          schedule(Math.max(Date.now() + limits.flushIntervalMs, pageState.backoffUntil));
        }
      });
  };

  function tick() {
    timer = undefined;
    timerAt = Number.POSITIVE_INFINITY;
    flush(false);
    const next = nextDedupeExpiry();
    if (next !== Number.POSITIVE_INFINITY) {
      schedule(next);
    }
  }

  const baseAttributes = (source: string): LogAttributes => ({
    'log.source': source,
    'url.template': currentRouteTemplate(),
    'session.id': sessionId(),
  });

  const createEntry = (
    level: ClientLogLevel,
    body: string,
    attributes: LogAttributes,
  ): LogEntry => {
    const firstFrame = String(attributes['exception.stacktrace'] ?? '').split('\n', 1)[0];
    return {
      key: [
        level,
        attributes['log.source'],
        attributes['logger.name'],
        attributes['event.name'],
        attributes['error.boundary'],
        body,
        attributes['exception.type'],
        attributes['exception.message'],
        firstFrame,
      ].join('|'),
      level,
      body,
      attributes: pickAttributes(attributes),
      timeMs: Date.now(),
      count: 1,
      attempts: 0,
      state: 'queued',
      sendId: 0,
      trace: getActiveTraceContext(),
      onSettled: [],
    };
  };

  const log = (level: 'warn' | 'error', args: unknown[]) => {
    const [first, second] = args;
    const name = typeof first === 'string' && typeof second === 'string' ? first : undefined;
    const message = name != null ? second : first;
    const error = args.find(isErrorLike);
    const attributes: LogAttributes = {
      ...baseAttributes('logger'),
      'logger.name': stringAttribute(name, MAX_NAME_LENGTH),
      ...errorAttributes(error),
    };
    const body =
      stringAttribute(message, MAX_MESSAGE_LENGTH) ??
      attributes['exception.message'] ??
      attributes['exception.type'] ??
      'Client log';
    add(createEntry(level, String(body), attributes));
  };

  const event = (
    type: string,
    attributes: ClientEventAttributes = {},
    onDelivered?: () => void,
    onDropped?: () => void,
  ): boolean => {
    const definition = ASSET_EVENTS.get(type);
    if (!definition) {
      return false;
    }
    const entry = createEntry(definition.level, definition.name, {
      ...baseAttributes('asset'),
      'event.name': definition.name,
      'asset.path': stringAttribute(attributes.assetPath, MAX_MESSAGE_LENGTH),
      'asset.tag': stringAttribute(attributes.tagName, MAX_NAME_LENGTH),
      'asset.optional': typeof attributes.optional === 'boolean' ? attributes.optional : undefined,
      'event.build_id': stringAttribute(attributes.clientBuildId, MAX_NAME_LENGTH),
    });
    if (onDelivered || onDropped) {
      const callback: DeliveryCallback = (delivered) => {
        if (!pendingDeliveries.delete(callback)) {
          return;
        }
        try {
          (delivered ? onDelivered : onDropped)?.();
        } catch {
          /* Telemetry must never affect the caller. */
        }
      };
      pendingDeliveries.add(callback);
      entry.onSettled.push(callback);
    }
    return add(entry);
  };

  const boundary = (name: string, error: unknown, chunkLoad: boolean) => {
    const attributes: LogAttributes = {
      ...baseAttributes('boundary'),
      'error.boundary': scrubField(name, MAX_NAME_LENGTH),
      'error.chunk_load': chunkLoad,
      ...errorAttributes(error),
    };
    const body = attributes['exception.message'] ?? attributes['exception.type'] ?? 'Unknown error';
    add(createEntry(chunkLoad ? 'warn' : 'error', String(body), attributes));
  };

  const dispose = () => {
    discard();
  };

  return { log, event, boundary, flush, dispose };
}

let exporter: ClientLogExporter | undefined;
let exporterKey: string | undefined;
const startedListeners = new Set<() => void>();
const reportedErrors = new WeakSet<object>();

function onVisibilityChange() {
  if (document.visibilityState === 'hidden') {
    exporter?.flush(true);
  }
}

function onPageHide() {
  exporter?.flush(true);
}

function forwardLog(level: 'warn' | 'error', args: unknown[]) {
  try {
    exporter?.log(level, args);
  } catch {
    /* Telemetry must never affect the caller. */
  }
}

/** Starts exporting client logs for this page; a repeat call with the same settings is a no-op. */
export function startClientLogs(options: ClientLogsOptions): void {
  const key = [options.endpoint, options.serviceName, options.environment, options.buildId].join(
    '|',
  );
  if (exporter && exporterKey === key) {
    return;
  }
  stopClientLogs();
  if (!isSameOriginPath(options.endpoint)) {
    return;
  }
  try {
    exporter = createClientLogExporter(options);
  } catch {
    return;
  }
  exporterKey = key;
  setRemoteLogSink(forwardLog);
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pagehide', onPageHide);
  startedListeners.forEach((callback) => {
    try {
      callback();
    } catch {
      /* Reporting must never affect startup. */
    }
  });
}

/** Stops exporting and drops anything still queued (e.g. on sign-out or when RUM is disabled). */
export function stopClientLogs(): void {
  if (!exporter) {
    return;
  }
  exporter.dispose();
  exporter = undefined;
  exporterKey = undefined;
  setRemoteLogSink(undefined);
  document.removeEventListener('visibilitychange', onVisibilityChange);
  window.removeEventListener('pagehide', onPageHide);
}

/** Mounted boundaries can report after startup config and authentication enable the sink. */
export function onClientLogsStarted(callback: () => void): () => void {
  startedListeners.add(callback);
  return () => {
    startedListeners.delete(callback);
  };
}

export function isClientLogsActive(): boolean {
  return exporter !== undefined;
}

export function isClientEventType(type: unknown): boolean {
  return typeof type === 'string' && ASSET_EVENTS.has(type);
}

/**
 * Forwards an allowlisted stale-asset diagnostic event. Returns `true` when an active exporter
 * took it; `onDelivered` runs only after the collector accepted the record that carries it.
 */
export function recordClientEvent(
  type: string,
  attributes?: ClientEventAttributes,
  onDelivered?: () => void,
  onDropped?: () => void,
): boolean {
  if (!exporter || !isClientEventType(type)) {
    return false;
  }
  try {
    return exporter.event(type, attributes, onDelivered, onDropped);
  } catch {
    return false;
  }
}

/** Reports an error caught by an error boundary, once per error object. */
export function reportBoundaryError(boundary: string, error: unknown, chunkLoad = false): void {
  if (!exporter) {
    return;
  }
  if (typeof error === 'object' && error !== null) {
    if (reportedErrors.has(error)) {
      return;
    }
    reportedErrors.add(error);
  }
  try {
    exporter.boundary(boundary, error, chunkLoad);
  } catch {
    /* Telemetry must never affect the caller. */
  }
}
