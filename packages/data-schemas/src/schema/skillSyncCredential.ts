import { Schema } from 'mongoose';
import type { ISkillSyncCredentialDocument } from '~/types/skillSync';

const skillSyncCredentialSchema: Schema<ISkillSyncCredentialDocument> = new Schema(
  {
    provider: {
      type: String,
      enum: ['github'],
      required: true,
      index: true,
    },
    credentialKey: {
      type: String,
      required: true,
      maxlength: 64,
      match: /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/,
      index: true,
    },
    encryptedToken: {
      type: String,
      required: true,
      select: false,
    },
    tokenHash: {
      type: String,
      required: true,
      select: false,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  {
    timestamps: true,
  },
);

skillSyncCredentialSchema.index({ provider: 1, credentialKey: 1 }, { unique: true });

export default skillSyncCredentialSchema;
