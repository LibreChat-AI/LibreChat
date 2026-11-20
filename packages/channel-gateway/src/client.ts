import { createHash } from 'node:crypto';
import {
  channelGatewayWirePolicySchema,
  channelStorageConfigSchema,
} from 'librechat-data-provider';
import type {
  ChannelRunActor,
  ChannelRunAdmission,
  ChannelRunView,
  ChannelRunFence,
  ChannelLinkView,
  ChannelLinkTicket,
  ChannelIdentityResult,
  ChannelArtifact,
  ResponseReviewDecision,
  ResponseReviewDecisionReceipt,
} from 'librechat-data-provider';
import type {
  ChannelBundle,
  Lease,
  LeaseRenewal,
  ResponseGrant,
  ResponsePreparation,
  Review,
  BackgroundResponse,
} from './types';
import type { GatewayConfig } from './config';
import { ServiceClient, ServiceError, boundedBody } from './transport';

const validId = (value: unknown): value is string =>
  typeof value === 'string' && /^[\w:.-]{1,256}$/.test(value);

function validFence(
  value: ChannelRunFence | undefined,
  expected: Partial<ChannelRunFence>,
): boolean {
  return Boolean(
    value &&
      validId(value.runId) &&
      validId(value.owner) &&
      Number.isSafeInteger(value.epoch) &&
      value.epoch > 0 &&
      (expected.runId === undefined || value.runId === expected.runId) &&
      (expected.owner === undefined || value.owner === expected.owner) &&
      (expected.epoch === undefined || value.epoch === expected.epoch),
  );
}

export class ChannelClient extends ServiceClient {
  readonly root: string;
  constructor(
    readonly config: GatewayConfig,
    transport: typeof fetch = fetch,
  ) {
    super(config, transport);
    this.root = `/api/channels/service/${encodeURIComponent(config.CHANNEL_ID)}`;
  }

  async channel(signal?: AbortSignal): Promise<ChannelBundle> {
    const value = await this.request<ChannelBundle>(
      `/api/channels/service/slack/${encodeURIComponent(this.config.CHANNEL_TENANT_ID)}/${encodeURIComponent(this.config.CHANNEL_ID)}`,
      undefined,
      signal,
    );
    const { channel, agent, credentials } = value;
    if (
      channel?.channelId !== this.config.CHANNEL_ID ||
      (channel.tenantId ?? '_') !== this.config.CHANNEL_TENANT_ID ||
      channel.type !== 'slack' ||
      channel.status !== 'active' ||
      !channel.revision ||
      !channel.slack?.teamId ||
      !channel.slack.appId ||
      !channel.slack.botUserId ||
      !credentials?.botToken ||
      !agent?.id ||
      channel.agentId !== agent.id
    )
      throw new Error('Invalid active channel binding');
    const policy = channelGatewayWirePolicySchema.safeParse(value.gateway);
    if (!policy.success) throw new Error('Unsupported channel gateway policy');
    const delivery = channelStorageConfigSchema
      .pick({ maxDeliveryParts: true })
      .extend({
        maxDeliveryParts: channelStorageConfigSchema.shape.maxDeliveryParts.removeDefault(),
      })
      .safeParse(value.delivery);
    if (!delivery.success) throw new Error('Invalid channel delivery policy');
    return { ...value, gateway: policy.data, delivery: delivery.data };
  }
  async runs<T>(suffix: string, body: object, signal?: AbortSignal, empty?: T): Promise<T> {
    return this.request<T>(this.root + '/runs' + suffix, body, signal, empty);
  }
  private assertRun(run: ChannelRunView | undefined, runId: string): asserts run is ChannelRunView {
    if (
      !run ||
      typeof run !== 'object' ||
      run.runId !== runId ||
      run.channelId !== this.config.CHANNEL_ID ||
      !validId(run.revision) ||
      !Number.isSafeInteger(run.sequence) ||
      run.sequence < 1 ||
      ![
        'queued',
        'executing',
        'requires_action',
        'delivering',
        'delivered',
        'failed',
        'cancelled',
        'blocked',
      ].includes(run.state) ||
      typeof run.cancellationRequested !== 'boolean' ||
      !Array.isArray(run.receipts) ||
      !validId(run.admission?.externalChannelId) ||
      typeof run.admission?.externalThreadKey !== 'string' ||
      !run.admission.externalThreadKey.startsWith(run.admission.externalChannelId + ':') ||
      !validId(run.admission.actor?.teamId) ||
      !validId(run.admission.actor?.appId) ||
      !validId(run.admission.actor?.externalUserId)
    )
      throw new Error('Channel run identity changed');
  }
  private assertGrant(grant: ResponseGrant): void {
    if (
      !grant ||
      typeof grant !== 'object' ||
      typeof grant.apiKey !== 'string' ||
      !grant.apiKey.startsWith('sk-bound-') ||
      /[\r\n]/.test(grant.apiKey) ||
      typeof grant.requestKey !== 'string' ||
      !grant.requestKey ||
      grant.requestKey.length > 256 ||
      /[\r\n]/.test(grant.requestKey) ||
      typeof grant.request?.model !== 'string' ||
      !grant.request.model ||
      typeof grant.request.input !== 'string' ||
      grant.request.background !== true ||
      grant.request.store !== true
    )
      throw new Error('Invalid run-bound response credential');
  }
  async mutate(
    fence: ChannelRunFence,
    action: string,
    body: object = {},
    signal?: AbortSignal,
  ): Promise<ChannelRunView> {
    const result = await this.runs<ChannelRunView>(
      `/${encodeURIComponent(fence.runId)}/${action}`,
      { ...body, fence },
      signal,
    );
    this.assertRun(result, fence.runId);
    return result;
  }
  admit(
    input: ChannelRunAdmission,
    signal?: AbortSignal,
  ): Promise<{ runId: string; duplicate: boolean }> {
    return this.runs('', input, signal);
  }
  async claim(owner: string, signal?: AbortSignal): Promise<Lease | null> {
    const lease = await this.runs<Lease | null>('/claim', { owner }, signal, null);
    if (lease === null) return null;
    if (
      !validFence(lease?.fence, { owner }) ||
      !Number.isSafeInteger(lease.leaseExpiresAt) ||
      lease.leaseExpiresAt <= 0
    )
      throw new Error('Invalid channel run lease');
    this.assertRun(lease.run, lease.fence.runId);
    return lease;
  }
  async renew(fence: ChannelRunFence, signal?: AbortSignal): Promise<LeaseRenewal> {
    const lease = await this.runs<LeaseRenewal>(
      `/${encodeURIComponent(fence.runId)}/renew`,
      { fence },
      signal,
    );
    if (
      !validFence(lease?.fence, fence) ||
      !Number.isSafeInteger(lease.leaseExpiresAt) ||
      lease.leaseExpiresAt <= 0
    )
      throw new Error('Invalid channel run lease');
    return lease;
  }
  yield(fence: ChannelRunFence, signal?: AbortSignal): Promise<null> {
    return this.runs(`/${encodeURIComponent(fence.runId)}/yield`, { fence }, signal, null);
  }
  async prepare(fence: ChannelRunFence, signal?: AbortSignal): Promise<ResponsePreparation> {
    const result = await this.runs<ResponsePreparation>(
      `/${encodeURIComponent(fence.runId)}/response/prepare`,
      { fence },
      signal,
    );
    if (!result || typeof result !== 'object') throw new Error('Invalid Response preparation');
    if ('settled' in result) {
      this.assertRun(result.settled, fence.runId);
      if ('apiKey' in result) throw new Error('Invalid Response preparation');
    } else this.assertGrant(result);
    return result;
  }
  review(
    runId: string,
    actor: ChannelRunActor,
    revision: string,
    externalChannelId?: string,
    signal?: AbortSignal,
  ): Promise<Review> {
    return this.runs(
      `/${encodeURIComponent(runId)}/review`,
      { actor, revision, ...(externalChannelId ? { externalChannelId } : {}) },
      signal,
    );
  }
  async decide(
    runId: string,
    actor: ChannelRunActor,
    revision: string,
    externalChannelId: string,
    decision: ResponseReviewDecision,
    signal?: AbortSignal,
  ): Promise<ResponseReviewDecisionReceipt> {
    const receipt = await this.runs<ResponseReviewDecisionReceipt>(
      `/${encodeURIComponent(runId)}/review/decision`,
      { actor, revision, externalChannelId, decision },
      signal,
    );
    if (
      !receipt.intentId ||
      !receipt.responseId ||
      receipt.actionId !== decision.actionId ||
      !['queued', 'settled'].includes(receipt.status)
    )
      throw new Error('Invalid decision receipt');
    return receipt;
  }
  cancel(
    runId: string,
    actor: ChannelRunActor,
    revision: string,
    externalChannelId: string,
    signal?: AbortSignal,
  ): Promise<{ cancellationRequested: boolean }> {
    return this.runs(
      `/${encodeURIComponent(runId)}/cancel`,
      { actor, revision, externalChannelId },
      signal,
    );
  }
  stop(
    actor: ChannelRunActor,
    externalThreadKey: string,
    eventAt: number,
    externalChannelId: string,
    signal?: AbortSignal,
  ): Promise<{ cancellationRequested: boolean }> {
    return this.runs(
      '/stop-thread',
      { actor, externalThreadKey, externalChannelId, eventAt },
      signal,
    );
  }
  identity<T extends ChannelLinkView | ChannelLinkTicket | null>(
    actor: string,
    suffix = '',
    body?: object,
    signal?: AbortSignal,
  ): Promise<ChannelIdentityResult<T>> {
    return this.request<ChannelIdentityResult<T>>(
      `${this.root}/identity/${encodeURIComponent(actor)}${suffix}`,
      body,
      signal,
    );
  }
  async response(
    grant: ResponseGrant,
    method: 'create' | 'read' | 'cancel',
    signal?: AbortSignal,
  ): Promise<BackgroundResponse> {
    this.assertGrant(grant);
    const id = grant.responseId;
    if (
      (id !== undefined || method !== 'create') &&
      (!id || !/^resp_[A-Za-z0-9_-]{1,250}$/.test(id))
    )
      throw new Error('Invalid Response identity');
    const suffix =
      method === 'create'
        ? ''
        : `/${encodeURIComponent(id!)}${method === 'cancel' ? '/cancel' : ''}`;
    let body: object | undefined;
    if (method === 'cancel') body = {};
    if (method === 'create') body = { ...grant.request, stream: false };
    const value = await this.decode<BackgroundResponse>(
      await this.raw(
        '/api/agents/v1/responses' + suffix,
        body,
        signal,
        grant.apiKey,
        method === 'create' ? grant.requestKey : undefined,
        method === 'create' ? this.config.AGENT_INVOKE_TIMEOUT_MS : this.config.API_CALL_TIMEOUT_MS,
      ),
    );
    if (
      !/^resp_[A-Za-z0-9_-]{1,250}$/.test(value.id) ||
      value.model !== grant.request.model ||
      value.object !== 'response' ||
      value.store !== true ||
      value.background !== true ||
      (id && value.id !== id) ||
      ![
        'queued',
        'in_progress',
        'requires_action',
        'completed',
        'failed',
        'incomplete',
        'cancelled',
      ].includes(value.status)
    )
      throw new Error('Responses identity or state changed');
    return value;
  }
  async artifact(
    fence: ChannelRunFence,
    artifact: ChannelArtifact,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    if (
      !artifact.artifactId ||
      artifact.artifactId.length > 512 ||
      !artifact.filename ||
      Buffer.byteLength(artifact.filename) > 720 ||
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes < 0 ||
      artifact.bytes > 50 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
      /[/\\\p{Cc}\p{Cf}]/u.test(artifact.filename)
    )
      throw new Error('Invalid artifact descriptor');
    const response = await this.raw(
      `${this.root}/runs/${encodeURIComponent(fence.runId)}/artifacts/${encodeURIComponent(artifact.artifactId)}`,
      { fence },
      signal,
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new ServiceError(response.status);
    }
    let filename: string;
    try {
      filename = decodeURIComponent(response.headers.get('X-Artifact-Filename') ?? '');
    } catch {
      await response.body?.cancel();
      throw new Error('Artifact metadata changed');
    }
    if (
      filename !== artifact.filename ||
      response.headers.get('X-Artifact-SHA256') !== artifact.sha256 ||
      response.headers.get('X-Artifact-Media-Type') !== artifact.mediaType ||
      response.headers.get('Content-Type')?.split(';')[0] !== 'application/octet-stream'
    ) {
      await response.body?.cancel();
      throw new Error('Artifact metadata changed');
    }
    const bytes = await boundedBody(response, artifact.bytes);
    if (
      bytes.length !== artifact.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== artifact.sha256
    )
      throw new Error('Artifact content changed');
    return bytes;
  }
}
