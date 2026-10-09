import { Schema } from 'mongoose';
import type { ISkillFileDocument } from '~/types/skill';
import { codeEnvRefMapSchema, codeEnvRefSchema } from './codeEnvRef';

/** Max length for a skill file's relative path (e.g. "scripts/parse.sh"). */
const SKILL_FILE_PATH_MAX_LENGTH = 500;

/** Pattern for valid path characters — conservative allowlist. */
const relativePathCharPattern = /^[a-zA-Z0-9._\-/]+$/;

const skillFileSchema: Schema<ISkillFileDocument> = new Schema(
  {
    skillId: {
      type: Schema.Types.ObjectId,
      ref: 'Skill',
      required: true,
      index: true,
    },
    relativePath: {
      type: String,
      required: true,
      maxlength: [
        SKILL_FILE_PATH_MAX_LENGTH,
        `Relative path cannot exceed ${SKILL_FILE_PATH_MAX_LENGTH} characters`,
      ],
      validate: {
        validator: function (value: string): boolean {
          if (!value || value.length === 0) {
            return false;
          }
          if (value.startsWith('/') || value.startsWith('\\')) {
            return false;
          }
          if (!relativePathCharPattern.test(value)) {
            return false;
          }
          const segments = value.split('/');
          if (segments.some((s) => s === '' || s === '.' || s === '..')) {
            return false;
          }
          if (value === 'SKILL.md' || segments[0] === 'SKILL.md') {
            return false;
          }
          return true;
        },
        message:
          'Relative path must be relative, cannot contain ".." or absolute paths, and cannot be SKILL.md.',
      },
    },
    file_id: {
      type: String,
      required: true,
      index: true,
    },
    filename: {
      type: String,
      required: true,
    },
    filepath: {
      type: String,
      required: true,
    },
    storageKey: {
      type: String,
    },
    storageRegion: {
      type: String,
    },
    source: {
      type: String,
      required: true,
    },
    sourceMetadata: {
      type: Schema.Types.Mixed,
    },
    mimeType: {
      type: String,
      required: true,
    },
    bytes: {
      type: Number,
      required: true,
      min: 0,
    },
    category: {
      type: String,
      enum: ['script', 'reference', 'asset', 'other'],
      default: 'other',
    },
    isExecutable: {
      type: Boolean,
      default: false,
    },
    author: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    tenantId: {
      type: String,
      index: true,
    },
    content: {
      type: String,
    },
    isBinary: {
      type: Boolean,
    },
    codeEnvRef: {
      type: codeEnvRefSchema,
      default: undefined,
    },
    codeEnvRefs: {
      type: codeEnvRefMapSchema,
      default: undefined,
    },
  },
  {
    timestamps: true,
  },
);

skillFileSchema.index({ skillId: 1, relativePath: 1 }, { unique: true });
skillFileSchema.index({ skillId: 1, category: 1 });

export default skillFileSchema;
