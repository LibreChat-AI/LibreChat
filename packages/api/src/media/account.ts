import type {
  MediaAccountingMethods,
  MediaMethods,
  MediaOwnerScope,
} from '@librechat/data-schemas';
import { MediaServiceError } from './errors';

export interface MediaAccountDeletion {
  scope: MediaOwnerScope;
  token: string;
}
export type MediaAccountDeletionRepository = Pick<
  MediaMethods,
  | 'hasMediaActivation'
  | 'prepareMediaAccountDeletion'
  | 'cancelMediaAccountDeletion'
  | 'completeMediaAccountDeletion'
> &
  Pick<MediaAccountingMethods, 'hasMediaAccountingObligations'>;
type DeletionLog = (message: string, error?: Error) => void;

/**
 * Called under the existing account deletion fence, before deleting any account data. A
 * deployment that never activated media holds no media records, so it has nothing to fence.
 */
export async function prepareMediaAccountDeletion({
  repository,
  scope,
  token,
}: {
  repository: MediaAccountDeletionRepository;
  scope: MediaOwnerScope;
  token: string;
}): Promise<MediaAccountDeletion | undefined> {
  if (!(await repository.hasMediaActivation())) {
    return undefined;
  }
  const session = { scope, token };
  try {
    if (
      !(await repository.prepareMediaAccountDeletion(session)) ||
      (await repository.hasMediaAccountingObligations(scope))
    ) {
      throw new MediaServiceError(
        'not_ready',
        409,
        'Media work or accounting must finish before account deletion.',
      );
    }
    return session;
  } catch (error) {
    await repository.cancelMediaAccountDeletion(session);
    throw error;
  }
}

/**
 * Runs after the User is removed, so it must not fail the deletion: media account reconciliation
 * completes a prepared owner whose User no longer exists.
 */
export async function completeMediaAccountDeletion({
  repository,
  session,
  log,
}: {
  repository: MediaAccountDeletionRepository;
  session?: MediaAccountDeletion;
  log: DeletionLog;
}): Promise<void> {
  if (!session) {
    return;
  }
  try {
    await repository.completeMediaAccountDeletion(session);
  } catch (error) {
    log(
      '[media] Account deletion cleanup deferred to reconciliation.',
      error instanceof Error ? error : new Error('Media account deletion cleanup failed.'),
    );
  }
}

export async function cancelMediaAccountDeletion({
  repository,
  session,
  userDeleted,
  log,
}: {
  repository: MediaAccountDeletionRepository;
  session?: MediaAccountDeletion;
  userDeleted: boolean;
  log: DeletionLog;
}): Promise<void> {
  if (!session || userDeleted) {
    return;
  }
  try {
    await repository.cancelMediaAccountDeletion(session);
  } catch (error) {
    log(
      '[media] Account deletion fence could not be released.',
      error instanceof Error
        ? error
        : new Error('Media account deletion fence could not be released.'),
    );
  }
}
