import { channelSnowflakeSchema, channelRunActorSchema } from 'librechat-data-provider';
import type {
  ChannelRunView,
  ChannelDeliveryPart,
  DiscordChannelServiceBundle,
} from 'librechat-data-provider';
import type { DiscordRateCoordinator } from './rates';
import type { WorkerProvider } from '../provider';
import type { ChannelBundle } from '../types';
import type { DiscordClient } from './client';
import {
  discordRendererVersion,
  renderDiscordPlan,
  discordPlanRevision,
  sanitizeDiscordMentions,
} from './render';
import { safeSummarySessionURL, validSummary } from '../render';
import { pendingReview, terminalSnapshot } from '../provider';
import { DiscordWriteError } from './client';

export interface DiscordWorkerDependencies {
  rates: DiscordRateCoordinator;
  /** Build from the current bundle, not the credential present when the worker was constructed. */
  createClient: (
    bundle: DiscordChannelServiceBundle,
    rates: DiscordRateCoordinator,
  ) => Pick<DiscordClient, 'createMessage' | 'editMessage' | 'deleteMessage'>;
}

function discordBundle(bundle: ChannelBundle): asserts bundle is DiscordChannelServiceBundle {
  if (bundle.channel.type !== 'discord' || !('discord' in bundle) || !bundle.discord.enabled)
    throw new Error('Unsupported Discord channel provider');
}

function addressKey(key: string, channelId: string): string {
  const [channel, id, extra] = key.split(':');
  if (channel !== channelId || extra !== undefined || !channelSnowflakeSchema.safeParse(id).success)
    throw new Error('Invalid Discord durable address');
  return id;
}

function validateAddress(run: ChannelRunView): void {
  const channel = run.admission.externalChannelId;
  if (!channelSnowflakeSchema.safeParse(channel).success)
    throw new Error('Invalid Discord destination');
  addressKey(run.admission.externalThreadKey, channel);
  addressKey(run.admission.externalMessageKey, channel);
}

const traceText = (url: string) => `[View session](<${url}>)`;
function validatePart(part: ChannelDeliveryPart): void {
  if (
    part.kind !== 'message' ||
    part.presentation !== undefined ||
    part.artifactId !== undefined ||
    !part.text ||
    part.text.length > 2000
  )
    throw new Error('Unsupported Discord delivery part');
  if (part.traceUrl !== undefined) {
    if (
      part.required ||
      !safeSummarySessionURL(part.traceUrl) ||
      part.text !== traceText(part.traceUrl)
    )
      throw new Error('Invalid Discord session link');
  } else if (sanitizeDiscordMentions(part.text) !== part.text)
    throw new Error('Unsafe Discord delivery text');
}

function assertBinding(
  run: ChannelRunView,
  bundle: ChannelBundle,
): asserts bundle is DiscordChannelServiceBundle {
  discordBundle(bundle);
  validateAddress(run);
  const actor = run.admission.actor;
  if (
    run.channelId !== bundle.channel.channelId ||
    run.revision !== bundle.channel.revision ||
    !channelRunActorSchema.safeParse(actor).success ||
    actor.provider !== 'discord' ||
    actor.applicationId !== bundle.channel.discord.applicationId ||
    actor.guildId !== bundle.channel.discord.guildId ||
    run.admission.externalChannelId !== bundle.channel.discord.externalChannelId
  )
    throw new Error('Discord run binding changed');
  if (run.plan) {
    if (run.plan.rendererVersion !== discordRendererVersion)
      throw new Error('Unsupported Discord renderer');
    for (const part of run.plan.parts) {
      validatePart(part);
      if (!part.operationId.startsWith(`${run.runId}:`))
        throw new Error('Discord operation identity changed');
    }
  }
}

export function discordProgressText(run: ChannelRunView): string {
  if (terminalSnapshot(run)) {
    if (run.snapshot?.status === 'completed') return 'Completed.';
    if (run.snapshot?.status === 'cancelled') return 'Cancelled.';
    return 'Failed.';
  }
  if (run.snapshot?.recovery === 'execution_state_unavailable')
    return (
      (run.cancellationRequested ? 'Cancellation requested. ' : '') +
      'The execution status is unavailable, possibly after a restart. Completion is not confirmed. Check the result before retrying actions that may already have run. Ask an administrator to reconcile this request if the status stays unavailable.'
    );
  if (run.cancellationRequested) return 'Cancellation requested.';
  if (run.snapshot?.status === 'requires_action')
    return pendingReview(run)
      ? 'Your input is needed. Open the private review to continue.'
      : 'Waiting for input. The review action is unavailable or expired.';
  return 'Working...';
}

export function createDiscordWorkerProvider(deps: DiscordWorkerDependencies): WorkerProvider {
  const client = (bundle: DiscordChannelServiceBundle) => deps.createClient(bundle, deps.rates);
  return {
    progressRenderer: 'discord-progress-v1',
    maxProgressLength: 2000,
    validateAddress,
    assertBinding,
    progressText: discordProgressText,
    supportsRenderer: (version) => version === discordRendererVersion,
    makePlan(run, bundle) {
      assertBinding(run, bundle);
      if (run.plan) throw new Error('Existing delivery plans must not be regenerated');
      const snapshot = run.snapshot;
      if (
        !snapshot ||
        !terminalSnapshot(run) ||
        (snapshot.status === 'completed' && !snapshot.responseId)
      )
        throw new Error('Missing terminal Discord snapshot');
      let text = snapshot.text;
      if (snapshot.status === 'failed')
        text = 'Something went wrong while talking to the agent. Please try again.';
      else if (snapshot.status === 'cancelled') text = 'This request was cancelled.';
      else if (!text.trim()) text = 'The agent finished without a text reply.';
      if (snapshot.artifacts?.length || snapshot.artifactsUnavailable)
        text += '\n\nAttachments are unavailable in Discord. The text answer is preserved.';
      const plan = renderDiscordPlan({ runId: run.runId, text }, bundle.delivery.maxDeliveryParts, {
        shorten: true,
      });
      const summary = snapshot.summary;
      const url = validSummary(summary, run.sequence) ? summary.session?.url : undefined;
      if (
        url &&
        safeSummarySessionURL(url) &&
        traceText(url).length <= 2000 &&
        plan.parts.length < bundle.delivery.maxDeliveryParts
      )
        plan.parts.push({
          operationId: `${run.runId}:trace:0`,
          kind: 'message',
          required: false,
          text: traceText(url),
          traceUrl: url,
        });
      plan.revision = discordPlanRevision(plan);
      return plan;
    },
    preparePart(part, renderer, bundle) {
      discordBundle(bundle);
      if (renderer !== discordRendererVersion) throw new Error('Unsupported Discord renderer');
      validatePart(part);
      return async (run, signal) => {
        assertBinding(run, bundle);
        if (!part.operationId.startsWith(`${run.runId}:`))
          throw new Error('Discord operation identity changed');
        return client(bundle).createMessage(
          run.admission.externalChannelId,
          { content: part.text },
          part.operationId,
          signal,
        );
      };
    },
    async writeProgress(run, bundle, signal) {
      assertBinding(run, bundle);
      const progress = run.progress;
      if (
        !progress ||
        progress.rendererVersion !== 'discord-progress-v1' ||
        !progress.text ||
        progress.text.length > 2000 ||
        sanitizeDiscordMentions(progress.text) !== progress.text
      )
        throw new Error('Invalid Discord progress state');
      const channel = run.admission.externalChannelId;
      const message = { content: progress.text };
      if (progress.externalMessageKey)
        return client(bundle).editMessage(
          channel,
          addressKey(progress.externalMessageKey, channel),
          message,
          signal,
        );
      return client(bundle).createMessage(
        channel,
        message,
        `${run.runId}:progress:${progress.revision}`,
        signal,
      );
    },
    async deleteProgress(run, bundle, signal) {
      assertBinding(run, bundle);
      const channel = run.admission.externalChannelId;
      if (!run.progress?.externalMessageKey) throw new Error('Missing Discord progress address');
      await client(bundle).deleteMessage(
        channel,
        addressKey(run.progress.externalMessageKey, channel),
        signal,
      );
    },
    async deliverArtifact() {
      throw new Error('Discord artifacts are unsupported');
    },
    classifyError(error) {
      return error instanceof DiscordWriteError
        ? { outcome: error.outcome, retryAfterMs: error.retryAfterMs }
        : { outcome: 'unknown' };
    },
    recoveryEvent(error) {
      if (!(error instanceof DiscordWriteError)) return undefined;
      if (error.outcome === 'permanent') return 'discord_write_rejected';
      if (error.outcome === 'retryable') return 'discord_write_deferred';
      return 'discord_write_outcome_unconfirmed';
    },
  };
}
