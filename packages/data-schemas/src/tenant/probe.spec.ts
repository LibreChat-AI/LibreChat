import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { TenantProbe, TenantCommandRecord } from './probe';
import { tenantStorage, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import { tenantSafeBulkWrite } from '~/utils/tenantBulkWrite';
import { attachTenantProbe, unscoped } from './probe';

/**
 * Completeness proof for the Mongoose tenant-isolation binding.
 *
 * Every other tenant test asserts what a query *returns*. These assert what
 * reaches the database, which is the only way to catch a path the binding never
 * hooked. In particular this pins the reason the middleware cannot be replaced
 * by a wrapper around the model's static methods: document-level writes and
 * populate never pass through such a wrapper, but they do reach the wire.
 */

interface WidgetDocument {
  name: string;
  tenantId?: string;
  parts: mongoose.Types.ObjectId[];
}

interface PartDocument {
  label: string;
  tenantId?: string;
}

const TENANT = 'tenant-a';

let server: MongoMemoryServer;
let probe: TenantProbe;
let Widget: mongoose.Model<WidgetDocument>;
let Part: mongoose.Model<PartDocument>;

const asTenant = <T>(fn: () => Promise<T>): Promise<T> =>
  tenantStorage.run({ tenantId: TENANT }, fn);

const describeLeaks = (records: readonly TenantCommandRecord[]): string =>
  unscoped(records)
    .map((record) => `${record.commandName} on ${record.collection}: ${record.predicate}`)
    .join('\n');

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri(), { monitorCommands: true });

  const partSchema = new mongoose.Schema<PartDocument>({
    label: String,
    tenantId: { type: String, index: true },
  });
  applyTenantIsolation(partSchema);
  Part = mongoose.model<PartDocument>('ProbePart', partSchema);

  const widgetSchema = new mongoose.Schema<WidgetDocument>({
    name: String,
    tenantId: { type: String, index: true },
    parts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'ProbePart' }],
  });
  applyTenantIsolation(widgetSchema);
  Widget = mongoose.model<WidgetDocument>('ProbeWidget', widgetSchema);

  probe = attachTenantProbe(mongoose.connection, [
    Widget.collection.collectionName,
    Part.collection.collectionName,
  ]);
});

afterAll(async () => {
  probe.close();
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  await tenantStorage.run({ tenantId: SYSTEM_TENANT_ID }, async () => {
    await Widget.deleteMany({});
    await Part.deleteMany({});
  });
});

describe('the probe itself', () => {
  it('detects a command that reached the wire unscoped', async () => {
    const records = await probe.record(() =>
      asTenant(async () => {
        await mongoose.connection
          .db!.collection(Widget.collection.collectionName)
          .find({})
          .toArray();
      }),
    );

    expect(unscoped(records)).toHaveLength(1);
    expect(records[0].commandName).toBe('find');
  });

  const rawFind = (filter: Record<string, unknown>) =>
    probe.record(() =>
      asTenant(async () => {
        await mongoose.connection
          .db!.collection(Widget.collection.collectionName)
          .find(filter)
          .toArray();
      }),
    );

  /**
   * The probe accepts only the binding's own contribution — `tenantId` equal to
   * the active tenant, at the top level of the filter. Everything else is
   * reported unscoped, because deciding tenant-safety for arbitrary filter
   * algebra is unbounded and every operator left open is a way for a regression
   * to look scoped.
   */
  it.each([
    ['a different tenant entirely', { tenantId: 'tenant-b' }],
    ['a permissive $or branch', { $or: [{ tenantId: TENANT }, {}] }],
    ['tenantId nested under an unrelated field', { meta: { tenantId: TENANT } }],
    ['$ne, which selects every other tenant', { tenantId: { $ne: TENANT } }],
    ['a multi-valued $in', { tenantId: { $in: [TENANT, 'tenant-b'] } }],
    ['a regex inside a singleton $in', { tenantId: { $in: [/^tenant-/] } }],
    ['a regex over tenants', { tenantId: { $regex: '.*' } }],
    ['$exists: true, which matches any tenant', { tenantId: { $exists: true } }],
    ['operator forms the binding never emits', { tenantId: { $eq: TENANT } }],
  ])('does not accept %s as scoping', async (_label, filter) => {
    expect(unscoped(await rawFind(filter))).toHaveLength(1);
  });

  it('accepts the shape the binding actually emits', async () => {
    const records = await rawFind({ tenantId: TENANT, name: 'x' });

    expect(records).toHaveLength(1);
    expect(unscoped(records)).toHaveLength(0);
    expect(records[0].tenantId).toBe(TENANT);
  });

  const rawAggregate = (pipeline: Record<string, unknown>[]) =>
    probe.record(() =>
      asTenant(async () => {
        await mongoose.connection
          .db!.collection(Widget.collection.collectionName)
          .aggregate(pipeline)
          .toArray();
      }),
    );

  /**
   * Position is the whole point. A `$match` that lands after data has been
   * combined, limited or skipped mentions the tenant without having restricted
   * what the earlier stages saw.
   */
  it.each([
    ['after a $group', [{ $group: { _id: null } }, { $match: { tenantId: TENANT } }]],
    ['after a $limit', [{ $limit: 1 }, { $match: { tenantId: TENANT } }]],
    ['after a $skip', [{ $skip: 1 }, { $match: { tenantId: TENANT } }]],
    ['after a $sort', [{ $sort: { name: 1 } }, { $match: { tenantId: TENANT } }]],
  ])('does not accept a tenant $match %s', async (_label, pipeline) => {
    expect(unscoped(await rawAggregate(pipeline))).toHaveLength(1);
  });

  it('accepts a pipeline whose first stage is the tenant $match', async () => {
    const records = await rawAggregate([
      { $match: { tenantId: TENANT } },
      { $group: { _id: null, total: { $sum: 1 } } },
    ]);

    expect(unscoped(records)).toHaveLength(0);
  });

  it('does not accept an outer $match as scoping a joined collection', async () => {
    const records = await rawAggregate([
      { $match: { tenantId: TENANT } },
      {
        $lookup: {
          from: Part.collection.collectionName,
          localField: 'parts',
          foreignField: '_id',
          as: 'joined',
        },
      },
    ]);

    expect(unscoped(records)).toHaveLength(1);
  });

  it('accepts a $lookup whose sub-pipeline leads with the tenant $match', async () => {
    const records = await rawAggregate([
      { $match: { tenantId: TENANT } },
      {
        $lookup: {
          from: Part.collection.collectionName,
          pipeline: [{ $match: { tenantId: TENANT } }],
          as: 'joined',
        },
      },
    ]);

    expect(unscoped(records)).toHaveLength(0);
  });

  /**
   * `$out` and `$merge` rewrite another collection from inside the aggregate,
   * so the destination write never surfaces as its own command to inspect.
   */
  it('rejects a pipeline that writes to another collection', async () => {
    const records = await rawAggregate([
      { $match: { tenantId: TENANT } },
      { $out: 'probe_out_target' },
    ]);

    expect(unscoped(records)).toHaveLength(1);
  });

  /**
   * A cursor continuation carries no predicate, and the scope its cursor was
   * opened under is not visible here — so it must be reported rather than
   * silently dropped, or a cursor primed under one scope could be drained under
   * another with the probe seeing nothing at all.
   */
  it('reports a cursor continuation rather than discarding it', async () => {
    await tenantStorage.run({ tenantId: SYSTEM_TENANT_ID }, async () => {
      await Widget.insertMany(
        Array.from({ length: 6 }, (_, index) => ({ name: `batched-${index}`, tenantId: TENANT })),
      );
    });

    const records = await probe.record(() =>
      asTenant(async () => {
        const cursor = mongoose.connection
          .db!.collection(Widget.collection.collectionName)
          .find({ tenantId: TENANT })
          .batchSize(2);
        await cursor.toArray();
      }),
    );

    expect(records.some((record) => record.commandName === 'getMore')).toBe(true);
  });

  /**
   * A collation can broaden equality — under a case-insensitive one,
   * `tenantId: 'tenant-a'` also matches `TENANT-A` — so the literal predicate
   * no longer proves isolation.
   */
  it('does not accept a predicate broadened by a collation', async () => {
    const records = await probe.record(() =>
      asTenant(async () => {
        await mongoose.connection
          .db!.collection(Widget.collection.collectionName)
          .find({ tenantId: TENANT }, { collation: { locale: 'en', strength: 2 } })
          .toArray();
      }),
    );

    expect(unscoped(records)).toHaveLength(1);
  });

  /**
   * `.explain()` nests the real command inside an `explain` envelope. Without
   * unwrapping it the operation is invisible, though `executionStats` still
   * reveals cross-tenant cardinality.
   */
  it('unwraps an explain envelope instead of dropping it', async () => {
    const records = await probe.record(() =>
      asTenant(async () => {
        await mongoose.connection
          .db!.collection(Widget.collection.collectionName)
          .find({ name: 'x' })
          .explain('queryPlanner');
      }),
    );

    expect(records).toHaveLength(1);
    expect(records[0].commandName).toBe('find');
    expect(records[0].scoped).toBe(false);
  });

  /**
   * Diagnostics run inside the driver's synchronous event handler, so a
   * serialization throw would escape into the database operation itself.
   */
  it('does not throw out of the listener on a value JSON cannot serialize', async () => {
    const records = await probe.record(() =>
      asTenant(async () => {
        await mongoose.connection
          .db!.collection(Widget.collection.collectionName)
          .find({ tenantId: TENANT, big: { $gt: BigInt(1) } } as unknown as Record<string, unknown>)
          .toArray()
          .catch(() => undefined);
      }),
    );

    expect(records).toHaveLength(1);
    expect(records[0].predicate).toContain('tenantId');
  });

  /**
   * Dropping a collection destroys every tenant's rows. It carries no predicate
   * to inspect, so the only safe report is an unscoped one — silence would be a
   * green result for the most destructive escape hatch there is.
   */
  it('reports a collection drop as unscoped', async () => {
    const records = await probe.record(() =>
      asTenant(async () => {
        await mongoose.connection
          .db!.collection(Widget.collection.collectionName)
          .drop()
          .catch(() => undefined);
      }),
    );

    expect(unscoped(records)).toHaveLength(1);
    expect(records[0].commandName).toBe('drop');
  });

  /** `update` and `delete` carry collation per batched operation, not on the envelope. */
  it.each([
    [
      'updateOne',
      async () =>
        mongoose.connection.db!.collection(Widget.collection.collectionName).updateOne(
          { tenantId: TENANT },
          { $set: { name: 'x' } },
          {
            collation: { locale: 'en', strength: 2 },
          },
        ),
    ],
    [
      'deleteOne',
      async () =>
        mongoose.connection
          .db!.collection(Widget.collection.collectionName)
          .deleteOne({ tenantId: TENANT }, { collation: { locale: 'en', strength: 2 } }),
    ],
  ])('does not accept a per-operation collation on %s', async (_label, operation) => {
    const records = await probe.record(() => asTenant(async () => void (await operation())));

    expect(unscoped(records)).toHaveLength(1);
  });

  it('reports nothing for collections it does not watch', async () => {
    const records = await probe.record(() =>
      asTenant(async () => {
        await mongoose.connection.db!.collection('unwatched').find({}).toArray();
      }),
    );

    expect(records).toHaveLength(0);
  });
});

describe('query paths reach the wire scoped', () => {
  it.each([
    ['find', () => Widget.find({ name: 'x' })],
    ['findOne', () => Widget.findOne({ name: 'x' })],
    ['countDocuments', () => Widget.countDocuments({ name: 'x' })],
    ['distinct', () => Widget.distinct('name')],
    ['updateOne', () => Widget.updateOne({ name: 'x' }, { $set: { name: 'y' } })],
    ['updateMany', () => Widget.updateMany({ name: 'x' }, { $set: { name: 'y' } })],
    ['deleteOne', () => Widget.deleteOne({ name: 'x' })],
    ['deleteMany', () => Widget.deleteMany({ name: 'x' })],
    ['findOneAndUpdate', () => Widget.findOneAndUpdate({ name: 'x' }, { $set: { name: 'y' } })],
    ['findOneAndDelete', () => Widget.findOneAndDelete({ name: 'x' })],
    ['replaceOne', () => Widget.replaceOne({ name: 'x' }, { name: 'y' })],
    ['findOneAndReplace', () => Widget.findOneAndReplace({ name: 'x' }, { name: 'y' })],
    ['aggregate', () => Widget.aggregate([{ $group: { _id: '$name' } }])],
  ])('%s', async (_label, operation) => {
    const records = await probe.record(() => asTenant(async () => void (await operation())));

    expect(records.length).toBeGreaterThan(0);
    expect(describeLeaks(records)).toBe('');
  });
});

/**
 * `estimatedDocumentCount()` reads collection metadata and takes no filter, so
 * no binding can scope it — it is a genuine global side channel, currently used
 * once at `models/plugins/mongoMeili.ts` for a sync progress log on a boot path.
 * Pinned so it stays visible; making scoped callers fail closed is a runtime
 * change and belongs in its own PR.
 */
describe('estimatedDocumentCount is a known unscoped side channel', () => {
  it('reaches the wire with no tenant predicate', async () => {
    const records = await probe.record(() =>
      asTenant(async () => void (await Widget.estimatedDocumentCount())),
    );

    expect(records).toHaveLength(1);
    expect(records[0].scoped).toBe(false);
  });
});

describe('write paths reach the wire scoped', () => {
  it('Model.create', async () => {
    const records = await probe.record(() =>
      asTenant(async () => void (await Widget.create({ name: 'created', parts: [] }))),
    );

    expect(records.length).toBeGreaterThan(0);
    expect(describeLeaks(records)).toBe('');
  });

  it('insertMany', async () => {
    const records = await probe.record(() =>
      asTenant(async () => void (await Widget.insertMany([{ name: 'a' }, { name: 'b' }]))),
    );

    expect(records.length).toBeGreaterThan(0);
    expect(describeLeaks(records)).toBe('');
  });

  it('tenantSafeBulkWrite', async () => {
    const records = await probe.record(() =>
      asTenant(async () =>
        tenantSafeBulkWrite(Widget, [
          { insertOne: { document: { name: 'bulk' } } },
          { updateOne: { filter: { name: 'bulk' }, update: { $set: { name: 'bulk2' } } } },
          { deleteOne: { filter: { name: 'gone' } } },
        ]),
      ),
    );

    expect(records.length).toBeGreaterThan(0);
    expect(describeLeaks(records)).toBe('');
  });
});

/**
 * These are the paths that make schema middleware irreplaceable: none of them
 * pass through a wrapper around the model's static methods, but all of them
 * reach the database.
 */
describe('document-level paths reach the wire scoped', () => {
  it('doc.save() on a new document', async () => {
    const records = await probe.record(() =>
      asTenant(async () => {
        const widget = new Widget({ name: 'saved' });
        await widget.save();
      }),
    );

    expect(records.length).toBeGreaterThan(0);
    expect(describeLeaks(records)).toBe('');
  });

  it('doc.save() on a fetched document asserts the tenant in its predicate', async () => {
    await asTenant(async () => void (await Widget.create({ name: 'fetched', parts: [] })));

    const records = await probe.record(() =>
      asTenant(async () => {
        const widget = await Widget.findOne({ name: 'fetched' });
        widget!.name = 'renamed';
        await widget!.save();
      }),
    );

    const updates = records.filter((record) => record.commandName === 'update');
    expect(updates).toHaveLength(1);
    expect(updates[0].predicate).toContain('tenantId');
    expect(describeLeaks(records)).toBe('');
  });

  it('doc.updateOne()', async () => {
    await asTenant(async () => void (await Widget.create({ name: 'target', parts: [] })));

    const records = await probe.record(() =>
      asTenant(async () => {
        const widget = await Widget.findOne({ name: 'target' });
        await widget!.updateOne({ $set: { name: 'updated' } });
      }),
    );

    expect(records.length).toBeGreaterThan(0);
    expect(describeLeaks(records)).toBe('');
  });

  /**
   * `Document.prototype.deleteOne()` is called out in `schema/auditLog.ts` as an
   * escape hatch around *document* middleware. It is not one for tenant
   * filtering — it builds a Query, so the query-level hook still fires — but
   * nothing pinned that, so a future change could silently make it one.
   */
  it('doc.deleteOne() reaches the wire scoped', async () => {
    await asTenant(async () => void (await Widget.create({ name: 'doomed', parts: [] })));

    const records = await probe.record(() =>
      asTenant(async () => {
        const widget = await Widget.findOne({ name: 'doomed' });
        await widget!.deleteOne();
      }),
    );

    const deletes = records.filter((record) => record.commandName === 'delete');
    expect(deletes).toHaveLength(1);
    expect(describeLeaks(records)).toBe('');
  });

  it('doc.deleteOne() cannot remove another tenant document', async () => {
    const foreign = await tenantStorage.run({ tenantId: 'tenant-b' }, async () =>
      Widget.create({ name: 'foreign-doomed', parts: [] }),
    );
    const smuggled = await tenantStorage.run({ tenantId: SYSTEM_TENANT_ID }, async () =>
      Widget.findById(foreign._id),
    );

    await asTenant(async () => void (await smuggled!.deleteOne()));

    const survivor = await tenantStorage.run({ tenantId: SYSTEM_TENANT_ID }, async () =>
      Widget.findById(foreign._id).lean(),
    );
    expect(survivor).not.toBeNull();
  });

  it('populate() issues its own query', async () => {
    await asTenant(async () => {
      const part = await Part.create({ label: 'part-1' });
      await Widget.create({ name: 'parent', parts: [part._id] });
    });

    const records = await probe.record(() =>
      asTenant(async () => void (await Widget.findOne({ name: 'parent' }).populate('parts'))),
    );

    const partReads = records.filter(
      (record) => record.collection === Part.collection.collectionName,
    );
    expect(partReads.length).toBeGreaterThan(0);
    expect(describeLeaks(records)).toBe('');
  });
});

describe('system scope', () => {
  it('deliberately reaches the wire unscoped', async () => {
    const records = await probe.record(() =>
      tenantStorage.run({ tenantId: SYSTEM_TENANT_ID }, async () => {
        await Widget.find({ name: 'x' });
      }),
    );

    expect(unscoped(records)).toHaveLength(1);
  });
});

/**
 * The predicate added to `save()` must harden the cross-tenant case without
 * refusing writes that were always legitimate.
 */
describe('save predicate does not break legitimate writes', () => {
  it.each([
    ['missing', undefined],
    ['empty', ''],
  ])(
    'a document with a %s tenant can be claimed by the active tenant',
    async (_label, tenantId) => {
      const created = await tenantStorage.run({ tenantId: SYSTEM_TENANT_ID }, async () =>
        Widget.create({ name: 'pre-tenancy', parts: [], tenantId }),
      );

      const widget = await tenantStorage.run({ tenantId: SYSTEM_TENANT_ID }, async () =>
        Widget.findById(created._id),
      );
      await asTenant(async () => {
        const scopedWidget = await Widget.findById(created._id);
        expect(scopedWidget).toBeNull();
      });

      widget!.name = 'renamed';
      await asTenant(async () => widget!.save());

      const fresh = await tenantStorage.run({ tenantId: SYSTEM_TENANT_ID }, async () =>
        Widget.findById(created._id).lean(),
      );
      expect(fresh!.name).toBe('renamed');
      expect(fresh!.tenantId).toBe(TENANT);
    },
  );

  it('allows only one tenant to claim a legacy document', async () => {
    const created = await tenantStorage.run({ tenantId: SYSTEM_TENANT_ID }, async () =>
      Widget.create({ name: 'legacy-race', parts: [] }),
    );
    const [first, second] = await tenantStorage.run({ tenantId: SYSTEM_TENANT_ID }, async () =>
      Promise.all([Widget.findById(created._id), Widget.findById(created._id)]),
    );

    first!.name = 'claimed-a';
    await asTenant(async () => first!.save());

    second!.name = 'claimed-b';
    await expect(
      tenantStorage.run({ tenantId: 'tenant-b' }, async () => second!.save()),
    ).rejects.toThrow('No document found');

    const fresh = await tenantStorage.run({ tenantId: SYSTEM_TENANT_ID }, async () =>
      Widget.findById(created._id).lean(),
    );
    expect(fresh).toMatchObject({ name: 'claimed-a', tenantId: TENANT });
  });

  it('does not trust a projected-out tenantId', async () => {
    const foreign = await tenantStorage.run({ tenantId: 'tenant-b' }, async () =>
      Widget.create({ name: 'projected-foreign', parts: [] }),
    );
    const projected = await tenantStorage.run({ tenantId: SYSTEM_TENANT_ID }, async () =>
      Widget.findById(foreign._id).select('-tenantId'),
    );
    expect(projected!.tenantId).toBeUndefined();

    projected!.name = 'projected-stolen';
    await expect(asTenant(async () => projected!.save())).rejects.toThrow('No document found');
    expect(projected!.tenantId).toBeUndefined();

    projected!.name = 'system-recovered';
    await tenantStorage.run({ tenantId: SYSTEM_TENANT_ID }, async () => projected!.save());

    const fresh = await tenantStorage.run({ tenantId: SYSTEM_TENANT_ID }, async () =>
      Widget.findById(foreign._id).lean(),
    );
    expect(fresh).toMatchObject({ name: 'system-recovered', tenantId: 'tenant-b' });
  });

  it('rejects tenantId mutation on a persisted document', async () => {
    const widget = await asTenant(async () => Widget.create({ name: 'tenant-move', parts: [] }));

    widget.tenantId = 'tenant-b';
    widget.name = 'moved';
    await expect(asTenant(async () => widget.save())).rejects.toThrow(
      '[TenantIsolation] Cross-tenant tenantId mutation is not allowed',
    );

    const fresh = await tenantStorage.run({ tenantId: SYSTEM_TENANT_ID }, async () =>
      Widget.findById(widget._id).lean(),
    );
    expect(fresh).toMatchObject({ name: 'tenant-move', tenantId: TENANT });
  });

  it('refuses to save a document belonging to another tenant', async () => {
    const foreign = await tenantStorage.run({ tenantId: 'tenant-b' }, async () =>
      Widget.create({ name: 'foreign', parts: [] }),
    );

    const smuggled = await tenantStorage.run({ tenantId: SYSTEM_TENANT_ID }, async () =>
      Widget.findById(foreign._id),
    );

    await expect(
      asTenant(async () => {
        smuggled!.name = 'stolen';
        await smuggled!.save();
      }),
    ).rejects.toThrow('No document found');

    const fresh = await tenantStorage.run({ tenantId: SYSTEM_TENANT_ID }, async () =>
      Widget.findById(foreign._id).lean(),
    );
    expect(fresh!.name).toBe('foreign');

    smuggled!.name = 'system-recovered';
    await tenantStorage.run({ tenantId: SYSTEM_TENANT_ID }, async () => smuggled!.save());

    const recovered = await tenantStorage.run({ tenantId: SYSTEM_TENANT_ID }, async () =>
      Widget.findById(foreign._id).lean(),
    );
    expect(recovered!.name).toBe('system-recovered');
  });

  it('leaves system-scoped saves unfiltered', async () => {
    const created = await asTenant(async () => Widget.create({ name: 'sys-target', parts: [] }));

    const widget = await tenantStorage.run({ tenantId: SYSTEM_TENANT_ID }, async () =>
      Widget.findById(created._id),
    );
    widget!.name = 'tenant-renamed';
    await asTenant(async () => widget!.save());

    const records = await probe.record(() =>
      tenantStorage.run({ tenantId: SYSTEM_TENANT_ID }, async () => {
        widget!.name = 'sys-renamed';
        await widget!.save();
      }),
    );

    const updates = records.filter((record) => record.commandName === 'update');
    expect(updates).toHaveLength(1);
    expect(updates[0].predicate).not.toContain('tenantId');

    widget!.name = 'sys-renamed-again';
    await tenantStorage.run({ tenantId: SYSTEM_TENANT_ID }, async () => {
      await widget!.save();
    });

    const fresh = await tenantStorage.run({ tenantId: SYSTEM_TENANT_ID }, async () =>
      Widget.findById(created._id).lean(),
    );
    expect(fresh!.name).toBe('sys-renamed-again');
  });
});
