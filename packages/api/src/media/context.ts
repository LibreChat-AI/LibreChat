import type {
  FileStorage,
  MediaConfig,
  MediaSubmissionReceipt,
  MediaImportReceipt,
} from 'librechat-data-provider';
import type { AppConfig, MediaOwnerScope } from '@librechat/data-schemas';
import type { Request } from 'express';
import type { SafeUserInput } from '~/utils/env';
import { MediaServiceError } from './errors';

export interface MediaContext {
  scope: MediaOwnerScope;
  appConfig: AppConfig;
  config: MediaConfig;
  /** Internal origin-chat retention flag; never accepted from Studio commands. */
  temporary?: boolean;
  publicationExpiresAt?: string;
  canUse: boolean;
  canCreate: boolean;
  storageSources?: readonly FileStorage[];
  storageReady?: boolean;
  /** Loaded identity fields reused by provider configuration and title generation. */
  user?: SafeUserInput & { id: string };
  /** HTTP admission callbacks are omitted for worker reconciliation. */
  admitGeneration?(): Promise<void>;
  admitImport?(): Promise<void>;
  submissionReplay?: { clientRequestId: string; receipt: MediaSubmissionReceipt | null };
  importReplay?: { clientRequestId: string; receipt: MediaImportReceipt | null };
}

/** Reuse the authenticated chat's existing deadline; a resumed tool must not extend retention. */
export function mediaToolContext(
  request: Request,
  context: MediaContext,
  now: number,
): MediaContext {
  const origin = request as Request & {
    _agentEventBindingRetention?: { isTemporary?: boolean; expiredAt?: Date | string };
    resolvedConversation?: { isTemporary?: boolean; expiredAt?: Date | string };
  };
  const temporary =
    origin._agentEventBindingRetention?.isTemporary ??
    origin.resolvedConversation?.isTemporary ??
    request.body?.isTemporary === true;
  const deadline =
    origin._agentEventBindingRetention?.expiredAt ?? origin.resolvedConversation?.expiredAt;
  if (deadline == null) return { ...context, temporary };
  const expiresAt = new Date(deadline).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= now)
    throw new MediaServiceError('not_ready', 410, 'The originating chat has expired.');
  return { ...context, temporary, publicationExpiresAt: new Date(expiresAt).toISOString() };
}
