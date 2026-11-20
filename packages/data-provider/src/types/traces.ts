/**
 * Provider-neutral conversation trace contract. The server maps whatever its
 * tracing backend stores into these shapes, so the client never sees a
 * backend's field names, credentials, URL structure or API version.
 */

export type TTraceRecordKind = 'agent' | 'generation' | 'tool' | 'span' | 'event';

/**
 * What a record did in the run, in the application's own terms, so a client never reads a tracing
 * backend's span names. Absent on a record the backend did not describe: it is listed by `kind`.
 * `run` is a whole agent run, `agent` the named agent inside it, `plumbing` a wrapper that only
 * frames a model call, `model` a model call of the response, `tools` one round of tool calls, and
 * the label roles are the model calls that wrote the activity labels the chat shows while a
 * response runs.
 */
export type TTraceRecordRole =
  | 'run'
  | 'agent'
  | 'plumbing'
  | 'model'
  | 'tools'
  | 'stepLabel'
  | 'reasoningLabel'
  | 'phaseLabel';

/** `running` marks a record with no end time yet; it has a start but no duration. */
export type TTraceStatus = 'ok' | 'warning' | 'error' | 'running';

export type TTraceUsage = {
  input?: number;
  output?: number;
  total?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
};

export type TTraceRecord = {
  id: string;
  traceId: string;
  /** The response message whose turn produced this record; groups records into turns. */
  messageId: string;
  /** `null` for a root; may name a record that is not loaded (or does not exist). */
  parentId: string | null;
  kind: TTraceRecordKind;
  role?: TTraceRecordRole;
  /** The saved agent a `role: 'agent'` record ran; absent for an agent that was never saved. */
  agentId?: string;
  /** The tools a `role: 'tools'` round called, in order, as the backend recorded the round. */
  tools?: string[];
  name: string;
  model?: string;
  /** ISO-8601 timestamps. */
  startTime: string;
  endTime?: string;
  /** First streamed token of a generation; splits its span into TTFT and decoding. */
  completionStartTime?: string;
  status: TTraceStatus;
  statusMessage?: string;
  usage?: TTraceUsage;
  /** Total cost in USD, when the backend priced the record. */
  cost?: number;
  /** Set on records of the turn's title generation; absent on the response run itself. */
  origin?: 'title';
};

export type TTraceErrorCode =
  | 'disabled'
  | 'not_found'
  | 'invalid_request'
  | 'rate_limited'
  | 'timeout'
  | 'unauthorized'
  | 'unsupported'
  | 'upstream_error';

export type TTraceErrorResponse = {
  error: string;
  errorCode: TTraceErrorCode;
};

export type TTraceAvailability = {
  available: boolean;
  /** Set when the backend cannot decide yet; ask again after this many milliseconds. */
  retryAfterMs?: number;
};

export type TTracePageParams = {
  conversationId: string;
  cursor?: string;
};

export type TTraceRecordParams = {
  conversationId: string;
  recordId: string;
  /** The turn the list attributed the record to; its traces are what authorize the read. */
  messageId: string;
  /** The `sourceId` of the page that listed the record, so its detail reads the same project. */
  sourceId?: string;
};

/**
 * Newest turns first; `nextCursor` loads the next older page. A turn's records
 * may continue on the following page, and their order within a turn is not
 * defined, so a client groups records by turn and orders them by time.
 */
export type TTracePage = {
  records: TTraceRecord[];
  nextCursor?: string;
  /** Opaque identity of the backend project that served the page. */
  sourceId?: string;
};

export type TTraceContent = {
  value: string;
  truncated: boolean;
};

export type TTraceMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export type TTraceToolCall = {
  name: string;
  args?: TTraceContent;
};

/** One message of a model call's conversation, each bounded on its own so a long one hides no other. */
export type TTraceMessage = {
  role: TTraceMessageRole;
  text?: TTraceContent;
  /** The tool a `tool` message answers for. */
  toolName?: string;
  /** The tools an `assistant` message asked for. */
  toolCalls?: TTraceToolCall[];
  /** Parts that are not text (an image, a file), by their type. */
  attachments?: string[];
};

/**
 * What a model call was given, as a conversation. A long one keeps its system
 * message and its newest messages, which are what the call answered, and
 * `omitted` counts the older ones left out between them.
 */
export type TTracePrompt = {
  messages: TTraceMessage[];
  /** Every message the call was given, listed or not. */
  total: number;
  omitted: number;
  /** Names of the tools the model could call. */
  tools?: string[];
};

export type TTraceRecordDetail = {
  record: TTraceRecord;
  /** False when the deployment withholds input, output and metadata. */
  contentAvailable: boolean;
  /** Set when the input is a conversation the backend could read as one; `input` stays the raw form. */
  prompt?: TTracePrompt;
  /** Set when the output is a message the backend could read as one; `output` stays the raw form. */
  reply?: TTraceMessage;
  input?: TTraceContent;
  output?: TTraceContent;
  metadata?: TTraceContent;
};

export const TRACE_CURSOR_MAX_LENGTH = 4096;
export const TRACE_SOURCE_ID_MAX_LENGTH = 128;
export const TRACE_RECORD_ID_MAX_LENGTH = 256;
