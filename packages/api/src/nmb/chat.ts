import { logger } from '@librechat/data-schemas';
import { NMB_MASK_NOTE, stripNmbMaskNote } from 'librechat-data-provider';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { GatewayIdentity } from './identity';
import type { ScannerClient } from './scanner';
import type { NmbConfig } from './types';
import { screenText, type Screened } from './screen';
import { isNmbMisconfigured } from './config';
import { resolveIdentity } from './identity';

/** The sentinel the client submits after a review is approved. The server swaps in the approved content. */
export const RELEASE_RE = /^\s*\[\[nmb:release:(rev_[0-9a-f]{12})\]\]\s*$/;
export const PLACEHOLDER_RE = /<[A-Z][A-Z_]*_\d{3,}>/;
export const REVIEW_ID_RE = /^rev_[0-9a-f]{12}$/;
/** Cleared uploads are always renamed to this suffix by the upload gate. */
export const CLEARED_SUFFIX = '.masked.md';

export const MASK_NOTE = NMB_MASK_NOTE;

export type NmbErrorType =
  | 'nmb_review_pending'
  | 'nmb_rejected'
  | 'nmb_unavailable'
  | 'nmb_file_not_cleared'
  | 'nmb_forbidden';

const MESSAGES: Record<NmbErrorType, string> = {
  nmb_review_pending:
    'Your message contains content that needs review before it can be sent. It has not been sent to the AI.',
  nmb_rejected: 'Your message was not sent because it cannot be shared under the bank data policy.',
  nmb_unavailable:
    'The data-protection check is unavailable, so your message was not sent. Please try again later.',
  nmb_file_not_cleared:
    'An attached file was not cleared by the data-protection check, so the message was not sent.',
  nmb_forbidden: 'This action is not permitted.',
};

const STATUS: Record<NmbErrorType, number> = {
  nmb_review_pending: 423,
  nmb_rejected: 422,
  nmb_unavailable: 503,
  nmb_file_not_cleared: 422,
  nmb_forbidden: 403,
};

export function sendNmbError(
  res: Response,
  type: NmbErrorType,
  extra: { reviewId?: string; reason?: string } = {},
): void {
  res.status(STATUS[type]).json({
    type,
    message: MESSAGES[type],
    ...(extra.reviewId ? { review_id: extra.reviewId } : {}),
    ...(extra.reason ? { reason: extra.reason } : {}),
  });
}

/**
 * Route classification relative to the `/chat` mount. Only POSTs that carry model-bound user
 * content are screened; abort / steer-cancel / steer-arm and all reads are control traffic.
 */
export type ChatRouteKind = 'text' | 'resume' | null;

export function classifyChatRoute(method: string, path: string): ChatRouteKind {
  if (method !== 'POST') {
    return null;
  }
  const parts = path.split('?', 1)[0].split('/').filter(Boolean);
  if (parts.length === 0) {
    return 'text';
  }
  const [first, second] = parts;
  if (first === 'resume' && parts.length === 1) {
    return 'resume';
  }
  if (first === 'steer') {
    return parts.length === 1 || (parts.length === 2 && second === 'deliver') ? 'text' : null;
  }
  if (first === 'queued-turns') {
    return parts.length === 1 || (parts.length === 2 && second === 'v2') ? 'text' : null;
  }
  if (first === 'abort') {
    return null;
  }
  /** `/:endpoint` (ephemeral agents) */
  return parts.length === 1 ? 'text' : null;
}

export interface NmbChatDeps {
  config: NmbConfig;
  scanner: ScannerClient;
  /** Looks up the stored file records for `fileIds` owned by `userId`. Optional; skips the check when absent. */
  getFiles?: (
    fileIds: string[],
    userId: string,
  ) => Promise<Array<{ file_id: string; filename?: string }>>;
}

type Target = { get: () => string; set: (v: string) => void; isMessageText: boolean };

function collectTargets(body: Record<string, unknown>, skipText = false): Target[] {
  const targets: Target[] = [];
  const addField = (key: string, isMessageText: boolean) => {
    if (typeof body[key] === 'string' && (body[key] as string).trim().length > 0) {
      targets.push({
        get: () => stripNmbMaskNote(body[key] as string),
        set: (v) => {
          body[key] = v;
        },
        isMessageText,
      });
    }
  };
  if (!skipText) {
    addField('text', true);
  }
  /** User-set custom instructions are sent to the model as a system prompt. */
  addField('promptPrefix', false);
  const edited = body.editedContent;
  if (Array.isArray(edited)) {
    for (const part of edited) {
      if (part == null || typeof part !== 'object') {
        continue;
      }
      const p = part as Record<string, unknown>;
      if (typeof p.text === 'string' && p.text.trim()) {
        targets.push({
          get: () => p.text as string,
          set: (v) => {
            p.text = v;
          },
          isMessageText: false,
        });
      } else if (
        p.text != null &&
        typeof p.text === 'object' &&
        typeof (p.text as Record<string, unknown>).value === 'string'
      ) {
        const inner = p.text as Record<string, unknown>;
        targets.push({
          get: () => inner.value as string,
          set: (v) => {
            inner.value = v;
          },
          isMessageText: false,
        });
      }
    }
  }
  return targets;
}

function collectAnswerTargets(answers: unknown): Target[] | 'unsupported' {
  const targets: Target[] = [];
  if (answers == null) {
    return targets;
  }
  if (typeof answers !== 'object' || Array.isArray(answers)) {
    return 'unsupported';
  }
  const rec = answers as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    const v = rec[key];
    if (typeof v === 'string') {
      if (v.trim()) {
        targets.push({
          get: () => rec[key] as string,
          set: (nv) => {
            rec[key] = nv;
          },
          isMessageText: false,
        });
      }
    } else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
      (v as string[]).forEach((item, i) => {
        if (item.trim()) {
          targets.push({
            get: () => (rec[key] as string[])[i],
            set: (nv) => {
              (rec[key] as string[])[i] = nv;
            },
            isMessageText: false,
          });
        }
      });
    } else if (v != null && typeof v !== 'number' && typeof v !== 'boolean') {
      return 'unsupported';
    }
  }
  return targets;
}

async function release(
  scanner: ScannerClient,
  identity: GatewayIdentity,
  reviewId: string,
): Promise<{ ok: true; content: string } | { ok: false; reason: 'not_ready' | 'unavailable' }> {
  try {
    const review = await scanner.getReview(reviewId);
    if (
      review.user !== identity.userId ||
      review.source !== 'text' ||
      review.status !== 'approved-masked'
    ) {
      return { ok: false, reason: 'not_ready' };
    }
    const result = await scanner.getResult(reviewId);
    if (result.status !== 'approved-masked' || typeof result.sanitized_content !== 'string') {
      return { ok: false, reason: 'not_ready' };
    }
    return { ok: true, content: result.sanitized_content };
  } catch (error) {
    const kind = (error as { kind?: string })?.kind;
    if (kind === 'not_found' || kind === 'forbidden') {
      return { ok: false, reason: 'not_ready' };
    }
    logger.error('[nmb] release lookup failed; failing closed', { kind: kind ?? 'unknown' });
    return { ok: false, reason: 'unavailable' };
  }
}

type Blocked = Exclude<Screened, { kind: 'pass' }>;

function firstBlocked(results: Screened[]): Blocked | undefined {
  for (const r of results) {
    if (r.kind !== 'pass') {
      return r;
    }
  }
  return undefined;
}

function refuse(res: Response, screened: Blocked): void {
  if (screened.kind === 'hold') {
    sendNmbError(res, 'nmb_review_pending', { reviewId: screened.reviewId });
  } else if (screened.kind === 'reject') {
    sendNmbError(res, 'nmb_rejected', { reason: screened.reason });
  } else {
    sendNmbError(res, 'nmb_unavailable');
  }
}

/**
 * Express middleware screening every model-bound user text before it reaches the controller,
 * the message store, moderation or the provider. Fails closed.
 */
export function createNmbChatGateway(deps: NmbChatDeps): RequestHandler {
  const { config, scanner } = deps;
  return async function nmbChatGateway(req: Request, res: Response, next: NextFunction) {
    if (!config.enabled) {
      next();
      return;
    }
    const kind = classifyChatRoute(req.method, req.path);
    if (kind == null) {
      next();
      return;
    }
    try {
      if (isNmbMisconfigured(config)) {
        logger.error('[nmb] gateway enabled but scanner URL or service key is missing');
        sendNmbError(res, 'nmb_unavailable');
        return;
      }
      const identity = resolveIdentity(req, config);
      if (!identity) {
        res.status(401).json({ message: 'Authentication required' });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;

      /* Attachments must have come through the gated upload route. */
      if (kind === 'text' && Array.isArray(body.files) && body.files.length > 0) {
        const ids = body.files
          .map((f) => (f as { file_id?: unknown })?.file_id)
          .filter((id): id is string => typeof id === 'string');
        if (ids.length !== body.files.length) {
          sendNmbError(res, 'nmb_file_not_cleared');
          return;
        }
        if (deps.getFiles) {
          const found = await deps.getFiles(ids, identity.userId);
          const cleared = new Set(
            found.filter((f) => f.filename?.endsWith(CLEARED_SUFFIX)).map((f) => f.file_id),
          );
          if (!ids.every((id) => cleared.has(id))) {
            sendNmbError(res, 'nmb_file_not_cleared');
            return;
          }
        }
      }

      /* Release of an approved hold: the client names the review, the server supplies the content. */
      if (kind === 'text' && typeof body.text === 'string') {
        const m = RELEASE_RE.exec(body.text);
        if (m) {
          const out = await release(scanner, identity, m[1]);
          if (!out.ok) {
            sendNmbError(res, out.reason === 'unavailable' ? 'nmb_unavailable' : 'nmb_forbidden');
            return;
          }
          body.text =
            config.maskNote && PLACEHOLDER_RE.test(out.content)
              ? out.content + MASK_NOTE
              : out.content;
          const rest = collectTargets(body, true);
          const results = await Promise.all(
            rest.map((t) => screenText(scanner, t.get(), identity.ctx)),
          );
          const blocked = firstBlocked(results);
          if (blocked) {
            refuse(res, blocked);
            return;
          }
          rest.forEach((t, i) => {
            const r = results[i];
            if (r.kind === 'pass') {
              t.set(r.content);
            }
          });
          next();
          return;
        }
      }

      let targets: Target[];
      if (kind === 'resume') {
        const t = collectAnswerTargets(body.answers);
        if (t === 'unsupported') {
          sendNmbError(res, 'nmb_unavailable');
          return;
        }
        targets = t;
      } else {
        targets = collectTargets(body);
      }
      if (targets.length === 0) {
        next();
        return;
      }

      const results = await Promise.all(
        targets.map((t) => screenText(scanner, t.get(), identity.ctx)),
      );
      const blocked = firstBlocked(results);
      if (blocked) {
        refuse(res, blocked);
        return;
      }
      let anyMasked = false;
      targets.forEach((t, i) => {
        const r = results[i];
        if (r.kind !== 'pass') {
          return;
        }
        anyMasked = anyMasked || r.masked;
        const carriesTokens = r.masked || PLACEHOLDER_RE.test(r.content);
        t.set(
          carriesTokens && t.isMessageText && config.maskNote ? r.content + MASK_NOTE : r.content,
        );
      });
      if (anyMasked) {
        res.setHeader('X-NMB-Masked', '1');
      }
      next();
    } catch (error) {
      logger.error('[nmb] gateway error; failing closed', {
        name: (error as Error)?.name ?? 'unknown',
      });
      sendNmbError(res, 'nmb_unavailable');
    }
  };
}
