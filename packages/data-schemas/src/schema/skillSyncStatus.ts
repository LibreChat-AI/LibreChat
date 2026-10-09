import { Schema } from 'mongoose';
import type {
  ISkillSyncSkippedFile,
  ISkillSyncSkippedSkill,
  ISkillSyncStatusDocument,
} from '~/types/skillSync';

const skippedSkillSchema = new Schema<ISkillSyncSkippedSkill>(
  {
    path: {
      type: String,
      default: null,
      maxlength: 500,
      validate: {
        validator: (value: unknown) => typeof value === 'string',
        message: 'Path is required',
      },
    },
    name: {
      type: String,
      maxlength: 128,
    },
    errorCode: {
      type: String,
      required: true,
      maxlength: 64,
    },
    errorMessage: {
      type: String,
      required: true,
      maxlength: 500,
    },
  },
  { _id: false },
);

const skippedFileSchema = new Schema<ISkillSyncSkippedFile>(
  {
    path: {
      type: String,
      default: null,
      maxlength: 500,
      validate: {
        validator: (value: unknown) => typeof value === 'string',
        message: 'Path is required',
      },
    },
    /* A skill mirrored from the repository root has an empty root path, so this
       is validated for presence rather than marked `required`, which rejects the
       empty string. Same reason `skippedSkills.path` is written this way. */
    skillPath: {
      type: String,
      default: null,
      maxlength: 500,
      validate: {
        validator: (value: unknown) => typeof value === 'string',
        message: 'Skill path is required',
      },
    },
    errorCode: {
      type: String,
      required: true,
      maxlength: 64,
    },
    errorMessage: {
      type: String,
      required: true,
      maxlength: 500,
    },
  },
  { _id: false },
);

const skillSyncStatusSchema: Schema<ISkillSyncStatusDocument> = new Schema(
  {
    provider: {
      type: String,
      enum: ['github'],
      required: true,
      index: true,
    },
    sourceId: {
      type: String,
      required: true,
      maxlength: 128,
      index: true,
    },
    tenantId: {
      type: String,
      index: true,
    },
    status: {
      type: String,
      enum: ['idle', 'running', 'succeeded', 'partial', 'failed', 'skipped'],
      default: 'idle',
      required: true,
    },
    credentialKey: {
      type: String,
    },
    owner: {
      type: String,
    },
    repo: {
      type: String,
    },
    ref: {
      type: String,
    },
    paths: {
      type: [String],
      default: undefined,
    },
    startedAt: {
      type: Date,
    },
    finishedAt: {
      type: Date,
    },
    lastSuccessAt: {
      type: Date,
    },
    lastFailureAt: {
      type: Date,
    },
    errorCode: {
      type: String,
    },
    errorMessage: {
      type: String,
    },
    syncedSkillCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    syncedFileCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    deletedSkillCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    deletedFileCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    skippedSkillCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    skippedSkills: {
      type: [skippedSkillSchema],
      default: undefined,
    },
    skippedFileCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    skippedFiles: {
      type: [skippedFileSchema],
      default: undefined,
    },
    lockOwner: {
      type: String,
    },
    lockExpiresAt: {
      type: Date,
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

skillSyncStatusSchema.index({ provider: 1, sourceId: 1, tenantId: 1 }, { unique: true });

export default skillSyncStatusSchema;
