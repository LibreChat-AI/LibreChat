import { Constants, splitMCPToolKey, buildServerNameAliases } from 'librechat-data-provider';
import type { ScheduleMCPOutcome } from 'librechat-data-provider';

interface ScheduleTriggerRequest {
  _isAgentTrigger?: boolean;
  _isScheduledFire?: boolean;
  _isManualScheduledFire?: boolean;
  /** From the verified trigger or the run's own record: MCP servers the occurrence went without. */
  _scheduleSkippedServers?: string[];
  /** Every MCP server the occurrence's readiness check covered, skipped or not. */
  _scheduleCheckedServers?: string[];
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
  /** Every MCP server the readiness check covered: what a tool key is resolved against. */
  servers?: string[];
}

/** Absent, or a list of names. */
function names(value: unknown): value is string[] | null | undefined {
  return value == null || (Array.isArray(value) && value.every((name) => typeof name === 'string'));
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
  const servers = metadata?.servers;
  if (!names(skip) || !names(servers)) {
    return undefined;
  }
  return {
    scheduleId: source.id,
    scheduledFor: new Date(event.occurredAt).toISOString(),
    manual: metadata?.manual === true,
    ...(typeof metadata?.configRevision === 'number' && {
      configRevision: metadata.configRevision,
    }),
    ...(skip != null && skip.length > 0 && { skip, ...(servers != null && { servers }) }),
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
  req._scheduleCheckedServers = context?.servers;
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
 * The servers an occurrence's readiness check left out and all the servers it covered, from
 * its outcomes. Both travel with the occurrence: in its trigger when it fires, and on its run
 * row, which a resumed run reads them back from.
 */
export function skippedMCPServers(
  outcomes: ReadonlyArray<Pick<ScheduleMCPOutcome, 'server' | 'skipped'>>,
): { skip: string[]; servers: string[] } {
  const skip = [...new Set(outcomes.filter((item) => item.skipped === true).map((o) => o.server))];
  return { skip, servers: skip.length > 0 ? [...new Set(outcomes.map((o) => o.server))] : [] };
}

/**
 * Puts back, on a request that resumes a paused scheduled run, what its occurrence went
 * without. The resume rebuilds the run's tools, and is not a trigger: without this it would
 * load the servers the occurrence was started without.
 */
export function restoreSkippedMCPServers(
  req: ScheduleTriggerRequest,
  outcomes: ReadonlyArray<Pick<ScheduleMCPOutcome, 'server' | 'skipped'>>,
): void {
  const { skip, servers } = skippedMCPServers(outcomes);
  req._scheduleSkippedServers = skip.length > 0 ? skip : undefined;
  req._scheduleCheckedServers = skip.length > 0 ? servers : undefined;
}

/**
 * A run's tool keys without those on an MCP server its occurrence went without. The server
 * was not ready when the schedule fired, and its owner did not ask for every server to be
 * ready: left in, the run would stop to ask for a sign-in nobody is there to give.
 *
 * A key is resolved to its server among every server the check covered, longest name first,
 * as tool loading resolves it: skipping `bar` leaves a tool on `foo_mcp_bar` alone. Returns
 * the same list when nothing is left out. Any other request keeps every key.
 */
export function withoutSkippedMCPServers(
  req: ScheduleTriggerRequest | undefined,
  toolKeys: string[],
): string[] {
  const skipped = req?._scheduleSkippedServers;
  if (!skipped?.length) return toolKeys;
  const known = [...new Set([...(req?._scheduleCheckedServers ?? []), ...skipped])];
  const aliases = buildServerNameAliases(known);
  const candidates = [...known, ...aliases.keys()];
  const out = new Set(skipped);
  const kept = toolKeys.filter((key) => {
    if (!key.includes(Constants.mcp_delimiter)) return true;
    const [, alias] = splitMCPToolKey(key, candidates);
    const server = alias && (known.includes(alias) ? alias : aliases.get(alias));
    return !(server && out.has(server));
  });
  return kept.length === toolKeys.length ? toolKeys : kept;
}
