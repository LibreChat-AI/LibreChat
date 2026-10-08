import { createHash, randomUUID } from 'crypto';
import { logger } from '@librechat/data-schemas';
import { SteerEvents } from 'librechat-data-provider';
import type { IMongoFile } from '@librechat/data-schemas';
import type { TFile } from 'librechat-data-provider';
import type {
  GenerationProtocolVersion,
  SteerQueueItem,
  SteerReceipt,
} from '~/stream/interfaces/IJobStore';
import type { SteerRequestUser } from './refs';
import {
  STEER_ENQUEUE_NOT_RUNNING,
  STEER_ENQUEUE_QUEUE_FULL,
  STEER_ENQUEUE_RECEIPT_FULL,
} from '~/stream/interfaces/IJobStore';
import { toSteerFileRef, collectFileIds, buildOwnerFilter } from './refs';
import { GenerationJobManager } from '~/stream/GenerationJobManager';
import { isSteeringSupported } from './runtime';
import { getReferencedQuotes } from '~/utils';

/** Attachment cap per steer, mirroring the composer's practical limits. */
export const STEER_MAX_FILES = 10;

const DEFAULT_STEER_MAX_LENGTH = 16000;

/**
 * How long a cancel waits for its disarm to publish before answering anyway.
 * The steer is already durably removed by then, so this only buys the clear a
 * head start; a stalled Redis must not hold the response open behind it.
 */
const STEER_DISARM_ACK_TIMEOUT_MS = 1000;

/** Character cap for a single steer message (env-overridable). */
export function getSteerMaxLength(): number {
  return parseInt(process.env.STEER_MAX_LENGTH ?? '', 10) || DEFAULT_STEER_MAX_LENGTH;
}

/** `db.getFiles`-shaped dependency (injected — this package has no DB access). */
export type SteerFileFetcher = (
  filter: Record<string, unknown>,
  sortOptions: Record<string, unknown>,
  selectFields: Record<string, unknown>,
) => Promise<IMongoFile[] | null | undefined>;

export interface SteerRequestBody {
  conversationId?: unknown;
  generationCreatedAt?: unknown;
  text?: unknown;
  clientSteerId?: unknown;
  files?: unknown;
  /** Quoted excerpts steered with the message ("Add to chat" selections);
   *  normalized like the chat route's quotes and merged into the model-bound
   *  turn at the injection boundary. */
  quotes?: unknown;
  /** Ask the generating replica to seal the live model stream at the next
   *  provider-safe boundary instead of waiting for a tool step. NEVER a
   *  rejection reason: on an SDK without the capability the steer still
   *  enqueues and the 202 echoes `preempt: false`. */
  preempt?: unknown;
}

export interface SteerCancelBody {
  conversationId?: unknown;
  generationCreatedAt?: unknown;
  steerId?: unknown;
  clientSteerId?: unknown;
}

/** HTTP-shaped outcome the thin route wrapper serializes verbatim. */
export interface SteerRequestResult {
  status: number;
  body: Record<string, unknown>;
}

/** Protocol-only options shared by cancel/arm, which do not need the steer
 * request's file and agent-authorization dependencies. */
export interface SteerProtocolOptions {
  generationProtocolVersion?: GenerationProtocolVersion;
}

interface SteerProtocolContext {
  value: GenerationProtocolVersion;
  expose: boolean;
}

/** `undefined` means an older direct package caller, not an HTTP request. The
 * LibreChat wrapper always supplies this field, so malformed/missing wire
 * markers have already become an explicit v1 before entering the package. */
function protocolFromOptions(options: SteerProtocolOptions): GenerationProtocolVersion {
  if (!Object.prototype.hasOwnProperty.call(options, 'generationProtocolVersion')) {
    return 2;
  }
  return options.generationProtocolVersion === 2 ? 2 : 1;
}

function capProtocolToJob(
  protocol: SteerProtocolContext,
  job: { metadata?: { generationProtocolVersion?: unknown } } | null | undefined,
): void {
  protocol.value = protocol.value === 2 && job?.metadata?.generationProtocolVersion === 2 ? 2 : 1;
}

function attachProtocol(
  result: SteerRequestResult,
  protocol: SteerProtocolContext,
): SteerRequestResult {
  if (!protocol.expose) {
    return result;
  }
  return {
    ...result,
    body: { ...result.body, generationProtocolVersion: protocol.value },
  };
}

/** The originating run's identity, from job metadata (never the request). */
export interface SteerRunContext {
  agentId?: string;
  endpoint?: string;
}

/**
 * Host-injected dependencies for the steer guard ladder. All optional — a
 * host that omits them gets shape-level sanitization only (pre-round-13
 * behavior); the LibreChat route wires all three.
 */
export interface SteerRequestDeps {
  /** Upper protocol bound selected by the HTTP host from the request markers
   * and its rollout gate. Direct package callers that omit it retain the
   * current-package (v2) behavior. */
  generationProtocolVersion?: GenerationProtocolVersion;
  /** Refuse a legacy v1 enqueue that cannot persist `clientSteerId` receipts.
   * Background/event deliveries use this to make retrying an ambiguous
   * outcome safe instead of potentially injecting the same instruction twice. */
  requireIdempotentDelivery?: boolean;
  /** Best-effort cancellation observed immediately before durable mutation. */
  signal?: AbortSignal;
  /** Owner-scoped file fetch (`db.getFiles`-shaped). When present, every
   *  client-supplied ref must resolve to an owned DB doc at enqueue and the
   *  queued refs are replaced with DB-derived ones. */
  getFiles?: SteerFileFetcher;
  /** Marks resolved uploads used so the upload-window TTL cannot reap a file
   *  the persisted steer part references (parity with normal sends). */
  updateFilesUsage?: (
    files: Array<{ file_id: string }>,
    fileIds?: string[],
    options?: { user?: string; tenantId?: string | null },
  ) => Promise<unknown[]>;
  /** Agent authorization for the originating run (role + per-agent ACL),
   *  mirroring the chat route's middlewares. `false` → 403 FORBIDDEN. */
  checkAgentAccess?: (run: SteerRunContext) => Promise<boolean>;
}

interface SanitizedFilesResult {
  files?: Partial<TFile>[];
  error?: 'TOO_MANY_FILES' | 'INVALID_FILES';
}

function parseExpectedGenerationCreatedAt(value: unknown): { value?: number; invalid?: true } {
  if (value == null) {
    return {};
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return { invalid: true };
  }
  return { value };
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** Sanitizes client-supplied attachment refs via the shared ref picker;
 *  a single unusable entry rejects the whole list (fail-loud for the client). */
function sanitizeSteerFiles(rawFiles: unknown): SanitizedFilesResult {
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
    return {};
  }
  if (rawFiles.length > STEER_MAX_FILES) {
    return { error: 'TOO_MANY_FILES' };
  }
  const files: Partial<TFile>[] = [];
  for (const raw of rawFiles) {
    const ref = toSteerFileRef(raw);
    if (ref == null) {
      return { error: 'INVALID_FILES' };
    }
    files.push(ref);
  }
  return { files };
}

interface ResolvedFilesResult {
  files?: Partial<TFile>[];
  fileIds?: string[];
  error?: 'INVALID_FILES';
}

/**
 * Resolves sanitized client refs against the DB owner-scoped (same scoping as
 * the injection-time fetch) and re-derives every ref from the owned doc, so
 * only trusted shapes are ever queued, persisted, and rendered. Any id that
 * does not resolve fails the whole list (fail-loud, matching sanitize).
 */
async function resolveSteerFiles(
  files: Partial<TFile>[],
  user: SteerRequestUser,
  getFiles: SteerFileFetcher,
): Promise<ResolvedFilesResult> {
  const ids = collectFileIds(files);
  const filter = buildOwnerFilter(ids, user);
  if (filter == null) {
    return { error: 'INVALID_FILES' };
  }
  const docs = await getFiles(filter, {}, {});
  const docsById = new Map((docs ?? []).map((doc) => [doc.file_id, doc]));
  const resolved: Partial<TFile>[] = [];
  for (const id of ids) {
    const doc = docsById.get(id);
    const ref = doc == null ? null : toSteerFileRef(doc);
    if (ref == null) {
      return { error: 'INVALID_FILES' };
    }
    resolved.push(ref);
  }
  return { files: resolved, fileIds: ids };
}

/** Untenanted jobs (pre-multi-tenancy) remain accessible if the userId check passes. */
function hasTenantMismatch(
  metadata: { tenantId?: string } | undefined,
  user: SteerRequestUser,
): boolean {
  return metadata?.tenantId != null && metadata.tenantId !== user.tenantId;
}

/** DELIBERATELY quote-independent and display-metadata-independent: the
 *  legacy 3-field hash saw these same file refs before `llmDeliveryPath` was
 *  added, so a lost-ACK retry can replay its receipt across rollout versions.
 *  Quote identity is enforced separately via
 *  `SteerReceipt.requestedQuotesFingerprint`, which only quote-aware readers
 *  consult. */
function steerFingerprint(
  text: string,
  files: Partial<TFile>[] | undefined,
  preempt: boolean,
): string {
  const stableFiles = (files ?? []).map((file) =>
    Object.fromEntries(Object.entries(file).filter(([key]) => key !== 'llmDeliveryPath')),
  );
  return createHash('sha256')
    .update(JSON.stringify({ text, files: stableFiles, preempt }))
    .digest('base64url');
}

/** Normalized-quote identity stored beside (never inside) the fingerprint. */
function quotesFingerprint(quotes: string[]): string {
  return createHash('sha256').update(JSON.stringify(quotes)).digest('base64url');
}

/** Whether a receipt's recorded quote identity accepts this request's quotes.
 *  An ABSENT record means the receipt was written by a pre-quotes replica (or
 *  for a quote-less request) — quotes were never part of its contract, so any
 *  retry of the same words replays (the item carries no quotes; the missing
 *  `quotesAccepted` echo keeps the client's copy on its chip). A present
 *  record must match exactly: reusing a clientSteerId with different quotes
 *  is the same conflict a content-hash mismatch signals. */
function receiptQuotesCompatible(
  recorded: string | undefined,
  requested: string[] | null,
): boolean {
  if (recorded == null) {
    return true;
  }
  return requested != null && quotesFingerprint(requested) === recorded;
}

function receiptResponse(conversationId: string, receipt: SteerReceipt): SteerRequestResult {
  return {
    status: 202,
    body: {
      status: 'queued',
      steerId: receipt.item.steerId,
      position: receipt.position,
      conversationId,
      preempt: receipt.item.preempt === true,
      settled: receipt.state !== 'queued' && receipt.state !== 'claimed',
      leftover: receipt.state === 'leftover',
      replayed: true,
      /** From the DURABLE item, mirroring the fresh 202: a receipt written by
       *  a pre-quotes replica replays without this marker, telling the client
       *  its excerpts never attached to the accepted words. */
      ...(receipt.item.quotes != null &&
        receipt.item.quotes.length > 0 && {
          quotesAccepted: true,
        }),
      ...(receipt.item.preemptRevision != null && {
        preemptRevision: receipt.item.preemptRevision,
      }),
    },
  };
}

/**
 * Makes every attachment durable before a fresh steer can enter the queue.
 *
 * This is also run for receipt replays: an older process may have committed
 * the queue+receipt and disappeared before clearing the upload TTL. A 202 must
 * therefore mean both the steer and every referenced file are durable, not
 * merely that a best-effort background write was launched.
 */
async function markSteerFilesUsed(
  streamId: string,
  item: Pick<SteerQueueItem, 'files'>,
  owner: SteerRequestUser,
  deps: SteerRequestDeps,
): Promise<boolean> {
  if (!deps.updateFilesUsage) {
    return true;
  }
  const fileIds = collectFileIds(item.files ?? []);
  if (fileIds.length === 0) {
    return true;
  }

  try {
    const updated = await deps.updateFilesUsage(
      fileIds.map((file_id) => ({ file_id })),
      undefined,
      { user: owner.id, tenantId: owner.tenantId },
    );
    const updatedIds = new Set(
      updated.flatMap((file) =>
        file != null &&
        typeof file === 'object' &&
        'file_id' in file &&
        typeof file.file_id === 'string'
          ? [file.file_id]
          : [],
      ),
    );
    if (fileIds.every((fileId) => updatedIds.has(fileId))) {
      return true;
    }
    logger.warn(
      `[handleSteerRequest] Failed to retain every steer file: ${streamId} ` +
        `expected=${fileIds.length} retained=${updatedIds.size}`,
    );
  } catch (error) {
    logger.warn(`[handleSteerRequest] Failed to mark steer files used: ${streamId}`, error);
  }
  return false;
}

function publishSteerUpdate(streamId: string, createdAt: number, item: SteerQueueItem): void {
  void GenerationJobManager.emitChunkFromAnyReplica(
    streamId,
    {
      event: SteerEvents.ON_STEER_UPDATED,
      data: {
        conversationId: streamId,
        steers: [
          {
            steerId: item.steerId,
            ...(item.clientSteerId && { clientSteerId: item.clientSteerId }),
            preempt: item.preempt === true,
            preemptRevision: item.preemptRevision ?? 0,
          },
        ],
      },
    },
    createdAt,
  ).catch((error) =>
    logger.warn(`[steering] Failed to publish steer update for ${streamId}`, error),
  );
}

/**
 * The full steer-request guard ladder, typed and host-agnostic: validation,
 * capability gate, job ownership/state checks, and the status-guarded enqueue.
 * Returns the HTTP status + JSON body for the thin `/api` route wrapper.
 * Rejection codes tell the client how to degrade:
 * - 404 NO_ACTIVE_RUN → send as a normal message
 * - 409 RUN_PAUSED    → run awaits human review; queue client-side instead
 * - 429 STEER_QUEUE_FULL → too many undrained steers
 * - 501 STEER_UNSUPPORTED → SDK cannot inject; queue client-side
 */
export async function handleSteerRequest(
  user: SteerRequestUser,
  body: SteerRequestBody,
  deps: SteerRequestDeps = {},
): Promise<SteerRequestResult> {
  const protocol: SteerProtocolContext = {
    value: protocolFromOptions(deps),
    expose: Object.prototype.hasOwnProperty.call(deps, 'generationProtocolVersion'),
  };
  return attachProtocol(await handleSteerRequestInternal(user, body, deps, protocol), protocol);
}

async function handleSteerRequestInternal(
  user: SteerRequestUser,
  body: SteerRequestBody,
  deps: SteerRequestDeps,
  protocol: SteerProtocolContext,
): Promise<SteerRequestResult> {
  const conversationId = body.conversationId;
  if (typeof conversationId !== 'string' || !conversationId || conversationId === 'new') {
    return { status: 400, body: { code: 'INVALID_CONVERSATION' } };
  }
  const expectedGeneration = parseExpectedGenerationCreatedAt(body.generationCreatedAt);
  if (expectedGeneration.invalid) {
    return { status: 400, body: { code: 'INVALID_GENERATION_IDENTITY' } };
  }

  if (typeof body.text !== 'string') {
    return { status: 400, body: { code: 'EMPTY_TEXT' } };
  }
  const text = body.text.replace(/\0/g, '').trim();
  if (text.length === 0) {
    return { status: 400, body: { code: 'EMPTY_TEXT' } };
  }
  const maxLength = getSteerMaxLength();
  if (text.length > maxLength) {
    return { status: 413, body: { code: 'STEER_TOO_LONG', maxLength } };
  }

  const clientSteerId = body.clientSteerId;
  if (
    clientSteerId != null &&
    (typeof clientSteerId !== 'string' ||
      clientSteerId.length === 0 ||
      clientSteerId.length > 128 ||
      !/^[A-Za-z0-9_-]+$/.test(clientSteerId))
  ) {
    return { status: 400, body: { code: 'INVALID_CLIENT_STEER_ID' } };
  }
  if (deps.requireIdempotentDelivery === true && typeof clientSteerId !== 'string') {
    return { status: 400, body: { code: 'CLIENT_STEER_ID_REQUIRED' } };
  }

  const { files, error: filesError } = sanitizeSteerFiles(body.files);
  if (filesError) {
    return { status: 400, body: { code: filesError } };
  }

  /** Same normalization as the chat route (trim, drop empties, cap count and
   *  excerpt length) so a steer's quotes obey the caps a normal send does. */
  const quotes = getReferencedQuotes(body.quotes);

  /** streamId === conversationId for resumable agent jobs */
  const streamId = conversationId;
  const wantsPreempt = body.preempt === true;
  const fingerprint = steerFingerprint(text, files, wantsPreempt);

  /** A durable receipt is authoritative even after its accepting job was
   * deleted or replaced. Read it before capping to the current job marker:
   * otherwise a terminal cleanup (no job) or a later v1 generation hides the
   * lost-ACK proof and the client can resend already-accepted text. The host
   * and request still have to advertise v2 before any receipt surface is
   * touched; the receipt itself then proves that its generation was v2. */
  const job = await GenerationJobManager.getJob(streamId);
  if (protocol.value === 2 && typeof clientSteerId === 'string') {
    const receipt = await GenerationJobManager.steering.getReceipt(streamId, clientSteerId);
    if (receipt != null) {
      if (receipt.userId !== (user.id ?? '') || hasTenantMismatch(receipt, user)) {
        return { status: 403, body: { code: 'UNAUTHORIZED' } };
      }
      /** This is observation of an already-committed action, not a new agent
       * mutation. Re-running mutable agent ACL here can turn a lost 202 into
       * a definite 403 even though the queued words can still apply, causing
       * the client to expose resend controls and duplicate them. Stable
       * receipt ownership/tenant identity is the replay authorization. */
      if (
        expectedGeneration.value != null &&
        receipt.generationCreatedAt !== expectedGeneration.value
      ) {
        return { status: 409, body: { code: 'RUN_REPLACED' } };
      }
      if (
        receipt.fingerprint !== fingerprint ||
        !receiptQuotesCompatible(receipt.requestedQuotesFingerprint, quotes)
      ) {
        return { status: 409, body: { code: 'STEER_IDEMPOTENCY_CONFLICT' } };
      }
      if (
        !(await markSteerFilesUsed(
          streamId,
          receipt.item,
          { id: receipt.userId, tenantId: receipt.tenantId },
          deps,
        ))
      ) {
        return { status: 503, body: { code: 'STEER_FILE_RETENTION_FAILED' } };
      }
      return receiptResponse(conversationId, receipt);
    }
  }

  if (job != null) {
    capProtocolToJob(protocol, job);
  }

  if (!job) {
    /** No live marker and no v2 receipt proof is the pre-rollout shape. */
    protocol.value = 1;
    return { status: 404, body: { code: 'NO_ACTIVE_RUN' } };
  }
  if (job.status === 'complete' || job.status === 'error' || job.status === 'aborted') {
    return { status: 404, body: { code: 'NO_ACTIVE_RUN' } };
  }
  // Job creation always records an owner. Missing/corrupt ownership must fail
  // closed rather than authorizing anyone who knows the conversation id.
  if (job.metadata?.userId !== user.id) {
    logger.warn(`[handleSteerRequest] Unauthorized steer attempt for ${streamId} by ${user.id}`);
    return { status: 403, body: { code: 'UNAUTHORIZED' } };
  }
  if (hasTenantMismatch(job.metadata, user)) {
    return { status: 403, body: { code: 'UNAUTHORIZED' } };
  }
  if (expectedGeneration.value != null && job.createdAt !== expectedGeneration.value) {
    return { status: 409, body: { code: 'RUN_REPLACED' } };
  }

  /** A steer is model-bound instruction text for the ORIGINATING agent, so it
   *  must clear the same role/ACL gates the chat path runs — revoked access
   *  mid-run must not keep injecting. */
  if (deps.checkAgentAccess) {
    const allowed = await deps.checkAgentAccess({
      agentId: job.metadata?.agent_id,
      endpoint: job.metadata?.endpoint,
    });
    if (!allowed) {
      logger.warn(`[handleSteerRequest] Agent access denied for ${streamId} by ${user.id}`);
      return { status: 403, body: { code: 'FORBIDDEN' } };
    }
  }

  if (job.status === 'requires_action') {
    return { status: 409, body: { code: 'RUN_PAUSED' } };
  }

  /** AFTER the job checks: a steer racing run completion must get 404 (the
   *  client sends immediately) — a 501 here would queue it client-side with
   *  no remaining run-end signal to ever drain it. */
  if (!isSteeringSupported()) {
    return { status: 501, body: { code: 'STEER_UNSUPPORTED' } };
  }
  if (deps.requireIdempotentDelivery === true && protocol.value !== 2) {
    return { status: 409, body: { code: 'STEER_IDEMPOTENCY_UNAVAILABLE' } };
  }

  let queuedFiles = files;
  if (files && deps.getFiles) {
    const resolved = await resolveSteerFiles(files, user, deps.getFiles);
    if (resolved.error) {
      return { status: 400, body: { code: resolved.error } };
    }
    queuedFiles = resolved.files;
  }

  /**
   * The OWNER's recorded capability, not this replica's probe: a steer can
   * land on any replica, so during a rolling deploy a local probe would
   * answer for the wrong process and label a steer "interrupting" that the
   * old owner can only inject at a tool boundary. Jobs created before
   * preempt shipped carry no flag, which reads as incapable — the honest
   * outcome, and the chip relabels to ordinary steering.
   *
   * Re-read rather than reused from the `job` fetched at the top of the
   * ladder: `checkAgentAccess` and file resolution are awaits, so a request
   * can span an entire HITL pause/resume that hands ownership to a replica
   * with different capability and rewrites this very flag. Only paid for by
   * requests that actually asked to interrupt.
   *
   * THIS replica's own SDK is deliberately not consulted. It never seals —
   * it enqueues and publishes an arm, neither of which touches the SDK — so
   * ANDing in a local probe would answer for the wrong process and silently
   * drop interrupts during a rolling deploy whenever the request happened to
   * land on an un-upgraded replica while a capable owner generated. When
   * this replica IS the owner the probe is redundant anyway: the flag it
   * would consult is the one this process already wrote at `createJob`.
   */
  const owner = wantsPreempt ? ((await GenerationJobManager.getJob(streamId)) ?? job) : job;
  /**
   * The re-read may have crossed a replacement. Every guard above — ownership,
   * tenant, paused-state, agent ACL — was evaluated against `job`, so a
   * different generation here is a run this request was never authorized
   * against, and accepting into it would carry the wrong agent's metadata.
   * Refuse rather than re-derive: the run the caller targeted is gone. A live
   * replacement returns `RUN_REPLACED` so a stale tab queues behind it instead
   * of normal-sending and replacing it again; a terminal replacement remains
   * the ordinary `NO_ACTIVE_RUN` fallback.
   */
  if (owner.createdAt !== job.createdAt) {
    return owner.status === 'running' || owner.status === 'requires_action'
      ? { status: 409, body: { code: 'RUN_REPLACED' } }
      : { status: 404, body: { code: 'NO_ACTIVE_RUN' } };
  }
  if (isAborted(deps.signal)) {
    return { status: 499, body: { code: 'STEER_ABORTED' } };
  }
  /** Normal sends make resolved uploads durable before model execution. Do
   * the same before enqueue: once a 202 is visible, neither an upload-window
   * sweep nor a process crash may turn the accepted steer into text-only
   * history. A failure here commits no fresh queue item, so retry is safe. */
  if (!(await markSteerFilesUsed(streamId, { files: queuedFiles }, user, deps))) {
    return { status: 503, body: { code: 'STEER_FILE_RETENTION_FAILED' } };
  }
  if (isAborted(deps.signal)) {
    return { status: 499, body: { code: 'STEER_ABORTED' } };
  }
  /** The OWNER's execution-bound capability: an upgraded admission replica
   * must not store quotes (and claim them accepted) for a generation whose
   * owning drain would silently drop them at injection. This read is only
   * the FAST PATH — the enqueue transaction re-evaluates the same
   * marker-equals-execution predicate atomically against the live job and
   * strips `item.quotes` itself, so a HITL handover landing after this read
   * (same `createdAt`, invisible to the enqueue fence) cannot smuggle
   * quotes past a legacy owner. The returned persisted item reflects any
   * strip, keeping the `quotesAccepted` echo honest; on a missing echo the
   * client re-stages the excerpts. */
  const ownerAcceptsQuotes =
    owner.metadata?.steerQuotesExecutionId != null &&
    owner.metadata.steerQuotesExecutionId === owner.metadata.providerExecutionId;
  const item: SteerQueueItem = {
    steerId: randomUUID(),
    ...(protocol.value === 2 && typeof clientSteerId === 'string' && { clientSteerId }),
    text,
    userId: user.id ?? '',
    createdAt: Date.now(),
    ...(queuedFiles && { files: queuedFiles }),
    ...(quotes != null && ownerAcceptsQuotes && { quotes }),
  };
  /**
   * Fenced to the generation the capability decision was made against. The
   * access checks, file resolution and owner re-read above are all awaits, so
   * the run can be replaced before this line: without the fence the item
   * lands on the REPLACEMENT queue while `preempt` and the arm below still
   * describe the previous epoch, so the arm is fenced out at the owner and
   * the 202 claims an interrupt that can never happen. Rejecting is honest —
   * the run the caller was told about is gone, and `NO_ACTIVE_RUN` is what
   * the client already handles by converting to a queued follow-up.
   */
  let depth: number;
  let persistedItem: SteerQueueItem = item;
  let preemptRevision: number | undefined;
  if (protocol.value === 2 && typeof clientSteerId === 'string') {
    const result = await GenerationJobManager.steering.enqueueWithReceipt(
      streamId,
      item,
      {
        clientSteerId,
        fingerprint,
        ...(quotes != null && { requestedQuotesFingerprint: quotesFingerprint(quotes) }),
        userId: user.id ?? '',
        ...(user.tenantId && { tenantId: user.tenantId }),
        ...(job.metadata?.agent_id && { agentId: job.metadata.agent_id }),
        ...(job.metadata?.endpoint && { endpoint: job.metadata.endpoint }),
        generationCreatedAt: owner.createdAt,
      },
      wantsPreempt,
      owner.createdAt,
    );
    if (typeof result === 'number') {
      depth = result;
    } else {
      if (
        !('fingerprint' in result) ||
        result.fingerprint !== fingerprint ||
        !receiptQuotesCompatible(result.requestedQuotesFingerprint, quotes)
      ) {
        return { status: 409, body: { code: 'STEER_IDEMPOTENCY_CONFLICT' } };
      }
      if (result.userId !== (user.id ?? '') || hasTenantMismatch(result, user)) {
        return { status: 403, body: { code: 'UNAUTHORIZED' } };
      }
      if (
        expectedGeneration.value != null &&
        result.generationCreatedAt !== expectedGeneration.value
      ) {
        return { status: 409, body: { code: 'RUN_REPLACED' } };
      }
      if (result.item.steerId !== item.steerId) {
        return receiptResponse(conversationId, result);
      }
      depth = result.position;
      persistedItem = result.item;
      preemptRevision = result.item.preemptRevision;
    }
  } else {
    const result = await GenerationJobManager.steering.enqueueVersioned(
      streamId,
      item,
      wantsPreempt,
      owner.createdAt,
    );
    if (typeof result === 'number') {
      depth = result;
    } else {
      depth = result.position;
      persistedItem = result.item;
      preemptRevision = result.item.preemptRevision;
    }
  }
  if (depth === STEER_ENQUEUE_NOT_RUNNING) {
    /** The guarded enqueue may lose to a pause after the earlier job read
     * (agent ACL and attachment resolution can both await). Preserve the
     * paused contract for this same generation: clients queue on 409, while
     * 404 intentionally converts terminal/replaced runs into normal sends. */
    const liveJob = await GenerationJobManager.getJob(streamId);
    if (liveJob?.createdAt === owner.createdAt && liveJob.status === 'requires_action') {
      return { status: 409, body: { code: 'RUN_PAUSED' } };
    }
    if (
      liveJob != null &&
      liveJob.createdAt !== owner.createdAt &&
      (liveJob.status === 'running' || liveJob.status === 'requires_action')
    ) {
      return { status: 409, body: { code: 'RUN_REPLACED' } };
    }
    return { status: 404, body: { code: 'NO_ACTIVE_RUN' } };
  }
  if (depth === STEER_ENQUEUE_QUEUE_FULL) {
    return { status: 429, body: { code: 'STEER_QUEUE_FULL' } };
  }
  if (depth === STEER_ENQUEUE_RECEIPT_FULL) {
    return { status: 429, body: { code: 'STEER_RECEIPT_LIMIT' } };
  }

  const preemptArmed = persistedItem.preempt === true;
  /** Every modern enqueue publishes correlation, including ordinary steers
   * and incapable preempt requests. A lost 202 then promotes the optimistic
   * client id to the accepted server item instead of exposing unsafe local
   * edit/queue/remove actions for words the server already owns. */
  if (protocol.value === 2 && persistedItem.clientSteerId != null) {
    publishSteerUpdate(streamId, owner.createdAt, persistedItem);
  }

  /**
   * Strictly AFTER a successful enqueue: an armed request whose steer never
   * made the durable queue could seal a generation with nothing to inject.
   *
   * `preempt` in the 202 means "queued as an interrupt request", NOT "a seal
   * is guaranteed" — it mirrors the durable `item.preempt` exactly. A route
   * cannot synchronously know whether another replica will seal: proving that
   * needs a correlated request/response over pub-sub, and even then the owner
   * may finish before the arm lands. Reporting delivery instead made the
   * response disagree with the durable flag, which `rearmQueuedPreempts`
   * trusts on resume — the two must agree or a resumed owner honours an
   * interrupt the client was told had degraded.
   *
   * The gates that ARE knowable stay: the owner's recorded capability and a
   * successful enqueue. Everything past that degrades to the documented
   * fallback of injecting at the next tool boundary.
   */
  if (preemptArmed) {
    /**
     * NOT awaited. The answer no longer depends on it — the 202 reports
     * `preemptCapable`, not delivery — so awaiting only exposes the caller to
     * Redis latency after the queue item is already durable. The durable
     * clientSteerId receipt makes a lost-202 retry return this same item; a
     * lost publish merely takes the documented tool-boundary fallback.
     */
    void GenerationJobManager.requestPreempt(
      streamId,
      persistedItem.steerId,
      owner.createdAt,
      protocol.value === 2 ? preemptRevision : undefined,
    ).then(
      (armed) => {
        if (!armed) {
          logger.warn(
            `[handleSteerRequest] Preempt arm not confirmed for ${streamId} steer=${persistedItem.steerId}; ` +
              'the steer remains queued and will inject at the next boundary',
          );
        }
      },
      (error: unknown) => {
        logger.error(
          `[handleSteerRequest] Preempt arm failed for ${streamId} steer=${persistedItem.steerId}:`,
          error,
        );
      },
    );
  }

  return {
    status: 202,
    body: {
      status: 'queued',
      steerId: persistedItem.steerId,
      position: depth,
      conversationId,
      preempt: preemptArmed,
      /** Echoed from the DURABLE item so the client can tell whether its
       *  quoted excerpts will actually inject. A pre-quotes replica never
       *  sets this, and the client re-stages the excerpts on that absence —
       *  a 202 must not silently drop model-bound context. */
      ...(persistedItem.quotes != null &&
        persistedItem.quotes.length > 0 && {
          quotesAccepted: true,
        }),
      ...(protocol.value === 2 && preemptRevision != null && { preemptRevision }),
    },
  };
}

/**
 * Cancel a queued steer before injection. `removed: false` is advisory, not
 * an error (200): the cancel lost its race — the steer already injected (the
 * inline part is authoritative) or the run reached a terminal path that owns
 * delivery — and the client should defer to the events it will receive. A
 * missing job reads the same way: nothing is left to cancel from.
 *
 * No `checkAgentAccess` dep here: a cancel injects nothing model-bound, so
 * job ownership/tenant checks suffice.
 */
export async function handleSteerCancel(
  user: SteerRequestUser,
  body: SteerCancelBody,
  options: SteerProtocolOptions = {},
): Promise<SteerRequestResult> {
  const protocol: SteerProtocolContext = {
    value: protocolFromOptions(options),
    expose: Object.prototype.hasOwnProperty.call(options, 'generationProtocolVersion'),
  };
  return attachProtocol(await handleSteerCancelInternal(user, body, protocol), protocol);
}

async function handleSteerCancelInternal(
  user: SteerRequestUser,
  body: SteerCancelBody,
  protocol: SteerProtocolContext,
): Promise<SteerRequestResult> {
  const conversationId = body.conversationId;
  if (typeof conversationId !== 'string' || !conversationId || conversationId === 'new') {
    return { status: 400, body: { code: 'INVALID_CONVERSATION' } };
  }
  const expectedGeneration = parseExpectedGenerationCreatedAt(body.generationCreatedAt);
  if (expectedGeneration.invalid) {
    return { status: 400, body: { code: 'INVALID_GENERATION_IDENTITY' } };
  }
  const steerId = body.steerId;
  if (typeof steerId !== 'string' || steerId.length === 0) {
    return { status: 400, body: { code: 'INVALID_STEER_ID' } };
  }
  if (
    body.clientSteerId != null &&
    (typeof body.clientSteerId !== 'string' ||
      body.clientSteerId.length === 0 ||
      body.clientSteerId.length > 128)
  ) {
    return { status: 400, body: { code: 'INVALID_CLIENT_STEER_ID' } };
  }

  const streamId = conversationId;
  const clientSteerId = typeof body.clientSteerId === 'string' ? body.clientSteerId : undefined;
  const job = await GenerationJobManager.getJob(streamId);
  let sawReceipt = false;
  const readOwnedReceipt = async (): Promise<SteerReceipt | null | 'unauthorized'> => {
    if (protocol.value !== 2 || clientSteerId == null) {
      return null;
    }
    const receipt = await GenerationJobManager.steering.getReceipt(streamId, clientSteerId);
    if (receipt == null) {
      return null;
    }
    sawReceipt = true;
    if (
      receipt.userId !== (user.id ?? '') ||
      hasTenantMismatch(receipt, user) ||
      receipt.item.steerId !== steerId
    ) {
      return 'unauthorized';
    }
    return receipt;
  };
  /** Settle receipt states that prove this exact steer was already cancelled
   * or reached terminal leftover recovery. The second read covers concurrent
   * cancel requests that both observed `leftover` before one won the atomic
   * discard. */
  const settleReceipt = async (): Promise<SteerRequestResult | null> => {
    const receipt = await readOwnedReceipt();
    if (receipt === 'unauthorized') {
      return { status: 403, body: { code: 'UNAUTHORIZED' } };
    }
    if (
      receipt != null &&
      expectedGeneration.value != null &&
      receipt.generationCreatedAt !== expectedGeneration.value
    ) {
      return { status: 409, body: { code: 'RUN_REPLACED' } };
    }
    if (receipt?.state === 'cancelled') {
      return { status: 200, body: { removed: true, replayed: true } };
    }
    if (receipt?.state !== 'leftover' || clientSteerId == null) {
      return null;
    }
    const discarded = await GenerationJobManager.steering.discardLeftover(
      streamId,
      clientSteerId,
      steerId,
      { userId: user.id ?? '', tenantId: user.tenantId },
      receipt.generationCreatedAt,
    );
    if (discarded) {
      return { status: 200, body: { removed: true, replayed: true } };
    }
    const racedReceipt = await readOwnedReceipt();
    if (racedReceipt === 'unauthorized') {
      return { status: 403, body: { code: 'UNAUTHORIZED' } };
    }
    if (
      racedReceipt != null &&
      expectedGeneration.value != null &&
      racedReceipt.generationCreatedAt !== expectedGeneration.value
    ) {
      return { status: 409, body: { code: 'RUN_REPLACED' } };
    }
    return racedReceipt?.state === 'cancelled'
      ? { status: 200, body: { removed: true, replayed: true } }
      : null;
  };
  const replaySettlement = await settleReceipt();
  if (replaySettlement != null) {
    return replaySettlement;
  }
  /** A later v1 job must not hide an earlier v2 receipt. The receipt read
   * above is owner/tenant/epoch-authorized evidence about an already-accepted
   * action; only after settling it do we cap new mutations to the current
   * job's marker. This mirrors the enqueue replay ordering. */
  if (job != null) {
    capProtocolToJob(protocol, job);
  }
  if (!job) {
    /** The generation may have terminalized between the first receipt read
     * and this job lookup. Re-read before declaring the cancel lost so its
     * newly parked leftover cannot reappear after the client discarded it. */
    const racedSettlement = await settleReceipt();
    if (racedSettlement != null) {
      return racedSettlement;
    }
    if (!sawReceipt) {
      protocol.value = 1;
    }
    return { status: 200, body: { removed: false } };
  }
  if (job.metadata?.userId !== user.id) {
    logger.warn(`[handleSteerCancel] Unauthorized cancel attempt for ${streamId} by ${user.id}`);
    return { status: 403, body: { code: 'UNAUTHORIZED' } };
  }
  if (hasTenantMismatch(job.metadata, user)) {
    return { status: 403, body: { code: 'UNAUTHORIZED' } };
  }
  if (expectedGeneration.value != null && job.createdAt !== expectedGeneration.value) {
    return { status: 409, body: { code: 'RUN_REPLACED' } };
  }

  const removed = await GenerationJobManager.steering.cancel(streamId, steerId, job.createdAt);
  /** A cancelled steer must also disarm any preempt request it carried —
   *  cancel is live UI, and a request left armed would seal an unrelated
   *  stretch of generation, drain nothing, and end the run mid-sentence. */
  if (!removed) {
    return (await settleReceipt()) ?? { status: 200, body: { removed: false } };
  }
  /**
   * Waited on so a failed disarm is retried and logged before the response,
   * but BOUNDED, and its outcome is deliberately NOT reported to the client.
   *
   * The bound is the load-bearing part. ioredis queues commands while a
   * connection is down rather than rejecting them, so an unbounded await here
   * can hang for as long as the outage lasts — and the item is already
   * durably cancelled at this point. A client that gives up then treats the
   * cancel as failed and restores a chip for a steer that no longer exists
   * and can never produce an applied event, which is strictly worse than the
   * lost clear this wait was protecting against. Every successful cancel
   * publishes, so ordinary steers are exposed to it too, not just preemptive
   * ones. The publish keeps running with its retry and logging intact after
   * the timeout — it is simply no longer in front of the response.
   *
   * A resolved publish is not proof the owner heard it — the delivery count
   * includes this replica's own facade subscription — so any `disarmed` flag
   * would claim a certainty the transport cannot provide, which is the same
   * over-promise the `preempt` flag was corrected for. Disarm is best effort
   * with a bounded, self-healing failure: if the clear is lost the owner
   * seals once, its empty boundary self-clears, and the turn is persisted
   * `unfinished: true` rather than silently truncated.
   *
   * `removed` stays true because it is true — the steer really did leave the
   * queue, and inverting it would make the client re-show a chip for a steer
   * that can never arrive.
   */
  const disarm = GenerationJobManager.noteSteersRemoved(streamId, [steerId], job.createdAt);
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    disarm,
    new Promise<void>((resolve) => {
      settleTimer = setTimeout(() => {
        logger.warn(
          `[handleSteerCancel] Disarm publish for ${streamId} steer=${steerId} still pending ` +
            `after ${STEER_DISARM_ACK_TIMEOUT_MS}ms; answering the cancel and letting it retry`,
        );
        resolve();
      }, STEER_DISARM_ACK_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(settleTimer);
  return { status: 200, body: { removed } };
}

/**
 * Escalates a still-queued steer to an interrupt IN PLACE — one atomic flag
 * flip on the existing item, so its FIFO position, id, and timestamp all
 * survive and no reclaim window ever exists. `armed: false` is not an error:
 * the steer already injected, was cancelled, or belongs to a run that ended
 * (the client defers to the events it will receive). Mirrors the steer POST's
 * preempt contract exactly: the durable flag is gated on the OWNER's recorded
 * capability, the store op is fenced to the validated generation, and the
 * volatile arm publish is fire-and-forget because the durable flag is the
 * truth `rearmQueuedPreempts` trusts on resume and handover.
 */
export async function handleSteerArm(
  user: SteerRequestUser,
  body: SteerCancelBody,
  options: SteerProtocolOptions = {},
): Promise<SteerRequestResult> {
  const protocol: SteerProtocolContext = {
    value: protocolFromOptions(options),
    expose: Object.prototype.hasOwnProperty.call(options, 'generationProtocolVersion'),
  };
  return attachProtocol(await handleSteerArmInternal(user, body, protocol), protocol);
}

async function handleSteerArmInternal(
  user: SteerRequestUser,
  body: SteerCancelBody,
  protocol: SteerProtocolContext,
): Promise<SteerRequestResult> {
  const conversationId = body.conversationId;
  if (typeof conversationId !== 'string' || !conversationId || conversationId === 'new') {
    return { status: 400, body: { code: 'INVALID_CONVERSATION' } };
  }
  const expectedGeneration = parseExpectedGenerationCreatedAt(body.generationCreatedAt);
  if (expectedGeneration.invalid) {
    return { status: 400, body: { code: 'INVALID_GENERATION_IDENTITY' } };
  }
  if (typeof body.steerId !== 'string' || body.steerId.length === 0) {
    return { status: 400, body: { code: 'INVALID_STEER_ID' } };
  }

  const streamId = conversationId;
  const job = await GenerationJobManager.getJob(streamId);
  if (!job) {
    protocol.value = 1;
    return { status: 200, body: { armed: false } };
  }
  capProtocolToJob(protocol, job);
  if (job.metadata?.userId !== user.id) {
    logger.warn(`[handleSteerArm] Unauthorized arm attempt for ${streamId} by ${user.id}`);
    return { status: 403, body: { code: 'UNAUTHORIZED' } };
  }
  if (hasTenantMismatch(job.metadata, user)) {
    return { status: 403, body: { code: 'UNAUTHORIZED' } };
  }
  if (expectedGeneration.value != null && job.createdAt !== expectedGeneration.value) {
    return { status: 409, body: { code: 'RUN_REPLACED' } };
  }

  /**
   * Capability is decided INSIDE the atomic store predicate, not from the job
   * read above: a HITL resume on a rolling deploy rewrites `preemptCapable`
   * for the SAME generation, so a value read here can be stale by the time
   * the flag flips. An incapable owner answers `PREEMPT_UNSUPPORTED` (same
   * honesty rule as the POST's echo — the chip must not read "interrupting"
   * for a run that can only inject at a tool boundary), with the item left
   * unflagged and still queued.
   */
  /** Always retain the store-assigned revision internally, including for a
   * v1 wire response. A capable→incapable→capable handover raises the
   * runtime's minimum accepted arm revision; publishing legacy revision 0
   * after the durable flag advanced would leave the item marked preempting
   * while the owner rejects the seal. v1 still exposes neither the revision
   * nor the correlated update event, so its wire contract is unchanged. */
  const {
    outcome: armOutcome,
    revision: preemptRevision,
    item: armedItem,
  } = await GenerationJobManager.steering.armVersioned(streamId, body.steerId, job.createdAt);
  if (armOutcome === 'incapable') {
    return { status: 200, body: { armed: false, code: 'PREEMPT_UNSUPPORTED' } };
  }
  if (armOutcome !== 'armed') {
    return { status: 200, body: { armed: false } };
  }
  if (protocol.value === 2 && armedItem != null) {
    publishSteerUpdate(streamId, job.createdAt, armedItem);
  }
  /** NOT awaited, exactly like the POST: the durable flag is already the
   *  truth, a lost publish degrades to the tool-boundary fallback, and
   *  resume/handover re-arm from the queue. */
  void GenerationJobManager.requestPreempt(
    streamId,
    body.steerId,
    job.createdAt,
    preemptRevision,
  ).then(
    (confirmed) => {
      if (!confirmed) {
        logger.warn(
          `[handleSteerArm] Preempt arm not confirmed for ${streamId} steer=${body.steerId}; ` +
            'the steer remains queued and will inject at the next boundary',
        );
      }
    },
    (error) => {
      logger.error(`[handleSteerArm] Preempt arm publish failed for ${streamId}:`, error);
    },
  );
  return {
    status: 200,
    body: {
      armed: true,
      ...(protocol.value === 2 && preemptRevision != null && { preemptRevision }),
    },
  };
}
