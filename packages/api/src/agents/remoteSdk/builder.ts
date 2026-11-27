import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { initializeModel, createHostModelService, HostModelAdmission } from '@librechat/agents';
import type { TAgentsEndpoint } from 'librechat-data-provider';
import type { RunConfig } from '@librechat/agents';
import type { RemoteSdkHostServices } from './types';
import type { SdkAgentIdentity } from './identity';
import { createHostModelLifecycle } from './admission';

type Limits = NonNullable<NonNullable<TAgentsEndpoint>['sdkHostModels']>;

export interface SdkModelHost {
  snapshot(): ReturnType<HostModelAdmission['snapshot']>;
  bind(
    config: RunConfig,
    identity: Readonly<SdkAgentIdentity>,
    signal?: AbortSignal,
  ): RemoteSdkHostServices;
}

export class SdkHostModelError extends Error {
  readonly code = 'sdk_runtime_model_unsupported';
  constructor() {
    super('This SDK runtime cannot use the configured host model.');
    this.name = 'SdkHostModelError';
  }
}

/** One owner per server process, injected into every caller. Never recreate admission per turn. */
export function createSdkModelHost(
  limits: Limits | undefined,
  createModel: typeof initializeModel = initializeModel,
): SdkModelHost | undefined {
  if (!limits) return undefined;
  const admission = new HostModelAdmission({
    maxConcurrentCalls: limits.maxConcurrentCalls,
    maxRequestBytes: limits.maxBufferedRequestBytes,
  });
  return {
    snapshot: () => admission.snapshot(),
    bind(
      config: RunConfig,
      identity: Readonly<SdkAgentIdentity>,
      signal?: AbortSignal,
    ): RemoteSdkHostServices {
      const agents = 'agents' in config.graphConfig ? config.graphConfig.agents : undefined;
      const agent = agents?.[0];
      const modelName = agent?.clientOptions?.model;
      // Local graph tools and fallback models need explicit host adapters; never silently drop them.
      if (
        !agent ||
        agents?.length !== 1 ||
        agent.agentId !== identity.agentId ||
        !agent.clientOptions ||
        typeof modelName !== 'string' ||
        !modelName ||
        ('fallbacks' in agent.clientOptions &&
          Array.isArray(agent.clientOptions.fallbacks) &&
          agent.clientOptions.fallbacks.length > 0) ||
        agent.tools?.length ||
        agent.graphTools?.length
      )
        throw new SdkHostModelError();
      signal?.throwIfAborted();
      const model = createModel({ provider: agent.provider, clientOptions: agent.clientOptions });
      if (!(model instanceof BaseChatModel)) throw new SdkHostModelError();
      const modelLifecycle = createHostModelLifecycle(identity.agentId, limits.maxAdmissionEntries);
      model.callbacks = modelLifecycle.wrapCallbacks(model.callbacks);
      const modelProfile = {
        provider: agent.provider,
        name: modelName,
        streaming: agent.clientOptions?.streaming !== false,
      };
      return {
        modelLifecycle,
        modelProfile,
        model: createHostModelService({
          identity,
          model,
          descriptor: {
            version: 1,
            reference: 'primary',
            provider: modelProfile.provider,
            model: modelProfile.name,
            streaming: modelProfile.streaming,
            tools: (agent.toolDefinitions ?? []).map((definition) => ({
              type: 'function' as const,
              function: {
                ...definition,
                parameters: definition.parameters ?? { type: 'object', properties: {} },
              },
            })),
          },
          admission,
          limits: {
            timeoutMs: limits.timeoutMs,
            maxRequestBytes: limits.maxRequestBytes,
            maxResponseBytes: limits.maxResponseBytes,
          },
          config: {
            signal,
            metadata: { agentId: identity.agentId, run_id: identity.runId },
          },
        }),
      };
    },
  };
}
