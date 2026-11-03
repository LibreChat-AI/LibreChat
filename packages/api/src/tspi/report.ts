import type { TspiApproval, TspiPlanRecord, TspiViewer } from './types';

const REPORT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const APPROVED_STATUSES = new Set(['approved', 'validated']);
const REJECTED_STATUSES = new Set(['rejected']);

export type TspiReportErrorCode = 'invalid_id' | 'not_found' | 'forbidden' | 'unavailable';

export class TspiReportError extends Error {
  readonly code: TspiReportErrorCode;

  constructor(code: TspiReportErrorCode, message: string) {
    super(message);
    this.name = 'TspiReportError';
    this.code = code;
  }
}

export const isValidReportId = (reportId: string): boolean => REPORT_ID_PATTERN.test(reportId);

interface JsonObject {
  [key: string]: JsonValue;
}
type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

const isObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Tool output is the engine's JSON, possibly followed by other text blocks
 * (MCP text parts are joined with blank lines). Takes the first block that parses as an object.
 */
const parseFirstObject = (text: string): JsonObject | undefined => {
  const blocks = [text, ...text.split(/\n{2,}/)];
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed.startsWith('{')) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as JsonValue;
      if (isObject(parsed)) {
        return parsed;
      }
    } catch {
      continue;
    }
  }
  return undefined;
};

const errorText = (value: JsonObject): string | undefined => {
  const raw = value.error ?? value.detail ?? value.message;
  if (typeof raw === 'string') {
    return raw;
  }
  if (isObject(raw) && typeof raw.message === 'string') {
    return raw.message;
  }
  return undefined;
};

const classifyEngineError = (message: string): TspiReportError => {
  if (/not\s*found|no\s+such|unknown report/i.test(message)) {
    return new TspiReportError('not_found', message);
  }
  if (/forbidden|not\s+allowed|permission|unauthori[sz]ed|access denied|rbac/i.test(message)) {
    return new TspiReportError('forbidden', message);
  }
  return new TspiReportError('unavailable', message);
};

export const parsePlanRecord = (text: string): TspiPlanRecord => {
  const parsed = parseFirstObject(text);
  if (!parsed) {
    throw classifyEngineError(text.slice(0, 300) || 'Empty response from TSPI Brain');
  }
  if (typeof parsed.id !== 'string' || !isObject(parsed.payload)) {
    throw classifyEngineError(errorText(parsed) ?? 'TSPI Brain returned no treatment plan');
  }
  return parsed as object as TspiPlanRecord;
};

/** The viewer's role from the Brain's `/api/v2/me` (`v1_role`) or a whoami tool result. */
export const parseViewer = (text: string): TspiViewer => {
  const parsed = parseFirstObject(text);
  const identity = parsed && isObject(parsed.identity) ? parsed.identity : undefined;
  const candidates = [parsed?.v1_role, parsed?.role, identity?.role];
  const role = candidates.find((value): value is string => typeof value === 'string') ?? '';
  return { role: role.toLowerCase() };
};

export const getApproval = (plan: TspiPlanRecord): TspiApproval => {
  const status = (plan.status ?? '').toLowerCase();
  if (REJECTED_STATUSES.has(status)) {
    return 'rejected';
  }
  const decision = plan.payload.approved_by?.decision?.toLowerCase();
  if (APPROVED_STATUSES.has(status) && decision !== 'reject') {
    return 'approved';
  }
  return 'draft';
};

export const getCaseCode = (plan: TspiPlanRecord): string => plan.case_id ?? 'UNKNOWN-CASE';

const safeFilePart = (value: string): string => value.replace(/[^A-Za-z0-9_-]+/g, '-');

export const reportFileName = (plan: TspiPlanRecord): string => {
  const state = getApproval(plan) === 'approved' ? 'APPROVED' : 'DRAFT';
  return `TSPI_${safeFilePart(getCaseCode(plan))}_${safeFilePart(plan.id)}_${state}.pdf`;
};
