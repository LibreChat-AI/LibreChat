import type { TCheckpointerConfig } from 'librechat-data-provider';
import { DEFAULT_CHECKPOINT_TTL_SECONDS } from '../../stream/checkpoints';

const DEFAULT_CHECKPOINT_COLLECTION = 'agent_checkpoints';
const DEFAULT_CHECKPOINT_WRITES_COLLECTION = 'agent_checkpoint_writes';

/** Checkpointer settings with all defaults applied. */
export interface ResolvedCheckpointerConfig {
  type: 'mongo' | 'memory';
  /** Approval window / TTL in seconds. */
  ttlSeconds: number;
  checkpointCollectionName: string;
  checkpointWritesCollectionName: string;
}

/**
 * Apply defaults to the YAML `endpoints.agents.checkpointer` block. Mirrors
 * {@link resolveRecursionLimit} — the schema stays descriptive, defaults live here.
 */
export function resolveCheckpointerConfig(
  cfg: TCheckpointerConfig | undefined,
): ResolvedCheckpointerConfig {
  return {
    type: cfg?.type ?? 'mongo',
    ttlSeconds:
      typeof cfg?.ttl === 'number' && cfg.ttl > 0 ? cfg.ttl : DEFAULT_CHECKPOINT_TTL_SECONDS,
    checkpointCollectionName: cfg?.checkpointCollectionName ?? DEFAULT_CHECKPOINT_COLLECTION,
    checkpointWritesCollectionName:
      cfg?.checkpointWritesCollectionName ?? DEFAULT_CHECKPOINT_WRITES_COLLECTION,
  };
}
