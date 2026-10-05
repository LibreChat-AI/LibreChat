import { TOKEN_CREDITS_PER_USD } from 'librechat-data-provider';
import type {
  MediaAccountingMethods,
  MediaOwnerScope,
  MediaStoredJob,
} from '@librechat/data-schemas';
import type { MediaConfig, MediaIntegration } from 'librechat-data-provider';
import type { MediaAccounting, MediaContext } from './service';
import type { MediaProviderUsage } from './provider';
import type { MediaPricing } from './pricing';
import { buildInitialBalance } from '~/middleware/checkBalance';
import { snapshotMediaPricing } from './pricing';
import { mediaAccountingMode } from './service';
import { MediaServiceError } from './errors';

export interface MediaAccountingService extends MediaAccounting {
  ensureReady(): Promise<void>;
  scopes: MediaAccountingMethods['listMediaAccountingScopes'];
  reconcile(scope: MediaOwnerScope, config: MediaConfig): Promise<number>;
}

function frozenMode(job: MediaStoredJob): 'balance' | 'transactions' | 'none' {
  if (!job.execution.accountingMode) {
    throw new MediaServiceError(
      'not_ready',
      409,
      'The media accounting mode needs reconciliation.',
    );
  }
  return job.execution.accountingMode;
}

function cost(
  job: MediaStoredJob,
  usage?: MediaProviderUsage,
): { costUSD?: number; costSource?: 'provider' | 'tokens' | 'estimate' } {
  const tokenPricing = job.execution.tokenPricing;
  const hasTokens = usage?.inputTokens !== undefined || usage?.outputTokens !== undefined;
  const counts = [
    usage?.inputTokens,
    usage?.outputTokens,
    usage?.textInputTokens,
    usage?.imageInputTokens,
    usage?.cachedInputTokens,
    usage?.cachedTextInputTokens,
    usage?.cachedImageInputTokens,
  ];
  if (counts.some((count) => count !== undefined && (!Number.isFinite(count) || count < 0))) {
    throw new MediaServiceError('not_ready', 409, 'The provider token usage needs reconciliation.');
  }
  const rates =
    tokenPricing?.premium && (usage?.inputTokens ?? 0) > tokenPricing.premium.threshold
      ? tokenPricing.premium
      : tokenPricing;
  let tokenCost =
    hasTokens && rates
      ? ((usage?.inputTokens ?? 0) * rates.prompt + (usage?.outputTokens ?? 0) * rates.completion) /
        TOKEN_CREDITS_PER_USD
      : undefined;
  if (tokenPricing?.imagePrompt !== undefined) {
    // Images report distinct text/image input. Never apply a guessed blended prompt rate.
    tokenCost = undefined;
    const text = usage?.textInputTokens ?? (usage?.inputTokens === 0 ? 0 : undefined);
    const image = usage?.imageInputTokens ?? (usage?.inputTokens === 0 ? 0 : undefined);
    const cachedText = usage?.cachedTextInputTokens ?? 0;
    const cachedImage = usage?.cachedImageInputTokens ?? 0;
    const cached = usage?.cachedInputTokens ?? cachedText + cachedImage;
    if (
      text !== undefined &&
      image !== undefined &&
      usage?.outputTokens !== undefined &&
      cached === cachedText + cachedImage
    ) {
      if (
        cachedText > text ||
        cachedImage > image ||
        (usage.inputTokens !== undefined && text + image !== usage.inputTokens)
      ) {
        throw new MediaServiceError(
          'not_ready',
          409,
          'The provider image usage needs reconciliation.',
        );
      }
      tokenCost =
        ((text - cachedText) * tokenPricing.prompt +
          (image - cachedImage) * tokenPricing.imagePrompt +
          cachedText * (tokenPricing.cacheRead ?? tokenPricing.prompt) +
          cachedImage * (tokenPricing.imageCacheRead ?? tokenPricing.imagePrompt) +
          usage.outputTokens * tokenPricing.completion) /
        TOKEN_CREDITS_PER_USD;
    }
  }
  const value =
    usage?.costUSD ??
    tokenCost ??
    (job.provider.recovery?.terminalStatus === 'completed'
      ? job.execution.billing?.estimatedCostUSD
      : undefined);
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new MediaServiceError('not_ready', 409, 'The provider cost needs reconciliation.');
  }
  if (value === undefined) return { costUSD: value, costSource: undefined };
  if (usage?.costUSD !== undefined) return { costUSD: value, costSource: 'provider' };
  return { costUSD: value, costSource: tokenCost !== undefined ? 'tokens' : 'estimate' };
}

export function createMediaAccounting({
  repository,
  now,
  pricing,
}: {
  repository: MediaAccountingMethods;
  now: () => number;
  pricing?: MediaPricing;
}): MediaAccountingService {
  async function reserve(
    job: MediaStoredJob,
    integration: MediaIntegration,
    context: MediaContext,
  ): Promise<void> {
    if (job.executionOwner === 'chat') return;
    const mode = frozenMode(job);
    if (mode !== mediaAccountingMode(context.appConfig)) {
      throw new MediaServiceError(
        'not_ready',
        409,
        'Media billing policy changed before dispatch.',
      );
    }
    if (mode !== 'balance') return;
    const billing = job.execution.billing;
    if (
      !billing?.maxCostUSD ||
      !billing.creditsPerUSD ||
      !integration.billing?.maxCostUSD ||
      billing.maxCostUSD > integration.billing.maxCostUSD ||
      billing.creditsPerUSD !== integration.billing.creditsPerUSD
    ) {
      throw new MediaServiceError('not_ready', 409, 'A validated media cost limit is required.');
    }
    const result = await repository.acquireMediaHold({
      scope: context.scope,
      jobId: job.jobId,
      estimatedCredits: (billing.estimatedCostUSD ?? billing.maxCostUSD) * billing.creditsPerUSD,
      maxCredits: billing.maxCostUSD * billing.creditsPerUSD,
      now: new Date(now()),
      reviewAt: new Date(now() + context.config.recovery.attentionAfterMs).toISOString(),
      policy: context.config.accounting,
      initialBalance: buildInitialBalance(context.scope.ownerId, context.appConfig.balance),
    });
    if (result.status === 'held') return;
    if (result.status === 'insufficient') {
      throw new MediaServiceError(
        'quota_exceeded',
        429,
        'There are not enough available media credits.',
      );
    }
    throw new MediaServiceError(
      'not_ready',
      409,
      'Media billing needs reconciliation before dispatch.',
    );
  }

  async function settle(
    job: MediaStoredJob,
    usage: MediaProviderUsage | undefined,
    context: MediaContext,
  ): Promise<void> {
    if (job.executionOwner === 'chat') return;
    const mode = frozenMode(job);
    if (mode === 'none') return;
    const { costUSD, costSource } = cost(job, usage);
    const creditsPerUSD = job.execution.billing?.creditsPerUSD;
    const credits =
      costUSD !== undefined && creditsPerUSD !== undefined ? costUSD * creditsPerUSD : undefined;
    if (mode === 'transactions') {
      await repository.recordMediaUsage({
        scope: context.scope,
        jobId: job.jobId,
        credits,
        costUSD,
        costSource,
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
        model: job.execution.modelId,
      });
      return;
    }
    // A provider-reported failure without a cost is unbilled; an uncertain outcome never gets here.
    if (costUSD === undefined && job.provider.recovery?.terminalStatus === 'failed') {
      await release(job, context);
      return;
    }
    if (credits === undefined || costUSD === undefined || creditsPerUSD === undefined) {
      throw new MediaServiceError('not_ready', 409, 'The paid media cost needs reconciliation.');
    }
    const result = await repository.settleMediaJob({
      scope: context.scope,
      jobId: job.jobId,
      effect: {
        kind: 'charge',
        operation: job.operation,
        shortfall: job.execution.accountingShortfall,
        credits,
        costUSD,
        costSource,
        creditsPerUSD,
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
        model: job.execution.modelId,
      },
      policy: context.config.accounting,
    });
    if (result.status !== 'settled') {
      throw new MediaServiceError('not_ready', 409, 'Media settlement is still being reconciled.');
    }
  }

  async function release(job: MediaStoredJob, context: MediaContext): Promise<void> {
    if (job.executionOwner === 'chat' || frozenMode(job) !== 'balance') return;
    const result = await repository.releaseMediaHold({
      scope: context.scope,
      jobId: job.jobId,
      policy: context.config.accounting,
      certainNoCharge: true,
    });
    if (result.status !== 'settled') {
      throw new MediaServiceError(
        'not_ready',
        409,
        'Media credit release is still being reconciled.',
      );
    }
  }

  return {
    snapshot: (model, integration, appConfig) =>
      pricing ? snapshotMediaPricing(pricing, model, integration, appConfig) : undefined,
    reserve,
    settle,
    release,
    ensureReady: () => repository.ensureMediaAccountingIndexes(),
    scopes: (input) => repository.listMediaAccountingScopes(input),
    reconcile: (scope, config) =>
      repository.reconcileMediaAccounting({
        scope,
        limit: config.limits.pageSize,
        policy: config.accounting,
      }),
  };
}
