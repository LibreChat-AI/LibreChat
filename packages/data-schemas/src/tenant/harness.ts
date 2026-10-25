import mongoose from 'mongoose';
import type { TenantRow, TenantEngineHarness } from './conformance';
import { applyTenantIsolation, tenantPartitionFilter } from '~/models/plugins/tenantIsolation';

/**
 * The Mongoose binding's harness for the tenant-isolation contract, on whichever server
 * `connect` provides: mongodb-memory-server in the unit suite, or a live engine such as
 * FerretDB in `misc/ferretdb`. A PostgreSQL engine supplies its own harness instead.
 */

interface ConformanceDocument {
  name: string;
  tenantId?: string | null;
}

export interface MongooseTenantEngine {
  readonly name: string;
  /** Starts or locates the server and returns its connection URI. */
  connect(): Promise<string>;
  /** Releases the server once the suite has disconnected from it. */
  release(): Promise<void>;
}

const COLLECTION = 'conformances';

export function createMongooseTenantHarness(engine: MongooseTenantEngine): TenantEngineHarness {
  let Model: mongoose.Model<ConformanceDocument>;

  /** Reads and writes that must not be tenant-scoped, for fixtures and assertions. */
  const raw = () => mongoose.connection.db!.collection<ConformanceDocument>(COLLECTION);

  return {
    name: engine.name,

    async setup() {
      await mongoose.connect(await engine.connect());

      const schema = new mongoose.Schema<ConformanceDocument>({
        name: String,
        tenantId: { type: String, index: true },
      });
      applyTenantIsolation(schema);
      Model = mongoose.model<ConformanceDocument>('Conformance', schema, COLLECTION);
    },

    async teardown() {
      await raw()
        .drop()
        .catch(() => undefined);
      await mongoose.disconnect();
      await engine.release();
    },

    async reset() {
      await raw().deleteMany({});
    },

    async seed(rows) {
      await raw().insertMany(rows.map((row) => ({ ...row })));
    },

    async readAllUnscoped() {
      const rows = await raw().find({}).toArray();
      return rows.map((row): TenantRow => ({ name: row.name, tenantId: row.tenantId }));
    },

    async insert(row) {
      await Model.create({ ...row });
    },

    async findNames() {
      const rows = await Model.find({}).lean();
      return rows.map((row) => row.name);
    },

    async findNamesInPartition() {
      const rows = await Model.find(tenantPartitionFilter('conformance')).lean();
      return rows.map((row) => row.name);
    },

    async count() {
      return Model.countDocuments({});
    },

    async rename(from, to) {
      await Model.updateOne({ name: from }, { $set: { name: to } });
    },

    async renameAndReassign(from, to, tenantId) {
      await Model.updateOne({ name: from }, { $set: { name: to, tenantId } });
    },

    async remove(name) {
      await Model.deleteOne({ name });
    },
  };
}
