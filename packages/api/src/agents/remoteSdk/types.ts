import type {
  AgentInputs,
  createHostFileService,
  HostFileBindings,
  HostFileDescriptor,
  HostFileServiceDescriptor,
  createHostProviderTextService,
  createHostModelService,
  HostModelDescriptor,
  HostChatModel,
  HostProviderTextDescriptor,
  HostToolDescriptor,
  HostToolBindings,
  Run,
  RunConfig,
  EventHandler,
  IState,
  HookEvent,
} from '@librechat/agents';
import type { HostModelLifecycle } from './admission';
import type { SdkAgentIdentity } from './identity';

export interface RemoteSdkRecoveryOptions {
  /** Operator-allowlisted direct worker routes, keyed by stable owner identity. */
  routes?: Record<string, string>;
  maxDisconnectMs: number;
  retryDelayMs: number;
  maxJournalBytes: number;
}
export interface RemoteSdkOptions {
  /** Opt in to the saved-agent host model, configured by the operator. */
  hostModel?: boolean;
  /** Opt in to native host attachment reads. */
  hostFiles?: boolean;
  recovery?: RemoteSdkRecoveryOptions;
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
/** Public primary-model configuration required by the worker graph. */
export interface RemoteSdkModelProfile {
  provider: AgentInputs['provider'];
  name: string;
  streaming: boolean;
}

/** Explicit host-owned capabilities; never reconstructed from worker claims or YAML. */
export interface RemoteSdkHostServices {
  /** Already authorized host binding; storage credentials and policy stay with the host. */
  files?: ReturnType<typeof createHostFileService> & { sources: readonly HostFileDescriptor[] };
  modelLifecycle?: HostModelLifecycle;
  modelProfile?: RemoteSdkModelProfile;
  model?: ReturnType<typeof createHostModelService>;
  providerText?: ReturnType<typeof createHostProviderTextService>;
}

export interface RemoteSdkStart {
  transportVersion: 2;
  files?: {
    version: 1;
    publicKey: string;
    descriptor: HostFileServiceDescriptor;
    sources: HostFileDescriptor[];
  };
  modelAdmission?: { version: 1; maxEntries: number };
  model?: { version: 1; publicKey: string; descriptor: HostModelDescriptor };
  providerText?: { version: 1; publicKey: string; limits: HostProviderTextDescriptor };
  hostTools?: HostToolDescriptor[];
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
  agent: { id: string; name?: string; instructions?: string; model?: RemoteSdkModelProfile };
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
  hostFiles?: HostFileBindings & { readonly sources: readonly HostFileDescriptor[] };
  /** Retain this model as Graph.overrideModel when supplied by the authenticated host. */
  hostModel?: ReturnType<HostChatModel['bindTools']>;
  hostTools?: HostToolBindings;
  identity: Readonly<SdkAgentIdentity>;
  /** Host-owned event, hook, and checkpoint adapters. Retain these in the returned Run. */
  config: Pick<
    RunConfig,
    | 'runId'
    | 'customHandlers'
    | 'hooks'
    | 'humanInTheLoop'
    | 'streamLimits'
    | 'providerTextProtection'
  >;
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
