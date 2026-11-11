import { Schema } from 'mongoose';
import type { Model } from 'mongoose';

interface ChannelScope {
  _id: string;
  closed: boolean;
  revision: number;
}

/** Payload-free deletion fences survive connection erasure and reject delayed writers. */
export function createChannelScopeModel(mongoose: typeof import('mongoose')): Model<ChannelScope> {
  return (
    mongoose.models.ChannelScope ??
    mongoose.model<ChannelScope>(
      'ChannelScope',
      new Schema<ChannelScope>(
        {
          _id: { type: String, required: true },
          closed: { type: Boolean, required: true, default: false },
          revision: { type: Number, required: true, default: 0 },
        },
        { versionKey: false },
      ),
    )
  );
}
