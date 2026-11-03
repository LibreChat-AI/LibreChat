import { Schema } from 'mongoose';
import type { Query, Aggregate } from 'mongoose';
import type { ManagedState } from '~/types/managed';
import { includesManagedAllocations, managedVisibilityFilter } from '~/utils/managed';

const applied = new WeakSet<Schema>();

/** Hide ownerless allocation metadata without a per-message lookup or a new history layer. */
export function applyManagedStorage(schema: Schema): void {
  if (applied.has(schema)) return;
  applied.add(schema);
  schema.add({
    _managed: {
      type: new Schema<ManagedState>(
        {
          incarnation: { type: String, required: true },
          phase: {
            type: String,
            required: true,
            enum: ['empty', 'pinned', 'registering', 'registered', 'published', 'retired'],
          },
          parentId: String,
          ownerKey: String,
          conversationKey: String,
          receipt: String,
          logicalId: String,
        },
        { _id: false },
      ),
      select: false,
      default: undefined,
    },
  });
  function filter(this: Query<unknown, unknown>): void {
    if (!includesManagedAllocations(this)) this.and([managedVisibilityFilter]);
  }
  schema.pre('find', filter);
  schema.pre('findOne', filter);
  schema.pre('distinct', filter);
  schema.pre('countDocuments', filter);
  schema.pre('aggregate', function (this: Aggregate<unknown>): void {
    if (includesManagedAllocations(this)) return;
    this.pipeline().unshift({ $match: managedVisibilityFilter });
  });
}
