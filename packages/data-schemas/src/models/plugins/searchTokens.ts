import type { Schema, Query } from 'mongoose';
import type { SearchTokenField } from '~/utils/search';
import { withSearchTokens, searchTokenIndexes, computeSearchTokens } from '~/utils/search';

/**
 * Adds the derived search-token arrays of `fields` to `schema`, indexes each
 * with `tenantId` in both key orders (see `searchTokenIndexes`), and keeps them in sync on `save`, `insertMany` and the
 * update queries. `bulkWrite` runs no middleware: callers that change a source
 * field through it must apply `withSearchTokens` themselves.
 *
 * Token fields are `select: false` and stripped from `toJSON`/`toObject`
 * output (a freshly saved document still holds them); they exist for the
 * index, not for readers.
 */
export function applySearchTokens(schema: Schema, fields: readonly SearchTokenField[]): void {
  for (const field of fields) {
    schema.add({ [field.tokens]: { type: [String], default: undefined, select: false } });
    for (const index of searchTokenIndexes(field)) {
      schema.index(index);
    }
  }

  for (const option of ['toJSON', 'toObject'] as const) {
    schema.set(option, {
      ...schema.get(option),
      transform(_doc, ret: Record<string, unknown>) {
        for (const field of fields) {
          delete ret[field.tokens];
        }
        return ret;
      },
    });
  }

  schema.pre('save', function () {
    for (const field of fields) {
      if (this.isNew || this.isModified(field.source)) {
        this.set(field.tokens, computeSearchTokens(field.kind, this.get(field.source)));
      }
    }
  });

  schema.pre(
    ['findOneAndUpdate', 'updateOne', 'updateMany'],
    { document: false, query: true },
    function (this: Query<unknown, unknown>) {
      const update = this.getUpdate();
      if (!update) {
        return;
      }
      const next = withSearchTokens(fields, update, {
        upsert: this.getOptions().upsert === true,
        filter: this.getFilter(),
      });
      if (next !== update) {
        this.setUpdate(next);
      }
    },
  );

  schema.pre('insertMany', function (next, docs: unknown) {
    if (Array.isArray(docs)) {
      for (const doc of docs as Array<Record<string, unknown>>) {
        for (const field of fields) {
          doc[field.tokens] = computeSearchTokens(field.kind, doc[field.source]);
        }
      }
    }
    next();
  });
}
