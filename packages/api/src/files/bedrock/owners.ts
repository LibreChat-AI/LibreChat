export interface StoredSteerOwner {
  steerId: string;
  fileIds: string[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

export function collectStoredSteerOwners(
  messages: Iterable<{ content?: unknown }>,
): StoredSteerOwner[] {
  const owners = new Map<string, StoredSteerOwner>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const value of message.content) {
      const part = record(value);
      if (part?.type !== 'steer' || typeof part.steerId !== 'string') continue;
      const fileIds = Array.isArray(part.files)
        ? part.files.flatMap((file: unknown) => {
            const id = record(file)?.file_id;
            return typeof id === 'string' ? [id] : [];
          })
        : [];
      owners.set(part.steerId, { steerId: part.steerId, fileIds });
    }
  }
  return [...owners.values()];
}

/** Only acknowledged stored steer parts can revoke checkpoint media. */
export function withoutRepairedSteerMedia(
  content: unknown,
  repaired: ReadonlySet<string>,
): unknown {
  if (!Array.isArray(content) || repaired.size === 0) return content;
  const owned = content.some((value) => {
    const source = record(record(record(value)?.document)?.source);
    return typeof source?.librechatSteer === 'string' && repaired.has(source.librechatSteer);
  });
  if (owned) return content.filter((value) => record(value)?.type === 'text');
  return content.map((value) => {
    const part = record(value);
    if (part?.type !== 'steer' || typeof part.steerId !== 'string' || !repaired.has(part.steerId))
      return value;
    const next = { ...part };
    delete next.files;
    delete next.media;
    return next;
  });
}
