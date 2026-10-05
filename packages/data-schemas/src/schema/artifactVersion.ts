import { Schema } from 'mongoose';
import { isAllowedArtifactPreviewUrl } from 'librechat-data-provider';
import type { Query, UpdateQuery } from 'mongoose';
import type { IArtifactVersion } from '~/types';

const runtimeConfigSchema = new Schema(
  {
    dependencies: { type: Schema.Types.Mixed, default: undefined },
    entryPoint: { type: String },
    renderMode: { type: String },
  },
  { _id: false },
);

const integritySchema = new Schema(
  {
    sourceHash: { type: String, required: true },
    schemaVersion: { type: Number, required: true },
  },
  { _id: false },
);

const artifactPreviewSchema = new Schema(
  {
    type: { type: String, enum: ['image'], required: true },
    imageUrl: {
      type: String,
      required: true,
      maxlength: 75_000,
      validate: {
        validator: isAllowedArtifactPreviewUrl,
        message: 'Artifact preview must be a base64 PNG, JPEG, or WebP image',
      },
    },
    alt: { type: String, maxlength: 500 },
  },
  { _id: false },
);

const publicationSchema = new Schema(
  {
    state: {
      type: String,
      enum: ['draft', 'released', 'withdrawn'],
      default: 'draft',
    },
    releasedBy: { type: String },
    releasedAt: { type: Date },
  },
  { _id: false },
);

const artifactVersionSchema: Schema<IArtifactVersion> = new Schema<IArtifactVersion>(
  {
    artifactVersionId: {
      type: String,
      required: true,
    },
    artifactAppId: {
      type: String,
      required: true,
    },
    tenantId: {
      type: String,
    },
    versionNumber: {
      type: Number,
      required: true,
    },
    versionLabel: {
      type: String,
    },
    changelog: {
      type: String,
    },
    artifactType: {
      type: String,
      enum: [
        'react',
        'html',
        'svg',
        'mermaid',
        'markdown',
        'text',
        'code',
        'document',
        'spreadsheet',
        'presentation',
      ],
      required: true,
    },
    sourceSnapshot: {
      type: String,
      required: true,
    },
    runtimeConfig: {
      type: runtimeConfigSchema,
      default: () => ({}),
    },
    preview: {
      type: artifactPreviewSchema,
      default: undefined,
    },
    integrity: {
      type: integritySchema,
      required: true,
    },
    createdBy: {
      type: String,
      required: true,
    },
    publication: {
      type: publicationSchema,
      default: () => ({}),
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  },
);

const snapshotFields = [
  'sourceSnapshot',
  'artifactType',
  'runtimeConfig',
  'preview',
  'integrity',
  'versionNumber',
  'artifactAppId',
  'artifactVersionId',
] as const;

function isSnapshotPath(path: string): boolean {
  return snapshotFields.some((field) => path === field || path.startsWith(`${field}.`));
}

const previousSaveFilters = new WeakMap<IArtifactVersion, IArtifactVersion['$where']>();

function restoreSaveFilter(document: IArtifactVersion): void {
  if (previousSaveFilters.has(document)) {
    document.$where = previousSaveFilters.get(document) ?? {};
    previousSaveFilters.delete(document);
  }
}

/** The predicate is part of the write so a concurrent release cannot race a pre-read. */
artifactVersionSchema.pre('save', function () {
  restoreSaveFilter(this);
  if (this.isNew) {
    return;
  }
  if (
    snapshotFields.some((field) => this.isModified(field)) ||
    (this.isModified('publication') &&
      this.publication?.state !== 'released' &&
      this.publication?.state !== 'withdrawn')
  ) {
    previousSaveFilters.set(this, this.$where);
    this.$where = {
      ...this.$where,
      'publication.state': 'draft',
      'publication.releasedAt': { $exists: false },
    };
  }
});

artifactVersionSchema.post('save', restoreSaveFilter);
artifactVersionSchema.post(
  'save',
  function (error: Error, document: IArtifactVersion, next: (error?: Error) => void) {
    if (document) {
      restoreSaveFilter(document);
    }
    next(error);
  },
);

function guardVersionUpdate(this: Query<unknown, IArtifactVersion>) {
  const update = this.getUpdate();
  if (!update) {
    return;
  }
  if (Array.isArray(update)) {
    throw new Error('Artifact versions do not support pipeline updates');
  }
  let requiresDraft = false;
  for (const [operator, fields] of Object.entries(update as UpdateQuery<IArtifactVersion>)) {
    if (!operator.startsWith('$')) {
      throw new Error('Artifact versions require explicit update operators');
    }
    for (const [path, value] of Object.entries(fields)) {
      if (
        isSnapshotPath(path) ||
        (operator === '$rename' && typeof value === 'string' && isSnapshotPath(value))
      ) {
        requiresDraft = true;
      }
      if (path === 'publication' || path === 'publication.state') {
        const state =
          path === 'publication' ? (value as IArtifactVersion['publication'] | null)?.state : value;
        if (operator !== '$set' || (state !== 'released' && state !== 'withdrawn')) {
          requiresDraft = true;
        }
      }
      if (
        operator === '$rename' &&
        typeof value === 'string' &&
        (value === 'publication' || value.startsWith('publication.'))
      ) {
        requiresDraft = true;
      }
    }
  }
  if (requiresDraft) {
    this.setQuery({
      $and: [
        this.getFilter(),
        { 'publication.state': 'draft', 'publication.releasedAt': { $exists: false } },
      ],
    });
  }
}

artifactVersionSchema.pre(['updateOne', 'updateMany', 'findOneAndUpdate'], guardVersionUpdate);
artifactVersionSchema.pre(['replaceOne', 'findOneAndReplace'], function () {
  throw new Error('Artifact versions cannot be replaced');
});
artifactVersionSchema.pre('bulkWrite', function (next, operations) {
  if (
    operations.some(
      (operation) =>
        'updateOne' in operation || 'updateMany' in operation || 'replaceOne' in operation,
    )
  ) {
    next(new Error('Artifact version mutations must use guarded document or query writes'));
    return;
  }
  next();
});

artifactVersionSchema.index({ tenantId: 1, artifactAppId: 1, versionNumber: 1 }, { unique: true });
artifactVersionSchema.index({ tenantId: 1, artifactVersionId: 1 }, { unique: true });

export default artifactVersionSchema;
