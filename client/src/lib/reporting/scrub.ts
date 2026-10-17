import type { ErrorEvent, Exception, StackFrame } from '@sentry/browser';
import {
  scrubField,
  MAX_NAME_LENGTH,
  isSafeErrorMessage,
  MAX_MESSAGE_LENGTH,
} from '~/lib/rum/redact';
import { normalizeRumPath } from '~/lib/rum/routes';

const REDACTED_MESSAGE = '[redacted]';
/** Tags this module sets itself; anything else on the scope stays in the browser. */
const TAG_ALLOWLIST = ['boundary', 'browser', 'os'] as const;

/** Asset URLs keep their path; a query or fragment can carry tokens and is dropped. */
function stripUrl(value: string | undefined): string | undefined {
  return value?.split(/[?#]/, 1)[0];
}

function scrubFrame(frame: StackFrame): StackFrame {
  return {
    filename: stripUrl(frame.filename),
    abs_path: stripUrl(frame.abs_path),
    function: frame.function ? scrubField(frame.function, MAX_NAME_LENGTH) : undefined,
    module: frame.module,
    lineno: frame.lineno,
    colno: frame.colno,
    in_app: frame.in_app,
  };
}

function scrubMessage(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) {
    return undefined;
  }
  return isSafeErrorMessage(value) ? scrubField(value, MAX_MESSAGE_LENGTH) : REDACTED_MESSAGE;
}

/**
 * The same rule the RUM exporter applies: an error message travels only when it matches a known
 * engine-, browser- or library-generated shape, because any other message can echo prompt or
 * response text. Type and stack are kept, so issues still group and point at the code.
 */
function scrubException(exception: Exception): Exception {
  return {
    type: exception.type ? scrubField(exception.type, MAX_NAME_LENGTH) : undefined,
    value: scrubMessage(exception.value),
    mechanism: exception.mechanism && {
      type: exception.mechanism.type,
      handled: exception.mechanism.handled,
      synthetic: exception.mechanism.synthetic,
      exception_id: exception.mechanism.exception_id,
      parent_id: exception.mechanism.parent_id,
      source: exception.mechanism.source,
      is_exception_group: exception.mechanism.is_exception_group,
    },
    stacktrace: exception.stacktrace && {
      frames: exception.stacktrace.frames?.map(scrubFrame),
    },
  };
}

/**
 * Rebuilds an event from an allowlist rather than deleting known-bad fields, so a field a future
 * SDK version adds is dropped by default. No user, request, breadcrumbs, extra or contexts leave
 * the browser; the page is reported only as its route template (`/c/:conversationId`).
 */
export function scrubEvent(event: ErrorEvent, pathname: string): ErrorEvent {
  const route = normalizeRumPath(pathname);
  return {
    type: event.type,
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: event.platform,
    level: event.level,
    logger: event.logger,
    release: event.release,
    environment: event.environment,
    dist: event.dist,
    sdk: event.sdk,
    fingerprint: event.fingerprint,
    transaction: route,
    message: event.message ? REDACTED_MESSAGE : undefined,
    exception: event.exception && {
      values: event.exception.values?.map(scrubException),
    },
    tags: pickTags(event.tags, route),
  };
}

function pickTags(tags: ErrorEvent['tags'], route: string): Record<string, string> {
  const picked: Record<string, string> = { route };
  for (const key of TAG_ALLOWLIST) {
    const value = tags?.[key];
    if (typeof value === 'string') {
      picked[key] = scrubField(value, MAX_NAME_LENGTH);
    }
  }
  return picked;
}
