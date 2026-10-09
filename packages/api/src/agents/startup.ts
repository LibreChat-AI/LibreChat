import { performance } from 'node:perf_hooks';
import { ApprovalEvents, StepEvents } from 'librechat-data-provider';
import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { NextFunction, Response } from 'express';
import type { AgentStartupMilestone, AgentStartupResult } from './phases';
import type { ServerRequest, ServerSentEvent } from '~/types';
import {
  isMetricsConfigured,
  recordAgentStartupMilestone,
  recordAgentStartupResult,
} from '~/app/metrics';
import { agentStartupMilestones, agentStartupResults } from './phases';
import { getSafeSpanException } from '~/telemetry/safeException';

const SPAN_NAME = 'librechat.agent.startup';
const MILESTONES = new Set<string>(agentStartupMilestones);
const RESULTS = new Set<string>(agentStartupResults);
const RESPONSE_EVENTS = new Set<string>([
  ...Object.values(StepEvents),
  ApprovalEvents.ON_PENDING_ACTION,
  'attachment',
]);

interface AgentGenerationEventData {
  delta?: {
    content?:
      | {
          text?: string;
          think?: string;
        }
      | Array<{
          text?: string;
          think?: string;
        }>;
  };
}

export interface AgentStartupTelemetry {
  mark: (milestone: AgentStartupMilestone) => void;
  setStreamId: (streamId: string) => void;
  recordGenerationEvent: (event: ServerSentEvent) => boolean;
  end: (result: AgentStartupResult, error?: Error) => void;
}

interface AgentStartupTelemetryOptions {
  now?: () => number;
  startedAt?: number;
  spanStartedAt?: number;
}

interface AgentStartupState {
  accepted: boolean;
  telemetry: AgentStartupTelemetry;
}

const requestTelemetry = new WeakMap<ServerRequest, AgentStartupState>();
const AGENT_STARTUP_STARTED_AT = Symbol('agentStartupStartedAt');
const EXCLUDED_AGENT_CHAT_PATHS = new Set(['/abort', '/resume', '/steer', '/steer/cancel']);

interface AgentStartupIngressTime {
  monotonic: number;
  epoch: number;
}

function isInitialAgentChatRequest(req: ServerRequest): boolean {
  return req.method === 'POST' && !EXCLUDED_AGENT_CHAT_PATHS.has(req.path);
}

function isRenderableDelta(event: ServerSentEvent): boolean {
  if (
    !('event' in event) ||
    (event.event !== StepEvents.ON_MESSAGE_DELTA &&
      event.event !== StepEvents.ON_REASONING_DELTA) ||
    typeof event.data === 'string'
  ) {
    return false;
  }

  const content = (event.data as AgentGenerationEventData).delta?.content;
  const parts = Array.isArray(content) ? content : [content];
  return parts.some(
    (part) =>
      (typeof part?.text === 'string' && part.text.length > 0) ||
      (typeof part?.think === 'string' && part.think.length > 0),
  );
}

function isResponseEvent(event: ServerSentEvent, renderableDelta: boolean): boolean {
  if ('final' in event) {
    return true;
  }
  if (!('event' in event)) {
    return false;
  }
  if (
    event.event === StepEvents.ON_MESSAGE_DELTA ||
    event.event === StepEvents.ON_REASONING_DELTA
  ) {
    return renderableDelta;
  }
  return RESPONSE_EVENTS.has(event.event);
}

export function createAgentStartupTelemetry(
  options: AgentStartupTelemetryOptions = {},
): AgentStartupTelemetry | undefined {
  const now = options.now ?? (() => performance.now());
  const startedAt = options.startedAt ?? now();
  const spanOptions = {
    kind: SpanKind.INTERNAL,
    ...(options.spanStartedAt != null && { startTime: options.spanStartedAt }),
  };
  const span = trace
    .getTracer('librechat.telemetry')
    .startSpan(SPAN_NAME, spanOptions, context.active());
  const tracingEnabled = span.isRecording();
  const metricsEnabled = isMetricsConfigured();
  if (!tracingEnabled) {
    span.end();
  }
  if (!tracingEnabled && !metricsEnabled) {
    return undefined;
  }
  const milestones = new Set<AgentStartupMilestone>();
  let ended = false;

  const elapsedMilliseconds = (): number => Math.max(0, now() - startedAt);

  const mark = (milestone: AgentStartupMilestone): void => {
    if (ended || !MILESTONES.has(milestone) || milestones.has(milestone)) {
      return;
    }

    milestones.add(milestone);
    const elapsedMs = elapsedMilliseconds();
    if (tracingEnabled) {
      span.addEvent(milestone, {
        'librechat.agent.startup.elapsed_ms': elapsedMs,
      });
    }
    if (metricsEnabled) {
      recordAgentStartupMilestone(milestone, elapsedMs / 1_000);
    }
  };

  const setStreamId = (streamId: string): void => {
    if (ended || !streamId) {
      return;
    }
    if (tracingEnabled) {
      span.setAttribute('librechat.stream.id', streamId);
    }
  };

  const end = (result: AgentStartupResult, error?: Error): void => {
    if (ended) {
      return;
    }

    ended = true;
    const normalizedResult: AgentStartupResult = RESULTS.has(result) ? result : 'error';
    if (tracingEnabled) {
      span.setAttributes({
        'librechat.agent.startup.duration_ms': elapsedMilliseconds(),
        'librechat.agent.startup.milestones.count': milestones.size,
        'librechat.agent.startup.result': normalizedResult,
      });
    }
    if (metricsEnabled) {
      recordAgentStartupResult(normalizedResult);
    }

    if (tracingEnabled && error) {
      span.recordException(getSafeSpanException(error));
    }
    if (tracingEnabled && (normalizedResult === 'aborted' || normalizedResult === 'error')) {
      span.setStatus({ code: SpanStatusCode.ERROR });
    }

    if (tracingEnabled) {
      span.end();
    }
  };

  const recordGenerationEvent = (event: ServerSentEvent): boolean => {
    if (ended) {
      return true;
    }

    const renderableDelta = isRenderableDelta(event);
    if (!isResponseEvent(event, renderableDelta)) {
      return false;
    }

    mark('first_response_event_queued');
    if (!renderableDelta) {
      return false;
    }

    mark('first_content_delta_queued');
    end('content_queued');
    return true;
  };

  return { mark, setStreamId, recordGenerationEvent, end };
}

export function getAgentStartupTelemetry(req: ServerRequest): AgentStartupTelemetry | undefined {
  return requestTelemetry.get(req)?.telemetry;
}

export function acceptAgentStartupTelemetry(req: ServerRequest, streamId: string): void {
  const state = requestTelemetry.get(req);
  if (state) {
    state.accepted = true;
    state.telemetry.setStreamId(streamId);
  }
}

/**
 * Capture the outer request timestamp before body parsing and auth. The recorder is
 * created later, after the HTTP tracing middleware has installed its active context.
 */
export function agentStartupIngressMiddleware(
  req: ServerRequest,
  res: Response,
  next: NextFunction,
): void {
  if (isInitialAgentChatRequest(req)) {
    const ingressTime: AgentStartupIngressTime = {
      monotonic: performance.now(),
      epoch: Date.now(),
    };
    (res.locals as Record<PropertyKey, unknown>)[AGENT_STARTUP_STARTED_AT] = ingressTime;
  }
  next();
}

export function agentStartupTelemetryMiddleware(
  req: ServerRequest,
  res: Response,
  next: NextFunction,
): void {
  if (!isInitialAgentChatRequest(req)) {
    next();
    return;
  }

  const locals = res.locals as Record<PropertyKey, unknown>;
  const ingressTime = locals[AGENT_STARTUP_STARTED_AT] as AgentStartupIngressTime | undefined;
  delete locals[AGENT_STARTUP_STARTED_AT];
  const telemetry = createAgentStartupTelemetry({
    startedAt: ingressTime?.monotonic,
    spanStartedAt: ingressTime?.epoch,
  });
  if (!telemetry) {
    next();
    return;
  }
  const state: AgentStartupState = { accepted: false, telemetry };
  requestTelemetry.set(req, state);

  let responseEnded = false;
  const endBeforeAcceptance = (result: AgentStartupResult): void => {
    if (responseEnded) {
      return;
    }
    responseEnded = true;
    if (!state.accepted) {
      telemetry.end(result);
    }
  };

  res.once('finish', () => {
    if (state.accepted) {
      telemetry.mark('ack_sent');
      return;
    }
    endBeforeAcceptance(res.statusCode >= 500 ? 'error' : 'rejected');
  });
  res.once('close', () => {
    endBeforeAcceptance('aborted');
  });

  next();
}
