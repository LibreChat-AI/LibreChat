import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { sameChannelRunActor, sameDiscordNativeDestination } from 'librechat-data-provider';
import type {
  ChannelDeliveryReceipt,
  ChannelDeliveryPart,
  ChannelRunView,
  ChannelRunFence,
} from 'librechat-data-provider';
import type { ChannelBundle, Lease, Logger, ResponseGrant } from './types';
import type { WorkerProvider } from './provider';
import type { GatewayConfig } from './config';
import { createSlackWorkerProvider, slackWriteFailure, slackRecoveryEvent } from './slack/worker';
import { failedWrite, terminalSnapshot, pendingReview } from './provider';
import { ServiceError } from './transport';
import { ChannelClient } from './client';
import { SlackClient } from './slack';

export { terminalSnapshot, pendingReview } from './provider';
export { progressText } from './slack/worker';

const terminalStates = new Set(['delivered', 'failed', 'cancelled']);
class YieldRun extends Error {}

export function deliveryReceipt(run: ChannelRunView, operationId: string): ChannelDeliveryReceipt {
  const receipt = run.receipts.find((item) => item.operationId === operationId);
  if (!receipt) throw new Error('Missing persisted delivery receipt');
  return { ...receipt };
}

export function writeOutcome(
  error: unknown,
  attempts: number,
  classify: WorkerProvider['classifyError'] = slackWriteFailure,
): Omit<ChannelDeliveryReceipt, 'operationId'> {
  return failedWrite(classify(error), attempts);
}

function canYield(run: ChannelRunView): void {
  if (
    [run.progress, ...run.receipts].some(
      (item) => item?.outcome === 'inflight' || item?.outcome === 'unknown',
    )
  )
    throw new Error('Delivery awaits reconciliation');
  throw new YieldRun();
}

/** Bounded diagnostics distinguish recovery causes without retaining remote error text. */
export function recoveryEvent(
  error: unknown,
  classify: WorkerProvider['recoveryEvent'] = slackRecoveryEvent,
): string {
  if (error instanceof ServiceError) {
    if (error.code === 'transactions_unavailable') return 'channel_storage_transactions_required';
    if (error.status === 401) return 'channel_service_authentication_failed';
    if (error.status === 403) return 'channel_service_authority_unavailable';
    if (error.status === 404) return 'channel_binding_unavailable';
    if (error.status === 409) return 'channel_state_requires_reconciliation';
    if (error.status === 429) return 'channel_service_rate_limited';
    if ([500, 502, 503, 504].includes(error.status)) return 'channel_service_unavailable';
  }
  const platformEvent = classify(error);
  if (platformEvent) return platformEvent;
  if (error instanceof DOMException && error.name === 'TimeoutError')
    return 'channel_operation_timed_out';
  return 'channel_run_held_for_recovery';
}

export class ChannelWorker {
  private readonly provider: WorkerProvider;
  private readonly owner = randomBytes(16).toString('hex');
  constructor(
    private readonly config: GatewayConfig,
    private readonly client: ChannelClient,
    provider: WorkerProvider | SlackClient,
    private readonly log: Logger,
  ) {
    this.provider =
      provider instanceof SlackClient ? createSlackWorkerProvider(provider, log) : provider;
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.tick(signal);
      } catch (error) {
        if (signal.aborted) break;
        this.log.warn(recoveryEvent(error, (failure) => this.provider.recoveryEvent(failure)));
      }
      try {
        await delay(1000, undefined, { signal });
      } catch {
        break;
      }
    }
  }

  /** One durable projection turn, shared by bound loops and the bounded workspace pool. */
  async tick(signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    const lease = await this.client.claim(this.owner, signal);
    if (!lease) return false;
    if (lease.fence.owner !== this.owner) throw new Error('Claim owner changed');
    try {
      await this.process(lease, signal);
    } catch (error) {
      if (!(error instanceof YieldRun)) throw error;
      try {
        await this.client.yield(lease.fence, signal);
      } catch {
        this.log.warn('channel_yield_unconfirmed');
      }
    }
    return true;
  }

  async process(lease: Lease, parent: AbortSignal): Promise<void> {
    const { fence } = lease;
    this.assertView(lease.run, fence);
    if (!fence.owner || fence.epoch <= 0 || lease.leaseExpiresAt <= Date.now())
      throw new Error('Invalid durable lease');
    const controller = new AbortController();
    const signal = AbortSignal.any([parent, controller.signal]);
    let expiry = lease.leaseExpiresAt;
    let renewalUncertain = false;
    const check = () => {
      if (signal.aborted || Date.now() >= expiry) throw new Error('Durable lease lost');
    };
    const renewer = (async () => {
      while (!signal.aborted) {
        const remaining = expiry - Date.now();
        if (remaining <= 0) {
          renewalUncertain = true;
          controller.abort();
          return;
        }
        try {
          await delay(Math.max(1, Math.floor(remaining / 3)), undefined, { signal });
        } catch {
          return;
        }
        try {
          const renewed = await this.client.renew(fence, signal);
          if (
            renewed.fence.runId !== fence.runId ||
            renewed.fence.owner !== fence.owner ||
            renewed.fence.epoch !== fence.epoch ||
            renewed.leaseExpiresAt <= Date.now()
          )
            throw new Error('Renewal identity changed');
          expiry = renewed.leaseExpiresAt;
        } catch {
          renewalUncertain = true;
          controller.abort();
          return;
        }
      }
    })();
    let failure: unknown;
    try {
      await this.execute(lease.run, fence, signal, check);
    } catch (error) {
      failure = error;
    } finally {
      controller.abort();
      await renewer;
    }
    if (failure instanceof YieldRun && renewalUncertain) throw new Error('Renewal uncertain');
    if (failure) throw failure;
  }

  private async execute(
    initial: ChannelRunView,
    fence: ChannelRunFence,
    signal: AbortSignal,
    checkLease: () => void,
  ): Promise<void> {
    const original = structuredClone(initial.admission);
    const check = (current?: ChannelRunView) => {
      checkLease();
      const admission = current?.admission;
      if (
        admission &&
        (admission.eventId !== original.eventId ||
          admission.input !== original.input ||
          admission.externalChannelId !== original.externalChannelId ||
          admission.externalThreadKey !== original.externalThreadKey ||
          admission.externalMessageKey !== original.externalMessageKey ||
          !sameChannelRunActor(admission.actor, original.actor) ||
          !sameDiscordNativeDestination(admission.discordDestination, original.discordDestination))
      )
        throw new Error('Run admission changed');
    };
    const bundle = await this.client.channel(signal);
    if (initial.revision !== bundle.channel.revision) throw new Error('Run binding changed');
    this.provider.assertBinding(initial, bundle);
    let sessionStatus = '';
    let sessionUpdated = 0;
    let sessionRetry = 0;
    let lastProgressWrite = 0;
    const syncProgress = async (current: ChannelRunView) => {
      check(current);
      let native = false;
      if (bundle.gateway.nativeSessions && this.provider.setSessionStatus) {
        let status: 'active' | 'suspended' | 'processing' = 'processing';
        if (terminalSnapshot(current) || current.plan) status = 'active';
        else if (current.snapshot?.status === 'requires_action') status = 'suspended';
        if (!sessionRetry && sessionStatus === status && Date.now() - sessionUpdated < 60000)
          native = true;
        else if (terminalSnapshot(current) || Date.now() >= sessionRetry) {
          try {
            await this.provider.setSessionStatus(current, bundle, status, signal);
            sessionStatus = status;
            sessionUpdated = Date.now();
            sessionRetry = 0;
            native = true;
          } catch {
            sessionRetry = Date.now() + 60000;
            this.log.warn('native_status_unavailable');
          }
        }
      }
      if (native && !current.progress && !pendingReview(current) && !current.snapshot?.recovery)
        return current;
      const updated = await this.progress(current, fence, bundle, signal, check, lastProgressWrite);
      if (
        updated.progress?.revision !== current.progress?.revision ||
        updated.progress?.attempts !== current.progress?.attempts
      )
        lastProgressWrite = Date.now();
      return updated;
    };
    await this.provider.lifecycle?.(initial, bundle, 'started', signal);
    let run = initial;
    let projected = false;
    if (!run.plan && run.state !== 'queued') {
      try {
        run = await this.client.mutate(fence, 'advance', {}, signal);
        projected = true;
        check(run);
      } catch (error) {
        if (
          !(error instanceof ServiceError) ||
          error.status !== 409 ||
          error.code !== 'execution_not_prepared'
        )
          throw error;
      }
    }
    run = await syncProgress(run);
    let grant: ResponseGrant | undefined;
    let unstartedCancellation = false;
    if (!run.plan && !projected) {
      const context = run.cancellationRequested
        ? undefined
        : await this.provider.effectContext?.(run, bundle, signal);
      check(run);
      const prepared = context
        ? await this.client.prepare(fence, signal, context)
        : await this.client.prepare(fence, signal);
      if (prepared.settled) {
        this.assertView(prepared.settled, fence);
        if (
          prepared.settled.state !== 'delivering' ||
          !prepared.settled.cancellationRequested ||
          prepared.settled.snapshot?.status !== 'cancelled' ||
          prepared.settled.snapshot.responseId
        )
          throw new Error('Invalid unstarted cancellation proof');
        run = prepared.settled;
        unstartedCancellation = true;
      } else {
        if (
          !prepared.apiKey.startsWith('sk-bound-') ||
          prepared.requestKey !== `channel:${run.runId}` ||
          prepared.request.model !== bundle.agent.id ||
          prepared.request.input !== run.admission.input ||
          !prepared.request.background ||
          !prepared.request.store
        )
          throw new Error('Invalid Responses grant');
        if (!prepared.responseId) {
          if (run.cancellationRequested)
            throw new Error('Unstarted cancellation awaits reconciliation');
          check(run);
          const response = await this.client.response(prepared, 'create', signal);
          prepared.responseId = response.id;
          run = await this.client.mutate(
            fence,
            'response/bind',
            { responseId: response.id },
            signal,
          );
        }
        grant = prepared;
      }
    }
    for (let polls = 0; !run.plan; polls++) {
      check(run);
      if (grant)
        await this.client.response(grant, run.cancellationRequested ? 'cancel' : 'read', signal);
      if (!unstartedCancellation && (!projected || polls > 0))
        run = await this.client.mutate(fence, 'advance', {}, signal);
      this.assertView(run, fence);
      if (grant && run.snapshot?.responseId && run.snapshot.responseId !== grant.responseId)
        throw new Error('Response projection changed');
      if (run.plan) break;
      run = await syncProgress(run);
      if (
        terminalSnapshot(run) &&
        run.progress?.outcome === 'confirmed' &&
        run.progress.text !== this.provider.progressText(run)
      )
        run = await syncProgress(run);
      if (run.state === 'delivering' && run.snapshot) {
        if (
          terminalSnapshot(run) &&
          run.progress?.externalMessageKey &&
          ['planned', 'retryable'].includes(run.progress.outcome)
        )
          throw new Error('Terminal progress cleanup pending');
        run = await this.client.mutate(
          fence,
          'plan',
          {
            plan: this.provider.makePlan(run, bundle),
          },
          signal,
        );
        break;
      }
      if (terminalStates.has(run.state)) return;
      if (run.state === 'blocked' || run.state === 'requires_action' || polls >= 4) canYield(run);
      await delay(1000, undefined, { signal });
    }
    if (
      !run.plan ||
      !this.provider.supportsRenderer(run.plan.rendererVersion) ||
      !run.plan.parts.length ||
      run.plan.parts.length > 100
    )
      throw new Error('Unsupported delivery plan');
    const renderer = run.plan.rendererVersion;
    for (const part of run.plan.parts) {
      check(run);
      const traceAvailable = () =>
        !part.traceUrl ||
        run.plan?.parts.some(
          (current) =>
            current.operationId === part.operationId && current.traceUrl === part.traceUrl,
        );
      if (!traceAvailable()) continue;
      if (part.kind === 'artifact')
        run = await this.artifact(run, fence, part, bundle, signal, check);
      else {
        if (
          part.operationId === `${run.runId}:artifact-status` &&
          !part.required &&
          !run.plan?.parts.some(
            (item) =>
              item.kind === 'artifact' &&
              ['unknown', 'inflight', 'permanent_failure'].includes(
                deliveryReceipt(run, item.operationId).outcome,
              ),
          )
        )
          continue;
        let receipt = deliveryReceipt(run, part.operationId);
        if (
          receipt.outcome === 'confirmed' ||
          (!part.required &&
            (['unknown', 'permanent_failure'].includes(receipt.outcome) || receipt.attempts >= 5))
        )
          continue;
        this.retryable(receipt);
        const deliver = this.provider.preparePart(part, renderer, bundle);
        try {
          run = await this.client.mutate(
            fence,
            'delivery/begin',
            {
              ...(await this.provider.effectContext?.(run, bundle, signal)),
              operationId: part.operationId,
            },
            signal,
          );
        } catch (error) {
          if (
            part.traceUrl &&
            error instanceof ServiceError &&
            error.status === 409 &&
            error.code === 'trace_unavailable'
          )
            continue;
          throw error;
        }
        if (!traceAvailable()) continue;
        receipt = deliveryReceipt(run, part.operationId);
        if (receipt.outcome !== 'inflight') throw new Error('Delivery begin not persisted');
        check(run);
        try {
          const result = await deliver(run, signal);
          receipt = {
            ...receipt,
            outcome: 'confirmed',
            externalMessageKey: result.externalMessageKey,
          };
        } catch (error) {
          receipt = {
            operationId: part.operationId,
            ...failedWrite(this.provider.classifyError(error), receipt.attempts),
          };
        }
        check(run);
        run = await this.settle(run, fence, receipt, signal);
        if (receipt.outcome !== 'confirmed' && (part.required || receipt.outcome === 'retryable'))
          throw new Error('Delivery not confirmed');
      }
    }
    check(run);
    // The answer receipts are settled. Cosmetic cleanup must never cause answer replay.
    if (run.snapshot?.status === 'completed' && run.progress?.externalMessageKey) {
      try {
        if (
          run.receipts.some(
            (receipt) => receipt.externalMessageKey === run.progress?.externalMessageKey,
          )
        )
          throw new Error('Progress address overlaps answer');
        await this.provider.deleteProgress(
          run,
          bundle,
          AbortSignal.any([signal, AbortSignal.timeout(2000)]),
        );
      } catch {
        this.log.warn('optional_progress_cleanup_unavailable');
      }
    }
    check(run);
    run = await this.client.mutate(fence, 'commit', {}, signal);
    if (!terminalStates.has(run.state)) throw new Error('Commit not confirmed');
    await this.provider.lifecycle?.(
      run,
      bundle,
      run.state === 'delivered' ? 'completed' : 'failed',
      signal,
    );
  }

  private retryable(receipt: ChannelDeliveryReceipt): void {
    if (
      !['planned', 'retryable'].includes(receipt.outcome) ||
      receipt.upload ||
      receipt.attempts >= 5 ||
      (receipt.retryAt ?? 0) > Date.now()
    )
      throw new Error('Delivery deferred or awaits reconciliation');
  }

  private async settle(
    run: ChannelRunView,
    fence: ChannelRunFence,
    receipt: ChannelDeliveryReceipt,
    signal: AbortSignal,
  ): Promise<ChannelRunView> {
    const { upload: checkpoint, ...wire } = receipt;
    const updated = await this.client.mutate(fence, 'delivery/settle', { receipt: wire }, signal);
    const stored = deliveryReceipt(updated, receipt.operationId);
    if (
      stored.outcome !== receipt.outcome ||
      stored.externalMessageKey !== receipt.externalMessageKey ||
      stored.externalFileId !== receipt.externalFileId ||
      (checkpoint &&
        (stored.upload?.fileId !== checkpoint.fileId || stored.upload.stage !== checkpoint.stage))
    )
      throw new Error('Delivery settlement not persisted');
    return updated;
  }

  private async progress(
    run: ChannelRunView,
    fence: ChannelRunFence,
    bundle: ChannelBundle,
    signal: AbortSignal,
    check: (run?: ChannelRunView) => void,
    lastWrite: number,
  ): Promise<ChannelRunView> {
    if (run.plan || terminalStates.has(run.state) || run.state === 'blocked') return run;
    let progress = run.progress;
    if (terminalSnapshot(run) && !progress?.externalMessageKey) return run;
    if (
      progress &&
      (progress.rendererVersion !== this.provider.progressRenderer ||
        ['unknown', 'inflight', 'permanent_failure'].includes(progress.outcome))
    )
      return run;
    const text = this.provider.progressText(run);
    if (!progress || progress.outcome === 'confirmed') {
      if (progress?.text === text) return run;
      const revision = (progress?.revision ?? 0) + 1;
      check(run);
      run = await this.client.mutate(
        fence,
        'progress/plan',
        { revision, rendererVersion: this.provider.progressRenderer, text },
        signal,
      );
      progress = run.progress;
      if (!progress || progress.revision !== revision || progress.text !== text)
        throw new Error('Progress plan not persisted');
    }
    if (
      !['planned', 'retryable'].includes(progress.outcome) ||
      progress.text.length > this.provider.maxProgressLength
    )
      throw new Error('Unsupported progress state');
    if ((progress.retryAt ?? 0) > Date.now()) return run;
    if (Date.now() < lastWrite + 1000)
      await delay(lastWrite + 1000 - Date.now(), undefined, { signal });
    check(run);
    const revision = progress.revision;
    run = await this.client.mutate(
      fence,
      'progress/begin',
      { ...(await this.provider.effectContext?.(run, bundle, signal)), revision },
      signal,
    );
    progress = run.progress;
    if (
      !progress ||
      progress.revision !== revision ||
      progress.outcome !== 'inflight' ||
      progress.rendererVersion !== this.provider.progressRenderer ||
      !progress.text ||
      progress.text.length > this.provider.maxProgressLength
    )
      throw new Error('Progress begin not persisted');
    this.provider.validateAddress(run);
    let receipt: Omit<ChannelDeliveryReceipt, 'operationId'>;
    check(run);
    try {
      if (progress.attempts > 5) receipt = failedWrite({ outcome: 'permanent' }, progress.attempts);
      else {
        const posted = await this.provider.writeProgress(run, bundle, signal);
        receipt = {
          attempts: progress.attempts,
          outcome: 'confirmed',
          externalMessageKey: posted.externalMessageKey,
        };
      }
    } catch (error) {
      receipt = failedWrite(this.provider.classifyError(error), progress.attempts);
    }
    check(run);
    run = await this.client.mutate(fence, 'progress/settle', { revision, receipt }, signal);
    if (
      run.progress?.revision !== revision ||
      run.progress.outcome !== receipt.outcome ||
      (receipt.outcome === 'confirmed' &&
        run.progress.externalMessageKey !== receipt.externalMessageKey)
    )
      throw new Error('Progress settlement not persisted');
    return run;
  }

  private async artifact(
    run: ChannelRunView,
    fence: ChannelRunFence,
    part: ChannelDeliveryPart,
    bundle: ChannelBundle,
    signal: AbortSignal,
    check: (run?: ChannelRunView) => void,
  ): Promise<ChannelRunView> {
    const artifacts = run.snapshot?.artifacts ?? [];
    const artifact = artifacts.find((item) => item.artifactId === part.artifactId);
    if (!artifact || artifacts.length > 20 || part.required || part.presentation)
      throw new Error('Unsupported artifact part');
    let receipt = deliveryReceipt(run, part.operationId);
    if (['confirmed', 'unknown', 'permanent_failure'].includes(receipt.outcome)) return run;
    if (
      !['planned', 'retryable'].includes(receipt.outcome) ||
      receipt.upload ||
      (receipt.retryAt ?? 0) > Date.now()
    )
      throw new Error('Artifact deferred or awaits reconciliation');
    check(run);
    run = await this.client.mutate(
      fence,
      'delivery/begin',
      {
        ...(await this.provider.effectContext?.(run, bundle, signal)),
        operationId: part.operationId,
      },
      signal,
    );
    receipt = deliveryReceipt(run, part.operationId);
    if (receipt.outcome !== 'inflight' || receipt.upload)
      throw new Error('Artifact begin not persisted');
    const settle = async (outcome: ChannelDeliveryReceipt['outcome'], errorCode?: string) => {
      check(run);
      run = await this.settle(run, fence, { ...receipt, outcome, errorCode }, signal);
      if (outcome === 'retryable') throw new Error('Artifact retry deferred');
      return run;
    };
    if (receipt.attempts > 5) return settle('permanent_failure', 'artifact_retry_exhausted');
    let bytes: Buffer;
    try {
      bytes = await this.client.artifact(fence, artifact, signal);
    } catch (error) {
      if (error instanceof ServiceError && [401, 403, 409].includes(error.status)) throw error;
      return settle('permanent_failure', 'artifact_unavailable');
    }
    check(run);
    const checkpoint = async (upload: NonNullable<ChannelDeliveryReceipt['upload']>) => {
      check(run);
      run = await this.client.mutate(
        fence,
        'delivery/checkpoint',
        { operationId: part.operationId, attempts: receipt.attempts, upload },
        signal,
      );
      const stored = deliveryReceipt(run, part.operationId);
      if (
        stored.outcome !== 'inflight' ||
        stored.attempts !== receipt.attempts ||
        stored.upload?.fileId !== upload.fileId ||
        stored.upload.stage !== upload.stage
      )
        throw new Error('Upload checkpoint not persisted');
      receipt = stored;
    };
    const result = await this.provider.deliverArtifact({
      run,
      part,
      artifact,
      bytes,
      bundle,
      attempts: receipt.attempts,
      signal,
      checkpoint,
      check,
    });
    if (result.outcome === 'confirmed') {
      receipt.externalFileId = result.externalFileId;
      if (result.externalMessageKey) receipt.externalMessageKey = result.externalMessageKey;
      return settle('confirmed');
    }
    if ('retryAt' in result) receipt.retryAt = result.retryAt;
    return settle(result.outcome, result.errorCode);
  }

  private assertView(run: ChannelRunView, fence: ChannelRunFence): void {
    if (run.runId !== fence.runId || run.channelId !== this.config.CHANNEL_ID || !run.revision)
      throw new Error('Durable identity changed');
    this.provider.validateAddress(run);
  }
}
