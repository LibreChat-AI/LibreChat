import type { ChannelRunView } from 'librechat-data-provider';
import type { ProviderWriteFailure, WorkerProvider } from '../provider';
import type { SlackClient } from '../slack';
import type { Logger } from '../types';
import { durableSlackMessage, makeSlackPlan, supportedRenderer } from '../render';
import { failedWrite, pendingReview, terminalSnapshot } from '../provider';
import { assertSlackBundle } from '../types';
import { SlackWriteError } from '../slack';

export function progressText(run: ChannelRunView): string {
  if (terminalSnapshot(run)) {
    if (run.snapshot?.status === 'completed') return ':white_check_mark: Completed.';
    if (run.snapshot?.status === 'cancelled') return 'Cancelled.';
    return ':warning: Failed.';
  }
  if (run.snapshot?.recovery === 'execution_state_unavailable')
    return (
      (run.cancellationRequested ? 'Cancellation requested. ' : '') +
      ':warning: This request’s execution status is unavailable, possibly after a restart. Sign-in may be saved, but continuation and completion are not confirmed. Check the result; do not repeat actions that may already have run. If this stays unavailable, ask an administrator to reconcile the request before retrying. Stop requests cancellation, not proof that work has stopped.'
    );
  if (run.cancellationRequested) return 'Cancellation requested.';
  if (run.snapshot?.status === 'requires_action')
    return pendingReview(run)
      ? '⏸ Your input is needed. Open the private review to continue.'
      : '⏸ Waiting for input. The review action is unavailable or expired.';
  return ':hourglass_flowing_sand: Working…';
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

function progressAddress(run: ChannelRunView): { channel: string; ts: string } {
  const channel = run.admission.externalChannelId;
  const prefix = channel + ':';
  const key = run.progress?.externalMessageKey ?? '';
  const ts = key.slice(prefix.length);
  if (!key.startsWith(prefix) || !ts || /[:\s]/.test(ts))
    throw new Error('Invalid progress address');
  return { channel, ts };
}

export function slackWriteFailure(error: unknown): ProviderWriteFailure {
  if (error instanceof SlackWriteError)
    return { outcome: error.outcome, retryAfterMs: error.retryAfterMs };
  return { outcome: 'unknown' };
}

export function slackRecoveryEvent(error: unknown): string | undefined {
  if (!(error instanceof SlackWriteError)) return undefined;
  if (error.outcome === 'permanent') return 'slack_write_rejected';
  if (error.outcome === 'retryable') return 'slack_write_deferred';
  return 'slack_write_outcome_unconfirmed';
}

export function createSlackWorkerProvider(slack: SlackClient, log: Logger): WorkerProvider {
  return {
    progressRenderer: 'slack-progress-v1',
    maxProgressLength: 4000,
    validateAddress(run) {
      address(run);
    },
    assertBinding(run, bundle) {
      assertSlackBundle(bundle);
      if (
        run.admission.actor.provider !== undefined ||
        run.admission.actor.teamId !== bundle.channel.slack.teamId ||
        run.admission.actor.appId !== bundle.channel.slack.appId
      )
        throw new Error('Run binding changed');
    },
    progressText,
    makePlan(run, bundle) {
      assertSlackBundle(bundle);
      return makeSlackPlan(run, bundle.gateway.nativeSessions, bundle.delivery.maxDeliveryParts);
    },
    supportsRenderer: supportedRenderer,
    classifyError: slackWriteFailure,
    recoveryEvent: slackRecoveryEvent,
    preparePart(part, renderer, bundle) {
      assertSlackBundle(bundle);
      const message = durableSlackMessage(part, renderer);
      return async (run, signal) => {
        const result = await slack.deliverPart(
          bundle.credentials.botToken,
          { ...address(run), ...message },
          signal,
        );
        return { externalMessageKey: `${result.channel}:${result.ts}` };
      };
    },
    async writeProgress(run, bundle, signal) {
      assertSlackBundle(bundle);
      const progress = run.progress;
      if (!progress) throw new Error('Missing progress state');
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
      const posted = progress.externalMessageKey
        ? await slack.updateMessageOnce(
            bundle.credentials.botToken,
            { ...progressAddress(run), text: progress.text, blocks },
            signal,
          )
        : await slack.postMessage(
            bundle.credentials.botToken,
            { ...target, text: progress.text, blocks },
            signal,
          );
      return { externalMessageKey: `${posted.channel}:${posted.ts}` };
    },
    async deleteProgress(run, bundle, signal) {
      assertSlackBundle(bundle);
      await slack.deleteMessage(bundle.credentials.botToken, progressAddress(run), signal);
    },
    async setSessionStatus(run, bundle, status, signal) {
      assertSlackBundle(bundle);
      const target = address(run);
      await slack.setSessionStatus(
        bundle.credentials.botToken,
        {
          channel: target.channel,
          threadTs: target.thread_ts,
          status,
          title: bundle.agent.name ? `${bundle.agent.name} conversation`.slice(0, 200) : undefined,
        },
        signal,
      );
    },
    async deliverArtifact({ run, artifact, bytes, bundle, attempts, signal, checkpoint, check }) {
      assertSlackBundle(bundle);
      let allocation: { fileId: string; uploadUrl: string };
      try {
        allocation = await slack.allocateArtifact(
          bundle.credentials.botToken,
          artifact.filename,
          artifact.bytes,
          signal,
        );
      } catch (error) {
        const failure = failedWrite(slackWriteFailure(error), attempts);
        return {
          outcome: failure.outcome,
          errorCode: failure.errorCode,
          retryAt: failure.retryAt,
        };
      }
      await checkpoint({ fileId: allocation.fileId, stage: 'allocated' });
      check();
      try {
        await slack.uploadArtifact(allocation.uploadUrl, bytes, signal);
      } catch {
        return { outcome: 'unknown', errorCode: 'artifact_upload_uncertain' };
      }
      await checkpoint({ fileId: allocation.fileId, stage: 'uploaded' });
      check();
      const target = address(run);
      try {
        await slack.completeArtifact(
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
        return { outcome: 'unknown', errorCode: 'artifact_completion_uncertain' };
      }
      return { outcome: 'confirmed', externalFileId: allocation.fileId };
    },
    async lifecycle(run, bundle, phase, signal) {
      assertSlackBundle(bundle);
      if (!bundle.gateway.lifecycleReactions) return;
      const prefix = run.admission.externalChannelId + ':';
      const ts = run.admission.externalMessageKey.slice(prefix.length);
      if (!run.admission.externalMessageKey.startsWith(prefix) || !ts || /[:\s]/.test(ts)) return;
      const limited = AbortSignal.any([signal, AbortSignal.timeout(2000)]);
      const reaction = (operation: 'add' | 'remove', name: string) =>
        slack.reaction(
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
        log.warn('optional_lifecycle_unavailable');
      }
    },
  };
}
