import mongoose from 'mongoose';
import type { ConfigStoreHarness } from '~/app/conformance';
import { describeConfigStoreConformance } from '~/app/conformance';
import { createConfigStore } from '~/methods/config';
import { createConfigModel } from '~/models/config';

/**
 * The portable config store contract against a live engine: FerretDB (PostgreSQL + DocumentDB
 * extension), or any MongoDB-compatible server for parity. The binding stores override keys raw
 * where the engine accepts them and encoded where it refuses a dotted or `$`-prefixed field name,
 * so no engine ever holds a name it cannot store; this run proves the round trip on an engine
 * stricter than mongod.
 *
 * Run against FerretDB (see docker-compose.ferretdb.yml):
 *   FERRETDB_URI="mongodb://ferretdb:ferretdb@127.0.0.1:27020/config_store_test" \
 *     npx jest --config misc/ferretdb/jest.ferretdb.config.mjs configStore.ferretdb
 *
 * Run against MongoDB (for parity):
 *   FERRETDB_URI="mongodb://127.0.0.1:27017/config_store_test" \
 *     npx jest --config misc/ferretdb/jest.ferretdb.config.mjs configStore.ferretdb
 *
 * AWS DocumentDB and Azure Cosmos DB (MongoDB API) may restrict field names the same way and are
 * covered by the same fallback; they cannot be run locally.
 *
 * Destructive: the run deletes every document in the database's `configs` collection before each
 * case and drops the collection at teardown. Point `FERRETDB_URI` at a throwaway database, never
 * at one a LibreChat deployment uses. Setup refuses a `configs` collection that already holds
 * documents; after an interrupted run, drop that collection by hand.
 */

const FERRETDB_URI = process.env.FERRETDB_URI;

/** Set once setup has seen an empty `configs` collection; nothing is dropped before that. */
let owned = false;

const harness: ConfigStoreHarness = {
  name: `mongoose on ${FERRETDB_URI ? new URL(FERRETDB_URI).host : 'FERRETDB_URI (unset)'}`,

  async setup() {
    await mongoose.connect(FERRETDB_URI as string);
    const configs = mongoose.connection.db?.collection('configs');
    if (!configs || (await configs.countDocuments({}, { limit: 1 })) > 0) {
      throw new Error(
        'The configs collection at FERRETDB_URI already holds documents; this runner deletes them. Use a throwaway database.',
      );
    }
    owned = true;
    await createConfigModel(mongoose).init();
    return createConfigStore(mongoose);
  },

  async teardown() {
    if (owned) {
      await mongoose.connection.dropCollection('configs').catch(() => undefined);
    }
    await mongoose.disconnect();
  },

  async reset() {
    await mongoose.models.Config.deleteMany({});
  },
};

if (FERRETDB_URI) {
  describeConfigStoreConformance(harness);
} else {
  describe.skip('config store conformance (set FERRETDB_URI to run)', () => {
    it('runs against a live engine', () => {
      expect(FERRETDB_URI).toBeDefined();
    });
  });
}
