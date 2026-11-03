import { checkpointerSchema } from 'librechat-data-provider';
import type { ResponseReference, ResponseCheckpointExecution } from '~/models/response';
import { checkpointOwnerNamespacePrefix } from '~/utils/checkpoint';
import { createStoredResponseModel } from '~/models/response';
import { activeExpirationFilter } from '~/utils/retention';
import { responseRootFilter } from './responseRoot';

const uuidPattern = /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;

/** These callbacks bind one in-process saver to its exact root, provider and writer.
 * A fresh writer cannot adopt a crashed writer's unresolved command marker. */
export function createResponseCheckpointStorage(
  mongoose: typeof import('mongoose'),
  reference: ResponseReference,
  input: Omit<ResponseCheckpointExecution, 'state' | 'erased'>,
): { open: () => Promise<boolean>; settle: () => Promise<boolean> } {
  const checkpoint = {
    generationCreatedAt: input.generationCreatedAt,
    providerExecutionId: input.providerExecutionId,
    ...(input.ownerId ? { ownerId: input.ownerId } : {}),
    writerId: input.writerId,
    namespace: input.namespace,
    configJSON: input.configJSON,
  };
  const physical = responseRootFilter(mongoose, reference);
  const prefix = checkpointOwnerNamespacePrefix(reference.userId, reference.tenantId);
  if (
    !Number.isSafeInteger(checkpoint.generationCreatedAt) ||
    checkpoint.generationCreatedAt < 1 ||
    typeof checkpoint.providerExecutionId !== 'string' ||
    !checkpoint.providerExecutionId ||
    checkpoint.providerExecutionId.length > 128 ||
    (checkpoint.ownerId != null &&
      (typeof checkpoint.ownerId !== 'string' ||
        !checkpoint.ownerId ||
        checkpoint.ownerId.length > 128)) ||
    !uuidPattern.test(checkpoint.writerId) ||
    !checkpoint.namespace.startsWith(prefix) ||
    !uuidPattern.test(checkpoint.namespace.slice(prefix.length)) ||
    !checkpoint.configJSON
  )
    throw new TypeError('Invalid Response checkpoint writer');
  let parsed: unknown;
  try {
    parsed = JSON.parse(checkpoint.configJSON);
  } catch {
    throw new TypeError('Invalid Response checkpoint storage settings');
  }
  const config = checkpointerSchema.safeParse(parsed);
  if (
    !config.success ||
    config.data?.type !== 'mongo' ||
    !config.data.checkpointCollectionName ||
    !config.data.checkpointWritesCollectionName
  )
    throw new TypeError('Invalid Response checkpoint storage settings');
  const model = createStoredResponseModel(mongoose);
  const provider = {
    generationCreatedAt: checkpoint.generationCreatedAt,
    'providerExecution.id': checkpoint.providerExecutionId,
    'providerExecution.ownerId': checkpoint.ownerId ?? { $exists: false },
  };
  const exact = {
    'checkpoint.generationCreatedAt': checkpoint.generationCreatedAt,
    'checkpoint.providerExecutionId': checkpoint.providerExecutionId,
    'checkpoint.ownerId': checkpoint.ownerId ?? { $exists: false },
    'checkpoint.writerId': checkpoint.writerId,
    'checkpoint.namespace': checkpoint.namespace,
    'checkpoint.configJSON': checkpoint.configJSON,
  };
  return {
    async open() {
      const result = await model.updateOne(
        {
          ...physical,
          ...provider,
          'providerExecution.drained': { $ne: true },
          '_managed.phase': 'published',
          status: 'in_progress',
          persistenceFailure: { $exists: false },
          retiredAt: { $exists: false },
          cancellationRequestedAt: { $exists: false },
          $and: [activeExpirationFilter()],
          $or: [
            { checkpoint: { $exists: false } },
            {
              'checkpoint.state': 'settled',
              'checkpoint.generationCreatedAt': checkpoint.generationCreatedAt,
              'checkpoint.namespace': checkpoint.namespace,
              'checkpoint.configJSON': checkpoint.configJSON,
              'checkpoint.providerExecutionId': { $ne: checkpoint.providerExecutionId },
            },
            { ...exact, 'checkpoint.state': 'pending' },
          ],
        },
        { $set: { checkpoint: { ...checkpoint, state: 'pending' } } },
        { upsert: false },
      );
      return result.matchedCount === 1;
    },
    async settle() {
      // Retirement/expiry must not prevent a live exact writer from recording positive
      // settlement. Its retained root remains the cleanup authority until this succeeds.
      // An absent marker can mean opening failed before any checkpoint command ran.
      // Installing the exact settled marker also fences a delayed opening command.
      const result = await model.updateOne(
        {
          ...physical,
          ...provider,
          $or: [
            { checkpoint: { $exists: false } },
            { ...exact, 'checkpoint.state': { $in: ['pending', 'settled'] } },
          ],
        },
        {
          $set: Object.fromEntries(
            Object.entries({ ...checkpoint, state: 'settled' }).map(([field, value]) => [
              `checkpoint.${field}`,
              value,
            ]),
          ),
        },
        { upsert: false },
      );
      return result.matchedCount === 1;
    },
  };
}
