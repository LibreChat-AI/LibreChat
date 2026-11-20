import { Constants, normalizeServerName } from 'librechat-data-provider';

interface ScheduleTriggerRequest {
  _isAgentTrigger?: boolean;
  _isScheduledFire?: boolean;
  _isManualScheduledFire?: boolean;
  /** From the verified trigger: MCP servers the occurrence was fired without. */
  _scheduleSkippedServers?: string[];
  body?: Record<string, unknown>;
}

interface TriggerRecord {
  [key: string]: unknown;
}

export interface ScheduleFireContext {
  scheduleId: string;
  scheduledFor: string;
  manual: boolean;
  configRevision?: number;
  /** MCP servers that were not ready when the occurrence fired: the run loads no tool of theirs. */
  skip?: string[];
}

function record(value: unknown): TriggerRecord | undefined {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as TriggerRecord)
    : undefined;
}

/**
 * Reads the schedule identity carried by the trusted trigger host. The generic
 * trigger token is the trust boundary; ordinary chat requests cannot opt into
 * schedule bookkeeping or limiter exemptions by copying these body fields.
 */
export function readScheduleFireContext(
  req?: ScheduleTriggerRequest,
): ScheduleFireContext | undefined {
  if (req?._isAgentTrigger !== true) {
    return undefined;
  }
  const trigger = record(req.body?.agentTrigger);
  const event = record(trigger?.event);
  const source = record(event?.source);
  const metadata = record(trigger?.metadata);
  if (
    trigger?.version !== 1 ||
    event?.type !== 'schedule.occurrence' ||
    source?.type !== 'schedule' ||
    typeof source.id !== 'string' ||
    source.id.trim().length === 0 ||
    typeof event.occurredAt !== 'number' ||
    !Number.isSafeInteger(event.occurredAt) ||
    event.occurredAt < 0
  ) {
    return undefined;
  }
  if (metadata?.manual != null && typeof metadata.manual !== 'boolean') {
    return undefined;
  }
  if (
    metadata?.configRevision != null &&
    (typeof metadata.configRevision !== 'number' ||
      !Number.isSafeInteger(metadata.configRevision) ||
      metadata.configRevision < 0)
  ) {
    return undefined;
  }
  const skip = metadata?.skip;
  if (skip != null && !(Array.isArray(skip) && skip.every((name) => typeof name === 'string'))) {
    return undefined;
  }
  return {
    scheduleId: source.id,
    scheduledFor: new Date(event.occurredAt).toISOString(),
    manual: metadata?.manual === true,
    ...(typeof metadata?.configRevision === 'number' && {
      configRevision: metadata.configRevision,
    }),
    ...(Array.isArray(skip) && skip.length > 0 && { skip: skip as string[] }),
  };
}

/**
 * Captures the verified trigger classification once, then projects the minimum
 * schedule fields expected by the existing generation lifecycle hooks.
 */
export function captureScheduleFireContext(
  req: ScheduleTriggerRequest,
): ScheduleFireContext | undefined {
  const context = readScheduleFireContext(req);
  req._isScheduledFire = context != null;
  req._isManualScheduledFire = context?.manual === true;
  req._scheduleSkippedServers = context?.skip;
  if (context != null && req.body != null) {
    req.body.scheduleId = context.scheduleId;
    req.body.scheduledFor = context.scheduledFor;
    if (context.configRevision == null) {
      delete req.body.scheduleConfigRevision;
    } else {
      req.body.scheduleConfigRevision = context.configRevision;
    }
  }
  return context;
}

export function isScheduleFireRequest(req?: ScheduleTriggerRequest): boolean {
  return typeof req?._isScheduledFire === 'boolean'
    ? req._isScheduledFire
    : readScheduleFireContext(req) != null;
}

/** Automatic occurrences are bounded by schedule cadence and global capacity. */
export function exemptFromUserLimiter(req?: ScheduleTriggerRequest): boolean {
  if (typeof req?._isScheduledFire === 'boolean') {
    return req._isScheduledFire && req._isManualScheduledFire !== true;
  }
  const context = readScheduleFireContext(req);
  return context != null && !context.manual;
}

/** Acquire/release sites share this exact predicate to keep counters balanced. */
export function exemptFromConcurrencyLimiter(req?: ScheduleTriggerRequest): boolean {
  return exemptFromUserLimiter(req);
}

/**
 * A run's tool keys without those on an MCP server its occurrence was fired without. The
 * server was not ready when the schedule fired, and its owner did not ask for every server
 * to be ready: left in, the run would stop to ask for a sign-in nobody is there to give.
 * Returns the same list when nothing is left out. Any other request keeps every key.
 */
export function withoutSkippedMCPServers(
  req: ScheduleTriggerRequest | undefined,
  toolKeys: string[],
): string[] {
  const skipped = req?._scheduleSkippedServers;
  if (!skipped?.length) return toolKeys;
  const suffixes = new Set(
    skipped.flatMap((name) => [
      `${Constants.mcp_delimiter}${name}`,
      `${Constants.mcp_delimiter}${normalizeServerName(name)}`,
    ]),
  );
  const kept = toolKeys.filter((key) => ![...suffixes].some((suffix) => key.endsWith(suffix)));
  return kept.length === toolKeys.length ? toolKeys : kept;
}
