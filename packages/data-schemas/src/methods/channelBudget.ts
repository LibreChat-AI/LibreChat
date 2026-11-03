import { MAX_DURABLE_PENDING_TARGETS } from 'librechat-data-provider';
import type { AgentChannelRecord } from '~/models/channel';
import {
  MAX_BSON_DOCUMENT_BYTES,
  BSON_WRITE_HEADROOM_BYTES,
  ManagedDocumentTooLargeError,
} from '~/utils/bson';
import { MANAGED_REGISTRATION_BYTES } from '~/types/managed';
import { createAgentChannelModel } from '~/models/channel';

/** Leave room for the full validated registry ceiling, including later config increases. */
export function assertChannelBudget<Current extends object>(
  mongoose: typeof import('mongoose'),
  current: Current,
  fields: Partial<AgentChannelRecord> = {},
): void {
  const candidate = new (createAgentChannelModel(mongoose))({ ...current, ...fields });
  candidate.set('pending', undefined);
  candidate.set('pendingCount', Number.MAX_SAFE_INTEGER);
  candidate.set('retentionEpoch', Number.MAX_SAFE_INTEGER);
  candidate.set('updatedAt', new Date());
  const measured = {
    ...candidate.toObject({
      transform: false,
      minimize: false,
      getters: false,
      virtuals: false,
      depopulate: true,
    }),
    // Updates preserve fields outside their explicit $set, including nested extensions.
    ...current,
    ...Object.fromEntries(Object.keys(fields).map((field) => [field, candidate.get(field)])),
    pendingCount: Number.MAX_SAFE_INTEGER,
    retentionEpoch: Number.MAX_SAFE_INTEGER,
    updatedAt: candidate.get('updatedAt'),
  };
  Reflect.deleteProperty(measured, 'pending');
  const reserved = MAX_DURABLE_PENDING_TARGETS * MANAGED_REGISTRATION_BYTES + 16;
  if (
    mongoose.mongo.BSON.calculateObjectSize(measured) + reserved + BSON_WRITE_HEADROOM_BYTES >
    MAX_BSON_DOCUMENT_BYTES
  )
    throw new ManagedDocumentTooLargeError();
}
