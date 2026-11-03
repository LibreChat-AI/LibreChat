import { Schema } from 'mongoose';
import type { Model } from 'mongoose';
import type {
  ResponseCanonicalTarget,
  ManagedTarget,
  CanonicalConversationTarget,
} from '~/types/managed';
import { applyTenantIsolation } from './plugins/tenantIsolation';
import { applyManagedStorage } from './plugins/managed';

export interface ResponseOwner {
  userId: string;
  tenantId?: string;
}

export interface ResponseReservation extends ResponseOwner {
  /** A successful reservation durably accepts publication work. */
  dispatch?: boolean;
  /** Internal cancellation intent is installed atomically with request admission. */
  cancellationRequestedAt?: number;
  /** Captured when accepting an existing conversation; never resolved again by logical ID. */
  conversationTarget?: CanonicalConversationTarget;
  expiredAt?: Date;
  isTemporary?: boolean;
  responseId: string;
  requestKey: string;
  fingerprint: string;
  agentId: string;
  sourceKeyId?: string;
  requestJSON: string;
  conversationId: string;
  parentMessageId: string;
}

/** Internal authority resolved once, then carried across asynchronous work. */
export interface ResponseReference extends ResponseOwner {
  responseId: string;
  target: ManagedTarget<'response'>;
}

export type ResponseExecutionBinding = Pick<
  ResponseTerminalReceipt,
  'generationCreatedAt' | 'providerExecutionId' | 'ownerId'
>;

export interface ResponseProviderExecution {
  id: string;
  ownerId?: string;
  drained?: boolean;
  outcome?: 'complete' | 'error' | 'aborted';
}

export interface ResponseCheckpointExecution {
  generationCreatedAt: number;
  providerExecutionId: string;
  ownerId?: string;
  writerId: string;
  namespace: string;
  configJSON: string;
  configKey: string;
  state: 'pending' | 'settled';
  erased?: boolean;
}

export type StoredResponseStatus =
  | 'queued'
  | 'in_progress'
  | 'requires_action'
  /** Private preparation/publication phase; output is not yet materialized. */
  | 'materializing'
  | 'completed'
  | 'failed'
  | 'incomplete'
  | 'cancelled';

export interface ResponseReviewCheckpoint {
  actionId: string;
  providerExecutionId: string;
  expiresAt: number;
  /** Private seed for the resumed output; never part of the public response view. */
  partialResponseJSON: string;
  /** Visible assistant token counter, separate from billed multi-model usage. */
  visibleOutputTokens?: number;
  /** Private reviewed graph/tool/checkpoint bindings retained after the job consumes its action. */
  pendingActionJSON?: string;
  /** Exact checkpointer settings captured by the paused run, independent of later config changes. */
  checkpointConfigJSON?: string;
  checkpointId?: string;
  checkpointNs?: string;
}

export interface ResponseResumeIntent {
  intentId: string;
  actionId: string;
  previousProviderExecutionId: string;
  providerExecutionId: string;
  fingerprint: string;
  /** Validated, owner-submitted SDK resolution; not a credential or executable request. */
  resolutionJSON: string;
  /** Original validated browser decision, including edited arguments and remembered-approval scope. */
  decisionJSON?: string;
  state: 'reserved' | 'admitted';
  reservedAt: number;
  admittedAt?: number;
}

export type ResponseResumeSelection = Pick<
  ResponseResumeIntent,
  'intentId' | 'actionId' | 'previousProviderExecutionId' | 'providerExecutionId' | 'state'
>;

/** Server-written proposed or confirmed terminal result, bound to one provider attempt. */
export interface ResponseTerminalReceipt {
  generationCreatedAt: number;
  providerExecutionId: string;
  ownerId?: string;
  status: 'completed' | 'failed' | 'incomplete' | 'cancelled';
  responseJSON: string;
  /** Private immutable projection facts for canonical history recovery. */
  turnJSON?: string;
  checkpointNamespace?: string;
  /** Server-pinned saver settings, including initial failures before a review exists. */
  checkpointConfigJSON?: string;
}

/** Durable identity and dispatch/result journal for a background Responses request. */
export interface ResponseDispatchOutbox {
  kind: 'create' | 'resume';
  id: string;
  state: 'pending' | 'settled';
}

/** Permanent publication failure, owned by completion on the same provider attempt. */
export interface ResponsePersistenceFailure extends ResponseExecutionBinding {
  code: 'target_retired' | 'document_limit';
  receiptKey?: string;
}

export interface StoredResponseRecord {
  persistenceFailure?: ResponsePersistenceFailure;
  releaseAcknowledged?: boolean;
  storageTarget?: ManagedTarget<'response'>;
  conversationTarget?: CanonicalConversationTarget;
  providerExecution?: ResponseProviderExecution;
  checkpoint?: ResponseCheckpointExecution;
  retiredAt?: Date;
  canonicalTargets?: ResponseCanonicalTarget[];
  /** Atomic source outbox; settlement never authorizes execution. */
  dispatchOutbox?: ResponseDispatchOutbox;
  expiredAt?: Date;
  isTemporary?: boolean;
  tenantId?: string;
  userId: string;
  responseId: string;
  requestKey: string;
  fingerprint: string;
  agentId: string;
  sourceKeyId?: string;
  requestJSON: string;
  conversationId: string;
  parentMessageId: string;
  status: StoredResponseStatus;
  revision: number;
  deliveryKey?: string;
  generationCreatedAt?: number;
  responseJSON?: string;
  cancellationRequestedAt?: number;
  review?: ResponseReviewCheckpoint;
  resume?: ResponseResumeIntent;
  terminalReceiptKey?: string;
  pendingTerminal?: ResponseTerminalReceipt;
  /** Durable candidate only; independent provider drain proof is required before promotion. */
  preparedTerminal?: ResponseTerminalReceipt;
  createdAt: Date;
  updatedAt: Date;
}

export type ResponseMutationResult =
  | { ok: true; record: StoredResponseRecord }
  | { ok: false; code: 'response_conflict' | 'target_retired' | 'document_limit' };

export function createStoredResponseModel(
  mongoose: typeof import('mongoose'),
): Model<StoredResponseRecord> {
  const terminalSchema = new Schema<ResponseTerminalReceipt>(
    {
      generationCreatedAt: { type: Number, required: true, min: 1 },
      providerExecutionId: { type: String, required: true, maxlength: 128 },
      ownerId: { type: String, maxlength: 128 },
      status: {
        type: String,
        required: true,
        enum: ['completed', 'failed', 'incomplete', 'cancelled'],
      },
      responseJSON: { type: String, required: true },
      turnJSON: String,
      checkpointNamespace: String,
      checkpointConfigJSON: String,
    },
    { _id: false },
  );
  const schema = new Schema<StoredResponseRecord>(
    {
      tenantId: String,
      expiredAt: Date,
      isTemporary: Boolean,
      userId: { type: String, required: true },
      responseId: { type: String, required: true },
      requestKey: { type: String, required: true },
      fingerprint: { type: String, required: true },
      agentId: { type: String, required: true },
      sourceKeyId: String,
      storageTarget: {
        type: new Schema<ManagedTarget<'response'>>(
          {
            kind: { type: String, enum: ['response'], required: true },
            id: { type: String, required: true },
            incarnation: { type: String, required: true },
            tenantId: String,
          },
          { _id: false },
        ),
        default: undefined,
      },
      conversationTarget: {
        type: new Schema<CanonicalConversationTarget>(
          {
            id: { type: String, required: true },
            conversationId: { type: String, required: true },
            userId: { type: String, required: true },
            tenantId: String,
          },
          { _id: false },
        ),
        default: undefined,
      },
      providerExecution: {
        type: new Schema<ResponseProviderExecution>(
          {
            id: { type: String, required: true, maxlength: 128 },
            ownerId: { type: String, maxlength: 128 },
            drained: Boolean,
            outcome: { type: String, enum: ['complete', 'error', 'aborted'] },
          },
          { _id: false },
        ),
        default: undefined,
        select: false,
      },
      checkpoint: {
        type: new Schema<ResponseCheckpointExecution>(
          {
            generationCreatedAt: { type: Number, required: true, min: 1 },
            providerExecutionId: { type: String, required: true, maxlength: 128 },
            ownerId: { type: String, maxlength: 128 },
            writerId: { type: String, required: true },
            namespace: { type: String, required: true },
            configJSON: { type: String, required: true },
            configKey: { type: String, required: true, maxlength: 64 },
            state: { type: String, enum: ['pending', 'settled'], required: true },
            erased: Boolean,
          },
          { _id: false },
        ),
        default: undefined,
        select: false,
      },
      persistenceFailure: {
        type: new Schema<ResponsePersistenceFailure>(
          {
            generationCreatedAt: { type: Number, required: true, min: 1 },
            providerExecutionId: { type: String, required: true, maxlength: 128 },
            ownerId: { type: String, maxlength: 128 },
            code: { type: String, required: true, enum: ['target_retired', 'document_limit'] },
            receiptKey: { type: String, maxlength: 64 },
          },
          { _id: false },
        ),
        default: undefined,
      },
      retiredAt: Date,
      releaseAcknowledged: Boolean,
      canonicalTargets: {
        type: [
          {
            _id: false,
            logicalId: { type: String, required: true },
            receipt: { type: String, required: true },
            phase: {
              type: String,
              required: true,
              enum: ['selected', 'registering', 'registered', 'published', 'retired'],
            },
            target: {
              kind: { type: String, enum: ['message', 'conversation'], required: true },
              id: { type: String, required: true },
              incarnation: { type: String, required: true },
              tenantId: String,
            },
          },
        ],
        default: undefined,
        select: false,
      },
      requestJSON: { type: String, required: true },
      conversationId: { type: String, required: true },
      parentMessageId: { type: String, required: true },
      status: {
        type: String,
        required: true,
        enum: [
          'queued',
          'in_progress',
          'requires_action',
          'materializing',
          'completed',
          'failed',
          'incomplete',
          'cancelled',
        ],
      },
      revision: { type: Number, required: true, default: 0 },
      dispatchOutbox: {
        type: new Schema<ResponseDispatchOutbox>(
          {
            kind: { type: String, required: true, enum: ['create', 'resume'] },
            id: { type: String, required: true, maxlength: 256 },
            state: { type: String, required: true, enum: ['pending', 'settled'] },
          },
          { _id: false },
        ),
        required: false,
      },
      deliveryKey: String,
      generationCreatedAt: Number,
      responseJSON: String,
      cancellationRequestedAt: Number,
      terminalReceiptKey: { type: String, maxlength: 64 },
      pendingTerminal: {
        type: terminalSchema,
        required: false,
      },
      preparedTerminal: {
        type: terminalSchema,
        required: false,
      },
      review: {
        type: new Schema<ResponseReviewCheckpoint>(
          {
            actionId: { type: String, required: true, maxlength: 256 },
            providerExecutionId: { type: String, required: true, maxlength: 128 },
            expiresAt: { type: Number, required: true, min: 1 },
            partialResponseJSON: { type: String, required: true },
            visibleOutputTokens: {
              type: Number,
              min: 0,
              max: Number.MAX_SAFE_INTEGER,
              validate: Number.isSafeInteger,
            },
            pendingActionJSON: String,
            checkpointConfigJSON: String,
            checkpointId: String,
            checkpointNs: String,
          },
          { _id: false },
        ),
        required: false,
      },
      resume: {
        type: new Schema<ResponseResumeIntent>(
          {
            intentId: { type: String, required: true, maxlength: 256 },
            actionId: { type: String, required: true, maxlength: 256 },
            previousProviderExecutionId: { type: String, required: true, maxlength: 128 },
            providerExecutionId: { type: String, required: true, maxlength: 128 },
            fingerprint: { type: String, required: true },
            resolutionJSON: { type: String, required: true },
            decisionJSON: String,
            state: { type: String, required: true, enum: ['reserved', 'admitted'] },
            reservedAt: { type: Number, required: true, min: 1 },
            admittedAt: { type: Number, min: 1 },
          },
          { _id: false },
        ),
        required: false,
      },
    },
    // This journal drives admission and recovery; stale replica reads are not authoritative.
    { timestamps: true, minimize: false, read: 'primary' },
  );
  schema.index({ tenantId: 1, userId: 1, responseId: 1 }, { unique: true });
  // Global maintenance scans only the allocation namespace, across owner partitions.
  schema.index({ responseId: 1 });
  // Expiry hides payload immediately; the recovery owner retains this root until drain.
  schema.index({ expiredAt: 1, _id: 1 });
  schema.index({ 'dispatchOutbox.state': 1, _id: 1 });
  schema.index({ retiredAt: 1, _id: 1 });
  schema.index({ releaseAcknowledged: 1, _id: 1 });
  schema.index({ status: 1, _id: 1 });
  schema.index({ 'resume.state': 1, status: 1, _id: 1 });
  schema.index({ tenantId: 1, userId: 1, requestKey: 1 }, { unique: true });
  schema.index({ tenantId: 1, userId: 1, conversationId: 1, createdAt: 1 });
  schema.index({ userId: 1, conversationId: 1, tenantId: 1 });
  schema.index({ '_managed.ownerKey': 1, '_managed.conversationKey': 1, _id: 1 });
  applyManagedStorage(schema);
  applyTenantIsolation(schema);
  return (
    mongoose.models.StoredResponse ?? mongoose.model<StoredResponseRecord>('StoredResponse', schema)
  );
}
