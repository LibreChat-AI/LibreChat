import { logger } from '@librechat/data-schemas';
import { DeadLetterError, DEAD_LETTER_UNCLASSIFIED } from 'librechat-data-provider';
import type {
  DeadLetterDismissed,
  DeadLetterErrorCode,
  DeadLetterRequeued,
  DeadLetterPage,
  DeadLetter,
} from 'librechat-data-provider';
import type { AgentTriggerDeadLetter, AuditMetadata } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { DeadLetterOutcome, DeadLetters } from '~/agents/triggers/dead';
import type { AdminAuditEvent, RecordAuditEntry } from './audit';
import type { ServerRequest } from '~/types/http';
import { getSafeErrorMetadata } from '~/utils/errors';
import { createAdminAuditEmitter } from './audit';
import { parsePagination } from './pagination';

const OBJECT_ID = /^[a-fA-F0-9]{24}$/;
/**
 * An identifier, not prose. A source's event type and an upstream failure code are both
 * strings a caller chose, so anything that is not shaped like a label is withheld.
 */
const LABEL = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;

export interface AdminDeadLetterDeps {
  letters: DeadLetters;
  /** Audit emission for requeue and dismiss; fail-open unless `auditFailClosed`. */
  recordAuditEntry?: RecordAuditEntry;
  auditFailClosed?: boolean;
}

interface Action {
  action: 'dead_letter.requeued' | 'dead_letter.dismissed';
  run: (tenantId: string | undefined, id: string) => Promise<DeadLetterOutcome>;
  done: (id: string) => DeadLetterRequeued | DeadLetterDismissed;
  /** Code and wording when the delivery is no longer in a state the action applies to. */
  refused: { code: DeadLetterErrorCode; error: string };
  failed: string;
}

function label(value: string | undefined): string | undefined {
  return value != null && LABEL.test(value) ? value : undefined;
}

function view(letter: AgentTriggerDeadLetter): DeadLetter {
  const source = label(letter.source);
  const event = label(letter.event);
  const agentId = label(letter.agentId);
  return {
    id: letter.id,
    key: label(letter.deliveryKey) ?? '',
    userId: letter.user,
    ...(source != null && { source }),
    ...(event != null && { event }),
    ...(agentId != null && { agentId }),
    attempts: letter.attempts,
    requeues: letter.requeues,
    code: label(letter.code) ?? DEAD_LETTER_UNCLASSIFIED,
    requeueable: letter.requeueable,
    dismissable: letter.dismissable,
    createdAt: letter.createdAt.toISOString(),
    ...(letter.diedAt != null && { diedAt: letter.diedAt.toISOString() }),
    ...(letter.expiresAt != null && { expiresAt: letter.expiresAt.toISOString() }),
  };
}

/** What an audit entry keeps of the delivery: the same labels the list shows, nothing stored. */
function describe(letter: DeadLetter): AuditMetadata {
  return {
    key: letter.key,
    userId: letter.userId,
    source: letter.source ?? null,
    event: letter.event ?? null,
    agentId: letter.agentId ?? null,
    attempts: letter.attempts,
    requeues: letter.requeues,
    failure: letter.code,
  };
}

function refuse(res: Response, status: number, code: DeadLetterErrorCode, error: string): Response {
  return res.status(status).json({ error, code });
}

export function createAdminDeadLetterHandlers(deps: AdminDeadLetterDeps): {
  list: (req: ServerRequest, res: Response) => Promise<Response>;
  requeue: (req: ServerRequest, res: Response) => Promise<Response>;
  dismiss: (req: ServerRequest, res: Response) => Promise<Response>;
} {
  const { letters } = deps;
  const emitIntent = createAdminAuditEmitter({
    recordAuditEntry: deps.recordAuditEntry,
    failClosed: deps.auditFailClosed,
    logPrefix: '[adminDead]',
  });
  /** An outcome entry records what already happened, so an audit outage does not undo it. */
  const emitOutcome = createAdminAuditEmitter({
    recordAuditEntry: deps.recordAuditEntry,
    logPrefix: '[adminDead]',
  });

  async function list(req: ServerRequest, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    try {
      const { limit, offset } = parsePagination(req.query as { limit?: string; offset?: string });
      const page = await letters.list(req.user.tenantId, { limit, offset });
      const body: DeadLetterPage = {
        letters: page.letters.map(view),
        total: page.total,
        limit,
        offset,
      };
      return res.status(200).json(body);
    } catch (error) {
      logger.error('[adminDead] list error:', getSafeErrorMetadata(error));
      return res.status(500).json({ error: 'Failed to list dead letters' });
    }
  }

  /**
   * The intent is recorded before the write, so with fail-closed auditing a delivery is
   * never requeued or removed without an entry; the outcome follows as a second entry.
   * The store's own fenced write decides whether the action applies, not the read.
   */
  async function apply(req: ServerRequest, res: Response, action: Action): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const { id = '' } = req.params as { id?: string };
    if (!OBJECT_ID.test(id)) {
      return refuse(res, 400, DeadLetterError.invalid, 'Invalid dead letter id');
    }
    const tenantId = req.user.tenantId;
    const found = await letters.get(tenantId, id);
    if (found == null) {
      return refuse(res, 404, DeadLetterError.missing, 'Dead letter not found');
    }
    const letter = view(found);
    const entry: Omit<AdminAuditEvent, 'outcome'> = {
      action: action.action,
      severity: 'warning',
      target: { type: 'dead_letter', id, name: letter.key },
    };
    const metadata = describe(letter);
    try {
      await emitIntent(req, { ...entry, outcome: 'pending', metadata });
    } catch (error) {
      logger.error(
        `[adminDead] ${action.action} audit failed (fail-closed), nothing changed`,
        getSafeErrorMetadata(error),
      );
      return refuse(res, 500, DeadLetterError.audit, 'Failed to record audit entry');
    }
    let outcome: DeadLetterOutcome;
    try {
      outcome = await action.run(tenantId, id);
    } catch (error) {
      await emitOutcome(req, { ...entry, outcome: 'failure', metadata });
      throw error;
    }
    if (outcome.ok) {
      await emitOutcome(req, { ...entry, outcome: 'success', metadata });
      return res.status(200).json(action.done(id));
    }
    await emitOutcome(req, {
      ...entry,
      outcome: 'failure',
      metadata: { ...metadata, reason: outcome.error.code },
    });
    if (outcome.error.code === 'unavailable') {
      return refuse(res, 503, DeadLetterError.unavailable, 'Delivery queue is not available');
    }
    return refuse(res, 409, action.refused.code, action.refused.error);
  }

  async function act(req: ServerRequest, res: Response, action: Action): Promise<Response> {
    try {
      return await apply(req, res, action);
    } catch (error) {
      logger.error(`[adminDead] ${action.action} error:`, getSafeErrorMetadata(error));
      return res.status(500).json({ error: action.failed });
    }
  }

  const requeue = (req: ServerRequest, res: Response): Promise<Response> =>
    act(req, res, {
      action: 'dead_letter.requeued',
      run: letters.requeue,
      done: (id) => ({ id, requeued: true }),
      refused: { code: DeadLetterError.requeue, error: 'Dead letter cannot be requeued' },
      failed: 'Failed to requeue dead letter',
    });

  const dismiss = (req: ServerRequest, res: Response): Promise<Response> =>
    act(req, res, {
      action: 'dead_letter.dismissed',
      run: letters.dismiss,
      done: (id) => ({ id, dismissed: true }),
      refused: { code: DeadLetterError.dismiss, error: 'Dead letter cannot be dismissed' },
      failed: 'Failed to dismiss dead letter',
    });

  return { list, requeue, dismiss };
}
