/**
 * Update paths that record bookkeeping about a file rather than its content: usage counts,
 * TTLs, the deletion sweep's retry state, embedding-owner tracking and workspace import
 * records. Consumers fingerprint content by `updatedAt` (Project resume compatibility, the
 * code-output writer order), so a write of only these must not advance it. Every other path
 * is content, so a newly added field advances `updatedAt` until it is classified here.
 */
const bookkeeping = new Set([
  'usage',
  'temp_file_id',
  'expiresAt',
  'deletionAttempts',
  'deletionRetryAt',
  'embeddingOwnersComplete',
  'embeddingOwnersTrackedAt',
  'metadata.workspaceImports',
]);

/**
 * Whether an update built by `fileContentUpdate` writes content and so advances `updatedAt`.
 * Mongoose drops `undefined` values from updates, so a path set to `undefined` writes nothing.
 */
export function writesFileContent(update: ReturnType<typeof fileContentUpdate>): boolean {
  if (update.$addToSet != null) {
    return true;
  }
  return Object.entries(update.$set).some(
    ([path, value]) => value !== undefined && !bookkeeping.has(path),
  );
}

/** Only confirmed erasure may remove recorded vector owners. Content writes are additive. */
export function fileContentUpdate(data: object): {
  $set: Record<string, unknown>;
  $addToSet?: Record<string, { $each: string[] }>;
} {
  const update: Record<string, unknown> = { ...data };
  delete update.embeddingOwnersComplete;
  delete update.embeddingOwnersTrackedAt;
  const metadata = update.metadata;
  let owners: string[] | undefined;
  if (metadata !== undefined) {
    if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw new Error('Invalid file metadata');
    }
    delete update.metadata;
    for (const [key, value] of Object.entries(metadata)) {
      if (key.includes('.') || key.startsWith('$')) throw new Error('Invalid file metadata key');
      if (key === 'embeddedEntities') {
        if (value === undefined) continue;
        if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !id)) {
          throw new Error('Invalid file embedding snapshot');
        }
        owners = value;
      } else {
        update[`metadata.${key}`] = value;
      }
    }
  }
  return {
    $set: update,
    ...(owners?.length ? { $addToSet: { 'metadata.embeddedEntities': { $each: owners } } } : {}),
  };
}
