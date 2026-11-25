import { logger } from '@librechat/data-schemas';
import type {
  AuditActorInput,
  RecordAuditEntryInput,
  RecordAuditEntryOptions,
} from '@librechat/data-schemas';
import type { ServerRequest } from '~/types/http';
import { getSafeErrorMetadata } from '~/utils/errors';
import { buildAuditContext } from './context';

/** The `recordAuditEntry` data-schemas method, as handler factories receive it. */
export type RecordAuditEntry = (
  input: RecordAuditEntryInput,
  options?: RecordAuditEntryOptions,
) => Promise<unknown>;

/** An audit entry minus the parts derived from the request (actor, context). */
export type AdminAuditEvent = Omit<RecordAuditEntryInput, 'actor' | 'context'>;

export type AdminAuditEmitter = (req: ServerRequest, event: AdminAuditEvent) => Promise<void>;

/** Audit target for a principal's override document. Records field paths and
 * sections only: override values can carry secrets. */
export function configTarget(
  principalType: string,
  principalId: string,
): { type: 'config'; id: string; name: string } {
  const key = `${principalType}:${principalId}`;
  return { type: 'config', id: key, name: key };
}

/**
 * Whether resource permission updates fail closed. Their audit entry is written
 * before the ACL changes, so a failed write rejects the request with nothing
 * applied. On unless the operator opts out with `AUDIT_LOG_FAIL_CLOSED=false`;
 * any other value keeps the secure default so a typo cannot silently disable it.
 */
export function isAuditFailClosed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AUDIT_LOG_FAIL_CLOSED !== 'false';
}

/** Resolves the authenticated caller as an audit actor; null when unauthenticated. */
export function getAuditActor(req: ServerRequest): AuditActorInput | null {
  const user = req.user;
  const userId = user?._id?.toString() ?? user?.id;
  if (!user || !userId) {
    return null;
  }
  return { type: 'user', id: userId, name: user.name || user.username || user.email || userId };
}

/**
 * Builds the audit writer shared by the admin handler factories. The caller is
 * the actor and the request supplies forensic context; `tenantId` defaults to
 * the caller's tenant unless the event sets the key (even to `undefined`, which
 * routes the entry to the platform chain).
 *
 * Fail-open by default: a failed write is logged and the already-persisted
 * mutation stands. With `failClosed`, the write error propagates so the
 * handler's catch turns it into a 5xx.
 */
export function createAdminAuditEmitter(options: {
  recordAuditEntry?: RecordAuditEntry;
  failClosed?: boolean;
  logPrefix: string;
}): AdminAuditEmitter {
  const { recordAuditEntry, failClosed, logPrefix } = options;
  return async function emitAdminAudit(req, event) {
    if (!recordAuditEntry) {
      return;
    }
    const actor = getAuditActor(req);
    if (!actor) {
      return;
    }
    const input: RecordAuditEntryInput = {
      ...event,
      actor,
      context: buildAuditContext(req),
      tenantId: 'tenantId' in event ? event.tenantId : req.user?.tenantId,
    };
    if (failClosed) {
      await recordAuditEntry(input, { failClosed: true });
      return;
    }
    try {
      await recordAuditEntry(input);
    } catch (err) {
      logger.error(
        `${logPrefix} audit write failed for ${event.action}`,
        getSafeErrorMetadata(err),
      );
    }
  };
}

/**
 * Writes an entry for a change no request initiated (startup sync, IdP sync).
 * Always fail-open: these paths run during startup or login and must not be
 * blocked by the audit store.
 */
export async function recordSystemAuditEntry(
  recordAuditEntry: RecordAuditEntry | undefined,
  input: RecordAuditEntryInput,
  logPrefix: string,
): Promise<void> {
  if (!recordAuditEntry) {
    return;
  }
  const logFailure = (err: unknown) =>
    logger.error(`${logPrefix} audit write failed for ${input.action}`, getSafeErrorMetadata(err));
  /** Dispatched without being awaited: login and startup must not wait on the audit store. */
  try {
    Promise.resolve(recordAuditEntry(input)).catch(logFailure);
  } catch (err) {
    logFailure(err);
  }
}

type PermissionMap = Record<string, Record<string, boolean | undefined> | undefined>;

/**
 * Lists the permission flags that differ between two role permission maps as
 * sorted `TYPE.FIELD=value` strings, so an audit entry records what changed
 * without storing the whole role document.
 */
export function diffRolePermissions(
  before: PermissionMap | undefined,
  after: PermissionMap | undefined,
): string[] {
  const changes: string[] = [];
  const types = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const type of types) {
    const prev = before?.[type] ?? {};
    const next = after?.[type] ?? {};
    const fields = new Set([...Object.keys(prev), ...Object.keys(next)]);
    for (const field of fields) {
      if (prev[field] !== next[field]) {
        changes.push(`${type}.${field}=${String(next[field])}`);
      }
    }
  }
  return changes.sort();
}
