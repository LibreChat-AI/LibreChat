import type { Logger } from 'winston';
export type FlowStatus = 'PENDING' | 'COMPLETED' | 'FAILED';

export interface FlowMetadata {
  [key: string]: unknown;
}

export interface FlowState<T = unknown> {
  type: string;
  status: FlowStatus;
  metadata: FlowMetadata;
  createdAt: number;
  result?: T;
  error?: string;
  /** Additive wire field; older flow records retain the default Error name. */
  errorName?: string;
  completedAt?: number;
  failedAt?: number;
}

export interface FlowManagerOptions {
  ttl: number;
  /** Maximum time a flow may remain PENDING. Defaults to the storage TTL. */
  monitorTimeout?: number;
  /** Flow types whose FAILED state should remain readable until the storage TTL expires. */
  retainedFailureTypes?: readonly string[];
  ci?: boolean;
  logger?: Logger;
  redisScriptExecutor?: (
    script: string,
    options: { keys: string[]; arguments: string[] },
  ) => Promise<unknown>;
}
