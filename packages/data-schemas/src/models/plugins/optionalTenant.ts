import type { Schema } from 'mongoose';

/** Platform-owned media omits tenantId; explicit null query fences still match historical rows. */
export function omitDefaultTenant(schema: Schema): void {
  schema.pre('save', function () {
    if (this.get('tenantId') === null) this.set('tenantId', undefined);
  });
  schema.pre('insertMany', function (next, documents) {
    for (const document of documents) {
      if (document.tenantId === null) delete document.tenantId;
    }
    next();
  });
  schema.pre(['updateOne', 'updateMany', 'findOneAndUpdate'], function () {
    if (!this.getOptions().upsert) return;
    const update = this.getUpdate();
    if (!update || Array.isArray(update)) return;
    const tenantId =
      update.$set?.tenantId ?? update.$setOnInsert?.tenantId ?? this.getFilter().tenantId;
    if (tenantId !== null) return;
    if (update.$set) delete update.$set.tenantId;
    if (update.$setOnInsert) delete update.$setOnInsert.tenantId;
    // A disjunction preserves null/missing semantics without Mongo copying a scalar equality
    // into the inserted document. Tenant mutation guards stay intact.
    const filter = this.getFilter();
    delete filter.tenantId;
    filter.$and = [
      ...(filter.$and ?? []),
      { $or: [{ tenantId: null }, { tenantId: { $exists: false } }] },
    ];
    this.setQuery(filter);
  });
}
