import type { Run, RunConfig, EventHandler, IState, HookEvent } from '@librechat/agents';
import type { SdkAgentIdentity } from './identity';

export interface RemoteSdkOptions {
  url: string;
  secret: string;
  connectTimeoutMs?: number;
  rpcTimeoutMs?: number;
  maxFrameBytes?: number;
  maxBufferedBytes?: number;
  maxRunMs?: number;
  /** Trusted host diagnostics; never delivered to the browser or runtime. */
  onError?: (error: unknown) => void;
}
export interface RemoteSdkLimits {
  connectTimeoutMs: number;
  rpcTimeoutMs: number;
  maxFrameBytes: number;
  maxBufferedBytes: number;
  maxRunMs: number;
}
export function remoteSdkLimits(options: Partial<RemoteSdkLimits>): RemoteSdkLimits {
  const limits = {
    connectTimeoutMs: options.connectTimeoutMs ?? 10_000,
    rpcTimeoutMs: options.rpcTimeoutMs ?? 60_000,
    maxFrameBytes: options.maxFrameBytes ?? 1_048_576,
    maxBufferedBytes: options.maxBufferedBytes ?? 4_194_304,
    maxRunMs: options.maxRunMs ?? 600_000,
  };
  if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value <= 0))
    throw new Error('Invalid SDK runtime limits');
  return limits;
}
export type SdkRun = Awaited<ReturnType<typeof Run.create>>;
export type SdkRunInput = Parameters<SdkRun['processStream']>[0];
export type SdkRunOptions = Parameters<SdkRun['processStream']>[1];
export type SdkEventData = Parameters<EventHandler['handle']>[1];
export interface RemoteSdkStart {
  operation: 'start' | 'resume';
  input: IState;
  resume?: unknown;
  commandOptions?: Parameters<SdkRun['resume']>[3];
  options: Pick<SdkRunOptions, 'recursionLimit' | 'configurable'>;
  handlers: string[];
  hooks: HookEvent[];
  checkpoint: boolean;
  humanInTheLoop?: RunConfig['humanInTheLoop'];
  streamLimits?: RunConfig['streamLimits'];
  agent: { id: string; name?: string; instructions?: string };
}
export interface RemoteSdkSnapshot {
  state?: {
    [K in
      | 'getDiscoveredTools'
      | 'getCalibrationRatio'
      | 'getFadingTier'
      | 'getFadingTiers'
      | 'getFadingTierResetAgentIds'
      | 'getResolvedInstructionOverhead'
      | 'getToolCount'
      | 'getOutputTruncated'
      | 'getHandoffOutcome']: ReturnType<SdkRun[K]>;
  };
  content?: ReturnType<NonNullable<SdkRun['Graph']>['getContentParts']>;
  messages?: ReturnType<SdkRun['getRunMessages']>;
  interrupt?: ReturnType<SdkRun['getInterrupt']>;
  haltReason?: string;
  runSteps?: ReturnType<NonNullable<SdkRun['Graph']>['createRunStepResumeState']>;
}
export interface RemoteSdkFactoryInput {
  identity: Readonly<SdkAgentIdentity>;
  /** Host-owned event, hook, and checkpoint adapters. Retain these in the returned Run. */
  config: Pick<RunConfig, 'runId' | 'customHandlers' | 'hooks' | 'humanInTheLoop' | 'streamLimits'>;
  compileOptions: NonNullable<RunConfig['graphConfig']['compileOptions']>;
  signal: AbortSignal;
  agent: RemoteSdkStart['agent'];
}

export interface RemoteSdkResumeState {
  content: NonNullable<RemoteSdkSnapshot['content']>;
  steps: import('@librechat/agents').RunStep[];
}

/** Missing environment substitutions must never become predictable signing keys. */
export function isRemoteSdkSecret(secret: unknown): secret is string {
  return typeof secret === 'string' && secret.length >= 32 && !/\$\{[^}]+\}/.test(secret);
}
