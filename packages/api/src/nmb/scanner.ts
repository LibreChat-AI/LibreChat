import type {
  ScanResult,
  ScanContext,
  ReviewItem,
  NmbConfig,
  ReviewResult,
  ReviewOriginal,
  BlocklistEntry,
  ReviewActionBody,
} from './types';

export type ScannerErrorKind =
  | 'unavailable'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'bad_request'
  | 'bad_response';

/** Carries a kind and HTTP status only. Never the request or response body (it may hold sensitive text). */
export class ScannerError extends Error {
  readonly kind: ScannerErrorKind;
  readonly status?: number;
  constructor(kind: ScannerErrorKind, status?: number) {
    super(`scanner ${kind}${status != null ? ` (${status})` : ''}`);
    this.name = 'ScannerError';
    this.kind = kind;
    this.status = status;
  }
}

type FetchLike = typeof fetch;

const DECISIONS = new Set(['allow', 'mask', 'review', 'reject']);

function isScanResult(v: unknown): v is ScanResult {
  if (v == null || typeof v !== 'object') {
    return false;
  }
  const r = v as Record<string, unknown>;
  return (
    typeof r.decision === 'string' &&
    DECISIONS.has(r.decision) &&
    Array.isArray(r.findings) &&
    (r.sanitized_content == null || typeof r.sanitized_content === 'string')
  );
}

function isReviewItem(v: unknown): v is ReviewItem {
  if (v == null || typeof v !== 'object') {
    return false;
  }
  const r = v as Record<string, unknown>;
  return typeof r.id === 'string' && typeof r.user === 'string' && typeof r.status === 'string';
}

export interface ScannerClient {
  scanText(text: string, ctx: ScanContext): Promise<ScanResult>;
  scanFile(filename: string, data: Uint8Array, ctx: ScanContext): Promise<ScanResult>;
  unmask(scope: string, text: string, roles: string[]): Promise<{ text: string; restored: number }>;
  listReviews(query?: { status?: string; department?: string }): Promise<ReviewItem[]>;
  getReview(id: string): Promise<ReviewItem>;
  getOriginal(id: string, roles: string[]): Promise<ReviewOriginal>;
  getResult(id: string): Promise<ReviewResult>;
  approveMasked(id: string, body: ReviewActionBody): Promise<ScanResult>;
  reject(id: string, body: ReviewActionBody): Promise<ReviewItem>;
  getBlocklist(): Promise<BlocklistEntry[]>;
  addBlocklist(
    entries: { terms: string[]; regexes?: string[] },
    roles: string[],
  ): Promise<string[]>;
}

export function createScannerClient(
  config: Pick<NmbConfig, 'scannerUrl' | 'serviceKey' | 'timeoutMs'>,
  fetchImpl: FetchLike = fetch,
): ScannerClient {
  async function call(
    method: string,
    path: string,
    opts: { json?: unknown; form?: FormData; roles?: string[] } = {},
  ): Promise<unknown> {
    if (!config.scannerUrl || !config.serviceKey) {
      throw new ScannerError('unavailable');
    }
    const headers: Record<string, string> = { 'X-NMB-Service-Key': config.serviceKey };
    if (opts.roles) {
      headers['X-NMB-Roles'] = opts.roles.join(',');
    }
    let body: BodyInit | undefined;
    if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.json);
    } else if (opts.form) {
      body = opts.form;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(`${config.scannerUrl}${path}`, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
    } catch {
      throw new ScannerError('unavailable');
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401) {
      throw new ScannerError('unauthorized', 401);
    }
    if (res.status === 403) {
      throw new ScannerError('forbidden', 403);
    }
    if (res.status === 404) {
      throw new ScannerError('not_found', 404);
    }
    if (res.status === 409) {
      throw new ScannerError('conflict', 409);
    }
    if (res.status === 400 || res.status === 422) {
      throw new ScannerError('bad_request', res.status);
    }
    if (!res.ok) {
      throw new ScannerError('unavailable', res.status);
    }
    try {
      return await res.json();
    } catch {
      throw new ScannerError('bad_response', res.status);
    }
  }

  const scan = async (p: Promise<unknown>): Promise<ScanResult> => {
    const out = await p;
    if (!isScanResult(out)) {
      throw new ScannerError('bad_response');
    }
    return out;
  };

  return {
    scanText: (text, ctx) =>
      scan(
        call('POST', '/scan/text', {
          json: {
            text,
            conversation_id: ctx.scope,
            user: ctx.user,
            department: ctx.department ?? null,
            roles: ctx.roles,
          },
        }),
      ),

    scanFile: (filename, data, ctx) => {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(data)]), filename);
      form.append('conversation_id', ctx.scope);
      form.append('user', ctx.user);
      if (ctx.department) {
        form.append('department', ctx.department);
      }
      form.append('roles', ctx.roles.join(','));
      return scan(call('POST', '/scan/file', { form }));
    },

    async unmask(scope, text, roles) {
      const out = (await call('POST', '/unmask', {
        json: { conversation_id: scope, text, roles },
      })) as { text?: unknown; restored?: unknown };
      if (typeof out?.text !== 'string') {
        throw new ScannerError('bad_response');
      }
      return { text: out.text, restored: typeof out.restored === 'number' ? out.restored : 0 };
    },

    async listReviews(query = {}) {
      const params = new URLSearchParams();
      if (query.status) {
        params.set('status', query.status);
      }
      if (query.department) {
        params.set('department', query.department);
      }
      const qs = params.toString();
      const out = (await call('GET', `/reviews${qs ? `?${qs}` : ''}`)) as { items?: unknown };
      if (!Array.isArray(out?.items) || !out.items.every(isReviewItem)) {
        throw new ScannerError('bad_response');
      }
      return out.items as ReviewItem[];
    },

    async getReview(id) {
      const out = await call('GET', `/reviews/${encodeURIComponent(id)}`);
      if (!isReviewItem(out)) {
        throw new ScannerError('bad_response');
      }
      return out;
    },

    async getOriginal(id, roles) {
      const out = (await call('GET', `/reviews/${encodeURIComponent(id)}/original`, {
        roles,
      })) as ReviewOriginal;
      if (!out || !Array.isArray(out.segments)) {
        throw new ScannerError('bad_response');
      }
      return out;
    },

    async getResult(id) {
      const out = (await call('GET', `/reviews/${encodeURIComponent(id)}/result`)) as ReviewResult;
      if (!out || typeof out.status !== 'string') {
        throw new ScannerError('bad_response');
      }
      return out;
    },

    approveMasked: (id, body) =>
      scan(call('POST', `/reviews/${encodeURIComponent(id)}/approve-masked`, { json: body })),

    async reject(id, body) {
      const out = await call('POST', `/reviews/${encodeURIComponent(id)}/reject`, { json: body });
      if (!isReviewItem(out)) {
        throw new ScannerError('bad_response');
      }
      return out;
    },

    async getBlocklist() {
      const out = (await call('GET', '/blocklist')) as { entries?: unknown };
      if (!Array.isArray(out?.entries)) {
        throw new ScannerError('bad_response');
      }
      return out.entries as BlocklistEntry[];
    },

    async addBlocklist(entries, roles) {
      const out = (await call('POST', '/blocklist', { json: entries, roles })) as {
        added?: unknown;
      };
      if (!Array.isArray(out?.added)) {
        throw new ScannerError('bad_response');
      }
      return out.added.filter((x): x is string => typeof x === 'string');
    },
  };
}
