import mongoose, { Schema } from 'mongoose';
import { FileContext, FileSources } from 'librechat-data-provider';
import type { RunFileProvenance } from 'librechat-data-provider';
import type { IMongoFile } from '~/types';
import { codeEnvRefMapSchema, codeEnvRefSchema } from './codeEnvRef';

const runFileProvenanceSchema = new Schema<RunFileProvenance>(
  {
    runId: { type: String, required: true },
    executionId: { type: String, required: true },
    agentId: { type: String, required: true },
    parentExecutionId: { type: String },
    parentAgentId: { type: String },
    recipientAgentIds: { type: [String], default: undefined },
    sourceFileId: { type: String, required: true },
    publishedAt: { type: String, required: true },
    inputFileIds: { type: [String], required: true },
  },
  { _id: false },
);

const file: Schema<IMongoFile> = new Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
      required: true,
    },
    conversationId: {
      type: String,
      ref: 'Conversation',
      index: true,
    },
    messageId: {
      type: String,
      index: true,
    },
    file_id: {
      type: String,
      index: true,
      required: true,
    },
    temp_file_id: {
      type: String,
    },
    bytes: {
      type: Number,
      required: true,
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
    object: {
      type: String,
      required: true,
      default: 'file',
    },
    embedded: {
      type: Boolean,
    },
    type: {
      type: String,
      required: true,
    },
    text: {
      type: String,
    },
    textFormat: {
      /* 'html' when the backend produced a sanitized HTML preview
       * (office-type CDN/mammoth output), 'text' for plain-text
       * extracts (RAG / pdf-parse / mammoth.extractRawText). Clients
       * gate office-bucket routing on textFormat === 'html' to
       * prevent injecting RAG-extracted plain text into the iframe
       * as HTML. See Codex P1 review on PR #12934. */
      type: String,
      enum: ['html', 'text'],
    },
    status: {
      /* Deferred-preview code-execution flow: the immediate persist
       * step writes the record with 'pending'; the background render
       * (HTML extraction) updates to 'ready' or 'failed'. Absent on
       * legacy records and on file kinds that never expect a preview. */
      type: String,
      enum: ['pending', 'ready', 'failed'],
      index: true,
    },
    previewError: {
      type: String,
      /* Bounded to short machine-readable reasons (`'timeout'`,
       * `'parser-error'`, `'orphaned'`, `'unexpected'`). Cap prevents a
       * future codepath from accidentally persisting a stack trace or
       * full error message — would bloat documents and ship a wall of
       * text into the UI tooltip. */
      maxlength: 200,
    },
    previewRevision: {
      /* Generation marker for the deferred-preview lifecycle. Stamped
       * by the immediate persist step on every emit (each new emit
       * gets a fresh UUID); the deferred preview render's `updateFile`
       * only commits when the marker still matches what it was when
       * extraction started. Without this, two turns reusing the same
       * `(filename, conversationId)` share a `file_id`, and an older
       * render finishing after a newer one would silently overwrite
       * the newer record with stale `text`/`status`. (Codex P1 review
       * on PR #12957.) */
      type: String,
    },
    context: {
      type: String,
    },
    usage: {
      type: Number,
      required: true,
      default: 0,
    },
    source: {
      type: String,
      default: FileSources.local,
    },
    model: {
      type: String,
    },
    width: Number,
    height: Number,
    metadata: {
      runFile: {
        type: runFileProvenanceSchema,
        default: undefined,
        immutable: true,
      },
      codeEnvRef: {
        type: codeEnvRefSchema,
        default: undefined,
      },
      codeEnvRefs: {
        type: codeEnvRefMapSchema,
        default: undefined,
      },
      /** Dispatch-order stamp of the last writer (or claimant, on insert):
       *  the background harvest's stale-output guard compares writer
       *  dispatch order so an older task settling late cannot overwrite a
       *  newer task's same-named output. */
      sourceDispatchedAt: {
        type: Number,
        default: undefined,
      },
      /** Vector namespaces this file has been embedded into. Vectors are stored per
       *  entity, so a duplicated agent needs its own embedding even though the record
       *  is shared. */
      embeddedEntities: {
        type: [String],
        default: undefined,
      },
      /** The user named this file's destination, through the chooser or by requesting a
       *  tool resource, so the destinations absent from the record were declined rather
       *  than deferred. Unlike the endpoint setting, which the next turn may resolve
       *  differently, the choice belongs to the file. */
      destinationChosen: {
        type: Boolean,
        default: undefined,
      },
      /** The type the delivery route was resolved against, kept when conversion changes
       *  the stored type so a later resolution asks the same question. */
      routingMimeType: {
        type: String,
        default: undefined,
      },
    },
    llmDeliveryPath: {
      /* What upload time inferred about delivery, from the endpoint and MIME type it saw.
       * Not a contract: the executing agent, its provider and its tools are all decided
       * per turn, so a reader that needs the real destination resolves it there. */
      type: String,
      enum: ['provider', 'text', 'none'],
    },
    expiresAt: {
      /* Short-lived upload TTL managed by MongoDB. This is separate from
       * retention-scoped `expiredAt`, which is swept by application code
       * after storage cleanup succeeds. */
      type: Date,
      expires: 3600, // 1 hour in seconds
    },
    tenantId: {
      type: String,
      index: true,
    },
    expiredAt: {
      /* Retention deadline for persisted files. The file sweep deletes the
       * backing storage first, then removes this metadata record. */
      type: Date,
    },
    deletionAttempts: {
      /* Consecutive failed sweep deletions, driving the backoff below. A
       * file at or past `FILE_RETENTION_SWEEP_MAX_ATTEMPTS` is parked
       * rather than retried on the ordinary ladder. */
      type: Number,
    },
    deletionRetryAt: {
      /* Earliest next sweep attempt, backed off from `deletionAttempts`.
       * The sweep's only hold: a deadline, never a flag, so a record reused
       * for different content can be delayed but not stranded. */
      type: Date,
    },
  },
  {
    timestamps: true,
  },
);

file.index({ expiredAt: 1 });
file.index({ createdAt: 1, updatedAt: 1 });
file.index(
  { filename: 1, conversationId: 1, context: 1, tenantId: 1 },
  { unique: true, partialFilterExpression: { context: FileContext.execute_code } },
);
file.index(
  {
    user: 1,
    tenantId: 1,
    conversationId: 1,
    'metadata.runFile.runId': 1,
    'metadata.runFile.executionId': 1,
    'metadata.runFile.agentId': 1,
    'metadata.runFile.sourceFileId': 1,
  },
  {
    name: 'run_artifact_identity',
    unique: true,
    partialFilterExpression: { context: FileContext.run_artifact },
  },
);

export default file;
