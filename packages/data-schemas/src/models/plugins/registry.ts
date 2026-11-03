import { Schema } from 'mongoose';
import type { SchemaDefinition } from 'mongoose';
import type { ManagedRegistration } from '~/types/managed';
import { MANAGED_TARGET_KINDS } from '~/types/managed';

/** Canonical resource metadata is private; the payload-free ResponseScope remains directly readable. */
export function managedRegistryFields(hidden = false): SchemaDefinition {
  const visibility = hidden ? { select: false } : {};
  return {
    pending: {
      type: [
        new Schema<ManagedRegistration>(
          {
            key: { type: String, required: true },
            target: {
              kind: { type: String, enum: MANAGED_TARGET_KINDS, required: true },
              id: { type: String, required: true },
              incarnation: { type: String, required: true },
              tenantId: String,
            },
            retentionEpoch: { type: Number, required: true },
            authorityRevision: String,
          },
          { _id: false },
        ),
      ],
      default: undefined,
      ...visibility,
    },
    pendingCount: { type: Number, default: undefined, ...visibility },
    retentionEpoch: { type: Number, default: undefined, ...visibility },
  };
}

/** Keep internal admission state out of the resource's public record/update contract. */
export function applyManagedRegistry(schema: Schema): void {
  schema.add(managedRegistryFields(true));
}
