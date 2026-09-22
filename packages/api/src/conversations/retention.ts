import { isAllDataRetention, isForcedTemporaryRetention } from 'librechat-data-provider';
import type { ConversationMethods } from '@librechat/data-schemas';
import type { ConversationWriteContext } from './save';

export type ForcedRetentionStore = Pick<ConversationMethods, 'stampForcedRetention'>;

export interface ForcedRetentionWrite {
  ctx: ConversationWriteContext;
  /** The stored owner of the written message; a write with none has nothing to re-stamp. */
  conversationId?: string | null;
  /** Stamps this message as well; omit when the caller already saved it through `saveMessage`. */
  messageId?: string;
}

/**
 * Restores forced-temporary retention after a write that bypasses it.
 *
 * `updateMessage`, feedback, and the artifact and branch routes touch rows without going through
 * the retention-aware save path, so under `retentionMode: "ephemeral"` a write inside a chat that
 * predates the setting would leave the message expiring while the conversation holding it stayed
 * permanent and visible. The store's retention-only write reuses a stored deadline, never upserts,
 * and never rewrites the conversation's message list.
 */
export async function applyForcedRetention(
  { stampForcedRetention }: ForcedRetentionStore,
  { ctx, conversationId, messageId }: ForcedRetentionWrite,
): Promise<void> {
  if (!conversationId || !isForcedTemporaryRetention(ctx.interfaceConfig?.retentionMode)) {
    return;
  }

  await stampForcedRetention(
    { userId: ctx.userId, interfaceConfig: ctx.interfaceConfig },
    { conversationId, messageIds: messageId == null ? [] : [messageId] },
  );
}

export interface ForcedTemporaryRequest {
  body?: { isTemporary?: boolean | string | null } | null;
  config?: { interfaceConfig?: ConversationWriteContext['interfaceConfig'] } | null;
}

/**
 * Marks a request temporary when the administrator forces it, so every reader of the request's
 * own flag (title eligibility, the title generators, resumable job state) treats a chat the
 * server will hide exactly like a temporary chat the user chose, whatever the client sent.
 */
export function applyForcedTemporaryRequest(req: ForcedTemporaryRequest): void {
  if (req.body == null || !isForcedTemporaryRetention(req.config?.interfaceConfig?.retentionMode)) {
    return;
  }
  req.body.isTemporary = true;
}

export interface ImportRetentionFields {
  isTemporary?: boolean;
  expiredAt?: Date;
}

export interface ImportRetentionDependencies {
  createChatExpirationDate: (
    interfaceConfig?: ConversationWriteContext['interfaceConfig'],
    isTemporary?: boolean,
  ) => Date;
  createFallbackRetentionDate: () => Date;
  logger?: { error: (message: string, error?: unknown) => void };
}

/**
 * The retention fields an imported, forked or duplicated record is stored with.
 *
 * Empty unless the mode expires all data. Under `ephemeral` the records are additionally
 * marked temporary, which is what keeps an imported chat out of history and out of the
 * bookmark counts; a deadline that cannot be computed falls back rather than storing a
 * record with no expiration at all.
 *
 * A fork or duplicate passes `sourceIsTemporary` so a copy of a chat the user marked
 * temporary keeps that classification under `all` instead of being published into history
 * with the longer general deadline. A fresh import has no source and stays visible.
 */
export function resolveImportRetentionFields(
  interfaceConfig: ConversationWriteContext['interfaceConfig'],
  { createChatExpirationDate, createFallbackRetentionDate, logger }: ImportRetentionDependencies,
  { sourceIsTemporary }: { sourceIsTemporary?: boolean } = {},
): ImportRetentionFields {
  if (!isAllDataRetention(interfaceConfig?.retentionMode)) {
    return {};
  }

  const isTemporary =
    isForcedTemporaryRetention(interfaceConfig?.retentionMode) || sourceIsTemporary === true;
  try {
    return { isTemporary, expiredAt: createChatExpirationDate(interfaceConfig, isTemporary) };
  } catch (error) {
    logger?.error('[resolveImportRetentionFields] Error creating import expiration date:', error);
    return { isTemporary, expiredAt: createFallbackRetentionDate() };
  }
}

/**
 * The bookmark tags an import should count.
 *
 * Forced-temporary records are excluded from every bookmark-filtered conversation query and
 * are removed by TTL without a matching decrement, so counting their tags would leave
 * permanent phantom totals behind chats a user can never reach.
 */
export function resolveImportTagCounts(
  retention: ImportRetentionFields,
  tags: readonly string[],
): string[] {
  return retention.isTemporary === true ? [] : [...tags];
}
