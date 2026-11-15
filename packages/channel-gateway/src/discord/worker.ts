import { ButtonStyle, ComponentType, PermissionFlagsBits } from 'discord-api-types/v10';
import {
  channelSnowflakeSchema,
  channelRunActorSchema,
  discordRunControl,
} from 'librechat-data-provider';
import type {
  ChannelRunView,
  ChannelDeliveryPart,
  DiscordChannelServiceBundle,
} from 'librechat-data-provider';
import type { APIActionRowComponent, APIButtonComponent } from 'discord-api-types/v10';
import type { DiscordRateCoordinator } from './rates';
import type { WorkerProvider } from '../provider';
import type { ChannelBundle } from '../types';
import type { DiscordClient } from './client';
import {
  discordRendererVersion,
  discordLegacyRendererVersion,
  readDiscordFeedbackPresentation,
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
  ) => Pick<
    DiscordClient,
    | 'createMessage'
    | 'editMessage'
    | 'deleteMessage'
    | 'inspectGuildTextSource'
    | 'getChannelMemberPermissions'
  >;
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
function validatePart(part: ChannelDeliveryPart, renderer: string): void {
  if (
    part.kind !== 'message' ||
    (part.presentation !== undefined && renderer !== discordRendererVersion) ||
    part.artifactId !== undefined ||
    !part.text ||
    part.text.length > 2000
  )
    throw new Error('Unsupported Discord delivery part');
  if (part.presentation) {
    readDiscordFeedbackPresentation(part);
    if (!part.required || part.traceUrl !== undefined)
      throw new Error('Invalid Discord feedback placement');
  }
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
    actor.scope !== undefined ||
    actor.applicationId !== bundle.channel.discord.applicationId ||
    actor.guildId !== bundle.channel.discord.guildId ||
    run.admission.externalChannelId !== bundle.channel.discord.externalChannelId
  )
    throw new Error('Discord run binding changed');
  if (run.plan) {
    if (![discordRendererVersion, discordLegacyRendererVersion].includes(run.plan.rendererVersion))
      throw new Error('Unsupported Discord renderer');
    for (const part of run.plan.parts) {
      validatePart(part, run.plan.rendererVersion);
      if (!part.operationId.startsWith(`${run.runId}:`))
        throw new Error('Discord operation identity changed');
      const feedbackRun = readDiscordFeedbackPresentation(part);
      if (
        feedbackRun !== undefined &&
        (feedbackRun !== run.runId ||
          part.operationId !== `${run.runId}:discord:0` ||
          run.plan.parts.find((item) => item.required && !item.traceUrl)?.operationId !==
            part.operationId)
      )
        throw new Error('Invalid Discord feedback source');
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
      ? 'Your input is needed. Use /librechat status to open your private review in LibreChat.'
      : 'Waiting for input. The review action is unavailable or expired.';
  return 'Working...';
}

export function createDiscordWorkerProvider(deps: DiscordWorkerDependencies): WorkerProvider {
  const client = (bundle: DiscordChannelServiceBundle) => deps.createClient(bundle, deps.rates);
  async function writableClient(
    run: ChannelRunView,
    bundle: DiscordChannelServiceBundle,
    signal: AbortSignal,
  ) {
    const actor = run.admission.actor;
    if (actor.provider !== 'discord') throw new Error('Unsupported Discord actor');
    const current = client(bundle);
    const inspection = new AbortController();
    const inspectionSignal = AbortSignal.any([signal, inspection.signal]);
    try {
      const [source, permissions] = await Promise.all([
        current.inspectGuildTextSource(
          {
            applicationId: actor.applicationId,
            botUserId: bundle.channel.discord.botUserId,
            guildId: actor.guildId,
            channelId: run.admission.externalChannelId,
          },
          inspectionSignal,
        ),
        current.getChannelMemberPermissions(
          run.admission.externalChannelId,
          actor.externalUserId,
          inspectionSignal,
        ),
      ]);
      if (
        !source ||
        permissions === null ||
        (BigInt(permissions) &
          (PermissionFlagsBits.ViewChannel | PermissionFlagsBits.Administrator)) ===
          0n
      )
        throw new DiscordWriteError('permanent', 0, 403);
      signal.throwIfAborted();
      return current;
    } catch (error) {
      signal.throwIfAborted();
      // Permission reads have no message side effect, so a failed read can safely retry.
      if (error instanceof DiscordWriteError && error.outcome === 'unknown')
        throw new DiscordWriteError('retryable', error.retryAfterMs, error.status);
      throw error;
    } finally {
      inspection.abort();
    }
  }
  return {
    progressRenderer: 'discord-progress-v1',
    maxProgressLength: 2000,
    validateAddress,
    assertBinding,
    progressText: discordProgressText,
    supportsRenderer: (version) =>
      [discordRendererVersion, discordLegacyRendererVersion].includes(version),
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
        feedback:
          snapshot.status === 'completed' &&
          !run.cancellationRequested &&
          run.feedbackEnabled === true,
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
      if (![discordRendererVersion, discordLegacyRendererVersion].includes(renderer))
        throw new Error('Unsupported Discord renderer');
      validatePart(part, renderer);
      return async (run, signal) => {
        assertBinding(run, bundle);
        if (!part.operationId.startsWith(`${run.runId}:`))
          throw new Error('Discord operation identity changed');
        const current = run.plan?.parts.find((item) => item.operationId === part.operationId);
        if (
          run.plan?.rendererVersion !== renderer ||
          !current ||
          current.kind !== part.kind ||
          current.required !== part.required ||
          current.text !== part.text ||
          current.artifactId !== part.artifactId ||
          current.traceUrl !== part.traceUrl ||
          current.presentation?.format !== part.presentation?.format ||
          current.presentation?.payload !== part.presentation?.payload
        )
          throw new Error('Discord delivery source changed');
        const feedbackRun = readDiscordFeedbackPresentation(part);
        const components: APIActionRowComponent<APIButtonComponent>[] | undefined =
          feedbackRun !== undefined &&
          run.feedbackEnabled === true &&
          run.snapshot?.status === 'completed' &&
          !run.cancellationRequested
            ? [
                {
                  type: ComponentType.ActionRow,
                  components: [
                    {
                      type: ComponentType.Button,
                      style: ButtonStyle.Secondary,
                      label: 'Thumbs up',
                      emoji: { name: '👍' },
                      custom_id: discordRunControl('thumbsUp', feedbackRun),
                    },
                    {
                      type: ComponentType.Button,
                      style: ButtonStyle.Secondary,
                      label: 'Thumbs down',
                      emoji: { name: '👎' },
                      custom_id: discordRunControl('thumbsDown', feedbackRun),
                    },
                  ],
                },
              ]
            : undefined;
        const currentClient = await writableClient(run, bundle, signal);
        return currentClient.createMessage(
          run.admission.externalChannelId,
          { content: part.text, ...(components ? { components } : {}) },
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
      const components: APIActionRowComponent<APIButtonComponent>[] =
        !terminalSnapshot(run) && !run.cancellationRequested
          ? [
              {
                type: ComponentType.ActionRow,
                components: [
                  {
                    type: ComponentType.Button,
                    style: ButtonStyle.Danger,
                    label: 'Stop',
                    custom_id: discordRunControl('cancel', run.runId),
                  },
                ],
              },
            ]
          : [];
      const message = { content: progress.text, components };
      const messageId = progress.externalMessageKey
        ? addressKey(progress.externalMessageKey, channel)
        : undefined;
      const currentClient = await writableClient(run, bundle, signal);
      if (messageId) return currentClient.editMessage(channel, messageId, message, signal);
      return currentClient.createMessage(
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
