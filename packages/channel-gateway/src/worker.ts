import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  ChannelDeliveryReceipt,
  ChannelDeliveryPart,
  ChannelRunView,
  ChannelRunFence,
} from 'librechat-data-provider';
import type { ChannelBundle, Lease, Logger, ResponseGrant } from './types';
import type { GatewayConfig } from './config';
import { durableSlackMessage, makeSlackPlan, supportedRenderer } from './render';
import { SlackClient, SlackWriteError } from './slack';
import { ChannelClient, ServiceError } from './client';

const progressRenderer = 'slack-progress-v1';
const terminalStates = new Set(['delivered', 'failed', 'cancelled']);
class YieldRun extends Error {}

export function terminalSnapshot(run: ChannelRunView): boolean {
  return !!run.snapshot && ['completed', 'failed', 'cancelled'].includes(run.snapshot.status);
}

export function pendingReview(run: ChannelRunView): boolean {
  const pending = run.snapshot?.pendingAction;
  return (
    run.snapshot?.status === 'requires_action' &&
    !!pending?.actionId &&
    pending.expiresAt > Date.now() &&
    ['tool_approval', 'ask_user_question', 'oauth'].includes(pending.kind)
  );
}

export function progressText(run: ChannelRunView): string {
  if (terminalSnapshot(run)) {
    if (run.snapshot?.status === 'completed') return ':white_check_mark: Completed.';
    if (run.snapshot?.status === 'cancelled') return 'Cancelled.';
    return ':warning: Failed.';
  }
  if (run.cancellationRequested) return 'Cancellation requested.';
  if (run.snapshot?.recovery === 'execution_state_unavailable')
    return ':warning: This request’s execution status is unavailable, possibly after a restart. Sign-in may be saved, but continuation and completion are not confirmed. Check the result; do not repeat actions that may already have run. If this stays unavailable, ask an administrator to reconcile the request before retrying. Stop requests cancellation, not proof that work has stopped.';
  if (run.snapshot?.status === 'requires_action')
    return pendingReview(run)
      ? '⏸ Your input is needed. Open the private review to continue.'
      : '⏸ Waiting for input. The review action is unavailable or expired.';
  return ':hourglass_flowing_sand: Working…';
}

export function deliveryReceipt(run: ChannelRunView, operationId: string): ChannelDeliveryReceipt {
  const receipt = run.receipts.find((item) => item.operationId === operationId);
  if (!receipt) throw new Error('Missing persisted delivery receipt');
  return { ...receipt };
}

export function writeOutcome(
  error: unknown,
  attempts: number,
): Omit<ChannelDeliveryReceipt, 'operationId'> {
  if (error instanceof SlackWriteError && error.outcome === 'permanent')
    return { attempts, outcome: 'permanent_failure', errorCode: 'transport_rejected' };
  if (error instanceof SlackWriteError && error.outcome === 'retryable')
    return {
      attempts,
      outcome: 'retryable',
      errorCode: 'transport_retryable',
      retryAt: Date.now() + Math.max(1000, error.retryAfterMs),
    };
  return { attempts, outcome: 'unknown', errorCode: 'transport_uncertain' };
}

function address(run: ChannelRunView): { channel: string; thread_ts: string } {
  const channel = run.admission.externalChannelId;
  const prefix = channel + ':';
  const thread = run.admission.externalThreadKey.slice(prefix.length);
  if (
    !channel ||
    !run.admission.externalThreadKey.startsWith(prefix) ||
    !thread ||
    /[:\s]/.test(thread)
  )
    throw new Error('Invalid durable thread address');
  return { channel, thread_ts: thread };
}

function assertView(run: ChannelRunView, fence: ChannelRunFence, channelId: string): void {
  if (run.runId !== fence.runId || run.channelId !== channelId || !run.revision)
    throw new Error('Durable identity changed');
  address(run);
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

export class ChannelWorker {
  private readonly owner = randomBytes(16).toString('hex');
  constructor(
    private readonly config: GatewayConfig,
    private readonly client: ChannelClient,
    private readonly slack: SlackClient,
    private readonly log: Logger,
  ) {}

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let lease: Lease | null = null;
      try {
        lease = await this.client.claim(this.owner, signal);
        if (lease) {
          if (lease.fence.owner !== this.owner) throw new Error('Claim owner changed');
          await this.process(lease, signal);
        }
      } catch (error) {
        if (signal.aborted) break;
        if (error instanceof YieldRun && lease) {
          try {
            await this.client.yield(lease.fence, signal);
          } catch {
            this.log.warn('channel_yield_unconfirmed');
          }
        } else this.log.warn('channel_run_held_for_recovery');
      }
      try {
        await delay(1000, undefined, { signal });
      } catch {
        break;
      }
    }
  }

  async process(lease: Lease, parent: AbortSignal): Promise<void> {
    const { fence } = lease;
    assertView(lease.run, fence, this.config.CHANNEL_ID);
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
    check: () => void,
  ): Promise<void> {
    const bundle = await this.client.channel(signal);
    if (
      initial.revision !== bundle.channel.revision ||
      initial.admission.actor.teamId !== bundle.channel.slack.teamId ||
      initial.admission.actor.appId !== bundle.channel.slack.appId
    )
      throw new Error('Run binding changed');
    const token = bundle.credentials.botToken;
    let sessionStatus = '';
    let sessionUpdated = 0;
    let sessionRetry = 0;
    let lastProgressWrite = 0;
    const syncProgress = async (current: ChannelRunView) => {
      check();
      let native = false;
      if (this.config.SLACK_NATIVE_SESSIONS) {
        let status: 'active' | 'suspended' | 'processing' = 'processing';
        if (terminalSnapshot(current) || current.plan) status = 'active';
        else if (current.snapshot?.status === 'requires_action') status = 'suspended';
        if (!sessionRetry && sessionStatus === status && Date.now() - sessionUpdated < 60000)
          native = true;
        else if (terminalSnapshot(current) || Date.now() >= sessionRetry) {
          const target = address(current);
          try {
            await this.slack.setSessionStatus(
              token,
              {
                channel: target.channel,
                threadTs: target.thread_ts,
                status,
                title: bundle.agent.name
                  ? `${bundle.agent.name} conversation`.slice(0, 200)
                  : undefined,
              },
              signal,
            );
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
      if (native && !current.progress && !pendingReview(current)) return current;
      const updated = await this.progress(current, fence, bundle, signal, check, lastProgressWrite);
      if (
        updated.progress?.revision !== current.progress?.revision ||
        updated.progress?.attempts !== current.progress?.attempts
      )
        lastProgressWrite = Date.now();
      return updated;
    };
    await this.lifecycle(initial, bundle, 'started', signal);
    let run = await syncProgress(initial);
    let grant: ResponseGrant | undefined;
    let unstartedCancellation = false;
    if (!run.plan) {
      const prepared = await this.client.prepare(fence, signal);
      if (prepared.settled) {
        assertView(prepared.settled, fence, this.config.CHANNEL_ID);
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
          check();
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
      check();
      if (grant)
        await this.client.response(grant, run.cancellationRequested ? 'cancel' : 'read', signal);
      if (!unstartedCancellation) run = await this.client.mutate(fence, 'advance', {}, signal);
      assertView(run, fence, this.config.CHANNEL_ID);
      if (grant && run.snapshot?.responseId && run.snapshot.responseId !== grant.responseId)
        throw new Error('Response projection changed');
      if (run.plan) break;
      run = await syncProgress(run);
      if (
        terminalSnapshot(run) &&
        run.progress?.outcome === 'confirmed' &&
        run.progress.text !== progressText(run)
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
          { plan: makeSlackPlan(run, this.config.SLACK_NATIVE_SESSIONS) },
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
      !supportedRenderer(run.plan.rendererVersion) ||
      !run.plan.parts.length ||
      run.plan.parts.length > 100
    )
      throw new Error('Unsupported delivery plan');
    const renderer = run.plan.rendererVersion;
    for (const part of run.plan.parts) {
      check();
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
          (!part.required && ['unknown', 'permanent_failure'].includes(receipt.outcome))
        )
          continue;
        this.retryable(receipt);
        const message = durableSlackMessage(part, renderer);
        run = await this.client.mutate(
          fence,
          'delivery/begin',
          { operationId: part.operationId },
          signal,
        );
        receipt = deliveryReceipt(run, part.operationId);
        if (receipt.outcome !== 'inflight') throw new Error('Delivery begin not persisted');
        check();
        try {
          const result = await this.slack.deliverPart(
            token,
            { ...address(run), ...message },
            signal,
          );
          receipt = {
            ...receipt,
            outcome: 'confirmed',
            externalMessageKey: `${result.channel}:${result.ts}`,
          };
        } catch (error) {
          receipt = { operationId: part.operationId, ...writeOutcome(error, receipt.attempts) };
        }
        check();
        run = await this.settle(run, fence, receipt, signal);
        if (receipt.outcome !== 'confirmed' && (part.required || receipt.outcome === 'retryable'))
          throw new Error('Delivery not confirmed');
      }
    }
    check();
    run = await this.client.mutate(fence, 'commit', {}, signal);
    if (!terminalStates.has(run.state)) throw new Error('Commit not confirmed');
    await this.lifecycle(run, bundle, run.state === 'delivered' ? 'completed' : 'failed', signal);
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
    check: () => void,
    lastWrite: number,
  ): Promise<ChannelRunView> {
    if (run.plan || terminalStates.has(run.state) || run.state === 'blocked') return run;
    let progress = run.progress;
    if (terminalSnapshot(run) && !progress?.externalMessageKey) return run;
    if (
      progress &&
      (progress.rendererVersion !== progressRenderer ||
        ['unknown', 'inflight', 'permanent_failure'].includes(progress.outcome))
    )
      return run;
    const text = progressText(run);
    if (!progress || progress.outcome === 'confirmed') {
      if (progress?.text === text) return run;
      const revision = (progress?.revision ?? 0) + 1;
      check();
      run = await this.client.mutate(
        fence,
        'progress/plan',
        { revision, rendererVersion: progressRenderer, text },
        signal,
      );
      progress = run.progress;
      if (!progress || progress.revision !== revision || progress.text !== text)
        throw new Error('Progress plan not persisted');
    }
    if (!['planned', 'retryable'].includes(progress.outcome) || progress.text.length > 4000)
      throw new Error('Unsupported progress state');
    if ((progress.retryAt ?? 0) > Date.now()) return run;
    if (Date.now() < lastWrite + 1000)
      await delay(lastWrite + 1000 - Date.now(), undefined, { signal });
    check();
    const revision = progress.revision;
    run = await this.client.mutate(fence, 'progress/begin', { revision }, signal);
    progress = run.progress;
    if (
      !progress ||
      progress.revision !== revision ||
      progress.outcome !== 'inflight' ||
      progress.rendererVersion !== progressRenderer ||
      !progress.text ||
      progress.text.length > 4000
    )
      throw new Error('Progress begin not persisted');
    const target = address(run);
    const blocks: Parameters<SlackClient['postMessage']>[1]['blocks'] = [
      { type: 'section', text: { type: 'mrkdwn', text: progress.text }, expand: true },
    ];
    if (!terminalSnapshot(run) && !run.cancellationRequested) {
      const value = JSON.stringify({ runId: run.runId, revision: run.revision });
      const elements = [
        {
          type: 'button' as const,
          text: { type: 'plain_text' as const, text: 'Stop' },
          action_id: 'channel_run_cancel',
          value,
        },
      ];
      if (pendingReview(run))
        elements.push({
          type: 'button',
          text: { type: 'plain_text', text: 'Review request' },
          action_id: 'channel_run_review',
          value,
        });
      blocks.push({ type: 'actions', elements });
    }
    let receipt: Omit<ChannelDeliveryReceipt, 'operationId'>;
    check();
    try {
      if (progress.attempts > 5) throw new SlackWriteError('permanent');
      let posted: { channel: string; ts: string };
      if (progress.externalMessageKey) {
        const prefix = target.channel + ':';
        const ts = progress.externalMessageKey.slice(prefix.length);
        if (!progress.externalMessageKey.startsWith(prefix) || !ts || /[:\s]/.test(ts))
          throw new Error('Invalid progress address');
        posted = await this.slack.updateMessageOnce(
          bundle.credentials.botToken,
          { channel: target.channel, ts, text: progress.text, blocks },
          signal,
        );
      } else
        posted = await this.slack.postMessage(
          bundle.credentials.botToken,
          { ...target, text: progress.text, blocks },
          signal,
        );
      receipt = {
        attempts: progress.attempts,
        outcome: 'confirmed',
        externalMessageKey: `${posted.channel}:${posted.ts}`,
      };
    } catch (error) {
      receipt = writeOutcome(error, progress.attempts);
    }
    check();
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
    check: () => void,
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
    check();
    run = await this.client.mutate(
      fence,
      'delivery/begin',
      { operationId: part.operationId },
      signal,
    );
    receipt = deliveryReceipt(run, part.operationId);
    if (receipt.outcome !== 'inflight' || receipt.upload)
      throw new Error('Artifact begin not persisted');
    const settle = async (outcome: ChannelDeliveryReceipt['outcome'], errorCode?: string) => {
      check();
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
    check();
    let allocation: { fileId: string; uploadUrl: string };
    try {
      allocation = await this.slack.allocateArtifact(
        bundle.credentials.botToken,
        artifact.filename,
        artifact.bytes,
        signal,
      );
    } catch (error) {
      const outcome = writeOutcome(error, receipt.attempts);
      receipt.retryAt = outcome.retryAt;
      return settle(outcome.outcome, outcome.errorCode);
    }
    const checkpoint = async (stage: 'allocated' | 'uploaded') => {
      check();
      const upload = { fileId: allocation.fileId, stage };
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
        stored.upload.stage !== stage
      )
        throw new Error('Upload checkpoint not persisted');
      receipt = stored;
    };
    await checkpoint('allocated');
    check();
    try {
      await this.slack.uploadArtifact(allocation.uploadUrl, bytes, signal);
    } catch {
      return settle('unknown', 'artifact_upload_uncertain');
    }
    await checkpoint('uploaded');
    check();
    const target = address(run);
    try {
      await this.slack.completeArtifact(
        bundle.credentials.botToken,
        {
          channel: target.channel,
          threadTs: target.thread_ts,
          fileId: allocation.fileId,
          filename: artifact.filename,
        },
        signal,
      );
    } catch {
      return settle('unknown', 'artifact_completion_uncertain');
    }
    receipt.externalFileId = allocation.fileId;
    return settle('confirmed');
  }

  private async lifecycle(
    run: ChannelRunView,
    bundle: ChannelBundle,
    phase: 'started' | 'completed' | 'failed',
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.config.SLACK_LIFECYCLE_REACTIONS) return;
    const prefix = run.admission.externalChannelId + ':';
    const ts = run.admission.externalMessageKey.slice(prefix.length);
    if (!run.admission.externalMessageKey.startsWith(prefix) || !ts || /[:\s]/.test(ts)) return;
    const limited = AbortSignal.any([signal, AbortSignal.timeout(2000)]);
    const reaction = (operation: 'add' | 'remove', name: string) =>
      this.slack.reaction(
        bundle.credentials.botToken,
        operation,
        run.admission.externalChannelId,
        ts,
        name,
        limited,
      );
    try {
      if (phase === 'started') {
        await reaction('add', 'eyes');
        await reaction('add', 'hourglass_flowing_sand');
      } else {
        await reaction('remove', 'hourglass_flowing_sand');
        await reaction('add', phase === 'completed' ? 'white_check_mark' : 'warning');
      }
    } catch {
      this.log.warn('optional_lifecycle_unavailable');
    }
  }
}
