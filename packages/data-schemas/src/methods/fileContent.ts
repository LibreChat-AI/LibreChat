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
