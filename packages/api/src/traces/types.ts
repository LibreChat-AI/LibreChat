import type {
  TTracePage,
  TTraceAvailability,
  TTraceErrorCode,
  TTraceRecordDetail,
  TResolvedTraceViewerConfig,
} from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';

/** One authorized read: the caller has already proven `userId` owns `conversationId`. */
export interface TraceQuery {
  userId: string;
  /** The requester's tenant; `undefined` is the tenantless scope, never "any tenant". */
  tenantId?: string;
  conversationId: string;
  appConfig?: AppConfig;
  settings: TResolvedTraceViewerConfig;
  /** Aborts when the client goes away, so an abandoned read stops spending backend quota. */
  signal?: AbortSignal;
}

/**
 * The seam between LibreChat's trace routes and a tracing backend. An
 * implementation maps its storage into the provider-neutral records, so adding
 * a backend is a new reader rather than a branch in the routes or the client.
 */
export interface TraceReader {
  /**
   * Whether a trace may exist. Runs alongside the ownership check, so it may
   * read only the requesting user's own data and never the backend's records.
   */
  isAvailable(query: TraceQuery): Promise<TTraceAvailability>;
  listRecords(query: TraceQuery & { cursor?: string }): Promise<TTracePage>;
  /** `null` when the record is absent or outside the conversation's traces. */
  /** `messageId` is the turn the list attributed the record to, so only that turn's traces are
   *  looked up; `sourceId` pins the read to the page that listed the record when still readable. */
  getRecord(
    query: TraceQuery & { recordId: string; messageId: string; sourceId?: string },
  ): Promise<TTraceRecordDetail | null>;
}

export class TraceReadError extends Error {
  readonly code: TTraceErrorCode;

  constructor(code: TTraceErrorCode, message: string) {
    super(message);
    this.name = 'TraceReadError';
    this.code = code;
  }
}
