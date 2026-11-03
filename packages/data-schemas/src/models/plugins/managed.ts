import { Schema } from 'mongoose';
import type { Query, Aggregate } from 'mongoose';
import type { ManagedState } from '~/types/managed';
import { includesManagedAllocations, managedVisibilityFilter } from '~/utils/managed';

const applied = new WeakSet<Schema>();
const channelApplied = new WeakSet<Schema>();

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
          scopeKeys: {
            type: [{ type: String, match: /^[a-f\d]{64}$/ }],
            default: undefined,
            // Fixed role topology: two owners, two channel keys, two link keys, one conversation.
            validate: (keys: string[]) => keys.length <= 7,
          },
          expiredAt: Date,
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

/** One index covers the fixed admission authorities without indexing ordinary chat history. */
export function applyChannelStorage(schema: Schema): void {
  applyManagedStorage(schema);
  if (channelApplied.has(schema)) return;
  channelApplied.add(schema);
  schema.index({ '_managed.scopeKeys': 1, _id: 1 });
}
