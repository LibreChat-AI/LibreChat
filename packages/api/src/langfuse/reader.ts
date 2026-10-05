import { z } from 'zod';
import { createHash } from 'crypto';
import { logger } from '@librechat/data-schemas';
import type {
  TTraceUsage,
  TTraceRecord,
  TTraceStatus,
  TTraceContent,
  TTraceRecordKind,
} from 'librechat-data-provider';
import type {
  AppConfig,
  ConversationTraceRefs,
  SampledTraceMessage,
} from '@librechat/data-schemas';
import type { LangfuseScoreDestination } from './destinations';
import type { TraceQuery, TraceReader } from '~/traces/types';
import { TOOL_ROUND_NAME, resolveTraceRole } from './roles';
import { exportsInternalTraceUserId } from './identity';
import { toTracePrompt, toTraceReply } from './prompt';
import { getScoreDestinations } from './destinations';
import { TraceReadError } from '~/traces/types';
import { mergeHeaders } from '~/utils/headers';
import { redirectPolicyFor } from './utils';
import { traceIdForMessage } from './trace';
import { toolRoundNames } from './rounds';

const OBSERVATIONS_PATH = '/api/public/v2/observations';
const MAX_PAGE_SIZE = 1000;
/** Langfuse stamps observations with the exporting server's clock; the margin
 *  absorbs skew between that clock and the database's message timestamps. */
const TIME_WINDOW_MARGIN_MS = 10 * 60 * 1000;
/** Matches the central project lookup's own retry cadence. */
const IDENTITY_RETRY_MS = 30_000;
const NAME_MAX_LENGTH = 200;
const STATUS_MESSAGE_MAX_LENGTH = 1000;
const LIST_FIELDS = 'core,basic,time,model,usage';
const DETAIL_FIELDS = `${LIST_FIELDS},io,metadata`;
const ROUND_FIELDS = 'core,io';
/**
 * Bounds on naming tool rounds. Langfuse cannot return a round's input without its output, and
 * a round the SDK found no calls for keeps the whole graph state as its input, so the rounds are
 * read a few at a time and the read stops at a byte budget: the newest rounds are named and the
 * rest are left to the chat's messages. These are safety caps on a best-effort addition, as
 * `MAX_PAGE_SIZE` is, not limits an operator tunes; `showToolNames` is the lever.
 */
const ROUND_PAGE_SIZE = 50;
const ROUND_BYTES_BUDGET = 8 * 1024 * 1024;
const DESTINATION_PREFERENCE: Record<LangfuseScoreDestination['name'], number> = {
  connection: 0,
  tenant: 1,
  central: 2,
};

const timestampSchema = z.string().refine((value) => !Number.isNaN(Date.parse(value)));
const observationSchema = z.object({
  id: z.string().min(1),
  traceId: z.string().min(1),
  startTime: timestampSchema,
  endTime: timestampSchema.nullish(),
  parentObservationId: z.string().nullish(),
  type: z.string(),
  name: z.string().nullish(),
  level: z.string().nullish(),
  statusMessage: z.string().nullish(),
  completionStartTime: timestampSchema.nullish(),
  /** Langfuse Cloud serves the `model` field group as `model`; its SDK types name it `providedModelName`. */
  model: z.string().nullish(),
  providedModelName: z.string().nullish(),
  usageDetails: z.record(z.number()).nullish(),
  costDetails: z.record(z.number()).nullish(),
  totalCost: z.number().nullish(),
  input: z.unknown(),
  output: z.unknown(),
  metadata: z.unknown(),
});
const pageSchema = z.object({
  data: z.array(z.unknown()),
  meta: z.object({ cursor: z.string().nullish() }).partial().nullish(),
});

const roundSchema = z.object({ id: z.string().min(1), input: z.unknown() });

type LangfuseObservation = z.infer<typeof observationSchema>;
/** The response that owns a trace, and whether the trace is its title run rather than the run itself. */
type TraceOwner = { messageId: string; origin?: 'title' };
type OwnedObservation = { observation: LangfuseObservation } & TraceOwner;

export interface LangfuseTraceReaderDeps {
  getConversationTraceRefs: (input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    messageId?: string;
    through?: { messageId: string; orderKey: string };
    limit?: number;
  }) => Promise<ConversationTraceRefs>;
  hasSampledTraceMessage: (input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    destinationIds: string[];
  }) => Promise<boolean>;
  /** The projects a read may use; production passes {@link resolveLangfuseReadDestinations}. */
  resolveDestinations: (appConfig?: AppConfig) => Promise<LangfuseScoreDestination[]>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
}

/**
 * The destinations feedback scores use, which carry the read credentials. Never
 * waits on the central project lookup: the process starts it at boot, and a read
 * must not stall behind a `/api/public/projects` call that `requestTimeoutMs`
 * does not govern. Until it resolves, central has no id; availability then asks
 * the client to check again rather than answering a definitive no.
 */
export function resolveLangfuseReadDestinations(
  appConfig?: AppConfig,
): Promise<LangfuseScoreDestination[]> {
  return getScoreDestinations(appConfig, '', true, { waitForCentralProjectId: false });
}

const KIND_BY_TYPE: Record<string, TTraceRecordKind> = {
  AGENT: 'agent',
  GENERATION: 'generation',
  EMBEDDING: 'generation',
  TOOL: 'tool',
  RETRIEVER: 'tool',
  EVENT: 'event',
};

/** Node's fetch returns a connection to its pool only once the body is consumed or cancelled. */
async function release(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

type ByteBudget = { remaining: number };

/**
 * Parses a JSON body while holding no more of it than the budget has left. `Response.json()`
 * buffers whatever the backend sends, which for a read that returns content is not ours to bound
 * any other way.
 */
async function readBounded(response: Response, budget: ByteBudget): Promise<unknown> {
  const reader = response.body?.getReader();
  if (reader == null) {
    return undefined;
  }
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    budget.remaining -= value.byteLength;
    if (budget.remaining < 0) {
      await reader.cancel().catch(() => undefined);
      throw new TraceReadError('upstream_error', 'Langfuse returned more than the read allows');
    }
    text += decoder.decode(value, { stream: true });
  }
  return JSON.parse(text + decoder.decode());
}

function clamp(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function toStatus(observation: LangfuseObservation, endTime?: string | null): TTraceStatus {
  if (observation.level === 'ERROR') {
    return 'error';
  }
  if (observation.level === 'WARNING') {
    return 'warning';
  }
  return endTime ? 'ok' : 'running';
}

function usageValue(details: Record<string, number>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = details[key];
    if (Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return undefined;
}

function toUsage(details?: Record<string, number> | null): TTraceUsage | undefined {
  if (!details) {
    return undefined;
  }
  const usage: TTraceUsage = {
    input: usageValue(details, 'input', 'input_tokens', 'prompt_tokens'),
    output: usageValue(details, 'output', 'output_tokens', 'completion_tokens'),
    total: usageValue(details, 'total', 'total_tokens'),
    reasoning: usageValue(details, 'output_reasoning', 'reasoning', 'reasoning_tokens'),
    cacheRead: usageValue(details, 'input_cache_read', 'cache_read', 'cache_read_input_tokens'),
    cacheWrite: usageValue(
      details,
      'input_cache_creation',
      'input_cache_write',
      'cache_creation',
      'cache_creation_input_tokens',
    ),
  };
  const entries = Object.entries(usage).filter(([, value]) => value != null);
  return entries.length > 0 ? (Object.fromEntries(entries) as TTraceUsage) : undefined;
}

function toCost(observation: LangfuseObservation): number | undefined {
  const cost = observation.totalCost ?? observation.costDetails?.total;
  return cost != null && Number.isFinite(cost) && cost >= 0 ? cost : undefined;
}

function toRecord(
  observation: LangfuseObservation,
  messageId: string,
  origin?: 'title',
): TTraceRecord {
  const type = observation.type.toUpperCase();
  /** An event is a point in time and is never given an end, so a missing end is not "running". */
  const endTime = observation.endTime ?? (type === 'EVENT' ? observation.startTime : null);
  const status = toStatus(observation, endTime);
  const name = observation.name?.trim() || observation.type.toLowerCase();
  const statusMessage = observation.statusMessage?.trim();
  const model = (observation.model ?? observation.providedModelName)?.trim();
  const usage = toUsage(observation.usageDetails);
  const cost = toCost(observation);
  const kind = KIND_BY_TYPE[type] ?? 'span';
  return {
    id: observation.id,
    traceId: observation.traceId,
    messageId,
    parentId: observation.parentObservationId || null,
    kind,
    ...resolveTraceRole(kind, name),
    name: clamp(name, NAME_MAX_LENGTH),
    startTime: new Date(observation.startTime).toISOString(),
    status,
    ...(model ? { model: clamp(model, NAME_MAX_LENGTH) } : {}),
    ...(endTime ? { endTime: new Date(endTime).toISOString() } : {}),
    ...(observation.completionStartTime
      ? { completionStartTime: new Date(observation.completionStartTime).toISOString() }
      : {}),
    ...(statusMessage && (status === 'error' || status === 'warning')
      ? { statusMessage: clamp(statusMessage, STATUS_MESSAGE_MAX_LENGTH) }
      : {}),
    ...(usage ? { usage } : {}),
    ...(cost != null ? { cost } : {}),
    ...(origin ? { origin } : {}),
  };
}

function toContent(value: unknown, maxLength: number): TTraceContent | undefined {
  if (value == null) {
    return undefined;
  }
  /** An empty object or a JSON null carries nothing; a string that spells one is real output. */
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (
    text == null ||
    text === '' ||
    (typeof value !== 'string' && (text === '{}' || text === 'null'))
  ) {
    return undefined;
  }
  return text.length > maxLength
    ? { value: text.slice(0, maxLength), truncated: true }
    : { value: text, truncated: false };
}

/** The run whose trace a response reports: its own, or the run a failed turn's error row stands for. */
function runIdOf(message: SampledTraceMessage): string {
  return message.langfuseRunId ?? message.messageId;
}

/** The traces a sampled response owns: its run and that run's title run. */
function traceIdsOf(message: SampledTraceMessage): string[] {
  const runId = runIdOf(message);
  return [traceIdForMessage(runId), traceIdForMessage(`title-${runId}`)];
}

/**
 * Maps every trace a conversation's sampled responses can own to the response
 * that owns it. Langfuse sessions are keyed only by conversation id, which is
 * unique per user rather than globally, so a record whose trace is not in this
 * map is never returned.
 */
function buildTraceOwners(messages: SampledTraceMessage[]): Map<string, TraceOwner> {
  const owners = new Map<string, TraceOwner>();
  for (const message of messages) {
    const [run, title] = traceIdsOf(message);
    owners.set(run, { messageId: message.messageId });
    owners.set(title, { messageId: message.messageId, origin: 'title' });
  }
  return owners;
}

/** Whether a response's trace could be in a project: it names the project, or predates the record. */
function couldHold(destination: LangfuseScoreDestination, message: SampledTraceMessage): boolean {
  const ids = message.langfuseDestinationIds;
  return ids == null || (destination.id != null && ids.includes(destination.id));
}

/** Stable, opaque identity of a destination; its project hash when Langfuse gave one. */
function sourceIdOf(destination: LangfuseScoreDestination): string {
  return destination.id ?? `name:${destination.name}`;
}

/**
 * The projects a conversation can be read from, the tenant's own before
 * central. A message with no recorded destinations predates the record and
 * could be in any of them; a destination no message could be in is dropped, and
 * two credentials for one project are one source, since a cursor could not tell
 * them apart.
 */
function readableSources(
  destinations: LangfuseScoreDestination[],
  messages?: SampledTraceMessage[],
): LangfuseScoreDestination[] {
  return destinations
    .filter(
      (destination) =>
        messages == null || messages.some((message) => couldHold(destination, message)),
    )
    .sort((a, b) => DESTINATION_PREFERENCE[a.name] - DESTINATION_PREFERENCE[b.name])
    .filter(
      (destination, index, ordered) =>
        ordered.findIndex((candidate) => sourceIdOf(candidate) === sourceIdOf(destination)) ===
        index,
    );
}

/** Failures of one project that another project holding the same turns can stand in for. */
const FAILOVER_CODES = new Set([
  'unauthorized',
  'unsupported',
  'timeout',
  'rate_limited',
  'upstream_error',
]);

/** A destination named before its project id resolved still matches once the id arrives. */
function isSource(destination: LangfuseScoreDestination, sourceId?: string): boolean {
  return (
    sourceId != null &&
    (sourceIdOf(destination) === sourceId || `name:${destination.name}` === sourceId)
  );
}

/**
 * Turns per evidence window and per segment. Each turn costs two trace ids in a
 * filter, so fifty keep a request URL near 5 KB, well inside proxy limits, while
 * one read still spans a long conversation.
 */
const SEGMENT_TURNS = 50;

/** Root observations only: one row per trace, so a probe of which traces a project holds stays small. */
const ROOT_FILTER = { type: 'null', column: 'parentObservationId', operator: 'is null', value: '' };
const rootSchema = z.object({ traceId: z.string().min(1), startTime: timestampSchema.nullish() });

const cursorSchema = z.object({
  /** The newest turn of the segment being read. */
  m: z.string().min(1),
  /** That turn's position in the response order, which the next request resumes from. */
  p: z.string().min(1).max(64).optional(),
  /** The trace of that turn the segment starts at, when it starts partway through the turn. */
  k: z.enum(['r', 't']).optional(),
  /** The project reading it. */
  s: z.string().min(1).optional(),
  /** That project's Langfuse cursor. */
  c: z.string().min(1).optional(),
  /** The segment's trace set, so a Langfuse cursor is only resumed against the filter that issued it. */
  h: z.string().min(1).max(64).optional(),
});

type TraceCursor = z.infer<typeof cursorSchema>;

function encodeCursor(cursor: TraceCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string): TraceCursor {
  try {
    const parsed = cursorSchema.safeParse(
      JSON.parse(Buffer.from(value, 'base64url').toString('utf8')),
    );
    if (parsed.success) {
      return parsed.data;
    }
  } catch {
    /* falls through to the rejection below */
  }
  throw new TraceReadError('invalid_request', 'The page cursor is not one this server issued');
}

function segmentKey(traceIds: string[]): string {
  return createHash('sha256').update(traceIds.join(','), 'utf8').digest('base64url').slice(0, 16);
}

type LangfuseFilter = Array<{
  type: string;
  column: string;
  operator: string;
  value: string | string[];
}>;

type TraceKind = 'run' | 'title';
const KIND_BY_CODE: Record<'r' | 't', TraceKind> = { r: 'run', t: 'title' };

/**
 * Observations exported for the requesting user. The trace ids a conversation
 * owns derive from message ids, which a request can influence, so a colliding
 * id must still never return someone else's trace: every read also requires
 * the internal user id the server stamped on the trace at export.
 */
function ownerFilter(query: TraceQuery): LangfuseFilter[number] {
  return { type: 'stringOptions', column: 'userId', operator: 'any of', value: [query.userId] };
}

/**
 * Whether traces carry the internal user id. A deployment that exports another
 * user field as the trace `userId` has no immutable principal on its traces:
 * names and usernames repeat, and emails and provider ids repeat across
 * tenants. So its traces are never shown.
 */
function keyedByInternalId(appConfig?: AppConfig): boolean {
  const trace = appConfig?.langfuse?.trace;
  if (exportsInternalTraceUserId(trace)) {
    return true;
  }
  const field = trace?.userIdField;
  warnOnce(
    `user_id_field:${field}`,
    `[traces] The trace viewer shows no traces while langfuse.trace.userIdField is "${field}": only the internal user id identifies who a trace belongs to.`,
  );
  return false;
}

function startTimeFilter(window: { from?: string; to: string }): LangfuseFilter {
  return [
    { type: 'datetime', column: 'startTime', operator: '<', value: window.to },
    ...(window.from
      ? [{ type: 'datetime', column: 'startTime', operator: '>=', value: window.from }]
      : []),
  ];
}

function statusError(status: number, hasCursor: boolean): TraceReadError {
  if (status === 401 || status === 403) {
    return new TraceReadError('unauthorized', `Langfuse responded with ${status}`);
  }
  if (status === 404) {
    return new TraceReadError(
      'unsupported',
      'Langfuse has no v2 Observations API at this destination (self-hosted releases before v4)',
    );
  }
  if (status === 429) {
    return new TraceReadError('rate_limited', 'Langfuse is rate limiting trace reads');
  }
  if (status === 400 && hasCursor) {
    return new TraceReadError('invalid_request', 'Langfuse rejected the page cursor');
  }
  return new TraceReadError('upstream_error', `Langfuse responded with ${status}`);
}

/** Configuration problems already reported, so a per-request check cannot flood the log. */
const reportedWarnings = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (reportedWarnings.has(key)) {
    return;
  }
  reportedWarnings.add(key);
  logger.warn(message);
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

export function createLangfuseTraceReader({
  getConversationTraceRefs,
  hasSampledTraceMessage,
  resolveDestinations,
  fetch: fetchImpl,
  now = Date.now,
}: LangfuseTraceReaderDeps): TraceReader {
  async function readableDestinations(appConfig?: AppConfig): Promise<LangfuseScoreDestination[]> {
    const destinations = await resolveDestinations(appConfig);
    if (destinations.length === 0) {
      warnOnce(
        'no_destination',
        '[traces] The trace viewer is enabled, but Langfuse tracing is disabled or has no destination with read credentials, so no conversation shows a trace.',
      );
    }
    return destinations;
  }

  /** The one sampled response a detail read is for, with the projects that could hold its traces. */
  async function loadTurn(query: TraceQuery, messageId: string) {
    const [refs, destinations] = await Promise.all([
      getConversationTraceRefs({
        user: query.userId,
        conversationId: query.conversationId,
        tenantId: query.tenantId,
        messageId,
      }),
      readableDestinations(query.appConfig),
    ]);
    return { refs, sources: readableSources(destinations, refs.sampledMessages) };
  }

  function timeWindow(refs: ConversationTraceRefs): { from?: string; to: string } {
    const earliest = [refs.firstMessageAt, refs.sampledMessages[0]?.createdAt]
      .map((value) => (value == null ? Number.NaN : new Date(value).getTime()))
      .filter((value) => Number.isFinite(value));
    return {
      ...(earliest.length > 0
        ? { from: new Date(Math.min(...earliest) - TIME_WINDOW_MARGIN_MS).toISOString() }
        : {}),
      to: new Date(now() + TIME_WINDOW_MARGIN_MS).toISOString(),
    };
  }

  async function requestPage(
    destination: LangfuseScoreDestination,
    params: URLSearchParams,
    query: TraceQuery,
    hasCursor: boolean,
    /** Spends the body's bytes from this budget, refusing the rest of a body that outruns it. */
    budget?: ByteBudget,
  ): Promise<z.infer<typeof pageSchema>> {
    const url = `${destination.baseUrl.replace(/\/+$/, '')}${OBSERVATIONS_PATH}?${params.toString()}`;
    const timeout = AbortSignal.timeout(query.settings.requestTimeoutMs);
    const signal = query.signal ? AbortSignal.any([query.signal, timeout]) : timeout;
    const failed = (error: unknown, fallback: TraceReadError): TraceReadError => {
      if (query.signal?.aborted) {
        return new TraceReadError('upstream_error', 'The trace read was cancelled');
      }
      return isTimeout(error)
        ? new TraceReadError('timeout', 'Langfuse did not respond in time')
        : fallback;
    };

    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: mergeHeaders(destination.headers, { Authorization: destination.authorization }),
        signal,
        ...redirectPolicyFor(destination.headers),
      });
    } catch (error) {
      throw failed(
        error,
        new TraceReadError(
          'upstream_error',
          `Langfuse request failed: ${error instanceof Error ? error.name : 'unknown error'}`,
        ),
      );
    }
    if (!response.ok) {
      await release(response);
      throw statusError(response.status, hasCursor);
    }
    let body: unknown;
    try {
      body = budget == null ? await response.json() : await readBounded(response, budget);
    } catch (error) {
      if (error instanceof TraceReadError) {
        throw error;
      }
      throw failed(
        error,
        new TraceReadError('upstream_error', 'Langfuse returned an invalid response'),
      );
    }
    const parsed = pageSchema.safeParse(body);
    if (!parsed.success) {
      throw new TraceReadError('upstream_error', 'Langfuse returned an unexpected response');
    }
    return parsed.data;
  }

  function parseRows(rows: unknown[], owners: Map<string, TraceOwner>): OwnedObservation[] {
    const observations: OwnedObservation[] = [];
    let malformed = 0;
    for (const row of rows) {
      const parsed = observationSchema.safeParse(row);
      if (!parsed.success) {
        malformed++;
        continue;
      }
      const owner = owners.get(parsed.data.traceId);
      if (owner != null) {
        observations.push({ observation: parsed.data, ...owner });
      }
    }
    if (malformed > 0) {
      logger.warn(`[langfuse] Skipped ${malformed} malformed observation(s) in a trace read`);
    }
    /** Rows that all fail the schema mean the API changed shape, not that the trace is empty. */
    if (malformed > 0 && malformed === rows.length) {
      throw new TraceReadError(
        'upstream_error',
        'Langfuse returned observations in an unknown shape',
      );
    }
    return observations;
  }

  return {
    async isAvailable(query) {
      const destinations = await readableDestinations(query.appConfig);
      if (destinations.length === 0 || !keyedByInternalId(query.appConfig)) {
        return { available: false };
      }
      const available = await hasSampledTraceMessage({
        user: query.userId,
        conversationId: query.conversationId,
        tenantId: query.tenantId,
        destinationIds: destinations.flatMap(({ id }) => (id != null ? [id] : [])),
      });
      if (available) {
        return { available: true };
      }
      /** A response recorded against central cannot match until central's id resolves. */
      const identityPending = destinations.some(({ name, id }) => name === 'central' && id == null);
      return identityPending
        ? { available: false, retryAfterMs: IDENTITY_RETRY_MS }
        : { available: false };
    },

    async listRecords(query) {
      const continuation = query.cursor != null ? decodeCursor(query.cursor) : undefined;
      if (!keyedByInternalId(query.appConfig)) {
        throw new TraceReadError('not_found', 'Traces here are not keyed by the internal user id');
      }
      /**
       * Sampled responses load a segment's worth at a time, ending at the turn
       * being read, plus one older response that says where the next page starts.
       * A long conversation's pages then never reload the responses before them.
       */
      const loadWindow = async (through?: { messageId: string; orderKey: string }) => {
        const refs = await getConversationTraceRefs({
          user: query.userId,
          conversationId: query.conversationId,
          tenantId: query.tenantId,
          ...(through != null ? { through } : {}),
          limit: SEGMENT_TURNS + 1,
        });
        const peek =
          refs.sampledMessages.length > SEGMENT_TURNS ? refs.sampledMessages[0] : undefined;
        return {
          refs,
          peek,
          messages: peek ? refs.sampledMessages.slice(1) : refs.sampledMessages,
        };
      };
      if (continuation != null && continuation.p == null) {
        throw new TraceReadError(
          'invalid_request',
          'The page cursor is not one this server issued',
        );
      }
      const [initial, destinations] = await Promise.all([
        loadWindow(
          continuation?.p != null
            ? { messageId: continuation.m, orderKey: continuation.p }
            : undefined,
        ),
        readableDestinations(query.appConfig),
      ]);
      const sources = readableSources(destinations);
      let { messages, peek } = initial;
      let owners = buildTraceOwners(messages);
      const timeFilter = startTimeFilter(timeWindow(initial.refs));
      const scopeFilter = (traceIds: string[]): LangfuseFilter => [
        { type: 'string', column: 'sessionId', operator: '=', value: query.conversationId },
        ownerFilter(query),
        { type: 'stringOptions', column: 'traceId', operator: 'any of', value: traceIds },
        ...timeFilter,
      ];

      let turn = messages.length - 1;
      let startKind: TraceKind | undefined;
      if (continuation != null) {
        startKind = continuation.k != null ? KIND_BY_CODE[continuation.k] : undefined;
        if (messages[turn]?.messageId !== continuation.m) {
          throw new TraceReadError(
            'invalid_request',
            'The page cursor names a turn this conversation no longer has',
          );
        }
      } else if (messages.length === 0 || sources.length === 0) {
        throw new TraceReadError('not_found', 'No sampled trace for this conversation');
      }

      /**
       * What this request learned per project: the trace ids it asked about, the
       * ones the project holds, and a failure that rules the project out.
       * Recorded destinations only say where a trace was eligible to go, so a
       * trace more than one project could hold is read from one shown to hold it.
       */
      const probed = new Map<string, Set<string>>();
      const found = new Map<string, Set<string>>();
      /** Root start times the probes saw, which order a turn's traces when they sit in different projects. */
      const rootStarts = new Map<string, string>();
      const failures = new Map<string, TraceReadError>();
      const isFailed = (source: LangfuseScoreDestination) => failures.has(sourceIdOf(source));
      const isFailover = (error: unknown): error is TraceReadError =>
        !query.signal?.aborted && error instanceof TraceReadError && FAILOVER_CODES.has(error.code);
      const candidatesFor = (message: SampledTraceMessage) =>
        sources.filter((source) => couldHold(source, message));
      const holdsTrace = (source: LangfuseScoreDestination, traceId: string) =>
        !isFailed(source) && (found.get(sourceIdOf(source))?.has(traceId) ?? false);

      /** Asks a project which of `traceIds` it holds a root observation for. */
      async function probe(source: LangfuseScoreDestination, traceIds: string[]): Promise<void> {
        const sourceId = sourceIdOf(source);
        const asked = probed.get(sourceId) ?? new Set<string>();
        const pending = traceIds.filter((traceId) => !asked.has(traceId));
        if (isFailed(source) || pending.length === 0) {
          return;
        }
        const present = found.get(sourceId) ?? new Set<string>();
        const filter = JSON.stringify([...scopeFilter(pending), ROOT_FILTER]);
        try {
          let cursor: string | undefined;
          const seenCursors = new Set<string>();
          do {
            const params = new URLSearchParams({
              fields: 'core',
              limit: String(MAX_PAGE_SIZE),
              filter,
            });
            if (cursor) {
              params.set('cursor', cursor);
            }
            const page = await requestPage(source, params, query, cursor != null);
            let parsed = 0;
            for (const row of page.data) {
              const root = rootSchema.safeParse(row);
              if (root.success) {
                parsed++;
                present.add(root.data.traceId);
                if (root.data.startTime != null) {
                  rootStarts.set(root.data.traceId, new Date(root.data.startTime).toISOString());
                }
              }
            }
            if (page.data.length > 0 && parsed === 0) {
              throw new TraceReadError(
                'upstream_error',
                'Langfuse returned observations in an unknown shape',
              );
            }
            cursor = page.data.length > 0 ? page.meta?.cursor || undefined : undefined;
            /** A cursor that repeats would page forever, each request under its own timeout. */
            if (cursor != null && seenCursors.has(cursor)) {
              throw new TraceReadError('upstream_error', 'Langfuse repeated a page cursor');
            }
            if (cursor != null) {
              seenCursors.add(cursor);
            }
          } while (cursor);
        } catch (error) {
          if (!isFailover(error)) {
            throw error;
          }
          failures.set(sourceId, error);
          return;
        }
        for (const traceId of pending) {
          asked.add(traceId);
        }
        probed.set(sourceId, asked);
        found.set(sourceId, present);
      }

      /**
       * Looks each trace of the turns in `[lowest, highest]` that more than one
       * project could hold up in those projects, preferred first, until one holds
       * it. A turn's run and title run are exported separately, so each trace
       * needs its own evidence.
       */
      async function gatherEvidence(lowest: number, highest: number): Promise<void> {
        for (const source of sources) {
          const pending: string[] = [];
          for (let index = lowest; index <= highest; index++) {
            const message = messages[index];
            if (!couldHold(source, message) || candidatesFor(message).length < 2) {
              continue;
            }
            for (const traceId of traceIdsOf(message)) {
              if (!sources.some((other) => other !== source && holdsTrace(other, traceId))) {
                pending.push(traceId);
              }
            }
          }
          await probe(source, pending);
        }
      }

      type TraceUnit = { turn: number; kind: TraceKind; first: boolean; traceId: string };
      /**
       * A turn's traces in reading order, newest first: a title run seen to start
       * after its run (a title generated once the response finished) comes first;
       * otherwise the run does. The order only matters when the two sit in
       * different projects, and then both roots, and so their start times, are known.
       */
      const tracesOf = (index: number): Array<Pick<TraceUnit, 'kind' | 'traceId'>> => {
        const [run, title] = traceIdsOf(messages[index]);
        const runStart = rootStarts.get(run);
        const titleStart = rootStarts.get(title);
        const titleFirst = runStart != null && titleStart != null && titleStart > runStart;
        const ordered: Array<Pick<TraceUnit, 'kind' | 'traceId'>> = [
          { kind: 'run', traceId: run },
          { kind: 'title', traceId: title },
        ];
        return titleFirst ? ordered.reverse() : ordered;
      };
      const unitsFrom = (
        start: number,
        kind: TraceKind | undefined,
        lowest: number,
      ): TraceUnit[] => {
        const units: TraceUnit[] = [];
        for (let index = start; index >= lowest; index--) {
          const traces = tracesOf(index);
          const from =
            index === start && kind != null
              ? Math.max(
                  0,
                  traces.findIndex((trace) => trace.kind === kind),
                )
              : 0;
          traces.slice(from).forEach((trace, position) => {
            units.push({ turn: index, first: from + position === 0, ...trace });
          });
        }
        return units;
      };

      /**
       * The project a trace is read from: the only one that could hold it, or the
       * preferred one shown to hold it (`prefer` when that one does). `undefined`
       * when no project shows it, which is normal for a title run a turn never
       * had and for a run whose root is not exported yet. Throws when a failed
       * project could hold a turn's run and no other shows it.
       */
      function holderFor(
        unit: TraceUnit,
        prefer?: LangfuseScoreDestination,
      ): LangfuseScoreDestination | undefined {
        const candidates = candidatesFor(messages[unit.turn]);
        if (candidates.length === 1 && !isFailed(candidates[0])) {
          return candidates[0];
        }
        const holding = candidates.filter((source) => holdsTrace(source, unit.traceId));
        if (holding.length > 0) {
          return prefer != null && holding.includes(prefer) ? prefer : holding[0];
        }
        /** A run could be in any failed project; a title run only where a probe found it, since
         *  most turns never had one. */
        const failed = candidates.find(
          (source) =>
            isFailed(source) &&
            (unit.kind === 'run' || (found.get(sourceIdOf(source))?.has(unit.traceId) ?? false)),
        );
        if (failed != null) {
          throw failures.get(sourceIdOf(failed));
        }
        return undefined;
      }

      /**
       * The traces from `units[0]` that one project reads in a single stretch of
       * pages: consecutive traces it is shown to hold, plus traces no project
       * shows that it could hold. One project per segment keeps pages in turn
       * order and lets its own cursor page through records sharing a start time.
       */
      function segmentOf(units: TraceUnit[]) {
        const first = units[0];
        const eligible = (source: LangfuseScoreDestination, unit: TraceUnit) =>
          couldHold(source, messages[unit.turn]);
        let holder = holderFor(first);
        for (let index = 1; holder == null && index < units.length; index++) {
          let placed: LangfuseScoreDestination | undefined;
          try {
            placed = holderFor(units[index]);
          } catch {
            break;
          }
          if (placed != null && eligible(placed, first)) {
            holder = placed;
          }
        }
        holder ??= candidatesFor(messages[first.turn]).find((source) => !isFailed(source));
        if (holder == null) {
          return null;
        }
        const traceIds: string[] = [];
        let end = 0;
        while (end < units.length && traceIds.length < SEGMENT_TURNS * 2) {
          const unit = units[end];
          let placed: LangfuseScoreDestination | undefined;
          try {
            placed = holderFor(unit, holder);
          } catch (error) {
            if (end === 0) {
              throw error;
            }
            /** An unverifiable run reports its failure once it is the newest trace left. */
            break;
          }
          if (placed == null ? !eligible(holder, unit) : placed !== holder) {
            break;
          }
          traceIds.push(unit.traceId);
          end++;
        }
        return { holder, end, traceIds };
      }

      /** Reads a segment from its project until its records or this request's record budget run out. */
      /**
       * Names the tools of the listed tool rounds from the rounds' own input, in one read scoped to
       * those rounds. A list read carries no input, and asking for it on every record would return
       * each model call's whole conversation. The names are an addition to a page already read, so
       * a failure here leaves the rounds unnamed instead of failing the page.
       */
      async function nameToolRounds(
        destination: LangfuseScoreDestination,
        traceIds: string[],
        records: TTraceRecord[],
      ): Promise<void> {
        if (!query.settings.showToolNames) {
          return;
        }
        const rounds = new Map<string, TTraceRecord>();
        let from: string | undefined;
        let to: string | undefined;
        for (const record of records) {
          if (record.role !== 'tools') {
            continue;
          }
          rounds.set(record.id, record);
          from = from == null || record.startTime < from ? record.startTime : from;
          to = to == null || record.startTime > to ? record.startTime : to;
        }
        if (from == null || to == null) {
          return;
        }
        const filter = JSON.stringify([
          ...scopeFilter(traceIds),
          { type: 'string', column: 'name', operator: '=', value: TOOL_ROUND_NAME },
          { type: 'datetime', column: 'startTime', operator: '>=', value: from },
          { type: 'datetime', column: 'startTime', operator: '<=', value: to },
        ]);
        let unnamed = rounds.size;
        const budget: ByteBudget = { remaining: ROUND_BYTES_BUDGET };
        let cursor: string | undefined;
        const followed = new Set<string>();
        try {
          while (unnamed > 0 && budget.remaining > 0) {
            const params = new URLSearchParams({
              fields: ROUND_FIELDS,
              limit: String(ROUND_PAGE_SIZE),
              filter,
            });
            if (cursor) {
              params.set('cursor', cursor);
            }
            const page = await requestPage(destination, params, query, cursor != null, budget);
            for (const row of page.data) {
              const parsed = roundSchema.safeParse(row);
              const round = parsed.success ? rounds.get(parsed.data.id) : undefined;
              const tools = parsed.success ? toolRoundNames(parsed.data.input) : undefined;
              if (round != null && round.tools == null) {
                unnamed--;
              }
              if (round != null && tools != null) {
                round.tools = tools;
              }
            }
            const next = page.meta?.cursor || undefined;
            if (!next || page.data.length === 0 || followed.has(next)) {
              break;
            }
            followed.add(next);
            cursor = next;
          }
        } catch (error) {
          if (query.signal?.aborted) {
            throw error;
          }
          const reason = error instanceof TraceReadError ? error.code : 'unknown';
          logger.debug(`[traces] Tool rounds could not be named: ${reason}`);
        }
      }

      async function readFrom(
        destination: LangfuseScoreDestination,
        traceIds: string[],
        startCursor?: string,
      ) {
        const filter = JSON.stringify(scopeFilter(traceIds));
        const records: TTraceRecord[] = [];
        let cursor = startCursor;
        let remaining = query.settings.maxRecords;
        const followed = new Set<string>(startCursor != null ? [startCursor] : []);

        for (;;) {
          const params = new URLSearchParams({
            fields: LIST_FIELDS,
            limit: String(Math.min(MAX_PAGE_SIZE, remaining)),
            filter,
          });
          if (cursor) {
            params.set('cursor', cursor);
          }
          const page = await requestPage(destination, params, query, cursor != null);
          for (const { observation, messageId, origin } of parseRows(page.data, owners)) {
            records.push(toRecord(observation, messageId, origin));
          }
          remaining -= page.data.length;
          const next = page.meta?.cursor || undefined;
          if (!next || page.data.length === 0) {
            await nameToolRounds(destination, traceIds, records);
            return { records };
          }
          /** A cursor that repeats would hand every later page the same records. */
          if (followed.has(next)) {
            throw new TraceReadError('upstream_error', 'Langfuse repeated a page cursor');
          }
          followed.add(next);
          if (remaining <= 0) {
            await nameToolRounds(destination, traceIds, records);
            return { records, next };
          }
          cursor = next;
        }
      }

      /** A continuation that no longer matches the trace; the viewer reloads from the newest page. */
      const changed = () =>
        new TraceReadError('invalid_request', 'The trace changed since this page was loaded');
      const cursorAt = (message: SampledTraceMessage, kind?: TraceKind): TraceCursor => ({
        m: message.messageId,
        ...(message.orderKey != null ? { p: message.orderKey } : {}),
        ...(kind != null ? { k: kind === 'title' ? ('t' as const) : ('r' as const) } : {}),
      });
      const positionOf = (unit: Pick<TraceUnit, 'turn' | 'kind' | 'first'>): TraceCursor =>
        cursorAt(messages[unit.turn], unit.first ? undefined : unit.kind);

      let resume = continuation?.c != null ? continuation : undefined;
      let firstSourceId: string | undefined;
      for (;;) {
        if (turn < 0) {
          if (peek == null) {
            break;
          }
          ({ messages, peek } = await loadWindow(
            peek.orderKey != null
              ? { messageId: peek.messageId, orderKey: peek.orderKey }
              : undefined,
          ));
          owners = buildTraceOwners(messages);
          turn = messages.length - 1;
          startKind = undefined;
          continue;
        }
        const lowest = Math.max(0, turn - SEGMENT_TURNS + 1);
        await gatherEvidence(lowest, turn);
        const units = unitsFrom(turn, startKind, lowest);
        const segment = units.length > 0 ? segmentOf(units) : null;
        const after = segment != null ? units[segment.end] : units[1];
        const advance = () => {
          turn = after != null ? after.turn : lowest - 1;
          startKind = after != null && !after.first ? after.kind : undefined;
        };
        if (segment == null) {
          if (resume != null) {
            throw changed();
          }
          /** No readable project could hold this trace. */
          advance();
          continue;
        }

        const sourceId = sourceIdOf(segment.holder);
        const key = segmentKey(segment.traceIds);
        let cursor: string | undefined;
        if (resume != null) {
          if (resume.h !== key || !isSource(segment.holder, resume.s)) {
            throw changed();
          }
          cursor = resume.c;
          resume = undefined;
        }

        let result: Awaited<ReturnType<typeof readFrom>>;
        try {
          result = await readFrom(segment.holder, segment.traceIds, cursor);
        } catch (error) {
          /** A continuation stays on its project, so pages already shown are never replayed; a
           *  fresh read can move to another project shown to hold the same traces. */
          if (cursor != null || !isFailover(error)) {
            throw error;
          }
          failures.set(sourceId, error);
          continue;
        }

        firstSourceId ??= sourceId;
        if (result.next) {
          return {
            records: result.records,
            sourceId,
            nextCursor: encodeCursor({
              ...positionOf(units[0]),
              s: sourceId,
              c: result.next,
              h: key,
            }),
          };
        }
        if (result.records.length > 0) {
          let nextCursor: string | undefined;
          if (after != null) {
            nextCursor = encodeCursor(positionOf(after));
          } else if (lowest > 0) {
            nextCursor = encodeCursor(cursorAt(messages[lowest - 1]));
          } else if (peek != null) {
            nextCursor = encodeCursor(cursorAt(peek));
          }
          return { records: result.records, sourceId, ...(nextCursor ? { nextCursor } : {}) };
        }
        advance();
      }
      return { records: [], ...(firstSourceId ? { sourceId: firstSourceId } : {}) };
    },

    async getRecord(query) {
      if (!keyedByInternalId(query.appConfig)) {
        return null;
      }
      const { refs, sources } = await loadTurn(query, query.messageId);
      const pinned = sources.find((candidate) => isSource(candidate, query.sourceId));
      const candidates = pinned
        ? [pinned, ...sources.filter((entry) => entry !== pinned)]
        : sources;
      if (candidates.length === 0) {
        return null;
      }
      const owners = buildTraceOwners(refs.sampledMessages);
      const window = timeWindow(refs);
      const includeContent = query.settings.showInputOutput;
      const filter: LangfuseFilter = [
        { type: 'string', column: 'id', operator: '=', value: query.recordId },
        { type: 'string', column: 'sessionId', operator: '=', value: query.conversationId },
        ownerFilter(query),
        {
          type: 'stringOptions',
          column: 'traceId',
          operator: 'any of',
          value: refs.sampledMessages.flatMap(traceIdsOf),
        },
        ...startTimeFilter(window),
      ];
      const params = new URLSearchParams({
        fields: includeContent ? DETAIL_FIELDS : LIST_FIELDS,
        limit: '1',
        filter: JSON.stringify(filter),
      });
      /** A project that answers without the record proves nothing about the others, so each is asked in turn. */
      let lastFailure: TraceReadError | undefined;
      let match: OwnedObservation | undefined;
      for (const destination of candidates) {
        let page: z.infer<typeof pageSchema>;
        try {
          page = await requestPage(destination, params, query, false);
        } catch (error) {
          if (
            query.signal?.aborted ||
            !(error instanceof TraceReadError) ||
            !FAILOVER_CODES.has(error.code)
          ) {
            throw error;
          }
          lastFailure = error;
          continue;
        }
        match = parseRows(page.data, owners).find(
          ({ observation }) => observation.id === query.recordId,
        );
        if (match) {
          break;
        }
      }
      if (!match) {
        if (lastFailure != null) {
          throw lastFailure;
        }
        return null;
      }
      const { observation, messageId, origin } = match;
      const record = toRecord(observation, messageId, origin);
      if (!includeContent) {
        return { record, contentAvailable: false };
      }
      const maxLength = query.settings.maxContentLength;
      const input = toContent(observation.input, maxLength);
      const output = toContent(observation.output, maxLength);
      const metadata = toContent(observation.metadata, maxLength);
      const isModelCall = record.kind === 'generation';
      const prompt = isModelCall ? toTracePrompt(observation.input, maxLength) : undefined;
      const reply = isModelCall ? toTraceReply(observation.output, maxLength) : undefined;
      return {
        record,
        contentAvailable: true,
        ...(prompt ? { prompt } : {}),
        ...(reply ? { reply } : {}),
        ...(input ? { input } : {}),
        ...(output ? { output } : {}),
        ...(metadata ? { metadata } : {}),
      };
    },
  };
}
