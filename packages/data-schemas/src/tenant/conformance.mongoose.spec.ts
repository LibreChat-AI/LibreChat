import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { TenantRow, TenantEngineHarness } from './conformance';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import { describeTenantIsolationConformance } from './conformance';

/**
 * The Mongoose binding's answer to the portable contract. A PostgreSQL engine
 * satisfies the same suite by supplying its own harness — that is what makes
 * the seam real rather than hypothetical.
 */

interface ConformanceDocument {
  name: string;
  tenantId?: string;
}

let server: MongoMemoryServer;
let Model: mongoose.Model<ConformanceDocument>;

/** Reads and writes that must not be tenant-scoped, for fixtures and assertions. */
const raw = () => mongoose.connection.db!.collection<ConformanceDocument>('conformances');

const harness: TenantEngineHarness = {
  name: 'mongoose',

  async setup() {
    server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri());

    const schema = new mongoose.Schema<ConformanceDocument>({
      name: String,
      tenantId: { type: String, index: true },
    });
    applyTenantIsolation(schema);
    Model = mongoose.model<ConformanceDocument>('Conformance', schema);
  },

  async teardown() {
    await mongoose.disconnect();
    await server.stop();
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

describeTenantIsolationConformance(harness);
