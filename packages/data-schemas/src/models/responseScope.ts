import { Schema } from 'mongoose';
import type { Model } from 'mongoose';
import type { ManagedRegistration } from '~/types/managed';

interface ResponseScope {
  _id: string;
  closed: boolean;
  revision: number;
  expiredAt?: Date;
  pending?: ManagedRegistration[];
  pendingCount?: number;
  retentionEpoch?: number;
}

/** Payload-free admission anchors; closed scopes remain tombstones after erasure. */
export function createResponseScopeModel(
  mongoose: typeof import('mongoose'),
): Model<ResponseScope> {
  if (mongoose.models.ResponseScope) return mongoose.model<ResponseScope>('ResponseScope');
  const schema = new Schema<ResponseScope>(
    {
      _id: { type: String, required: true },
      closed: { type: Boolean, required: true, default: false },
      revision: { type: Number, required: true, default: 0 },
      expiredAt: Date,
      pending: {
        type: [
          {
            _id: false,
            key: { type: String, required: true },
            target: {
              kind: { type: String, enum: ['message', 'conversation'], required: true },
              id: { type: String, required: true },
              incarnation: { type: String, required: true },
              tenantId: String,
            },
            retentionEpoch: { type: Number, required: true },
          },
        ],
        default: undefined,
      },
      pendingCount: { type: Number, default: undefined },
      retentionEpoch: { type: Number, default: undefined },
    },
    // Closure and retention must be observed before any durable data is disclosed or mutated.
    { versionKey: false, read: 'primary' },
  );
  return mongoose.model<ResponseScope>('ResponseScope', schema);
}
