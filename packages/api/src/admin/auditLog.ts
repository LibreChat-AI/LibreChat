import {
  logger,
  AUDIT_ACTIONS,
  AUDIT_CATEGORIES,
  AUDIT_OUTCOMES,
  AUDIT_SEVERITIES,
  AUDIT_ACTOR_TYPES,
  MAX_AUDIT_EXPORT_ROWS,
  MAX_AUDIT_LOG_LIMIT,
  MAX_AUDIT_VERIFY_ROWS,
} from '@librechat/data-schemas';
import type {
  AdminAuditLogEntry,
  AuditAction,
  AuditActorType,
  AuditCategory,
  AuditChainVerification,
  AuditLogFilters,
  AuditLogPage,
  AuditOutcome,
  AuditSeverity,
} from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';

const FORMULA_PREFIX = /^[=+\-@\t\r]/;
/** UTF-8 BOM, written first so Excel recognizes the encoding on import. Spelled
 * as a Unicode escape so readers can see the constant in editors that hide the
 * zero-width glyph. */
const CSV_BOM = '﻿';

const VALID_ACTIONS = new Set<string>(AUDIT_ACTIONS);
const VALID_CATEGORIES = new Set<string>(AUDIT_CATEGORIES);
const VALID_OUTCOMES = new Set<string>(AUDIT_OUTCOMES);
const VALID_SEVERITIES = new Set<string>(AUDIT_SEVERITIES);
const VALID_ACTOR_TYPES = new Set<string>(AUDIT_ACTOR_TYPES);

/**
 * Accepts `YYYY-MM-DD` (interpreted as UTC by the downstream Date parse) or a
 * full ISO 8601 / RFC 3339 timestamp that includes either `Z` or a `±HH:MM`
 * offset. Local-time strings without a zone are rejected so every input maps to
 * an unambiguous instant.
 */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const OBJECT_ID_RE = /^[a-fA-F0-9]{24}$/;

export interface AdminAuditLogDeps {
  listAuditLogPage: (
    tenantId: string | undefined,
    filters: AuditLogFilters,
  ) => Promise<AuditLogPage>;
  findAuditLogEntry: (
    tenantId: string | undefined,
    id: string,
  ) => Promise<AdminAuditLogEntry | null>;
  streamAuditLogEntries: (
    tenantId: string | undefined,
    filters: Omit<AuditLogFilters, 'offset' | 'limit' | 'cursor'>,
    onEntry: (entry: AdminAuditLogEntry) => void | Promise<void>,
    options?: { isCancelled?: () => boolean; maxRows?: number },
  ) => Promise<{ count: number; truncated: boolean }>;
  verifyAuditChain: (
    tenantId: string | undefined,
    options?: { isCancelled?: () => boolean; maxRows?: number },
  ) => Promise<AuditChainVerification>;
}

interface CallerContext {
  userId: string;
  role: string;
  tenantId?: string;
}

function resolveCaller(req: ServerRequest): CallerContext | null {
  const user = req.user;
  if (!user) return null;
  const userId = user._id?.toString() ?? user.id;
  if (!userId || !user.role) return null;
  return { userId, role: user.role, tenantId: user.tenantId };
}

function asStringArray(v: unknown): string[] | undefined {
  if (v == null) return undefined;
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string') return [v];
  return undefined;
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Parses a repeatable enum filter (`?action=a&action=b`) against a whitelist. */
function parseEnumArray<T extends string>(
  raw: unknown,
  valid: Set<string>,
  label: string,
): ParseResult<T[] | undefined> {
  const arr = asStringArray(raw);
  if (!arr || arr.length === 0) return { ok: true, value: undefined };
  const invalid = arr.find((a) => !valid.has(a));
  if (invalid != null) return { ok: false, error: `Unknown ${label}: ${invalid}` };
  return { ok: true, value: arr as T[] };
}

function parseEnum<T extends string>(
  raw: unknown,
  valid: Set<string>,
  label: string,
): ParseResult<T | undefined> {
  if (raw == null || raw === '') return { ok: true, value: undefined };
  if (typeof raw !== 'string') return { ok: false, error: `${label} must be a string` };
  if (!valid.has(raw)) return { ok: false, error: `Unknown ${label}: ${raw}` };
  return { ok: true, value: raw as T };
}

/**
 * Parses a filter date. `boundary` controls how a bare `YYYY-MM-DD` is widened:
 * `start` leaves it at 00:00:00.000Z (default for `from`), `end` snaps it to
 * 23:59:59.999Z so `to=2025-01-15` includes everything on January 15 instead of
 * cutting off at midnight. Full ISO timestamps are honored exactly.
 */
function parseIsoDate(
  raw: unknown,
  boundary: 'start' | 'end' = 'start',
): ParseResult<Date | undefined> {
  if (raw == null || raw === '') return { ok: true, value: undefined };
  if (typeof raw !== 'string') return { ok: false, error: 'Date must be a string' };
  if (!ISO_DATE_RE.test(raw)) return { ok: false, error: 'Date must be ISO 8601' };
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return { ok: false, error: 'Invalid date' };
  /**
   * `new Date('2025-02-31')` (and the timestamp form `2025-02-31T00:00:00Z`)
   * silently normalizes to March 3 rather than throwing. Validate the literal
   * calendar tokens — independent of any time/zone, so legitimate offset shifts
   * are unaffected — so an out-of-range day is rejected instead of quietly
   * shifting the queried window.
   */
  const [year, month, day] = raw.slice(0, 10).split('-').map(Number);
  const lastDayOfMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > lastDayOfMonth) {
    return { ok: false, error: 'Invalid date' };
  }
  if (boundary === 'end' && DATE_ONLY_RE.test(raw)) {
    d.setUTCHours(23, 59, 59, 999);
  }
  return { ok: true, value: d };
}

function parseIntInRange(
  raw: unknown,
  label: string,
  min: number,
  max?: number,
): ParseResult<number | undefined> {
  if (raw == null || raw === '') return { ok: true, value: undefined };
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n)) return { ok: false, error: `${label} must be a number` };
  if (n < min) return { ok: false, error: `${label} must be >= ${min}` };
  if (max != null && n > max) return { ok: false, error: `${label} must be <= ${max}` };
  return { ok: true, value: Math.floor(n) };
}

function pickString(raw: unknown, maxLen = 256): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLen);
}

function escapeCsvCell(value: string): string {
  if (value === '') return '';
  const guarded = FORMULA_PREFIX.test(value) ? `'${value}` : value;
  if (/[",\n\r]/.test(guarded)) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }
  return guarded;
}

function stringifyMetaValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

const CSV_COLUMNS: ReadonlyArray<{ label: string; value: (e: AdminAuditLogEntry) => string }> = [
  { label: 'Timestamp', value: (e) => e.timestamp },
  { label: 'Category', value: (e) => e.category },
  { label: 'Action', value: (e) => e.action },
  { label: 'Outcome', value: (e) => e.outcome },
  { label: 'Severity', value: (e) => e.severity },
  { label: 'Actor type', value: (e) => e.actor.type },
  { label: 'Actor', value: (e) => e.actor.name },
  { label: 'Actor ID', value: (e) => e.actor.id ?? '' },
  { label: 'Target type', value: (e) => e.target.type },
  { label: 'Target', value: (e) => e.target.name ?? '' },
  { label: 'Target ID', value: (e) => e.target.id ?? '' },
  { label: 'Capability', value: (e) => stringifyMetaValue(e.metadata?.capability) },
  { label: 'Details', value: (e) => (e.metadata ? JSON.stringify(e.metadata) : '') },
  { label: 'IP', value: (e) => e.context?.ip ?? '' },
  { label: 'Request ID', value: (e) => e.context?.requestId ?? '' },
  { label: 'Seq', value: (e) => String(e.integrity.seq) },
  { label: 'Hash', value: (e) => e.integrity.hash },
];

function formatCsvHeader(): string {
  return CSV_COLUMNS.map((c) => escapeCsvCell(c.label)).join(',');
}

function formatCsvRow(entry: AdminAuditLogEntry): string {
  return CSV_COLUMNS.map((c) => escapeCsvCell(c.value(entry))).join(',');
}

type ParsedFilters = Omit<AuditLogFilters, 'offset' | 'limit' | 'cursor'>;

interface AuditLogQuery {
  search?: string;
  category?: string | string[];
  action?: string | string[];
  outcome?: string | string[];
  severity?: string | string[];
  actorType?: string;
  actorQuery?: string;
  targetType?: string;
  targetQuery?: string;
  capability?: string;
  from?: string;
  to?: string;
  limit?: string;
  offset?: string;
  cursor?: string;
}

function parseFilters(query: AuditLogQuery): ParseResult<ParsedFilters> {
  const from = parseIsoDate(query.from, 'start');
  if (!from.ok) return { ok: false, error: `from: ${from.error}` };
  const to = parseIsoDate(query.to, 'end');
  if (!to.ok) return { ok: false, error: `to: ${to.error}` };
  if (from.value && to.value && from.value > to.value) {
    return { ok: false, error: '`from` must be earlier than `to`' };
  }

  const category = parseEnumArray<AuditCategory>(query.category, VALID_CATEGORIES, 'category');
  if (!category.ok) return { ok: false, error: category.error };
  const action = parseEnumArray<AuditAction>(query.action, VALID_ACTIONS, 'action');
  if (!action.ok) return { ok: false, error: action.error };
  const outcome = parseEnumArray<AuditOutcome>(query.outcome, VALID_OUTCOMES, 'outcome');
  if (!outcome.ok) return { ok: false, error: outcome.error };
  const severity = parseEnumArray<AuditSeverity>(query.severity, VALID_SEVERITIES, 'severity');
  if (!severity.ok) return { ok: false, error: severity.error };
  const actorType = parseEnum<AuditActorType>(query.actorType, VALID_ACTOR_TYPES, 'actorType');
  if (!actorType.ok) return { ok: false, error: actorType.error };

  return {
    ok: true,
    value: {
      search: pickString(query.search, 200),
      category: category.value,
      action: action.value,
      outcome: outcome.value,
      severity: severity.value,
      actorType: actorType.value,
      actorQuery: pickString(query.actorQuery, 128),
      targetType: pickString(query.targetType, 128),
      targetQuery: pickString(query.targetQuery, 128),
      capability: pickString(query.capability, 256),
      from: from.value,
      to: to.value,
    },
  };
}

export function createAdminAuditLogHandlers(deps: AdminAuditLogDeps): {
  listAuditLog: (req: ServerRequest, res: Response) => Promise<Response>;
  getAuditLogEntry: (req: ServerRequest, res: Response) => Promise<Response>;
  verifyAuditLog: (req: ServerRequest, res: Response) => Promise<Response>;
  exportAuditLogCsv: (req: ServerRequest, res: Response) => Promise<Response | void>;
} {
  const { listAuditLogPage, findAuditLogEntry, streamAuditLogEntries, verifyAuditChain } = deps;

  async function listAuditLogHandler(req: ServerRequest, res: Response) {
    try {
      const caller = resolveCaller(req);
      if (!caller) return res.status(401).json({ error: 'Authentication required' });

      const query = req.query as AuditLogQuery;
      const filters = parseFilters(query);
      if (!filters.ok) return res.status(400).json({ error: filters.error });

      const limit = parseIntInRange(query.limit, 'limit', 1, MAX_AUDIT_LOG_LIMIT);
      if (!limit.ok) return res.status(400).json({ error: limit.error });
      const offset = parseIntInRange(query.offset, 'offset', 0);
      if (!offset.ok) return res.status(400).json({ error: offset.error });
      const cursor = parseIntInRange(query.cursor, 'cursor', 1);
      if (!cursor.ok) return res.status(400).json({ error: cursor.error });

      const page = await listAuditLogPage(caller.tenantId, {
        ...filters.value,
        offset: offset.value,
        limit: limit.value,
        cursor: cursor.value,
      });

      return res.status(200).json(page);
    } catch (err) {
      logger.error('[adminAuditLog] list error:', err);
      return res.status(500).json({ error: 'Failed to fetch audit log' });
    }
  }

  async function getAuditLogEntryHandler(req: ServerRequest, res: Response) {
    try {
      const caller = resolveCaller(req);
      if (!caller) return res.status(401).json({ error: 'Authentication required' });

      const { id } = req.params as { id?: string };
      if (!id || !OBJECT_ID_RE.test(id)) {
        return res.status(400).json({ error: 'Invalid id' });
      }

      const entry = await findAuditLogEntry(caller.tenantId, id);
      if (!entry) return res.status(404).json({ error: 'Not found' });
      return res.status(200).json({ entry });
    } catch (err) {
      logger.error('[adminAuditLog] get error:', err);
      return res.status(500).json({ error: 'Failed to fetch audit log entry' });
    }
  }

  async function verifyAuditLogHandler(req: ServerRequest, res: Response) {
    try {
      const caller = resolveCaller(req);
      if (!caller) return res.status(401).json({ error: 'Authentication required' });

      let clientAborted = false;
      const markAborted = () => {
        clientAborted = true;
      };
      res.once('close', markAborted);
      req.once('aborted', markAborted);

      try {
        const result = await verifyAuditChain(caller.tenantId, {
          isCancelled: () => clientAborted,
          maxRows: MAX_AUDIT_VERIFY_ROWS,
        });

        if (clientAborted) return res;
        return res.status(200).json(result);
      } finally {
        res.removeListener('close', markAborted);
        req.removeListener('aborted', markAborted);
      }
    } catch (err) {
      logger.error('[adminAuditLog] verify error:', err);
      return res.status(500).json({ error: 'Failed to verify audit log integrity' });
    }
  }

  async function exportAuditLogCsvHandler(req: ServerRequest, res: Response) {
    try {
      const caller = resolveCaller(req);
      if (!caller) return res.status(401).json({ error: 'Authentication required' });

      const filters = parseFilters(req.query as AuditLogQuery);
      if (!filters.ok) return res.status(400).json({ error: filters.error });

      const filenameStamp = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="audit-log-${filenameStamp}.csv"`);
      res.setHeader('Cache-Control', 'no-store');

      /**
       * The socket-`close` listener is the canonical signal — it fires on client
       * TCP RST as well as on graceful end. `req.aborted` (deprecated) is kept as
       * a belt-and-braces fallback for Node versions that emit it before the
       * response sees `close`.
       */
      let clientAborted = false;
      const markAborted = () => {
        clientAborted = true;
      };
      res.once('close', markAborted);
      req.once('aborted', markAborted);
      const isCancelled = () => clientAborted;

      /**
       * Wait for `drain` when the socket buffer is full so we never queue an
       * unbounded amount of CSV in Node memory for slow consumers. Race against
       * `close` so a destroyed socket can't strand the handler on a `drain` that
       * will never fire.
       */
      const writeChunk = (chunk: string): Promise<void> => {
        if (clientAborted) return Promise.resolve();
        if (res.write(chunk)) return Promise.resolve();
        return new Promise<void>((resolve) => {
          const onDrain = () => {
            res.removeListener('close', onClose);
            resolve();
          };
          const onClose = () => {
            res.removeListener('drain', onDrain);
            resolve();
          };
          res.once('drain', onDrain);
          res.once('close', onClose);
        });
      };

      await writeChunk(CSV_BOM);
      await writeChunk(formatCsvHeader());
      await writeChunk('\r\n');

      const { truncated } = await streamAuditLogEntries(
        caller.tenantId,
        filters.value,
        async (entry) => {
          if (clientAborted) return;
          await writeChunk(formatCsvRow(entry));
          await writeChunk('\r\n');
        },
        { isCancelled, maxRows: MAX_AUDIT_EXPORT_ROWS },
      );

      res.removeListener('close', markAborted);
      req.removeListener('aborted', markAborted);
      if (!clientAborted) {
        /**
         * `truncated` is true only when rows existed beyond the cap (an exact-cap
         * match is reported as complete). Surfacing this is a compliance
         * requirement — a silently truncated export reads as a complete record.
         * Emit an explicit trailing marker and log it; callers should narrow the
         * date range for the full set.
         */
        if (truncated) {
          logger.warn('[adminAuditLog] CSV export truncated at row cap', {
            maxRows: MAX_AUDIT_EXPORT_ROWS,
          });
          await writeChunk(
            `# TRUNCATED: export capped at ${MAX_AUDIT_EXPORT_ROWS} rows — narrow the from/to range to export the complete set\r\n`,
          );
        }
        res.end();
      }
    } catch (err) {
      logger.error('[adminAuditLog] export error:', err);
      if (!res.headersSent) {
        return res.status(500).json({ error: 'Failed to export audit log' });
      }
      res.end();
    }
  }

  return {
    listAuditLog: listAuditLogHandler,
    getAuditLogEntry: getAuditLogEntryHandler,
    verifyAuditLog: verifyAuditLogHandler,
    exportAuditLogCsv: exportAuditLogCsvHandler,
  };
}
