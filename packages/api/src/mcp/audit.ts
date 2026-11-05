import { MCP_USER_INPUT_FIELDS } from 'librechat-data-provider';
import type { AdminAuditEmitter, RecordAuditEntry } from '~/admin/audit';
import { createAdminAuditEmitter } from '~/admin/audit';
import { MCPCommittedWriteError } from '~/mcp/errors';

type MCPServerAction = 'mcp_server.created' | 'mcp_server.updated' | 'mcp_server.deleted';
type ServerConfigLike = Record<string, unknown> | null | undefined;

export interface MCPServerAuditEvent {
  action: MCPServerAction;
  serverName: string;
  /** Config before the change; omitted on create. */
  previous?: ServerConfigLike;
  /** Config after the change; omitted on delete. */
  next?: ServerConfigLike;
  /** The write committed but refreshing the read caches failed afterwards. */
  postWriteFailed?: boolean;
  /** The write found nothing to change (for example a delete that lost a race), so no entry is recorded. */
  noop?: boolean;
}

/** JSON with object keys sorted, so entry order never reads as a change. */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b)))
      : val,
  );
}

/**
 * Lists the user-input fields that differ between two server configs. Only
 * field names are returned, so headers, env values and credentials never reach
 * the audit trail.
 */
export function diffMCPServerFields(previous: ServerConfigLike, next: ServerConfigLike): string[] {
  const changed: string[] = [];
  for (const field of MCP_USER_INPUT_FIELDS) {
    const before = previous?.[field];
    const after = next?.[field];
    if (before === undefined && after === undefined) {
      continue;
    }
    if (stableStringify(before) !== stableStringify(after)) {
      changed.push(field);
    }
  }
  return changed.sort();
}

/** Optional OAuth fields the data layer also keeps when an update omits them alongside the secret. */
const OMITTED_OAUTH_BINDING_FIELDS = [
  'token_endpoint_auth_methods_supported',
  'revocation_endpoint',
  'revocation_endpoint_auth_methods_supported',
] as const;

/**
 * An update that omits `oauth.client_secret` keeps the stored one, so the secret
 * is carried onto the incoming config before comparing; otherwise a title-only
 * edit would be recorded as an oauth change.
 */
function withPreservedOAuthSecret(
  previous: ServerConfigLike,
  next: ServerConfigLike,
): ServerConfigLike {
  const before = previous?.oauth as Record<string, unknown> | undefined;
  const after = next?.oauth as Record<string, unknown> | undefined;
  if (!next || !before?.client_secret || !after || after.client_secret) {
    return next;
  }
  const carried = { ...after, client_secret: before.client_secret } as Record<string, unknown>;
  for (const field of OMITTED_OAUTH_BINDING_FIELDS) {
    if (carried[field] === undefined && before[field] !== undefined) {
      carried[field] = before[field];
    }
  }
  return { ...next, oauth: carried };
}

function serverTitle(config: ServerConfigLike): string | undefined {
  const title = config?.title;
  return typeof title === 'string' && title.length > 0 ? title : undefined;
}

/**
 * Builds the MCP server audit writer. Fail-open unless `failClosed` is set,
 * matching the admin handler factories.
 */
export function createMCPServerAuditor(options: {
  recordAuditEntry?: RecordAuditEntry;
  failClosed?: boolean;
}): (
  req: Parameters<AdminAuditEmitter>[0],
  event: MCPServerAuditEvent,
  afterCommit?: () => Promise<void>,
) => Promise<void> {
  const emit = createAdminAuditEmitter({ ...options, logPrefix: '[mcpServers]' });
  async function record(
    req: Parameters<AdminAuditEmitter>[0],
    event: MCPServerAuditEvent,
  ): Promise<void> {
    const { action, serverName, previous, next, postWriteFailed } = event;
    const name = serverTitle(next) ?? serverTitle(previous);
    const before = action === 'mcp_server.created' ? undefined : previous;
    const changed =
      action === 'mcp_server.deleted'
        ? []
        : diffMCPServerFields(before, withPreservedOAuthSecret(before, next));
    await emit(req, {
      action,
      severity: action === 'mcp_server.deleted' ? 'warning' : 'info',
      target: { type: 'mcp_server', id: serverName, ...(name ? { name } : {}) },
      metadata: {
        source: 'DB',
        ...(changed.length > 0 ? { fields: changed.join(',') } : {}),
        ...(postWriteFailed ? { postWrite: 'failed' } : {}),
      },
    });
  }

  /**
   * `afterCommit` carries the security-critical steps that follow a committed
   * change (connection fences); they run first, and the audit write follows even
   * when they throw, so audit latency never delays them and a failure never
   * drops the entry.
   */
  return async function auditMCPServer(req, event, afterCommit) {
    let afterCommitFailed = false;
    try {
      await afterCommit?.();
    } catch (error) {
      afterCommitFailed = true;
      throw error;
    } finally {
      if (!event.noop) {
        await record(req, {
          ...event,
          postWriteFailed: event.postWriteFailed || afterCommitFailed,
        });
      }
    }
  };
}

/**
 * Runs a registry write and reports what it persisted. When the write committed but the
 * cache refresh after it failed, the committed result is still returned together with that
 * failure, so the caller can audit the change and then surface the error.
 */
export async function settleMCPCommit<T>(
  write: () => Promise<T>,
): Promise<{ committed: T | undefined; postWriteError?: MCPCommittedWriteError<T> }> {
  try {
    return { committed: await write() };
  } catch (error) {
    if (error instanceof MCPCommittedWriteError) {
      return {
        committed: error.committed as T | undefined,
        postWriteError: error as MCPCommittedWriteError<T>,
      };
    }
    throw error;
  }
}
