import { Schema, Document } from 'mongoose';
import { BANNER_VARIANTS } from 'librechat-data-provider';
import type { BannerVariant } from 'librechat-data-provider';

export interface IBanner extends Document {
  bannerId: string;
  message: string;
  displayFrom: Date;
  displayTo?: Date;
  type: 'banner' | 'popup';
  isPublic: boolean;
  variant?: BannerVariant;
  persistable: boolean;
  tenantId?: string;
}

const bannerSchema: Schema<IBanner> = new Schema<IBanner>(
  {
    bannerId: {
      type: String,
      required: true,
    },
    message: {
      type: String,
      required: true,
    },
    displayFrom: {
      type: Date,
      required: true,
      default: Date.now,
    },
    displayTo: {
      type: Date,
    },
    type: {
      type: String,
      enum: ['banner', 'popup'],
      default: 'banner',
    },
    isPublic: {
      type: Boolean,
      default: false,
    },
    variant: {
      type: String,
      enum: BANNER_VARIANTS,
    },
    persistable: {
      type: Boolean,
      default: false,
    },
    tenantId: {
      type: String,
      index: true,
    },
  },
  { timestamps: true },
);

export default bannerSchema;
