export type ScheduledGrantProvenance = 'tagged' | 'provable' | 'ordinary' | 'ambiguous';

/** Null denotes duplicate clients, never a selectable provenance record. */
export function indexGrantClients<T>(
  clients: readonly T[],
  keyOf: (client: T) => string,
): Map<string, T | null> {
  const indexed = new Map<string, T | null>();
  for (const client of clients) {
    const key = keyOf(client);
    indexed.set(key, indexed.has(key) ? null : client);
  }
  return indexed;
}

/** Durable purpose survives missing client metadata; conflicting provenance never qualifies. */
export function classifyScheduledGrant(
  refresh: Record<string, unknown> | undefined,
  client: Record<string, unknown> | null | undefined,
): ScheduledGrantProvenance {
  const generation = refresh?.credential_set_id;
  if (client === null || typeof generation !== 'string' || !generation) return 'ambiguous';
  if (client !== undefined && client.credential_set_id !== generation) return 'ambiguous';
  if (refresh?.credential_purpose === 'scheduled_obo') return 'tagged';
  if (!client) return 'ambiguous';
  if (typeof client.openid_subject === 'string' && typeof client.openid_issuer === 'string')
    return 'provable';
  if (client.openid_subject !== undefined || client.openid_issuer !== undefined) return 'ambiguous';
  return 'ordinary';
}
