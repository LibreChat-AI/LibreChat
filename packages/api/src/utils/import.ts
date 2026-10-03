import { logger } from '@librechat/data-schemas';

/** 1 GiB: default max file size for conversation imports */
export const DEFAULT_IMPORT_MAX_FILE_SIZE = 1073741824;

/** Resolves the import file-size limit from the env var, falling back to the 1 GiB default */
export function resolveImportMaxFileSize(): number {
  const raw = process.env.CONVERSATION_IMPORT_MAX_FILE_SIZE_BYTES;
  if (!raw) {
    return DEFAULT_IMPORT_MAX_FILE_SIZE;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn(
      `[imports] Invalid CONVERSATION_IMPORT_MAX_FILE_SIZE_BYTES="${raw}"; using default ${DEFAULT_IMPORT_MAX_FILE_SIZE}`,
    );
    return DEFAULT_IMPORT_MAX_FILE_SIZE;
  }
  return parsed;
}

/** Default number of import stages one node will run at once. */
export const DEFAULT_IMPORT_MAX_CONCURRENCY = 3;

/**
 * Resolves the node-wide ceiling on concurrent import stages.
 *
 * Per-user limits bound what one account can start and say nothing about the
 * aggregate: each stage buffers, decodes and `JSON.parse`s a shard at roughly
 * 3.2x its size in heap, so enough accounts each inside their own limit will
 * still exhaust the process. This is the ceiling on all of them together, and
 * the env var is how a deployment with more headroom raises it.
 */
export function resolveImportMaxConcurrency(): number {
  const raw = process.env.CONVERSATION_IMPORT_MAX_CONCURRENT;
  if (!raw) {
    return DEFAULT_IMPORT_MAX_CONCURRENCY;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    logger.warn(
      `[imports] Invalid CONVERSATION_IMPORT_MAX_CONCURRENT="${raw}"; using default ${DEFAULT_IMPORT_MAX_CONCURRENCY}`,
    );
    return DEFAULT_IMPORT_MAX_CONCURRENCY;
  }
  return parsed;
}

/** 256 MiB: default cap on a single decompressed archive entry. */
export const DEFAULT_IMPORT_MAX_SHARD_SIZE = 268435456;

/**
 * Resolves the per-entry decompression cap.
 *
 * A shard is buffered, decoded to a string, and `JSON.parse`d, which peaks at
 * roughly 3.2x its size in heap, so this bounds what one import can cost the
 * process, and a small crafted archive can reach that ceiling as easily as a
 * real export. 256 MiB is far above any shard a real export ships (ChatGPT
 * shards deliberately, and a monolithic Claude or Grok file is orders of
 * magnitude smaller), and the env var is the escape hatch for the deployment
 * that proves otherwise.
 */
export function resolveImportMaxShardSize(): number {
  const raw = process.env.CONVERSATION_IMPORT_MAX_SHARD_SIZE_BYTES;
  if (!raw) {
    return DEFAULT_IMPORT_MAX_SHARD_SIZE;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn(
      `[imports] Invalid CONVERSATION_IMPORT_MAX_SHARD_SIZE_BYTES="${raw}"; using default ${DEFAULT_IMPORT_MAX_SHARD_SIZE}`,
    );
    return DEFAULT_IMPORT_MAX_SHARD_SIZE;
  }
  return parsed;
}
