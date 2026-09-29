import { Schema } from 'mongoose';

export const codeEnvRefSchema: Schema = new Schema(
  {
    kind: {
      type: String,
      enum: ['skill', 'agent', 'user'],
      required: true,
    },
    id: { type: String, required: true },
    storage_session_id: { type: String, required: true },
    file_id: { type: String, required: true },
    version: { type: Number },
    executionProfile: {
      type: String,
      enum: ['default', 'stateful'],
    },
    executionRouteKey: { type: String },
    provisionedAt: { type: Number },
    sandboxFilename: { type: String },
  },
  { _id: false },
);

/** Route keys are `default`, `stateful`, or `stateful:<deployment hash>`.
 * Mixed preserves dot-addressed dynamic keys as a plain object; a Mongoose
 * Map would require every existing hydrated-document reader to switch from
 * bracket access to `.get()`. Values are produced through the typed
 * CodeEnvRef write paths and the singular compatibility field remains fully
 * schema-validated. */
export const codeEnvRefMapSchema: typeof Schema.Types.Mixed = Schema.Types.Mixed;
