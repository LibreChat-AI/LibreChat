import { createCheckpointCatalog, checkpointStorageKey } from '@librechat/data-schemas';
import type { TCheckpointerConfig } from 'librechat-data-provider';
import type { CheckpointCatalog } from '@librechat/data-schemas';
import type { ResolvedCheckpointerConfig } from './config';
import { resolveCheckpointerConfig } from './config';

export { checkpointStorageKey, CHECKPOINT_STORAGE_COLLECTION } from '@librechat/data-schemas';
export type { CheckpointStorage, CheckpointStorageRecord } from '@librechat/data-schemas';
export const LIBRECHAT_CHECKPOINT_STORAGE_OWNER_KEY = '__librechat_checkpoint_storage_owner';

/** Descriptors locate stores; caller ownership and captured identities authorize deletion. */
export async function checkpointStorageConfigs(
  userId: string,
  tenantId: string | undefined,
  cfg?: TCheckpointerConfig,
  catalog: CheckpointCatalog = createCheckpointCatalog(),
): Promise<ResolvedCheckpointerConfig[]> {
  const configs = (await catalog.configurations(userId, tenantId)).map((storage) =>
    resolveCheckpointerConfig(storage),
  );
  configs.push(resolveCheckpointerConfig(cfg));
  return [...new Map(configs.map((storage) => [checkpointStorageKey(storage), storage])).values()];
}
