import { z } from 'zod';
import { Constants } from 'librechat-data-provider';
import type {
  AgentApiKeyBinding,
  AgentApiKeyListItem,
  AgentChannelRecord,
  ChannelRunRecord,
  ChannelRunStorage,
  ResponseOwner,
  ResponseStorage,
  IUser,
} from '@librechat/data-schemas';
import type { Request } from 'express';
import type { ChannelRunDependencies } from './runs';
import { hasChannelRunAuthority } from './runs';

export interface ChannelResponseCredentialDependencies {
  encrypt: (value: string) => Promise<string>;
  decrypt: (value: string) => Promise<string>;
  storage: Pick<ChannelRunStorage, 'read' | 'attachResponseCredential'>;
  responses: Pick<ResponseStorage, 'read'>;
  getChannel: (id: string) => Promise<AgentChannelRecord | null>;
  resolvePrincipal: ChannelRunDependencies['resolvePrincipal'];
  createKey: (input: {
    userId: string;
    name: string;
    expiresAt: Date;
    binding: AgentApiKeyBinding;
  }) => Promise<{ id: string; key: string }>;
  getKey: (keyId: string, userId: string) => Promise<AgentApiKeyListItem | null>;
  deleteKey: (keyId: string, userId: string) => Promise<boolean>;
  lifetimeMs: () => Promise<number>;
  now?: () => number;
}

const requestSchema = z
  .object({
    model: z.string(),
    input: z.string(),
    background: z.literal(true),
    store: z.literal(true),
    stream: z.literal(false).optional(),
    previous_response_id: z.string().optional(),
  })
  .strict();
const bindingFor = (run: ChannelRunRecord): AgentApiKeyBinding => ({
  kind: 'channel_run',
  id: `${run.channelId}/${run.runId}`,
});
const previousResponse = (run: ChannelRunRecord) =>
  run.execution?.parentMessageId === Constants.NO_PARENT
    ? undefined
    : run.execution?.parentMessageId;

/** Raw keys cross only the guarded gateway boundary; durable state retains encrypted keys and immutable grant references. */
export function createChannelResponseCredentials(deps: ChannelResponseCredentialDependencies) {
  const now = deps.now ?? Date.now;
  async function current(
    binding: AgentApiKeyBinding,
    keyId: string,
    owner: ResponseOwner,
    agentId?: string,
  ) {
    if (binding.kind !== 'channel_run') return null;
    const [channelId, runId, extra] = binding.id.split('/');
    if (!channelId || !runId || extra != null) return null;
    const run = await deps.storage.read(owner.tenantId ?? '_', channelId, runId);
    if (
      !run ||
      run.principal.userId !== owner.userId ||
      run.execution?.apiKeyId !== keyId ||
      run.execution.protocol !== 'responses' ||
      (agentId != null && run.agentId !== agentId)
    )
      return null;
    const channel = await deps.getChannel(channelId);
    if (!channel || !(await hasChannelRunAuthority(channel, run, deps.resolvePrincipal)))
      return null;
    return run;
  }
  async function reveal(run: ChannelRunRecord): Promise<string> {
    const execution = run.execution;
    if (!execution?.apiKeyId || !execution.encryptedApiKey)
      throw new Error('Response credential unavailable');
    const key = await deps.getKey(execution.apiKeyId, run.principal.userId);
    const binding = bindingFor(run);
    if (
      !key ||
      key.binding?.kind !== binding.kind ||
      key.binding.id !== binding.id ||
      (key.expiresAt != null && key.expiresAt.getTime() <= now())
    )
      throw new Error('Response credential authority changed');
    return deps.decrypt(execution.encryptedApiKey);
  }
  return {
    async provision(run: ChannelRunRecord): Promise<string> {
      if (run.execution?.apiKeyId) return reveal(run);
      if (
        !run.execution ||
        run.execution.deliveryKey ||
        run.execution.enqueueAttemptedAt ||
        run.cancellationRequested ||
        !run.leaseOwner
      )
        throw new Error('Response credential admission changed');
      const lifetimeMs = await deps.lifetimeMs();
      if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs <= 0)
        throw new Error('Invalid response credential policy');
      const key = await deps.createKey({
        userId: run.principal.userId,
        name: 'Channel response run',
        expiresAt: new Date(now() + lifetimeMs),
        binding: bindingFor(run),
      });
      let saved: ChannelRunRecord;
      try {
        saved = await deps.storage.attachResponseCredential(
          run.tenantId,
          { runId: run.runId, owner: run.leaseOwner, epoch: run.leaseEpoch },
          { apiKeyId: key.id, encryptedApiKey: await deps.encrypt(key.key) },
          now(),
        );
      } catch (error) {
        const currentRun = await deps.storage.read(run.tenantId, run.channelId, run.runId);
        if (currentRun?.execution?.apiKeyId !== key.id) {
          await deps.deleteKey(key.id, run.principal.userId);
          throw error;
        }
        saved = currentRun;
      }
      if (saved.execution?.apiKeyId !== key.id) await deps.deleteKey(key.id, run.principal.userId);
      return reveal(saved);
    },
    async authorizeSource(
      binding: AgentApiKeyBinding,
      keyId: string,
      owner: ResponseOwner,
      agentId: string,
    ): Promise<boolean> {
      return Boolean(await current(binding, keyId, owner, agentId));
    },
    async authorizeRequest(input: {
      keyId: string;
      binding: AgentApiKeyBinding;
      user: IUser;
      request: Request;
    }): Promise<boolean> {
      const owner = { userId: String(input.user._id), tenantId: input.user.tenantId };
      const run = await current(input.binding, input.keyId, owner);
      if (!run) return false;
      const pathname = input.request.originalUrl.split('?')[0];
      if (input.request.method === 'POST' && pathname === '/api/agents/v1/responses') {
        if (run.cancellationRequested) return false;
        const parsed = requestSchema.safeParse(input.request.body);
        return (
          parsed.success &&
          parsed.data.model === run.agentId &&
          parsed.data.input === run.admission.input &&
          parsed.data.previous_response_id === previousResponse(run) &&
          input.request.headers['idempotency-key'] === `channel:${run.runId}`
        );
      }
      const path = /^\/api\/agents\/v1\/responses\/(resp_[\w-]+)(\/cancel)?$/.exec(pathname);
      if (!path || (path[2] ? input.request.method !== 'POST' : input.request.method !== 'GET'))
        return false;
      const response = await deps.responses.read(owner, path[1]);
      return Boolean(
        response &&
          response.agentId === run.agentId &&
          response.requestKey === `channel:${run.runId}` &&
          response.sourceKeyId === input.keyId &&
          (run.execution?.responseId == null || run.execution.responseId === response.responseId),
      );
    },
  };
}
