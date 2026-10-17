import type { BannerVariant } from 'librechat-data-provider';
import type { Document } from 'mongoose';

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
