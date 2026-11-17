import { isDeepStrictEqual } from 'node:util';
import type { CreateIndexesOptions, IndexDescriptionInfo } from 'mongodb';
import type { IndexDefinition, IndexOptions, Model } from 'mongoose';
import type { IAgentTriggerDeliveryDocument } from '~/types/triggerDelivery';
import triggerDeliverySchema, { BACKGROUND_POLL_INDEX } from '~/schema/triggerDelivery';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import { buildIndexWithRetry } from '~/utils/retry';

interface DeliveryIndexBuildOptions extends CreateIndexesOptions {
  toCreate?: Array<[IndexDefinition, IndexOptions]>;
}

export function createAgentTriggerDeliveryModel(
  mongoose: typeof import('mongoose'),
): Model<IAgentTriggerDeliveryDocument> {
  const existing = mongoose.models.AgentTriggerDelivery;
  if (existing) {
    return existing;
  }
  applyTenantIsolation(triggerDeliverySchema);
  const model = mongoose.model<IAgentTriggerDeliveryDocument>(
    'AgentTriggerDelivery',
    triggerDeliverySchema,
  );
  const ensureIndexes = model.ensureIndexes;

  // Both automatic indexing and createIndexes() delegate to ensureIndexes().
  model.ensureIndexes = async (options: DeliveryIndexBuildOptions = {}) => {
    const toCreate = [...(options.toCreate ?? model.schema.indexes())];
    const pollingIndex = toCreate.findIndex(([, index]) => index.name === BACKGROUND_POLL_INDEX);
    if (pollingIndex >= 0) {
      const indexes: IndexDescriptionInfo[] = await model.listIndexes().catch((error: unknown) => {
        if (error instanceof mongoose.mongo.MongoServerError && error.code === 26) {
          return [];
        }
        throw error;
      });
      const [keys, indexOptions] = toCreate[pollingIndex];
      const orderedKeys = Object.entries(keys);
      const equivalent = indexes.find(
        (index) =>
          isDeepStrictEqual(Object.entries(index.key), orderedKeys) &&
          Boolean(index.unique) === Boolean(indexOptions.unique) &&
          Boolean(index.sparse) === Boolean(indexOptions.sparse) &&
          Boolean(index.hidden) === Boolean(indexOptions.hidden) &&
          index.expireAfterSeconds === indexOptions.expireAfterSeconds &&
          isDeepStrictEqual(index.partialFilterExpression, indexOptions.partialFilterExpression) &&
          isDeepStrictEqual(
            index.collation ?? { locale: 'simple' },
            indexOptions.collation ?? model.schema.options.collation ?? { locale: 'simple' },
          ),
      );
      if (equivalent) {
        toCreate[pollingIndex] = [keys, { ...indexOptions, name: equivalent.name }];
      }
    }
    await buildIndexWithRetry(() => {
      const buildOptions = { ...options, toCreate: [...toCreate] };
      return ensureIndexes.call(model, buildOptions);
    }, `ensureIndexes(${model.modelName})`);
  };
  return model;
}
