import { isDeepStrictEqual } from 'node:util';
import type { CollationOptions, CreateIndexesOptions, IndexDescriptionInfo } from 'mongodb';
import type { IndexDefinition, IndexOptions, Model } from 'mongoose';
import type { IAgentTriggerDeliveryDocument } from '~/types/triggerDelivery';
import triggerDeliverySchema, { BACKGROUND_POLL_INDEX } from '~/schema/triggerDelivery';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';

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
  const ensureIndexes = model.ensureIndexes.bind(model);

  // Both automatic indexing and createIndexes() delegate to ensureIndexes().
  model.ensureIndexes = async (options: DeliveryIndexBuildOptions = {}) => {
    const toCreate = [...(options.toCreate ?? model.schema.indexes())];
    const pollingIndex = toCreate.findIndex(([, index]) => index.name === BACKGROUND_POLL_INDEX);
    if (pollingIndex >= 0) {
      const { name } = model.collection;
      await model.db.asPromise();
      const existingIndexes: Promise<IndexDescriptionInfo[]> = model
        .listIndexes()
        .catch((error: unknown) => {
          if (error instanceof mongoose.mongo.MongoServerError && error.code === 26) {
            return [];
          }
          throw error;
        });
      const [indexes, collectionInfo] = await Promise.all([
        existingIndexes,
        Promise.resolve().then(() =>
          model.db.db!.listCollections({ name }, { nameOnly: false }).next(),
        ),
      ]);
      const [keys, indexOptions] = toCreate[pollingIndex];
      const collation: CollationOptions = indexOptions.collation ??
        model.schema.options.collation ??
        collectionInfo?.options?.collation ?? { locale: 'simple' };
      const orderedKeys = Object.entries(keys);
      const equivalent = indexes.find(
        (index) =>
          isDeepStrictEqual(Object.entries(index.key), orderedKeys) &&
          Boolean(index.unique) === Boolean(indexOptions.unique) &&
          Boolean(index.sparse) === Boolean(indexOptions.sparse) &&
          Boolean(index.hidden) === Boolean(indexOptions.hidden) &&
          index.expireAfterSeconds === indexOptions.expireAfterSeconds &&
          isDeepStrictEqual(index.partialFilterExpression, indexOptions.partialFilterExpression) &&
          isDeepStrictEqual(index.collation ?? { locale: 'simple' }, collation),
      );
      if (equivalent) {
        toCreate[pollingIndex] = [keys, { ...indexOptions, name: equivalent.name }];
      }
    }
    const buildOptions = { ...options, toCreate };
    return ensureIndexes(buildOptions);
  };
  return model;
}
