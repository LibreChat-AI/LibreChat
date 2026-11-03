import { z } from 'zod';
import type { AccountingBasis, ResponseAccounting } from './responseAccounting';

export const CHANNEL_DELIVERY_TEXT_MAX_CHARS = 40_000;
export const CHANNEL_DELIVERY_PRESENTATION_MAX_BYTES = 64_000;
/**
 * A run is stored in one document (at most 16 MiB). JSON escaping can expand
 * strings sixfold; eightfold leaves room for the service's lease envelope.
 * This is a protocol safety ceiling, not an operator rendering preference.
 */
export const CHANNEL_RUN_MAX_JSON_BYTES = 128 * 1024 * 1024;

/** Verified transport identities are supplied by the gateway, never by Agent output. */
export interface ChannelRunActor {
  teamId: string;
  appId: string;
  externalUserId: string;
}

export interface ChannelRunPrincipal {
  userId: string;
  channelRevision: string;
  linkId?: string;
  linkRevision?: string;
}

export interface ChannelRunAdmission {
  eventId: string;
  externalChannelId: string;
  externalThreadKey: string;
  externalMessageKey: string;
  actor: ChannelRunActor;
  input: string;
}

export type ChannelRunState =
  | 'queued'
  | 'executing'
  | 'requires_action'
  | 'delivering'
  | 'delivered'
  | 'failed'
  | 'cancelled'
  | 'blocked';

const channelFenceId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[\w:.-]+$/);
/** A lease names one physical Run, owner and epoch; public IDs cannot authorize replacements. */
export const channelRunFenceSchema = z
  .object({
    targetId: z.string().regex(/^[a-f\d]{24}$/),
    incarnation: z
      .string()
      .regex(/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/),
    runId: channelFenceId,
    owner: channelFenceId,
    epoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type ChannelRunFence = z.infer<typeof channelRunFenceSchema>;

export interface ChannelRunUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens?: number;
  reasoningTokens?: number;
}

export interface ChannelSummaryMetric<T> {
  coverage: 'complete' | 'partial' | 'unavailable';
  coveredRuns: number;
  /** Present only when every expected run is covered. */
  value?: T;
  /** A known subtotal, never presented as the full thread total. */
  knownValue?: T;
}

/** Current run plus prior attempts in this actor/link revision's lane, not other thread actors. */
export interface ChannelRunSummary {
  version: 1;
  scope: 'actor_lane';
  throughSequence: number;
  includesCurrent: true;
  priorRuns: number;
  expectedRuns: number;
  observedRuns: number;
  costUSD: ChannelSummaryMetric<string> & { basis?: AccountingBasis };
  /** Sum of per-run admission-to-final durations, not the thread's wall-clock span. */
  elapsedMs: ChannelSummaryMetric<number>;
  tokens: ChannelSummaryMetric<
    Pick<ChannelRunUsage, 'inputTokens' | 'outputTokens' | 'totalTokens'>
  >;
  /** Existing authorized trace UI session; never a collector URL or a raw OAuth URL. */
  session?: { url: string };
}

/** This is a safe projection, not the Agent transcript or private reasoning. */
export interface ChannelRunSnapshot {
  recovery?: 'execution_state_unavailable';
  responseId?: string;
  text: string;
  status: 'running' | 'requires_action' | 'completed' | 'failed' | 'cancelled';
  elapsedMs: number;
  usage?: ChannelRunUsage;
  accounting?: ResponseAccounting;
  summary?: ChannelRunSummary;
  artifacts?: ChannelArtifact[];
  artifactsUnavailable?: boolean;
  activity?: 'working' | 'tool_requested' | 'tool_finished';
  pendingAction?: {
    actionId: string;
    kind: 'tool_approval' | 'ask_user_question' | 'oauth';
    expiresAt: number;
  };
}

export interface ChannelArtifact {
  artifactId: string;
  filename: string;
  mediaType: string;
  bytes: number;
  sha256: string;
}

/** A deterministic render plan is immutable once its first transport operation starts. */
export interface ChannelDeliveryPart {
  operationId: string;
  kind: 'message' | 'artifact';
  required: boolean;
  text: string;
  /** Provider-defined, versioned JSON presentation; immutable alongside the text fallback. */
  presentation?: { format: string; payload: string };
  /** Optional diagnostic operation; reauthorized independently of immutable answer delivery. */
  traceUrl?: string;
  /** Opaque server-authorized artifact identity; never an arbitrary URL or disk path. */
  artifactId?: string;
}

export interface ChannelDeliveryPlan {
  revision: string;
  rendererVersion: string;
  parts: ChannelDeliveryPart[];
}

export type ChannelDeliveryOutcome =
  | 'planned'
  | 'inflight'
  | 'confirmed'
  | 'retryable'
  | 'unknown'
  | 'permanent_failure';

export interface ChannelDeliveryReceipt {
  operationId: string;
  outcome: ChannelDeliveryOutcome;
  attempts: number;
  externalMessageKey?: string;
  externalFileId?: string;
  retryAt?: number;
  errorCode?: string;
  upload?: { fileId: string; stage: 'allocated' | 'uploaded' };
}

export interface ChannelRunProgress
  extends Omit<ChannelDeliveryReceipt, 'operationId' | 'externalFileId'> {
  revision: number;
  rendererVersion: string;
  text: string;
}

export interface ChannelRunView {
  runId: string;
  channelId: string;
  revision: string;
  state: ChannelRunState;
  admission: ChannelRunAdmission;
  sequence: number;
  snapshot?: ChannelRunSnapshot;
  progress?: ChannelRunProgress;
  plan?: ChannelDeliveryPlan;
  receipts: ChannelDeliveryReceipt[];
  cancellationRequested: boolean;
}

/** Renewal extends a fence's lifetime without returning another run snapshot. */
export interface ChannelRunLeaseRenewal {
  fence: ChannelRunFence;
  leaseExpiresAt: number;
}
export interface ChannelRunLease extends ChannelRunLeaseRenewal {
  run: ChannelRunView;
}
/** Credentials are absent when cancellation settles before execution starts. */
export interface ChannelResponseGrant {
  settled?: never;
  apiKey: string;
  requestKey: string;
  responseId?: string;
  request: {
    model: string;
    input: string;
    background: true;
    store: true;
    previous_response_id?: string;
  };
}
export type ChannelResponsePreparation = ChannelResponseGrant | { settled: ChannelRunView };
