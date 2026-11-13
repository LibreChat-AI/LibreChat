import { z } from 'zod';
import { resolve } from 'node:path';
import { Run } from '@librechat/agents';
import { createRequire } from 'node:module';
import type { Agent, SdkRuntimeBinding, TAgentsEndpoint } from 'librechat-data-provider';
import type { RunConfig } from '@librechat/agents';

export interface SdkAgentIdentity {
  readonly agentId: string;
  readonly runtimeId: string;
  readonly runId: string;
  readonly conversationId?: string;
  readonly userId: string;
  readonly tenantId?: string;
}

export interface SdkAgentRuntime {
  protocolVersion: 1;
  /** Retain the host config's handlers, hooks, signal, and run identity. */
  createRun(input: {
    config: RunConfig;
    identity: SdkAgentIdentity;
  }): ReturnType<typeof Run.create>;
}

export type SdkAgentRuntimeLoader = (module: string) => unknown;

type AgentBinding = Pick<Agent, 'id' | 'sdk_runtime' | 'subagents'>;
type RuntimeConfig = Pick<NonNullable<TAgentsEndpoint>, 'sdkRuntimes'>;

export class SdkAgentRuntimeError extends Error {
  constructor(
    public readonly code:
      | 'sdk_runtime_unavailable'
      | 'sdk_runtime_forbidden'
      | 'sdk_runtime_composition_unsupported'
      | 'sdk_runtime_invalid'
      | 'sdk_runtime_identity_mismatch',
  ) {
    super('The SDK agent runtime is unavailable for this request.');
    this.name = 'SdkAgentRuntimeError';
  }
}

const runtimeModuleSchema = z.object({
  protocolVersion: z.literal(1),
  createRun: z.custom<SdkAgentRuntime['createRun']>((value) => typeof value === 'function'),
});

// Only operator configuration chooses modules. Node caches modules; no per-turn filesystem scan.
const requireRuntime = (module: string): unknown =>
  createRequire(resolve(process.cwd(), 'package.json'))(module);

/** Classifies binding rejection at the legacy duplicate/restore error boundary. */
export function getSdkAgentWriteErrorStatus(error: unknown): number {
  return error instanceof z.ZodError &&
    error.issues.some((issue) => issue.path[0] === 'sdk_runtime')
    ? 400
    : 500;
}

/** Applies an explicit write only after the operator has enabled its execution binding. */
export function applySdkAgentBindingWrite(
  patch: { sdk_runtime?: SdkRuntimeBinding | null },
  binding: SdkRuntimeBinding | null | undefined,
  endpoint: RuntimeConfig | undefined,
  role: string | undefined,
): void {
  if (binding === undefined) return;
  if (binding != null) {
    try {
      resolveSdkAgentBinding([{ id: '', sdk_runtime: binding }], endpoint, role);
    } catch (error) {
      if (!(error instanceof SdkAgentRuntimeError)) throw error;
      throw new z.ZodError([{ code: 'custom', path: ['sdk_runtime'], message: error.message }]);
    }
  }
  patch.sdk_runtime = binding;
}

export function resolveSdkAgentBinding(
  agents: readonly AgentBinding[],
  endpoint: RuntimeConfig | undefined,
  role: string | undefined,
): { binding: SdkRuntimeBinding; module: string } | undefined {
  if (!agents.some((agent) => agent.sdk_runtime != null)) return undefined;
  const binding = agents[0]?.sdk_runtime;
  if (agents.length !== 1 || binding == null || agents[0]?.subagents?.enabled === true) {
    throw new SdkAgentRuntimeError('sdk_runtime_composition_unsupported');
  }
  const configured = Object.prototype.hasOwnProperty.call(endpoint?.sdkRuntimes ?? {}, binding.id)
    ? endpoint?.sdkRuntimes?.[binding.id]
    : undefined;
  if (binding.protocolVersion !== 1 || configured == null) {
    throw new SdkAgentRuntimeError('sdk_runtime_unavailable');
  }
  if (role == null || !configured.roles.includes(role)) {
    throw new SdkAgentRuntimeError('sdk_runtime_forbidden');
  }
  return { binding, module: configured.module };
}

/** Dispatch an already-authorized agent through its operator-installed SDK factory. */
export async function createSdkAgentRun({
  registration,
  config,
  identity,
  signal,
  loadModule = requireRuntime,
}: {
  registration: { binding: SdkRuntimeBinding; module: string };
  config: RunConfig;
  identity: Omit<SdkAgentIdentity, 'runtimeId' | 'runId'>;
  signal?: AbortSignal;
  loadModule?: SdkAgentRuntimeLoader;
}): ReturnType<typeof Run.create> {
  signal?.throwIfAborted();
  if (!identity.agentId || !identity.userId) {
    throw new SdkAgentRuntimeError('sdk_runtime_identity_mismatch');
  }
  let runtime: SdkAgentRuntime;
  try {
    runtime = runtimeModuleSchema.parse(loadModule(registration.module));
  } catch {
    throw new SdkAgentRuntimeError('sdk_runtime_invalid');
  }
  const run = await runtime.createRun({
    config,
    identity: Object.freeze({
      ...identity,
      runId: config.runId,
      runtimeId: registration.binding.id,
    }),
  });
  if (!(run instanceof Run) || run.id !== config.runId) {
    throw new SdkAgentRuntimeError('sdk_runtime_identity_mismatch');
  }
  return run;
}
