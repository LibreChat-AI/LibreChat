import { Schema } from 'mongoose';
import type {
  ChannelRunView,
  ChannelRunPrincipal,
  ChannelDeliveryReceipt,
} from 'librechat-data-provider';
import type { Model, SchemaDefinition } from 'mongoose';
import type { ManagedTarget, ManagedState } from '~/types/managed';
import { applyTenantIsolation } from './plugins/tenantIsolation';
import { applyChannelStorage } from './plugins/managed';

export interface ChannelRunRecord extends Omit<ChannelRunView, 'revision'> {
  tenantId: string;
  /** Internal storage metadata; service views omit it. */
  _managed?: ManagedState;
  agentId: string;
  laneId: string;
  principal: ChannelRunPrincipal;
  payloadHash: string;
  receivedAt: number;
  leaseOwner?: string;
  leaseGrantId?: string;
  cursorState?: 'pending' | 'complete' | 'retired';
  terminalFence?: { owner: string; epoch: number; grantId: string };
  leaseEpoch: number;
  leaseExpiresAt: number;
  /** Durable fairness stamp; not execution authority or a retry policy. */
  claimCheckedAt?: number;
  /** Persisted before dispatch; every retry attaches to this exact identity. */
  execution?: {
    protocol?: 'responses';
    responseId?: string;
    responseTarget?: ManagedTarget<'response'>;
    responseFingerprint?: string;
    apiKeyId?: string;
    encryptedApiKey?: string;
    requestId: string;
    conversationId: string;
    parentMessageId: string;
    generationCreatedAt?: number;
    deliveryKey?: string;
    enqueueAttemptedAt?: number;
  };
  errorCode?: string;
  deliveredAt?: number;
  /** Captured once before private staging; recovery never adopts logical replacements. */
  publication?: {
    creatorId: string;
    lane: ManagedTarget<'channelLane'>;
    control: ManagedTarget<'channelLane'>;
    channel: ChannelLaneAuthorityRef<'channel'>;
    identity?: ChannelLaneAuthorityRef<'channelIdentity'>;
  };
}

export interface ChannelLaneAuthorityRef<
  Kind extends 'channel' | 'channelIdentity' = 'channel' | 'channelIdentity',
> {
  target: ManagedTarget<Kind>;
  revision: string;
}

export interface ChannelRunIdentity {
  target: ManagedTarget<'channelRun'>;
  runId: string;
}

export interface ChannelControlAssignment {
  grantId: string;
  phase: 'granting' | 'active';
  purpose: 'work' | 'cleanup';
  run: ChannelRunIdentity;
  lane: ManagedTarget<'channelLane'>;
  principalFingerprint: string;
  owner: string;
  previousEpoch: number;
  epoch: number;
  leaseExpiresAt: number;
  checkedAt: number;
}

export type ChannelStopSelection =
  | { result: 'none' }
  | { result: 'run'; run: ChannelRunIdentity; epoch: number };

export interface ChannelControlLaneRecord {
  kind: 'control';
  tenantId: string;
  channelId: string;
  laneId: string;
  revision: number;
  fingerprint: string;
  channelRef: ChannelLaneAuthorityRef<'channel'>;
  assignment?: ChannelControlAssignment;
  stop?: {
    occurrenceId: string;
    eventAt: number;
    before: number;
    principalFingerprint: string;
    phase: 'selecting' | 'selected';
    selection?: ChannelStopSelection;
  };
}

export interface ChannelPrincipalLaneRecord {
  kind: 'principal';
  revision: number;
  fingerprint: string;
  channelRef: ChannelLaneAuthorityRef<'channel'>;
  identityRef?: ChannelLaneAuthorityRef<'channelIdentity'>;
  controlTarget: ManagedTarget<'channelLane'>;
  publishedThrough: number;
  publisher?: { run: ChannelRunIdentity; sequence: number };
  tenantId: string;
  userId: string;
  channelId: string;
  laneId: string;
  nextSequence: number;
  handoff?: { run: ChannelRunIdentity; sequence: number };
  conversationId?: string;
  responseId?: string;
}

export type ChannelLaneRecord = ChannelPrincipalLaneRecord | ChannelControlLaneRecord;

function channelPhysicalSchema() {
  return new Schema(
    {
      kind: {
        type: String,
        enum: ['channel', 'channelIdentity', 'channelRun', 'channelLane'],
        required: true,
      },
      id: { type: String, match: /^[a-f\d]{24}$/, required: true },
      incarnation: { type: String, required: true },
      tenantId: String,
    },
    { _id: false },
  );
}

function channelAuthoritySchema() {
  return new Schema(
    {
      target: { type: channelPhysicalSchema(), required: true },
      revision: { type: String, required: true },
    },
    { _id: false },
  );
}

export function createChannelRunModel(
  mongoose: typeof import('mongoose'),
): Model<ChannelRunRecord> {
  const receipt = new Schema<ChannelDeliveryReceipt>(
    {
      operationId: { type: String, required: true },
      outcome: {
        type: String,
        required: true,
        enum: ['planned', 'inflight', 'confirmed', 'retryable', 'unknown', 'permanent_failure'],
      },
      attempts: { type: Number, required: true },
      externalMessageKey: String,
      externalFileId: String,
      retryAt: Number,
      errorCode: String,
      upload: {
        type: new Schema(
          {
            fileId: { type: String, required: true },
            stage: {
              type: String,
              required: true,
              enum: ['allocated', 'uploaded'],
            },
          },
          { _id: false },
        ),
      },
    },
    { _id: false },
  );
  const schema = new Schema<ChannelRunRecord>(
    {
      tenantId: { type: String, required: true },
      channelId: { type: String, required: true },
      agentId: { type: String, required: true },
      laneId: { type: String, required: true },
      runId: { type: String, required: true },
      state: {
        type: String,
        required: true,
        enum: [
          'queued',
          'executing',
          'requires_action',
          'delivering',
          'delivered',
          'failed',
          'cancelled',
          'blocked',
        ],
      },
      admission: { type: Schema.Types.Mixed, required: true },
      principal: { type: Schema.Types.Mixed, required: true },
      payloadHash: { type: String, required: true },
      sequence: { type: Number, required: true },
      receivedAt: { type: Number, required: true },
      leaseOwner: String,
      leaseGrantId: String,
      cursorState: { type: String, enum: ['pending', 'complete', 'retired'] },
      terminalFence: {
        type: new Schema(
          {
            owner: { type: String, required: true },
            epoch: { type: Number, required: true },
            grantId: { type: String, required: true },
          },
          { _id: false },
        ),
        default: undefined,
      },
      leaseEpoch: { type: Number, required: true, default: 0 },
      leaseExpiresAt: { type: Number, required: true, default: 0 },
      claimCheckedAt: { type: Number, default: 0 },
      publication: {
        type: new Schema(
          {
            creatorId: { type: String, required: true },
            lane: { type: channelPhysicalSchema(), required: true },
            control: { type: channelPhysicalSchema(), required: true },
            channel: { type: channelAuthoritySchema(), required: true },
            identity: { type: channelAuthoritySchema(), default: undefined },
          },
          { _id: false },
        ),
        default: undefined,
      },
      execution: Schema.Types.Mixed,
      snapshot: Schema.Types.Mixed,
      progress: Schema.Types.Mixed,
      plan: Schema.Types.Mixed,
      receipts: { type: [receipt], required: true, default: [] },
      cancellationRequested: { type: Boolean, required: true, default: false },
      errorCode: String,
      deliveredAt: Number,
    },
    { timestamps: true, minimize: false },
  );
  schema.pre('validate', function () {
    for (const [path, kind] of [
      ['publication.lane.kind', 'channelLane'],
      ['publication.control.kind', 'channelLane'],
      ['publication.channel.target.kind', 'channel'],
      ['publication.identity.target.kind', 'channelIdentity'],
    ])
      if (this.get(path) !== undefined && this.get(path) !== kind)
        this.invalidate(path, 'Invalid Run publication target kind');
  });
  schema.index({ tenantId: 1, runId: 1 }, { unique: true });
  schema.index({ tenantId: 1, 'principal.userId': 1 });
  schema.index(
    {
      tenantId: 1,
      channelId: 1,
      'admission.actor.teamId': 1,
      'admission.actor.appId': 1,
      'admission.eventId': 1,
    },
    { unique: true, name: 'channel_run_event_v2' },
  );
  schema.index({ tenantId: 1, laneId: 1, sequence: 1 }, { unique: true });
  schema.index(
    { tenantId: 1, laneId: 1, state: 1, sequence: 1 },
    { name: 'channel_run_active_predecessor' },
  );
  schema.index({ tenantId: 1, channelId: 1, state: 1, leaseExpiresAt: 1, receivedAt: 1 });
  schema.index(
    {
      tenantId: 1,
      channelId: 1,
      state: 1,
      claimCheckedAt: 1,
      receivedAt: 1,
      sequence: 1,
      leaseExpiresAt: 1,
    },
    { name: 'channel_run_fair_claim' },
  );
  schema.index({ state: 1, _id: 1 });
  schema.index({ tenantId: 1, channelId: 1, '_managed.phase': 1, _id: 1 });
  schema.index({ tenantId: 1, channelId: 1, 'receipts.externalMessageKey': 1 });
  schema.index({ runId: 1 });
  applyChannelStorage(schema);
  applyTenantIsolation(schema);
  return mongoose.models.ChannelRun ?? mongoose.model<ChannelRunRecord>('ChannelRun', schema);
}

export function createChannelLaneModel(
  mongoose: typeof import('mongoose'),
): Model<ChannelLaneRecord> {
  const physical = channelPhysicalSchema();
  const authority = channelAuthoritySchema();
  const runIdentity = new Schema(
    { target: { type: physical, required: true }, runId: { type: String, required: true } },
    { _id: false },
  );
  const selection = new Schema(
    {
      result: { type: String, enum: ['none', 'run'], required: true },
      run: { type: runIdentity, default: undefined },
      epoch: Number,
    },
    { _id: false },
  );
  // Mongoose maps the union definition to one member; the validation below enforces both kinds.
  const schema = new Schema<ChannelLaneRecord>(
    {
      tenantId: { type: String, required: true },
      kind: { type: String, enum: ['principal', 'control'], required: true },
      revision: { type: Number, required: true },
      fingerprint: { type: String, match: /^[a-f\d]{64}$/, required: true },
      channelRef: { type: authority, required: true, default: undefined },
      identityRef: { type: authority, default: undefined },
      controlTarget: {
        type: physical,
        default: undefined,
        required: function (this: ChannelLaneRecord) {
          return this.kind === 'principal';
        },
      },
      userId: {
        type: String,
        required: function (this: ChannelLaneRecord) {
          return this.kind === 'principal';
        },
      },
      channelId: { type: String, required: true },
      laneId: { type: String, required: true },
      nextSequence: {
        type: Number,
        required: function (this: ChannelLaneRecord) {
          return this.kind === 'principal';
        },
      },
      publishedThrough: {
        type: Number,
        required: function (this: ChannelLaneRecord) {
          return this.kind === 'principal';
        },
      },
      publisher: {
        type: new Schema(
          {
            run: { type: runIdentity, required: true },
            sequence: { type: Number, required: true },
          },
          { _id: false },
        ),
        default: undefined,
      },
      assignment: {
        type: new Schema(
          {
            grantId: { type: String, required: true },
            phase: { type: String, enum: ['granting', 'active'], required: true },
            purpose: { type: String, enum: ['work', 'cleanup'], required: true },
            run: { type: runIdentity, required: true },
            lane: { type: physical, required: true },
            principalFingerprint: { type: String, match: /^[a-f\d]{64}$/, required: true },
            owner: { type: String, required: true },
            previousEpoch: { type: Number, required: true },
            epoch: { type: Number, required: true },
            leaseExpiresAt: { type: Number, required: true },
            checkedAt: { type: Number, required: true },
          },
          { _id: false },
        ),
        default: undefined,
      },
      stop: {
        type: new Schema(
          {
            occurrenceId: { type: String, required: true },
            eventAt: { type: Number, required: true },
            before: { type: Number, required: true },
            principalFingerprint: { type: String, match: /^[a-f\d]{64}$/, required: true },
            phase: { type: String, enum: ['selecting', 'selected'], required: true },
            selection: { type: selection, default: undefined },
          },
          { _id: false },
        ),
        default: undefined,
      },
      handoff: {
        type: new Schema(
          {
            run: { type: runIdentity, required: true },
            sequence: { type: Number, required: true },
          },
          { _id: false },
        ),
        default: undefined,
      },
      conversationId: String,
      responseId: String,
    } as SchemaDefinition<ChannelLaneRecord>,
    { timestamps: true },
  );
  schema.pre('validate', function () {
    const control = this.get('kind') === 'control';
    for (const [path, kind] of [
      ['channelRef.target.kind', 'channel'],
      ['identityRef.target.kind', 'channelIdentity'],
      ['controlTarget.kind', 'channelLane'],
      ['publisher.run.target.kind', 'channelRun'],
      ['handoff.run.target.kind', 'channelRun'],
      ['assignment.run.target.kind', 'channelRun'],
      ['assignment.lane.kind', 'channelLane'],
      ['stop.selection.run.target.kind', 'channelRun'],
    ])
      if (this.get(path) !== undefined && this.get(path) !== kind)
        this.invalidate(path, 'Invalid lane target kind');

    const forbidden = control
      ? [
          'userId',
          'identityRef',
          'controlTarget',
          'nextSequence',
          'publishedThrough',
          'publisher',
          'handoff',
          'conversationId',
          'responseId',
        ]
      : ['assignment', 'stop'];
    for (const field of forbidden)
      if (this.get(field) !== undefined) this.invalidate(field, 'Invalid lane kind field');
    if (control)
      for (const field of ['fingerprint', 'channelRef'])
        if (!this.get(field)) this.invalidate(field, 'Control lane coordination field required');
  });
  schema.index({ tenantId: 1, laneId: 1 }, { unique: true });
  schema.index({ tenantId: 1, channelId: 1, kind: 1, _id: 1 });
  schema.index({ tenantId: 1, userId: 1 });
  schema.index({ laneId: 1 });
  applyChannelStorage(schema);
  applyTenantIsolation(schema);
  return mongoose.models.ChannelLane ?? mongoose.model<ChannelLaneRecord>('ChannelLane', schema);
}
