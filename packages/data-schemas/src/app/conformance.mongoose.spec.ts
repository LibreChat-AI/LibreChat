import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { ConfigStoreHarness } from './conformance';
import { describeConfigStoreConformance } from './conformance';
import { createConfigStore } from '~/methods/config';
import { createConfigModel } from '~/models/config';

/**
 * The Mongoose binding's answer to the portable config store contract, on a real mongod.
 * Key encoding and legacy-document behaviour specific to this engine are covered in
 * `methods/config.spec.ts`.
 */

let server: MongoMemoryServer;

const harness: ConfigStoreHarness = {
  name: 'mongoose',

  async setup() {
    server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri());
    await createConfigModel(mongoose).init();
    return createConfigStore(mongoose);
  },

  async teardown() {
    await mongoose.disconnect();
    await server.stop();
  },

  async reset() {
    await mongoose.models.Config.deleteMany({});
  },

  /** The driver applies the insert, then reports the error a dropped connection gives. */
  loseNextCreateAcknowledgement() {
    const collection = mongoose.models.Config.collection;
    const findOneAndUpdate = collection.findOneAndUpdate.bind(collection);
    jest.spyOn(collection, 'findOneAndUpdate').mockImplementationOnce((async (
      ...args: Parameters<typeof findOneAndUpdate>
    ) => {
      await findOneAndUpdate(...args);
      throw new mongoose.mongo.MongoNetworkError('connection reset after the write was applied');
    }) as unknown as typeof collection.findOneAndUpdate);
  },
};

describeConfigStoreConformance(harness);
