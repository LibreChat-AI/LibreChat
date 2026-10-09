import { Schema } from 'mongoose';
import { PrincipalType } from 'librechat-data-provider';
import type { ISystemGrant } from '~/types';
import { isValidCapability } from '~/admin/capabilities';

const systemGrantSchema: Schema<ISystemGrant> = new Schema<ISystemGrant>(
  {
    principalType: {
      type: String,
      enum: Object.values(PrincipalType),
      required: true,
    },
    principalId: {
      type: Schema.Types.Mixed,
      required: true,
    },
    capability: {
      type: String,
      required: true,
      validate: {
        validator: isValidCapability,
        message: 'Invalid capability string: "{VALUE}"',
      },
    },
    /**
     * Platform-level grants MUST omit this field entirely — never set it to null.
     * Queries for platform-level grants use `{ tenantId: { $exists: false } }`, which
     * matches absent fields but NOT `null`. A document stored with `{ tenantId: null }`
     * would silently match neither platform-level nor tenant-scoped queries.
     */
    tenantId: {
      type: String,
      required: false,
      validate: {
        validator: (v: unknown) => v !== null && v !== '',
        message: 'tenantId must be a non-empty string or omitted entirely — never null or empty',
      },
    },
    grantedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    grantedAt: {
      type: Date,
      default: Date.now,
    },
    /** Reserved for future TTL enforcement — time-bounded / temporary grants. Not enforced yet. */
    expiresAt: {
      type: Date,
      required: false,
    },
  },
  { timestamps: true },
);

/*
 * principalId normalization (string → ObjectId for USER/GROUP) is handled
 * explicitly by grantCapability — the only sanctioned write path.
 * All writes MUST go through grantCapability; do not use Model.create()
 * or save() directly, as there is no schema-level normalization hook.
 */

systemGrantSchema.index(
  { principalType: 1, principalId: 1, capability: 1, tenantId: 1 },
  { unique: true },
);

systemGrantSchema.index({ capability: 1, tenantId: 1 });
systemGrantSchema.index({ principalType: 1, capability: 1, tenantId: 1 });

export default systemGrantSchema;
