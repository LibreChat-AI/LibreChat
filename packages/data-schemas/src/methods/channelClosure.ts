import type { ManagedTarget } from '~/types/managed';
import { assertManagedCleanupTenant, managedTargetPredicate } from './managed';
import { includeManagedAllocations } from '~/utils/managed';
import { createAgentChannelModel } from '~/models/channel';

/** A page is selected before checking this snapshot, so no later generation can enter that page. */
export interface DisabledChannelGeneration {
  target: ManagedTarget<'channel'>;
  channelId: string;
  createdBy: string;
  revision: string;
  version: number;
}

export function disabledChannelGenerationFilter(
  mongoose: typeof import('mongoose'),
  generation: DisabledChannelGeneration,
): Record<string, unknown> {
  assertManagedCleanupTenant(generation.target.tenantId);
  if (
    generation.target.kind !== 'channel' ||
    ![generation.channelId, generation.createdBy, generation.revision].every(
      (value) => typeof value === 'string' && value.length > 0,
    ) ||
    !Number.isSafeInteger(generation.version) ||
    generation.version < 0
  )
    throw new TypeError('Invalid channel closure snapshot');
  return {
    ...managedTargetPredicate(mongoose, generation.target),
    '_managed.phase': 'published',
    channelId: generation.channelId,
    createdBy: generation.createdBy,
    status: 'disabled' as const,
    revision: generation.revision,
    __v: generation.version,
  };
}

export async function isDisabledChannelGeneration(
  mongoose: typeof import('mongoose'),
  generation: DisabledChannelGeneration,
): Promise<boolean> {
  return Boolean(
    await includeManagedAllocations(
      createAgentChannelModel(mongoose).exists(
        disabledChannelGenerationFilter(mongoose, generation),
      ),
    ).read('primary'),
  );
}
