import mongoose, { Schema } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { tenantStorage, runAsSystem, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { applyTenantIsolation, _resetStrictCache } from './tenantIsolation';

let mongoServer: InstanceType<typeof MongoMemoryServer>;

interface ITestDoc {
  name: string;
  tenantId?: string;
}

function createTestModel(suffix: string) {
  const schema = new Schema<ITestDoc>({
    name: { type: String, required: true },
    tenantId: { type: String, index: true },
  });
  applyTenantIsolation(schema);
  const modelName = `TestTenant_${suffix}_${Date.now()}`;
  return mongoose.model<ITestDoc>(modelName, schema);
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('applyTenantIsolation', () => {
  describe('idempotency', () => {
    it('does not add duplicate hooks when called twice on the same schema', async () => {
      const schema = new Schema<ITestDoc>({
        name: { type: String, required: true },
        tenantId: { type: String, index: true },
      });

      applyTenantIsolation(schema);
      applyTenantIsolation(schema);

      const modelName = `TestIdempotent_${Date.now()}`;
      const Model = mongoose.model<ITestDoc>(modelName, schema);

      await Model.create([
        { name: 'a', tenantId: 'tenant-a' },
        { name: 'b', tenantId: 'tenant-b' },
      ]);

      const docs = await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
        Model.find().lean(),
      );

      expect(docs).toHaveLength(1);
      expect(docs[0].name).toBe('a');
    });
  });

  describe('query filtering', () => {
    let TestModel: mongoose.Model<ITestDoc>;

    beforeAll(() => {
      TestModel = createTestModel('query');
    });

    beforeEach(async () => {
      await TestModel.deleteMany({});
      await TestModel.create([
        { name: 'tenant-a-doc', tenantId: 'tenant-a' },
        { name: 'tenant-b-doc', tenantId: 'tenant-b' },
        { name: 'no-tenant-doc' },
      ]);
    });

    it('injects tenantId filter into find when context is set', async () => {
      const docs = await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
        TestModel.find().lean(),
      );

      expect(docs).toHaveLength(1);
      expect(docs[0].name).toBe('tenant-a-doc');
    });

    it('injects tenantId filter into findOne', async () => {
      const doc = await tenantStorage.run({ tenantId: 'tenant-b' }, async () =>
        TestModel.findOne({ name: 'tenant-a-doc' }).lean(),
      );

      expect(doc).toBeNull();
    });

    it('does not inject filter when context is absent (non-strict)', async () => {
      const docs = await TestModel.find().lean();
      expect(docs).toHaveLength(3);
    });

    it('bypasses filter for SYSTEM_TENANT_ID', async () => {
      const docs = await tenantStorage.run({ tenantId: SYSTEM_TENANT_ID }, async () =>
        TestModel.find().lean(),
      );

      expect(docs).toHaveLength(3);
    });

    it('injects tenantId filter into countDocuments', async () => {
      const count = await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
        TestModel.countDocuments(),
      );

      expect(count).toBe(1);
    });

    it('injects tenantId filter into findOneAndUpdate', async () => {
      const doc = await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
        TestModel.findOneAndUpdate(
          { name: 'tenant-b-doc' },
          { $set: { name: 'updated' } },
          { new: true },
        ).lean(),
      );

      expect(doc).toBeNull();
      const original = await TestModel.findOne({ name: 'tenant-b-doc' }).lean();
      expect(original).not.toBeNull();
    });

    it('injects tenantId filter into deleteOne', async () => {
      await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
        TestModel.deleteOne({ name: 'tenant-b-doc' }),
      );

      const doc = await TestModel.findOne({ name: 'tenant-b-doc' }).lean();
      expect(doc).not.toBeNull();
    });

    it('injects tenantId filter into deleteMany', async () => {
      await tenantStorage.run({ tenantId: 'tenant-a' }, async () => TestModel.deleteMany({}));

      const remaining = await TestModel.find().lean();
      expect(remaining).toHaveLength(2);
      expect(remaining.every((d) => d.tenantId !== 'tenant-a')).toBe(true);
    });

    it('injects tenantId filter into updateMany', async () => {
      await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
        TestModel.updateMany({}, { $set: { name: 'updated' } }),
      );

      const tenantBDoc = await TestModel.findOne({ tenantId: 'tenant-b' }).lean();
      expect(tenantBDoc!.name).toBe('tenant-b-doc');

      const tenantADoc = await TestModel.findOne({ tenantId: 'tenant-a' }).lean();
      expect(tenantADoc!.name).toBe('updated');
    });

    it('injects tenantId filter into distinct', async () => {
      const names = await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
        TestModel.distinct('name'),
      );

      expect(names).toEqual(['tenant-a-doc']);
    });

    it('injects tenantId filter into find().distinct() (op switches to distinct)', async () => {
      const names = await tenantStorage.run({ tenantId: 'tenant-b' }, async () =>
        TestModel.find().distinct('name'),
      );

      expect(names).toEqual(['tenant-b-doc']);
    });

    it('does not scope distinct when context is absent (non-strict)', async () => {
      const names = await TestModel.distinct('name');
      expect(names.sort()).toEqual(['no-tenant-doc', 'tenant-a-doc', 'tenant-b-doc']);
    });

    it('bypasses distinct filter for SYSTEM_TENANT_ID', async () => {
      const names = await tenantStorage.run({ tenantId: SYSTEM_TENANT_ID }, async () =>
        TestModel.distinct('name'),
      );

      expect(names).toHaveLength(3);
    });
  });

  describe('aggregate filtering', () => {
    let TestModel: mongoose.Model<ITestDoc>;

    beforeAll(() => {
      TestModel = createTestModel('aggregate');
    });

    beforeEach(async () => {
      await TestModel.deleteMany({});
      await TestModel.create([
        { name: 'agg-a', tenantId: 'tenant-a' },
        { name: 'agg-b', tenantId: 'tenant-b' },
        { name: 'agg-none' },
      ]);
    });

    it('prepends $match stage with tenantId to aggregate pipeline', async () => {
      const results = await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
        TestModel.aggregate([{ $project: { name: 1 } }]),
      );

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('agg-a');
    });

    it('does not filter aggregate when no context is set (non-strict)', async () => {
      const results = await TestModel.aggregate([{ $project: { name: 1 } }]);
      expect(results).toHaveLength(3);
    });

    it('bypasses aggregate filter for SYSTEM_TENANT_ID', async () => {
      const results = await tenantStorage.run({ tenantId: SYSTEM_TENANT_ID }, async () =>
        TestModel.aggregate([{ $project: { name: 1 } }]),
      );

      expect(results).toHaveLength(3);
    });
  });

  describe('save hook', () => {
    let TestModel: mongoose.Model<ITestDoc>;

    beforeAll(() => {
      TestModel = createTestModel('save');
    });

    beforeEach(async () => {
      await TestModel.deleteMany({});
    });

    it('stamps tenantId on save for new documents', async () => {
      const doc = await tenantStorage.run({ tenantId: 'tenant-x' }, async () => {
        const d = new TestModel({ name: 'new-doc' });
        await d.save();
        return d;
      });

      expect(doc.tenantId).toBe('tenant-x');
    });

    it('does not overwrite existing tenantId on save when it matches context', async () => {
      const doc = await tenantStorage.run({ tenantId: 'tenant-x' }, async () => {
        const d = new TestModel({ name: 'existing', tenantId: 'tenant-x' });
        await d.save();
        return d;
      });

      expect(doc.tenantId).toBe('tenant-x');
    });

    it('allows mismatched tenantId on save in non-strict mode', async () => {
      const doc = await tenantStorage.run({ tenantId: 'tenant-x' }, async () => {
        const d = new TestModel({ name: 'mismatch', tenantId: 'tenant-other' });
        await d.save();
        return d;
      });

      expect(doc.tenantId).toBe('tenant-other');
    });

    it('does not set tenantId for SYSTEM_TENANT_ID', async () => {
      const doc = await tenantStorage.run({ tenantId: SYSTEM_TENANT_ID }, async () => {
        const d = new TestModel({ name: 'system-doc' });
        await d.save();
        return d;
      });

      expect(doc.tenantId).toBeUndefined();
    });

    it('saves without tenantId when no context is set (non-strict)', async () => {
      const doc = new TestModel({ name: 'no-context' });
      await doc.save();

      expect(doc.tenantId).toBeUndefined();
    });
  });

  describe('insertMany hook', () => {
    let TestModel: mongoose.Model<ITestDoc>;

    beforeAll(() => {
      TestModel = createTestModel('insertMany');
    });

    beforeEach(async () => {
      await TestModel.deleteMany({});
    });

    it('stamps tenantId on all insertMany docs', async () => {
      const docs = await tenantStorage.run({ tenantId: 'tenant-bulk' }, async () =>
        TestModel.insertMany([{ name: 'bulk-1' }, { name: 'bulk-2' }]),
      );

      expect(docs).toHaveLength(2);
      for (const doc of docs) {
        expect(doc.tenantId).toBe('tenant-bulk');
      }
    });

    it('does not overwrite existing tenantId in insertMany when it matches', async () => {
      const docs = await tenantStorage.run({ tenantId: 'tenant-bulk' }, async () =>
        TestModel.insertMany([{ name: 'pre-set', tenantId: 'tenant-bulk' }]),
      );

      expect(docs[0].tenantId).toBe('tenant-bulk');
    });

    it('allows mismatched tenantId in insertMany in non-strict mode', async () => {
      const docs = await tenantStorage.run({ tenantId: 'tenant-bulk' }, async () =>
        TestModel.insertMany([{ name: 'mismatch', tenantId: 'tenant-other' }]),
      );

      expect(docs[0].tenantId).toBe('tenant-other');
    });

    it('does not hang when no tenant context is set (non-strict)', async () => {
      const docs = await TestModel.insertMany([{ name: 'no-context-bulk' }]);

      expect(docs).toHaveLength(1);
      expect(docs[0].tenantId).toBeUndefined();
    });

    it('does not stamp tenantId for SYSTEM_TENANT_ID', async () => {
      const docs = await tenantStorage.run({ tenantId: SYSTEM_TENANT_ID }, async () =>
        TestModel.insertMany([{ name: 'system-bulk' }]),
      );

      expect(docs[0].tenantId).toBeUndefined();
    });
  });

  describe('update mutation guard', () => {
    let TestModel: mongoose.Model<ITestDoc>;

    beforeAll(() => {
      TestModel = createTestModel('mutation');
    });

    beforeEach(async () => {
      await TestModel.deleteMany({});
      await TestModel.create({ name: 'guarded', tenantId: 'tenant-a' });
    });

    it('throws on cross-tenant $set of tenantId', async () => {
      await expect(
        tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
          TestModel.findOneAndUpdate({ name: 'guarded' }, { $set: { tenantId: 'tenant-b' } }),
        ),
      ).rejects.toThrow('[TenantIsolation] Cross-tenant tenantId mutation is not allowed');
    });

    it('strips same-tenant tenantId from $set', async () => {
      const result = await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
        TestModel.findOneAndUpdate(
          { name: 'guarded' },
          { $set: { tenantId: 'tenant-a', name: 'updated-same' } },
          { new: true },
        ).lean(),
      );

      expect(result).not.toBeNull();
      expect(result!.name).toBe('updated-same');
      expect(result!.tenantId).toBe('tenant-a');
    });

    it('strips tenantId from $unset', async () => {
      const result = await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
        TestModel.findOneAndUpdate(
          { name: 'guarded' },
          { $unset: { tenantId: 1 }, $set: { name: 'unset-attempt' } },
          { new: true },
        ).lean(),
      );

      expect(result).not.toBeNull();
      expect(result!.name).toBe('unset-attempt');
      expect(result!.tenantId).toBe('tenant-a');
    });

    it('throws on cross-tenant top-level tenantId', async () => {
      await expect(
        tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
          TestModel.updateOne({ name: 'guarded' }, { tenantId: 'tenant-b' } as Record<
            string,
            string
          >),
        ),
      ).rejects.toThrow('[TenantIsolation] Cross-tenant tenantId mutation is not allowed');
    });

    it('strips same-tenant top-level tenantId', async () => {
      const result = await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
        TestModel.findOneAndUpdate(
          { name: 'guarded' },
          { tenantId: 'tenant-a', name: 'top-level-same' } as Record<string, string>,
          { new: true },
        ).lean(),
      );

      expect(result).not.toBeNull();
      expect(result!.name).toBe('top-level-same');
      expect(result!.tenantId).toBe('tenant-a');
    });

    it('throws on cross-tenant $setOnInsert of tenantId', async () => {
      await expect(
        tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
          TestModel.updateMany({}, { $setOnInsert: { tenantId: 'tenant-b' } }),
        ),
      ).rejects.toThrow('[TenantIsolation] Cross-tenant tenantId mutation is not allowed');
    });

    it('strips same-tenant tenantId from $setOnInsert on upsert', async () => {
      const uniqueName = `upsert-soi-${Date.now()}`;
      await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
        TestModel.updateOne(
          { name: uniqueName },
          { $setOnInsert: { tenantId: 'tenant-a', name: uniqueName } },
          { upsert: true },
        ),
      );

      const doc = await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
        TestModel.findOne({ name: uniqueName }).lean(),
      );
      expect(doc).not.toBeNull();
      expect(doc!.tenantId).toBe('tenant-a');
    });

    it('strips same-tenant tenantId from $set via findByIdAndUpdate', async () => {
      const doc = await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
        TestModel.findOne({ name: 'guarded' }).lean(),
      );
      const result = await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
        TestModel.findByIdAndUpdate(
          doc!._id,
          { $set: { tenantId: 'tenant-a', name: 'byId-same' } },
          { new: true },
        ).lean(),
      );

      expect(result).not.toBeNull();
      expect(result!.name).toBe('byId-same');
      expect(result!.tenantId).toBe('tenant-a');
    });

    it('allows updates that do not touch tenantId', async () => {
      const result = await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
        TestModel.findOneAndUpdate(
          { name: 'guarded' },
          { $set: { name: 'updated' } },
          { new: true },
        ).lean(),
      );

      expect(result).not.toBeNull();
      expect(result!.name).toBe('updated');
      expect(result!.tenantId).toBe('tenant-a');
    });

    it('allows SYSTEM_TENANT_ID to modify tenantId', async () => {
      const result = await tenantStorage.run({ tenantId: SYSTEM_TENANT_ID }, async () =>
        TestModel.findOneAndUpdate(
          { name: 'guarded' },
          { $set: { tenantId: 'tenant-b' } },
          { new: true },
        ).lean(),
      );

      expect(result).not.toBeNull();
      expect(result!.tenantId).toBe('tenant-b');
    });

    it('strips tenantId from $set without tenant context', async () => {
      await TestModel.updateOne(
        { name: 'guarded' },
        { $set: { tenantId: 'tenant-b', name: 'no-ctx' } },
      );

      const doc = await TestModel.findOne({ name: 'no-ctx' }).lean();
      expect(doc).not.toBeNull();
      expect(doc!.tenantId).toBe('tenant-a');
    });

    it('strips tenantId from $rename without tenant context', async () => {
      await TestModel.updateOne({ name: 'guarded' }, { $rename: { tenantId: 'oldTenant' } });

      const doc = await TestModel.findOne({ name: 'guarded' }).lean();
      expect(doc).not.toBeNull();
      expect(doc!.tenantId).toBe('tenant-a');
    });

    it('no-ops when update contains only tenantId', async () => {
      await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
        TestModel.updateOne({ name: 'guarded' }, { $set: { tenantId: 'tenant-a' } }),
      );

      const doc = await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
        TestModel.findOne({ name: 'guarded' }).lean(),
      );
      expect(doc).not.toBeNull();
      expect(doc!.name).toBe('guarded');
      expect(doc!.tenantId).toBe('tenant-a');
    });

    it('no-ops when top-level update contains only tenantId', async () => {
      const result = await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
        TestModel.findOneAndUpdate(
          { name: 'guarded' },
          { tenantId: 'tenant-a' } as Record<string, string>,
          { new: true },
        ).lean(),
      );

      expect(result).toBeNull();
    });

    it('blocks tenantId in replaceOne replacement document', async () => {
      await expect(
        tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
          TestModel.replaceOne({ name: 'guarded' }, { name: 'replaced', tenantId: 'tenant-b' }),
        ),
      ).rejects.toThrow('[TenantIsolation] Modifying tenantId via replacement is not allowed');
    });

    it('blocks tenantId in findOneAndReplace replacement document', async () => {
      await expect(
        tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
          TestModel.findOneAndReplace(
            { name: 'guarded' },
            { name: 'replaced', tenantId: 'tenant-b' },
          ),
        ),
      ).rejects.toThrow('[TenantIsolation] Modifying tenantId via replacement is not allowed');
    });

    it('stamps tenantId into replacement when absent from replacement document', async () => {
      await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
        TestModel.replaceOne({ name: 'guarded' }, { name: 'replaced-ok' }),
      );

      const doc = await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
        TestModel.findOne({ name: 'replaced-ok' }).lean(),
      );
      expect(doc).not.toBeNull();
      expect(doc!.tenantId).toBe('tenant-a');
    });

    it('allows replacement with matching tenantId', async () => {
      await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
        TestModel.replaceOne({ name: 'guarded' }, { name: 'replaced-match', tenantId: 'tenant-a' }),
      );

      const doc = await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
        TestModel.findOne({ name: 'replaced-match' }).lean(),
      );
      expect(doc).not.toBeNull();
      expect(doc!.tenantId).toBe('tenant-a');
    });

    it('allows SYSTEM_TENANT_ID to replace with tenantId', async () => {
      await tenantStorage.run({ tenantId: SYSTEM_TENANT_ID }, async () =>
        TestModel.replaceOne({ name: 'guarded' }, { name: 'sys-replaced', tenantId: 'tenant-b' }),
      );

      const doc = await TestModel.findOne({ name: 'sys-replaced' }).lean();
      expect(doc).not.toBeNull();
      expect(doc!.tenantId).toBe('tenant-b');
    });
  });

  describe('runAsSystem', () => {
    let TestModel: mongoose.Model<ITestDoc>;

    beforeAll(() => {
      TestModel = createTestModel('runAsSystem');
    });

    beforeEach(async () => {
      await TestModel.deleteMany({});
      await TestModel.create([
        { name: 'sys-a', tenantId: 'tenant-a' },
        { name: 'sys-b', tenantId: 'tenant-b' },
      ]);
    });

    it('bypasses tenant filter inside runAsSystem', async () => {
      const docs = await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
        runAsSystem(async () => TestModel.find().lean()),
      );

      expect(docs).toHaveLength(2);
    });
  });

  describe('async context propagation', () => {
    let TestModel: mongoose.Model<ITestDoc>;

    beforeAll(() => {
      TestModel = createTestModel('asyncCtx');
    });

    beforeEach(async () => {
      await TestModel.deleteMany({});
      await TestModel.create([
        { name: 'ctx-a', tenantId: 'tenant-a' },
        { name: 'ctx-b', tenantId: 'tenant-b' },
      ]);
    });

    it('propagates tenant context through await boundaries', async () => {
      const docs = await tenantStorage.run({ tenantId: 'tenant-a' }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return TestModel.find().lean();
      });

      expect(docs).toHaveLength(1);
      expect(docs[0].name).toBe('ctx-a');
    });
  });

  describe('strict mode', () => {
    let TestModel: mongoose.Model<ITestDoc>;
    const originalEnv = process.env.TENANT_ISOLATION_STRICT;

    beforeAll(() => {
      TestModel = createTestModel('strict');
    });

    beforeEach(async () => {
      await runAsSystem(async () => {
        await TestModel.deleteMany({});
        await TestModel.create({ name: 'strict-doc', tenantId: 'tenant-a' });
      });
      process.env.TENANT_ISOLATION_STRICT = 'true';
      _resetStrictCache();
    });

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.TENANT_ISOLATION_STRICT;
      } else {
        process.env.TENANT_ISOLATION_STRICT = originalEnv;
      }
      _resetStrictCache();
    });

    it('throws on find without tenant context', async () => {
      await expect(TestModel.find().lean()).rejects.toThrow(
        '[TenantIsolation] Query attempted without tenant context in strict mode',
      );
    });

    it('throws on findOne without tenant context', async () => {
      await expect(TestModel.findOne().lean()).rejects.toThrow('[TenantIsolation]');
    });

    it('throws on aggregate without tenant context', async () => {
      await expect(TestModel.aggregate([{ $project: { name: 1 } }])).rejects.toThrow(
        '[TenantIsolation] Aggregate attempted without tenant context in strict mode',
      );
    });

    it('throws on save without tenant context', async () => {
      const doc = new TestModel({ name: 'strict-new' });
      await expect(doc.save()).rejects.toThrow(
        '[TenantIsolation] Save attempted without tenant context in strict mode',
      );
    });

    it('throws on insertMany without tenant context', async () => {
      await expect(TestModel.insertMany([{ name: 'strict-bulk' }])).rejects.toThrow(
        '[TenantIsolation] insertMany attempted without tenant context in strict mode',
      );
    });

    it('throws on save with mismatched tenantId', async () => {
      await expect(
        tenantStorage.run({ tenantId: 'tenant-a' }, async () => {
          const d = new TestModel({ name: 'mismatch', tenantId: 'tenant-b' });
          await d.save();
        }),
      ).rejects.toThrow(
        '[TenantIsolation] Document tenantId does not match current tenant context',
      );
    });

    it('throws on insertMany with mismatched tenantId', async () => {
      await expect(
        tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
          TestModel.insertMany([{ name: 'mismatch', tenantId: 'tenant-b' }]),
        ),
      ).rejects.toThrow(
        '[TenantIsolation] Document tenantId does not match current tenant context',
      );
    });

    it('allows queries with tenant context in strict mode', async () => {
      const docs = await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
        TestModel.find().lean(),
      );

      expect(docs).toHaveLength(1);
    });

    it('allows SYSTEM_TENANT_ID to bypass strict mode', async () => {
      const docs = await tenantStorage.run({ tenantId: SYSTEM_TENANT_ID }, async () =>
        TestModel.find().lean(),
      );

      expect(docs).toHaveLength(1);
    });

    it('allows runAsSystem to bypass strict mode', async () => {
      const docs = await runAsSystem(async () => TestModel.find().lean());
      expect(docs).toHaveLength(1);
    });
  });

  describe('multi-tenant unique constraints', () => {
    let UniqueModel: mongoose.Model<ITestDoc>;

    beforeAll(async () => {
      const schema = new Schema<ITestDoc>({
        name: { type: String, required: true },
        tenantId: { type: String, index: true },
      });
      schema.index({ name: 1, tenantId: 1 }, { unique: true });
      applyTenantIsolation(schema);
      UniqueModel = mongoose.model<ITestDoc>(`TestUnique_${Date.now()}`, schema);
      await UniqueModel.ensureIndexes();
    });

    afterAll(async () => {
      await UniqueModel.deleteMany({});
    });

    it('allows same name in different tenants', async () => {
      await tenantStorage.run({ tenantId: 'tenant-a' }, async () => {
        await UniqueModel.create({ name: 'shared-name' });
      });
      await tenantStorage.run({ tenantId: 'tenant-b' }, async () => {
        await UniqueModel.create({ name: 'shared-name' });
      });

      const docA = await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
        UniqueModel.findOne({ name: 'shared-name' }).lean(),
      );
      const docB = await tenantStorage.run({ tenantId: 'tenant-b' }, async () =>
        UniqueModel.findOne({ name: 'shared-name' }).lean(),
      );

      expect(docA).not.toBeNull();
      expect(docB).not.toBeNull();
      expect(docA!.tenantId).toBe('tenant-a');
      expect(docB!.tenantId).toBe('tenant-b');
    });

    it('rejects duplicate name within the same tenant', async () => {
      await tenantStorage.run({ tenantId: 'tenant-dup' }, async () => {
        await UniqueModel.create({ name: 'unique-within-tenant' });
      });

      await expect(
        tenantStorage.run({ tenantId: 'tenant-dup' }, async () =>
          UniqueModel.create({ name: 'unique-within-tenant' }),
        ),
      ).rejects.toThrow(/E11000|duplicate key/);
    });

    it('tenant-scoped query returns only the correct document', async () => {
      await tenantStorage.run({ tenantId: 'tenant-x' }, async () => {
        await UniqueModel.create({ name: 'scoped-doc' });
      });
      await tenantStorage.run({ tenantId: 'tenant-y' }, async () => {
        await UniqueModel.create({ name: 'scoped-doc' });
      });

      const results = await tenantStorage.run({ tenantId: 'tenant-x' }, async () =>
        UniqueModel.find({ name: 'scoped-doc' }).lean(),
      );

      expect(results).toHaveLength(1);
      expect(results[0].tenantId).toBe('tenant-x');
    });
  });
});
