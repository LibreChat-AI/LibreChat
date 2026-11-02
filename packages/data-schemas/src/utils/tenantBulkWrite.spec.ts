import mongoose, { Schema } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { applyTenantIsolation, _resetStrictCache } from '~/models/plugins/tenantIsolation';
import { tenantSafeBulkWrite, _resetBulkWriteStrictCache } from './tenantBulkWrite';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';

let mongoServer: InstanceType<typeof MongoMemoryServer>;

interface ITestDoc {
  name: string;
  value?: number;
  tenantId?: string;
}

function createTestModel(suffix: string) {
  const schema = new Schema<ITestDoc>({
    name: { type: String, required: true },
    value: { type: Number, default: 0 },
    tenantId: { type: String, index: true },
  });
  applyTenantIsolation(schema);
  const modelName = `TestBulkWrite_${suffix}_${Date.now()}`;
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

afterEach(() => {
  delete process.env.TENANT_ISOLATION_STRICT;
  _resetStrictCache();
  _resetBulkWriteStrictCache();
});

describe('tenantSafeBulkWrite', () => {
  describe('with tenant context', () => {
    it('injects tenantId into updateOne filters', async () => {
      const Model = createTestModel('updateOne');

      // Seed data for two tenants
      await runAsSystem(async () => {
        await Model.create([
          { name: 'doc1', value: 1, tenantId: 'tenant-a' },
          { name: 'doc1', value: 1, tenantId: 'tenant-b' },
        ]);
      });

      // Update only tenant-a's doc
      await tenantStorage.run({ tenantId: 'tenant-a' }, async () => {
        await tenantSafeBulkWrite(Model, [
          {
            updateOne: {
              filter: { name: 'doc1' },
              update: { $set: { value: 99 } },
            },
          },
        ]);
      });

      // Verify tenant-a was updated, tenant-b was not
      const docs = await runAsSystem(async () => Model.find({}).lean());
      const docA = docs.find((d) => d.tenantId === 'tenant-a');
      const docB = docs.find((d) => d.tenantId === 'tenant-b');
      expect(docA?.value).toBe(99);
      expect(docB?.value).toBe(1);
    });

    it('injects tenantId into insertOne documents', async () => {
      const Model = createTestModel('insertOne');

      await tenantStorage.run({ tenantId: 'tenant-x' }, async () => {
        await tenantSafeBulkWrite(Model, [
          {
            insertOne: {
              document: { name: 'new-doc', value: 42 } as ITestDoc,
            },
          },
        ]);
      });

      const docs = await runAsSystem(async () => Model.find({}).lean());
      expect(docs).toHaveLength(1);
      expect(docs[0].tenantId).toBe('tenant-x');
      expect(docs[0].name).toBe('new-doc');
    });

    it('injects tenantId into deleteOne filters', async () => {
      const Model = createTestModel('deleteOne');

      await runAsSystem(async () => {
        await Model.create([
          { name: 'to-delete', tenantId: 'tenant-a' },
          { name: 'to-delete', tenantId: 'tenant-b' },
        ]);
      });

      await tenantStorage.run({ tenantId: 'tenant-a' }, async () => {
        await tenantSafeBulkWrite(Model, [
          {
            deleteOne: {
              filter: { name: 'to-delete' },
            },
          },
        ]);
      });

      const docs = await runAsSystem(async () => Model.find({}).lean());
      expect(docs).toHaveLength(1);
      expect(docs[0].tenantId).toBe('tenant-b');
    });

    it('injects tenantId into updateMany filters', async () => {
      const Model = createTestModel('updateMany');

      await runAsSystem(async () => {
        await Model.create([
          { name: 'batch', value: 0, tenantId: 'tenant-a' },
          { name: 'batch', value: 0, tenantId: 'tenant-a' },
          { name: 'batch', value: 0, tenantId: 'tenant-b' },
        ]);
      });

      await tenantStorage.run({ tenantId: 'tenant-a' }, async () => {
        await tenantSafeBulkWrite(Model, [
          {
            updateMany: {
              filter: { name: 'batch' },
              update: { $set: { value: 5 } },
            },
          },
        ]);
      });

      const docs = await runAsSystem(async () => Model.find({}).lean());
      const tenantADocs = docs.filter((d) => d.tenantId === 'tenant-a');
      const tenantBDocs = docs.filter((d) => d.tenantId === 'tenant-b');
      expect(tenantADocs.every((d) => d.value === 5)).toBe(true);
      expect(tenantBDocs[0].value).toBe(0);
    });
  });

  describe('with SYSTEM_TENANT_ID', () => {
    it('skips tenantId injection (cross-tenant operation)', async () => {
      const Model = createTestModel('system');

      await runAsSystem(async () => {
        await Model.create([
          { name: 'sys-doc', value: 0, tenantId: 'tenant-a' },
          { name: 'sys-doc', value: 0, tenantId: 'tenant-b' },
        ]);
      });

      // System context should update ALL docs regardless of tenant
      await runAsSystem(async () => {
        await tenantSafeBulkWrite(Model, [
          {
            updateMany: {
              filter: { name: 'sys-doc' },
              update: { $set: { value: 100 } },
            },
          },
        ]);
      });

      const docs = await runAsSystem(async () => Model.find({}).lean());
      expect(docs.every((d) => d.value === 100)).toBe(true);
    });
  });

  describe('with SYSTEM_TENANT_ID in strict mode', () => {
    it('does not throw when runAsSystem is used in strict mode', async () => {
      process.env.TENANT_ISOLATION_STRICT = 'true';
      _resetBulkWriteStrictCache();

      const Model = createTestModel('systemStrict');

      await runAsSystem(async () => {
        await Model.create({ name: 'strict-sys', value: 0 });
      });

      await expect(
        runAsSystem(async () =>
          tenantSafeBulkWrite(Model, [
            {
              updateOne: {
                filter: { name: 'strict-sys' },
                update: { $set: { value: 42 } },
              },
            },
          ]),
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('deleteMany and replaceOne', () => {
    it('injects tenantId into deleteMany filters', async () => {
      const Model = createTestModel('deleteMany');

      await runAsSystem(async () => {
        await Model.create([
          { name: 'batch-del', value: 0, tenantId: 'tenant-a' },
          { name: 'batch-del', value: 0, tenantId: 'tenant-a' },
          { name: 'batch-del', value: 0, tenantId: 'tenant-b' },
        ]);
      });

      await tenantStorage.run({ tenantId: 'tenant-a' }, async () => {
        await tenantSafeBulkWrite(Model, [{ deleteMany: { filter: { name: 'batch-del' } } }]);
      });

      const docs = await runAsSystem(async () => Model.find({}).lean());
      expect(docs).toHaveLength(1);
      expect(docs[0].tenantId).toBe('tenant-b');
    });

    it('injects tenantId into replaceOne filter and replacement', async () => {
      const Model = createTestModel('replaceOne');

      await runAsSystem(async () => {
        await Model.create([
          { name: 'to-replace', value: 1, tenantId: 'tenant-a' },
          { name: 'to-replace', value: 1, tenantId: 'tenant-b' },
        ]);
      });

      await tenantStorage.run({ tenantId: 'tenant-a' }, async () => {
        await tenantSafeBulkWrite(Model, [
          {
            replaceOne: {
              filter: { name: 'to-replace' },
              replacement: { name: 'replaced', value: 99 },
            },
          },
        ]);
      });

      const docs = await runAsSystem(async () => Model.find({}).sort({ name: 1 }).lean());
      const replaced = docs.find((d) => d.name === 'replaced');
      const untouched = docs.find((d) => d.tenantId === 'tenant-b');
      expect(replaced?.value).toBe(99);
      expect(replaced?.tenantId).toBe('tenant-a');
      expect(untouched?.value).toBe(1);
    });

    it('replaceOne overwrites a conflicting tenantId in the replacement document', async () => {
      const Model = createTestModel('replaceOverwrite');

      await runAsSystem(async () => {
        await Model.create({ name: 'conflict', value: 1, tenantId: 'tenant-a' });
      });

      await tenantStorage.run({ tenantId: 'tenant-a' }, async () => {
        await tenantSafeBulkWrite(Model, [
          {
            replaceOne: {
              filter: { name: 'conflict' },
              replacement: { name: 'conflict', value: 2, tenantId: 'tenant-evil' } as ITestDoc,
            },
          },
        ]);
      });

      const docs = await runAsSystem(async () => Model.find({}).lean());
      expect(docs).toHaveLength(1);
      expect(docs[0].tenantId).toBe('tenant-a');
      expect(docs[0].value).toBe(2);
    });
  });

  describe('tenantId stripping from update documents', () => {
    it('strips top-level tenantId from updateOne plain-object update', async () => {
      const Model = createTestModel('stripPlain');

      await runAsSystem(async () => {
        await Model.create({ name: 'target', value: 1, tenantId: 'tenant-a' });
      });

      await tenantStorage.run({ tenantId: 'tenant-a' }, async () => {
        await tenantSafeBulkWrite(Model, [
          {
            updateOne: {
              filter: { name: 'target' },
              update: { value: 99, tenantId: 'cross-tenant' } as Record<string, unknown>,
              upsert: true,
            },
          },
        ]);
      });

      const doc = await runAsSystem(async () => Model.findOne({ name: 'target' }).lean());
      expect(doc?.value).toBe(99);
      expect(doc?.tenantId).toBe('tenant-a');
    });

    it('strips tenantId from $set in updateOne', async () => {
      const Model = createTestModel('stripSet');

      await runAsSystem(async () => {
        await Model.create({ name: 'target', value: 1, tenantId: 'tenant-a' });
      });

      await tenantStorage.run({ tenantId: 'tenant-a' }, async () => {
        await tenantSafeBulkWrite(Model, [
          {
            updateOne: {
              filter: { name: 'target' },
              update: { $set: { value: 50, tenantId: 'cross-tenant' } },
            },
          },
        ]);
      });

      const doc = await runAsSystem(async () => Model.findOne({ name: 'target' }).lean());
      expect(doc?.value).toBe(50);
      expect(doc?.tenantId).toBe('tenant-a');
    });

    it('strips tenantId from $unset in updateMany', async () => {
      const Model = createTestModel('stripUnset');

      await runAsSystem(async () => {
        await Model.create([
          { name: 'batch', value: 1, tenantId: 'tenant-a' },
          { name: 'batch', value: 2, tenantId: 'tenant-a' },
        ]);
      });

      await tenantStorage.run({ tenantId: 'tenant-a' }, async () => {
        await tenantSafeBulkWrite(Model, [
          {
            updateMany: {
              filter: { name: 'batch' },
              update: { $unset: { tenantId: 1 }, $set: { value: 0 } },
            },
          },
        ]);
      });

      const docs = await runAsSystem(async () => Model.find({ name: 'batch' }).lean());
      expect(docs).toHaveLength(2);
      for (const doc of docs) {
        expect(doc.value).toBe(0);
        expect(doc.tenantId).toBe('tenant-a');
      }
    });

    it('handles update where tenantId is the only field in $set', async () => {
      const Model = createTestModel('stripOnlyField');

      await runAsSystem(async () => {
        await Model.create({ name: 'target', value: 5, tenantId: 'tenant-a' });
      });

      await tenantStorage.run({ tenantId: 'tenant-a' }, async () => {
        await tenantSafeBulkWrite(Model, [
          {
            updateOne: {
              filter: { name: 'target' },
              update: { $set: { tenantId: 'cross-tenant' } },
            },
          },
        ]);
      });

      const doc = await runAsSystem(async () => Model.findOne({ name: 'target' }).lean());
      expect(doc?.tenantId).toBe('tenant-a');
      expect(doc?.value).toBe(5);
    });
  });

  describe('mixed top-level and operator tenantId', () => {
    it('strips both top-level and $set tenantId when both are present', async () => {
      const Model = createTestModel('stripBoth');

      await runAsSystem(async () => {
        await Model.create({ name: 'target', value: 1, tenantId: 'tenant-a' });
      });

      await tenantStorage.run({ tenantId: 'tenant-a' }, async () => {
        await tenantSafeBulkWrite(Model, [
          {
            updateOne: {
              filter: { name: 'target' },
              update: {
                tenantId: 'top-cross',
                $set: { value: 99, tenantId: 'set-cross' },
              } as Record<string, unknown>,
            },
          },
        ]);
      });

      const doc = await runAsSystem(async () => Model.findOne({ name: 'target' }).lean());
      expect(doc?.value).toBe(99);
      expect(doc?.tenantId).toBe('tenant-a');
    });
  });

  describe('edge cases', () => {
    it('handles empty ops array', async () => {
      const Model = createTestModel('emptyOps');
      const result = await tenantStorage.run({ tenantId: 'tenant-x' }, async () =>
        tenantSafeBulkWrite(Model, []),
      );
      expect(result.insertedCount).toBe(0);
      expect(result.modifiedCount).toBe(0);
    });
  });

  describe('without tenant context', () => {
    it('passes through in non-strict mode', async () => {
      const Model = createTestModel('noCtx');

      await runAsSystem(async () => {
        await Model.create({ name: 'no-ctx', value: 0 });
      });

      // No ALS context — non-strict should pass through
      const result = await tenantSafeBulkWrite(Model, [
        {
          updateOne: {
            filter: { name: 'no-ctx' },
            update: { $set: { value: 10 } },
          },
        },
      ]);

      expect(result.modifiedCount).toBe(1);
    });

    it('strips tenantId from updates even without tenant context', async () => {
      const Model = createTestModel('noCtxStrip');

      await runAsSystem(async () => {
        await Model.create({ name: 'no-ctx-strip', value: 1, tenantId: 'original' });
      });

      await tenantSafeBulkWrite(Model, [
        {
          updateOne: {
            filter: { name: 'no-ctx-strip' },
            update: { $set: { value: 50, tenantId: 'injected' } },
          },
        },
      ]);

      const doc = await runAsSystem(async () => Model.findOne({ name: 'no-ctx-strip' }).lean());
      expect(doc?.value).toBe(50);
      expect(doc?.tenantId).toBe('original');
    });

    it('throws in strict mode', async () => {
      process.env.TENANT_ISOLATION_STRICT = 'true';
      _resetBulkWriteStrictCache();

      const Model = createTestModel('strict');

      await expect(
        tenantSafeBulkWrite(Model, [
          {
            updateOne: {
              filter: { name: 'any' },
              update: { $set: { value: 1 } },
            },
          },
        ]),
      ).rejects.toThrow('bulkWrite on TestBulkWrite_strict');
    });
  });

  describe('mixed operations', () => {
    it('handles a batch of mixed insert, update, delete operations', async () => {
      const Model = createTestModel('mixed');

      await runAsSystem(async () => {
        await Model.create([
          { name: 'existing1', value: 1, tenantId: 'tenant-m' },
          { name: 'to-remove', value: 2, tenantId: 'tenant-m' },
          { name: 'existing1', value: 1, tenantId: 'tenant-other' },
        ]);
      });

      await tenantStorage.run({ tenantId: 'tenant-m' }, async () => {
        await tenantSafeBulkWrite(Model, [
          {
            insertOne: {
              document: { name: 'new-item', value: 10 } as ITestDoc,
            },
          },
          {
            updateOne: {
              filter: { name: 'existing1' },
              update: { $set: { value: 50 } },
            },
          },
          {
            deleteOne: {
              filter: { name: 'to-remove' },
            },
          },
        ]);
      });

      const docs = await runAsSystem(async () => Model.find({}).sort({ name: 1 }).lean());

      // tenant-other's doc should be untouched
      const otherDoc = docs.find((d) => d.tenantId === 'tenant-other' && d.name === 'existing1');
      expect(otherDoc?.value).toBe(1);

      // tenant-m: existing1 updated, to-remove deleted, new-item inserted
      const tenantMDocs = docs.filter((d) => d.tenantId === 'tenant-m');
      expect(tenantMDocs).toHaveLength(2);
      expect(tenantMDocs.find((d) => d.name === 'existing1')?.value).toBe(50);
      expect(tenantMDocs.find((d) => d.name === 'new-item')?.value).toBe(10);
      expect(tenantMDocs.find((d) => d.name === 'to-remove')).toBeUndefined();
    });
  });
});
