import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  context,
  trace,
  createContextKey,
} from '@opentelemetry/api';
import type {
  MediaApi,
  MediaJobPhase,
  MediaOperation,
  MediaErrorCode,
  MediaWorkerHealth,
} from 'librechat-data-provider';
import type { MediaStoredJob } from '@librechat/data-schemas';
import type { Tracer } from '@opentelemetry/api';

export type MediaLifecycleEvent = {
  kind: 'attempt' | 'transition' | 'settlement' | 'cleanup' | 'cancellation' | 'worker';
  worker?: MediaWorkerHealth;
  result: 'started' | 'completed' | 'failed' | 'interrupted';
  durationMs?: number;
  queueWaitMs?: number;
  failureCode?: MediaErrorCode;
  task?:
    | 'account_deletion'
    | 'asset_write'
    | 'retiring_asset'
    | 'retirement'
    | 'native'
    | 'consumers'
    | 'permits'
    | 'accounting'
    | 'staging';
  /** Correlation belongs in traces, never metric labels. */
  jobId?: string;
  tenantId?: string | null;
  api?: MediaApi;
  operation?: MediaOperation;
  executionOwner?: 'media' | 'chat';
  phase?: MediaJobPhase;
  previousPhase?: MediaJobPhase;
  version?: number;
};
export type MediaLifecycleObserver = ((event: MediaLifecycleEvent) => void) & {
  run?<T>(event: MediaLifecycleEvent, work: () => Promise<T>): Promise<T>;
};
export type MediaMetricEvent = Pick<
  MediaLifecycleEvent,
  | 'kind'
  | 'result'
  | 'api'
  | 'operation'
  | 'executionOwner'
  | 'phase'
  | 'previousPhase'
  | 'durationMs'
  | 'queueWaitMs'
  | 'failureCode'
  | 'task'
  | 'worker'
>;

const attemptContext = createContextKey('librechat.media.attempt');

/** Run the work once even if an injected observer fails before or after calling it. */
export async function withMediaAttempt<T>(
  observer: MediaLifecycleObserver | undefined,
  event: MediaLifecycleEvent,
  work: () => Promise<T>,
): Promise<T> {
  if (!observer?.run) return work();
  let invoked = false;
  let completed = false;
  let result: T;
  try {
    return await observer.run(event, async () => {
      invoked = true;
      result = await work();
      completed = true;
      return result;
    });
  } catch (error) {
    if (completed) return result!;
    if (!invoked) return work();
    throw error;
  }
}

/** A broken telemetry exporter must never change a paid request's outcome. */
export function observeMedia(
  observer: MediaLifecycleObserver | undefined,
  event: MediaLifecycleEvent,
): void {
  try {
    observer?.(event);
  } catch {
    /* Telemetry is best effort; no provider data in diagnostic logs. */
  }
}

export function mediaJobEvent(
  job: MediaStoredJob,
): Pick<
  MediaLifecycleEvent,
  'jobId' | 'tenantId' | 'api' | 'operation' | 'executionOwner' | 'phase' | 'version'
> {
  return {
    jobId: job.jobId,
    tenantId: job.tenantId,
    api: job.execution.api,
    operation: job.operation,
    executionOwner: job.executionOwner,
    phase: job.phase,
    version: job.version,
  };
}

/** Uses the host's existing tracer and registry, with no separate exporter or global recorder. */
export function createMediaLifecycleObserver({
  tracer,
  metrics,
  now = Date.now,
}: {
  tracer: Tracer;
  metrics?: (event: MediaMetricEvent) => void;
  now?: () => number;
}): MediaLifecycleObserver {
  const observer: MediaLifecycleObserver = (event) => {
    const {
      kind,
      result,
      api,
      operation,
      executionOwner,
      phase,
      previousPhase,
      durationMs,
      queueWaitMs,
      failureCode,
      task,
    } = event;
    try {
      metrics?.({
        kind,
        result,
        worker: event.worker,
        api,
        operation,
        executionOwner,
        phase,
        previousPhase,
        durationMs,
        queueWaitMs,
        failureCode,
        task,
      });
    } catch {
      /* Preserve tracing when metrics fails. */
    }
    if (kind === 'worker') return;
    const endedAt = now();
    const duration = Number.isFinite(durationMs) ? Math.max(0, durationMs ?? 0) : 0;
    const attributes = {
      'librechat.media.event': kind,
      'librechat.media.result': result,
      ...(phase ? { 'librechat.media.phase': phase } : {}),
      ...(event.previousPhase ? { 'librechat.media.previous_phase': event.previousPhase } : {}),
      ...(event.version !== undefined ? { 'librechat.media.version': event.version } : {}),
      ...(failureCode ? { 'librechat.media.failure_code': failureCode } : {}),
      ...(failureCode ? { 'error.type': failureCode } : {}),
      ...(task ? { 'librechat.media.task': task } : {}),
    };
    const active = context.active();
    const activeSpan = trace.getSpan(active);
    if (
      event.jobId &&
      activeSpan &&
      active.getValue(attemptContext) === JSON.stringify([event.tenantId, event.jobId])
    ) {
      activeSpan.addEvent(`media.${kind}`, attributes, new Date(endedAt));
      if (failureCode) activeSpan.setAttribute('error.type', failureCode);
      if (result === 'failed' || phase === 'requires_attention' || phase === 'failed') {
        activeSpan.setStatus({ code: SpanStatusCode.ERROR });
      }
      return;
    }
    const span = tracer.startSpan(
      `librechat.media.${kind}`,
      {
        kind: SpanKind.INTERNAL,
        startTime: new Date(endedAt - duration),
        attributes: {
          ...attributes,
          'librechat.media.event': kind,
          'librechat.media.result': result,
          ...(api ? { 'librechat.media.api': api } : {}),
          ...(operation ? { 'librechat.media.operation': operation } : {}),
          ...(executionOwner ? { 'librechat.media.execution_owner': executionOwner } : {}),
          ...(phase ? { 'librechat.media.phase': phase } : {}),
          ...(event.previousPhase ? { 'librechat.media.previous_phase': event.previousPhase } : {}),
          ...(event.jobId ? { 'librechat.media.job.id': event.jobId } : {}),
          ...(event.tenantId ? { 'librechat.tenant.id': event.tenantId } : {}),
          ...(event.version !== undefined ? { 'librechat.media.version': event.version } : {}),
          ...(queueWaitMs !== undefined ? { 'librechat.media.queue_wait_ms': queueWaitMs } : {}),
        },
      },
      ROOT_CONTEXT,
    );
    if (result === 'failed' || phase === 'requires_attention' || phase === 'failed') {
      span.setStatus({ code: SpanStatusCode.ERROR });
    }
    span.end(new Date(endedAt));
  };
  observer.run = async (event, work) => {
    const span = tracer.startSpan(
      'librechat.media.attempt',
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          'librechat.media.job.id': event.jobId ?? '',
          'librechat.tenant.id': event.tenantId ?? '',
          'librechat.media.api': event.api ?? '',
          'librechat.media.operation': event.operation ?? '',
        },
      },
      ROOT_CONTEXT,
    );
    const scope = trace
      .setSpan(ROOT_CONTEXT, span)
      .setValue(attemptContext, JSON.stringify([event.tenantId, event.jobId]));
    try {
      return await context.with(scope, work);
    } catch (error) {
      try {
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.recordException({
          name: 'MediaAttemptError',
          message: 'Media execution attempt failed.',
        });
      } catch {
        /* Preserve the provider/storage failure if an exporter throws. */
      }
      throw error;
    } finally {
      try {
        span.end();
      } catch {
        /* Telemetry cannot change inference. */
      }
    }
  };
  return observer;
}
