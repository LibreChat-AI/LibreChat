import { RetentionMode } from 'librechat-data-provider';
import { createChatExpirationDate } from '@librechat/data-schemas';
import type { NativeSignatures } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { Request } from 'express';
import type { UsageMetadata } from '~/stream/interfaces/IJobStore';
import type { ModelUsageSinkOptions } from '~/agents/usage';
import type { NativeMediaFactory } from './native';
import type { MediaRuntime } from './runtime';
import { createModelUsageSink } from '~/agents/usage';

type Retention = { isTemporary?: boolean; expiredAt?: Date | string | null };
type NativeRequest = Request & {
  config?: AppConfig;
  resolvedConversation?: Retention | null;
  _agentEventBindingRetention?: Retention;
  _resumableStreamId?: string;
};

/** Reuse the request's loaded conversation and effective policy, including its original deadline. */
export function resolveNativeMediaFactory(
  request: NativeRequest,
  conversationId: string,
  messageId: string,
  collectedUsage: UsageMetadata[] = [],
  usageOptions: ModelUsageSinkOptions = {},
  runtime?: Pick<MediaRuntime, 'nativeFactory'>,
  nativeSignatures?: NativeSignatures,
  previousContent?: unknown[],
  onSignatures?: (signatures: NativeSignatures) => Promise<void>,
): Promise<NativeMediaFactory | undefined> | undefined {
  if (!runtime?.nativeFactory) return undefined;
  const collectUsage = createModelUsageSink(collectedUsage, {
    ...usageOptions,
    onUsage: (usage) =>
      usage.usage_type === 'subagent' ? usageOptions.onUsage?.(usage) : undefined,
  });
  const retention = request._agentEventBindingRetention ?? request.resolvedConversation;
  const temporary = retention?.isTemporary ?? request.body?.isTemporary === true;
  const policy = request.config?.interfaceConfig;
  let deadline = retention?.expiredAt;
  if (!retention && (temporary || policy?.retentionMode === RetentionMode.ALL)) {
    deadline = createChatExpirationDate(policy, temporary);
  }
  return runtime.nativeFactory(
    request,
    {
      conversationId,
      messageId,
      prompt: typeof request.body?.text === 'string' ? request.body.text : '',
      temporary,
      nativeSignatures,
      previousContent,
      onSignatures,
      ...(deadline ? { expiresAt: new Date(deadline).toISOString() } : {}),
    },
    ({ usage, modelRunId, model, provider, agentId, usageType }) =>
      collectUsage({
        ...usage,
        modelRunId,
        model,
        provider,
        agentId,
        ...(usageType ? { usage_type: usageType } : {}),
      }),
  );
}

/** Wiring adapter shared by initial and resumed agent runs. */
export function buildNativeMediaFactory(
  client: {
    options: { req: NativeRequest; mediaRuntime?: Pick<MediaRuntime, 'nativeFactory'> };
    conversationId: string;
    responseMessageId: string;
    collectedUsage: UsageMetadata[];
    collectedNativeSignatures?: NativeSignatures;
    contentParts?: unknown[];
    jobCreatedAt?: number;
  },
  usageOptions: ModelUsageSinkOptions,
  jobs?: {
    updateMetadata(
      streamId: string,
      metadata: { nativeSignatures: NativeSignatures },
      expectedCreatedAt?: number,
    ): Promise<void>;
  },
): ReturnType<typeof resolveNativeMediaFactory> {
  const streamId = client.options.req._resumableStreamId;
  let pending = Promise.resolve();
  const publish =
    jobs && streamId
      ? (signatures: NativeSignatures) => {
          const snapshot = { ...signatures };
          const update = pending.then(() =>
            jobs.updateMetadata(streamId, { nativeSignatures: snapshot }, client.jobCreatedAt),
          );
          pending = update.catch(() => undefined);
          return update;
        }
      : undefined;
  return resolveNativeMediaFactory(
    client.options.req,
    client.conversationId,
    client.responseMessageId,
    client.collectedUsage,
    usageOptions,
    client.options.mediaRuntime,
    (client.collectedNativeSignatures ??= {}),
    client.contentParts,
    publish,
  );
}

export function getNativeResponseMetadata(client: {
  collectedNativeSignatures?: NativeSignatures;
}): { nativeSignatures?: NativeSignatures } {
  const signatures = client.collectedNativeSignatures;
  return signatures && Object.keys(signatures).length ? { nativeSignatures: signatures } : {};
}
