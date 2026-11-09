import { logger } from '@librechat/data-schemas';
import type { Request, RequestHandler, Response } from 'express';
import type { ScannerClient } from './scanner';
import type { NmbConfig, ReviewItem } from './types';
import { SCANNER_REVIEWER_ROLES, resolveIdentity } from './identity';
import { PLACEHOLDER_RE, REVIEW_ID_RE } from './chat';
import { parseChoices, type ChoiceError } from './blocklist';
import { isNmbMisconfigured } from './config';
import { ScannerError } from './scanner';

export type NmbAuditAction =
  | 'nmb_review.listed'
  | 'nmb_review.original_viewed'
  | 'nmb_review.approved'
  | 'nmb_review.rejected'
  | 'nmb_review.blocklist_updated'
  | 'nmb_review.denied';

export interface NmbAuditEntry {
  action: NmbAuditAction;
  actor: { type: 'user'; id: string; name: string };
  target: { type: string; id?: string };
  outcome: 'success' | 'failure' | 'denied';
  /** Counts, ids and flags only. Never prompt content, terms, or values. */
  metadata?: Record<string, string | number | boolean | null>;
}

export interface NmbHandlerDeps {
  config: NmbConfig;
  scanner: ScannerClient;
  /** LibreChat capability check (`SystemCapabilities.REVIEW_PROMPTS`). */
  isReviewer: (user: { id: string; role: string; tenantId?: string }) => Promise<boolean>;
  recordAudit: (entry: NmbAuditEntry) => Promise<unknown>;
  /** id -> display label, for the queue. */
  getUserLabels?: (ids: string[]) => Promise<Record<string, string>>;
}

type SessionUser = {
  id?: string;
  _id?: { toString(): string };
  role?: string;
  tenantId?: string;
  username?: string;
  email?: string;
  name?: string;
};

const STATUSES = new Set(['pending', 'approved-masked', 'rejected']);
const MAX_NOTE = 500;
const MAX_UNMASK_CHARS = 400_000;

const CHOICE_MESSAGES: Record<ChoiceError, string> = {
  invalid_shape: 'Invalid blocklist entry.',
  too_many: 'Too many blocklist entries.',
  too_short: 'Blocklist values must be at least 3 characters.',
  too_long: 'Blocklist value is too long.',
  control_chars: 'Blocklist value contains control characters.',
  invalid_regex: 'The pattern is not an allowed regular expression.',
  regex_matches_empty: 'The pattern matches empty text.',
  not_in_original: 'A blocklist value does not occur in the reviewed content.',
};

function toPublic(item: ReviewItem & { original_prompt_ref?: unknown; result_ref?: unknown }) {
  const { original_prompt_ref: _o, result_ref: _r, ...rest } = item;
  return rest;
}

export function createNmbHandlers(deps: NmbHandlerDeps) {
  const { config, scanner } = deps;

  const actor = (req: Request) => {
    const u = (req as Request & { user?: SessionUser }).user as SessionUser;
    const id = u.id ?? u._id?.toString() ?? '';
    return { type: 'user' as const, id, name: u.username ?? u.email ?? u.name ?? id };
  };

  async function audit(entry: NmbAuditEntry): Promise<void> {
    logger.info('[nmb][audit]', {
      action: entry.action,
      actor: entry.actor.id,
      target: entry.target.id ?? entry.target.type,
      outcome: entry.outcome,
      ...entry.metadata,
    });
    try {
      await deps.recordAudit(entry);
    } catch (error) {
      logger.error('[nmb][audit] failed to write audit entry', {
        action: entry.action,
        name: (error as Error)?.name,
      });
    }
  }

  function fail(res: Response, error: unknown): void {
    if (error instanceof ScannerError) {
      if (error.kind === 'not_found') {
        res.status(404).json({ message: 'Review not found' });
        return;
      }
      if (error.kind === 'conflict') {
        res.status(409).json({ message: 'Review is no longer pending' });
        return;
      }
      if (error.kind === 'bad_request') {
        res.status(400).json({ message: 'Invalid request' });
        return;
      }
    }
    logger.error('[nmb] reviewer request failed', {
      kind: error instanceof ScannerError ? error.kind : (error as Error)?.name,
    });
    res
      .status(503)
      .json({ type: 'nmb_unavailable', message: 'Data-protection service unavailable.' });
  }

  /** Authorises on the LibreChat capability, never on anything in the request. */
  const requireReviewer: RequestHandler = async (req, res, next) => {
    try {
      const u = (req as Request & { user?: SessionUser }).user;
      const id = u?.id ?? u?._id?.toString();
      if (!u || !id) {
        res.status(401).json({ message: 'Authentication required' });
        return;
      }
      if (!config.enabled) {
        res.status(404).json({ message: 'Not found' });
        return;
      }
      if (isNmbMisconfigured(config)) {
        res.status(503).json({ type: 'nmb_unavailable', message: 'Gateway is not configured.' });
        return;
      }
      const ok = await deps.isReviewer({ id, role: u.role ?? '', tenantId: u.tenantId });
      if (!ok) {
        await audit({
          action: 'nmb_review.denied',
          actor: actor(req),
          target: {
            type: 'nmb_review',
            id: typeof req.params?.id === 'string' ? req.params.id : undefined,
          },
          outcome: 'denied',
          metadata: { method: req.method },
        });
        res.status(403).json({ message: 'Forbidden' });
        return;
      }
      next();
    } catch (error) {
      logger.error('[nmb] reviewer check failed', { name: (error as Error)?.name });
      res
        .status(503)
        .json({ type: 'nmb_unavailable', message: 'Data-protection service unavailable.' });
    }
  };

  /** Loads a review the caller is allowed to act on, or answers 400/403/404. */
  async function loadForReviewer(req: Request, res: Response): Promise<ReviewItem | null> {
    const id = req.params.id;
    if (!REVIEW_ID_RE.test(id)) {
      res.status(400).json({ message: 'Invalid review id' });
      return null;
    }
    const me = actor(req);
    let item: ReviewItem;
    try {
      item = await scanner.getReview(id);
    } catch (error) {
      fail(res, error);
      return null;
    }
    if (item.user === me.id) {
      await audit({
        action: 'nmb_review.denied',
        actor: me,
        target: { type: 'nmb_review', id },
        outcome: 'denied',
        metadata: { reason: 'self_review' },
      });
      res.status(403).json({ message: 'You cannot review your own submission.' });
      return null;
    }
    return item;
  }

  return {
    requireReviewer,

    /** GET /me */
    me: (async (req, res) => {
      const u = (req as Request & { user?: SessionUser }).user;
      const id = u?.id ?? u?._id?.toString();
      if (!u || !id) {
        res.status(401).json({ message: 'Authentication required' });
        return;
      }
      let reviewer = false;
      if (config.enabled) {
        try {
          reviewer = await deps.isReviewer({ id, role: u.role ?? '', tenantId: u.tenantId });
        } catch {
          reviewer = false;
        }
      }
      res.json({ enabled: config.enabled, reviewer, regexBlocklist: config.regexBlocklist });
    }) as RequestHandler,

    /** GET /submissions/:id, owner only */
    mySubmission: (async (req, res) => {
      const id = req.params.id;
      const identity = resolveIdentity(req, config);
      if (!config.enabled || !identity || !REVIEW_ID_RE.test(id)) {
        res.status(404).json({ message: 'Not found' });
        return;
      }
      try {
        const item = await scanner.getReview(id);
        if (item.user !== identity.userId) {
          res.status(404).json({ message: 'Not found' });
          return;
        }
        res.json({
          id: item.id,
          source: item.source,
          status: item.status,
          created_at: item.created_at,
          resolved_at: item.resolved_at,
          reason: item.status === 'rejected' ? (item.reviewer_note ?? null) : null,
        });
      } catch (error) {
        fail(res, error);
      }
    }) as RequestHandler,

    /** POST /unmask: display-only restoration for the caller's own placeholders */
    unmask: (async (req, res) => {
      const identity = resolveIdentity(req, config);
      const text = (req.body as { text?: unknown } | undefined)?.text;
      if (!config.enabled || !identity) {
        res.status(404).json({ message: 'Not found' });
        return;
      }
      if (typeof text !== 'string' || text.length > MAX_UNMASK_CHARS) {
        res.status(400).json({ message: 'Invalid text' });
        return;
      }
      if (!new RegExp(PLACEHOLDER_RE.source).test(text)) {
        res.json({ text, restored: 0 });
        return;
      }
      try {
        const out = await scanner.unmask(identity.ctx.scope, text, identity.ctx.roles);
        res.json({ text: out.text, restored: out.restored });
      } catch (error) {
        if (error instanceof ScannerError && error.kind === 'forbidden') {
          res.json({ text, restored: 0 });
          return;
        }
        fail(res, error);
      }
    }) as RequestHandler,

    /** GET /reviews */
    listReviews: (async (req, res) => {
      const me = actor(req);
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      if (status && !STATUSES.has(status)) {
        res.status(400).json({ message: 'Invalid status' });
        return;
      }
      try {
        const items = (await scanner.listReviews({ status })).filter((i) => i.user !== me.id);
        const labels = (await deps.getUserLabels?.([...new Set(items.map((i) => i.user))])) ?? {};
        await audit({
          action: 'nmb_review.listed',
          actor: me,
          target: { type: 'nmb_review' },
          outcome: 'success',
          metadata: { count: items.length, status: status ?? 'all' },
        });
        res.json({
          items: items.map((i) => ({ ...toPublic(i), user_label: labels[i.user] ?? i.user })),
        });
      } catch (error) {
        fail(res, error);
      }
    }) as RequestHandler,

    /** GET /reviews/:id */
    getReview: (async (req, res) => {
      const item = await loadForReviewer(req, res);
      if (!item) {
        return;
      }
      const labels = (await deps.getUserLabels?.([item.user])) ?? {};
      res.json({ ...toPublic(item), user_label: labels[item.user] ?? item.user });
    }) as RequestHandler,

    /** GET /reviews/:id/original */
    getOriginal: (async (req, res) => {
      const item = await loadForReviewer(req, res);
      if (!item) {
        return;
      }
      if (item.decision_at_creation === 'reject') {
        res.status(404).json({ message: 'No original is retained for rejected submissions.' });
        return;
      }
      try {
        const original = await scanner.getOriginal(item.id, SCANNER_REVIEWER_ROLES);
        await audit({
          action: 'nmb_review.original_viewed',
          actor: actor(req),
          target: { type: 'nmb_review', id: item.id },
          outcome: 'success',
          metadata: { segments: original.segments.length },
        });
        res.setHeader('Cache-Control', 'no-store');
        res.json(original);
      } catch (error) {
        fail(res, error);
      }
    }) as RequestHandler,

    /** POST /reviews/:id/approve  { note?, additions?: [{value, mode}] } */
    approve: (async (req, res) => {
      const item = await loadForReviewer(req, res);
      if (!item) {
        return;
      }
      const me = actor(req);
      const body = (req.body ?? {}) as { note?: unknown; additions?: unknown };
      const note = typeof body.note === 'string' ? body.note.trim().slice(0, MAX_NOTE) : undefined;
      if (item.status !== 'pending') {
        res.status(409).json({ message: 'Review is no longer pending' });
        return;
      }
      if (item.decision_at_creation === 'reject') {
        res.status(409).json({ message: 'Rejected submissions cannot be approved.' });
        return;
      }
      try {
        const additions = body.additions ?? [];
        let literals: string[] = [];
        let regexes: string[] = [];
        if (Array.isArray(additions) && additions.length > 0) {
          const original = await scanner.getOriginal(item.id, SCANNER_REVIEWER_ROLES);
          const parsed = parseChoices(
            additions,
            original.segments.map((s) => s.text),
          );
          if (!parsed.ok) {
            res
              .status(400)
              .json({ type: 'nmb_invalid_blocklist', message: CHOICE_MESSAGES[parsed.error] });
            return;
          }
          if (parsed.regexes.length > 0 && !config.regexBlocklist) {
            res.status(422).json({
              type: 'nmb_regex_unsupported',
              message: 'The scanner does not support pattern entries.',
            });
            return;
          }
          literals = parsed.literals;
          regexes = parsed.regexes;
        } else if (!Array.isArray(additions)) {
          res.status(400).json({ message: 'Invalid additions' });
          return;
        }
        if (regexes.length > 0) {
          await scanner.addBlocklist({ terms: [], regexes }, SCANNER_REVIEWER_ROLES);
        }
        const result = await scanner.approveMasked(item.id, {
          reviewer: me.id,
          roles: SCANNER_REVIEWER_ROLES,
          note,
          blocklist_additions: literals,
        });
        await audit({
          action: 'nmb_review.approved',
          actor: me,
          target: { type: 'nmb_review', id: item.id },
          outcome: 'success',
          metadata: {
            findings: result.findings.length,
            literals_added: literals.length,
            patterns_added: regexes.length,
            has_note: Boolean(note),
          },
        });
        res.json({ id: item.id, status: 'approved-masked', findings: result.findings.length });
      } catch (error) {
        await audit({
          action: 'nmb_review.approved',
          actor: me,
          target: { type: 'nmb_review', id: item.id },
          outcome: 'failure',
        });
        fail(res, error);
      }
    }) as RequestHandler,

    /** POST /reviews/:id/reject  { reason } */
    reject: (async (req, res) => {
      const item = await loadForReviewer(req, res);
      if (!item) {
        return;
      }
      const me = actor(req);
      const reason = (req.body as { reason?: unknown } | undefined)?.reason;
      if (typeof reason !== 'string' || reason.trim().length < 3) {
        res.status(400).json({ type: 'nmb_reason_required', message: 'A reason is required.' });
        return;
      }
      if (item.status !== 'pending') {
        res.status(409).json({ message: 'Review is no longer pending' });
        return;
      }
      try {
        await scanner.reject(item.id, {
          reviewer: me.id,
          roles: SCANNER_REVIEWER_ROLES,
          note: reason.trim().slice(0, MAX_NOTE),
        });
        await audit({
          action: 'nmb_review.rejected',
          actor: me,
          target: { type: 'nmb_review', id: item.id },
          outcome: 'success',
          metadata: { reason_length: Math.min(reason.trim().length, MAX_NOTE) },
        });
        res.json({ id: item.id, status: 'rejected' });
      } catch (error) {
        await audit({
          action: 'nmb_review.rejected',
          actor: me,
          target: { type: 'nmb_review', id: item.id },
          outcome: 'failure',
        });
        fail(res, error);
      }
    }) as RequestHandler,

    /** GET /blocklist */
    getBlocklist: (async (req, res) => {
      try {
        const entries = await scanner.getBlocklist();
        await audit({
          action: 'nmb_review.listed',
          actor: actor(req),
          target: { type: 'nmb_blocklist' },
          outcome: 'success',
          metadata: { count: entries.length },
        });
        res.setHeader('Cache-Control', 'no-store');
        res.json({ entries });
      } catch (error) {
        fail(res, error);
      }
    }) as RequestHandler,

    /** POST /blocklist  { entries: [{value, mode}] } */
    addBlocklist: (async (req, res) => {
      const me = actor(req);
      const parsed = parseChoices((req.body as { entries?: unknown } | undefined)?.entries);
      if (!parsed.ok) {
        res
          .status(400)
          .json({ type: 'nmb_invalid_blocklist', message: CHOICE_MESSAGES[parsed.error] });
        return;
      }
      if (parsed.regexes.length > 0 && !config.regexBlocklist) {
        res.status(422).json({
          type: 'nmb_regex_unsupported',
          message: 'The scanner does not support pattern entries.',
        });
        return;
      }
      try {
        const added = await scanner.addBlocklist(
          { terms: parsed.literals, ...(parsed.regexes.length ? { regexes: parsed.regexes } : {}) },
          SCANNER_REVIEWER_ROLES,
        );
        await audit({
          action: 'nmb_review.blocklist_updated',
          actor: me,
          target: { type: 'nmb_blocklist' },
          outcome: 'success',
          metadata: {
            literals: parsed.literals.length,
            patterns: parsed.regexes.length,
            added: added.length,
          },
        });
        res.json({ added: added.length });
      } catch (error) {
        fail(res, error);
      }
    }) as RequestHandler,
  };
}
