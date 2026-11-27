import { Schema, Document } from 'mongoose';

export interface ICategory extends Document {
  label: string;
  value: string;
  tenantId?: string;
}

const categoriesSchema: Schema<ICategory> = new Schema<ICategory>({
  label: {
    type: String,
    required: true,
  },
  value: {
    type: String,
    required: true,
  },
  tenantId: {
    type: String,
    index: true,
  },
});

categoriesSchema.index({ label: 1, tenantId: 1 }, { unique: true });
categoriesSchema.index({ value: 1, tenantId: 1 }, { unique: true });

export default categoriesSchema;
