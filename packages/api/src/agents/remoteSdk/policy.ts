import { z } from 'zod';
import {
  createHostProviderTextProtection,
  serializeProviderTextProtectionError,
  deserializeProviderTextProtectionError,
  ProviderTextProtectionError,
} from '@librechat/agents';
import type { HostProviderTextRequest } from '@librechat/agents';
import type { RemoteSdkHostServices, RemoteSdkStart, RemoteSdkLimits } from './types';
import type { SdkAgentIdentity } from './identity';
import type { SdkRpc } from './peer';
import { createPolicyReceiver, createPolicySender } from './sealed';

export const policyDescriptorSchema = z
  .object({
    version: z.literal(1),
    publicKey: z.string().length(60),
    limits: z
      .object({
        version: z.literal(1),
        timeoutMs: z.number().int().positive().max(2_147_483_647),
        maxAttemptBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        maxBufferedBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      })
      .strict(),
  })
  .strict();

/** Only sanitized failures and approved canonical text enter the peer's reply/logging path. */
export function createHostPolicyChannel(
  providerText: NonNullable<RemoteSdkHostServices['providerText']>,
  limits: RemoteSdkLimits,
) {
  const receiver = createPolicyReceiver(limits.maxFrameBytes);
  return {
    descriptor: {
      version: 1 as const,
      publicKey: receiver.publicKey,
      limits: providerText.descriptor,
    },
    dispose: receiver.dispose,
    inspect: async (data: unknown, signal?: AbortSignal) => {
      try {
        let request: HostProviderTextRequest;
        try {
          request = JSON.parse(receiver.open(data)) as HostProviderTextRequest;
        } catch {
          throw new ProviderTextProtectionError('incompatible');
        }
        const content = await providerText.service.inspect(request, signal);
        return { version: 1 as const, ok: true as const, content };
      } catch (error) {
        return serializeProviderTextProtectionError(error);
      }
    },
  };
}

export function createWorkerProviderTextPolicy(options: {
  descriptor: NonNullable<RemoteSdkStart['providerText']>;
  identity: Readonly<SdkAgentIdentity>;
  peer: { call: SdkRpc };
  limits: RemoteSdkLimits;
}) {
  const descriptor = policyDescriptorSchema.parse(options.descriptor);
  const seal = createPolicySender(descriptor.publicKey, options.limits.maxFrameBytes);
  return createHostProviderTextProtection({
    identity: options.identity,
    descriptor: descriptor.limits,
    service: {
      version: 1,
      inspect: async (request, signal) => {
        let payload: ReturnType<typeof seal>;
        try {
          payload = seal(JSON.stringify(request));
        } catch {
          throw new ProviderTextProtectionError('overflow');
        }
        const result = await options.peer.call(
          'policy.providerText',
          payload,
          options.limits.maxRunMs,
          signal,
        );
        const success = z
          .object({ version: z.literal(1), ok: z.literal(true), content: z.string() })
          .safeParse(result);
        if (!success.success) throw deserializeProviderTextProtectionError(result);
        return success.data.content;
      },
    },
  });
}
