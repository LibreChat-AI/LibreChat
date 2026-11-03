import { randomUUID, createHash } from 'node:crypto';

export const ALLOCATION_PREFIX = '__allocation_';
const managedQueries = new WeakSet<object>();

/** Only internal canonical writers may inspect the payload-free allocation row. */
export function includeManagedAllocations<T extends object>(query: T): T {
  managedQueries.add(query);
  return query;
}

export function includesManagedAllocations(query: object): boolean {
  return managedQueries.has(query);
}

export function isManagedMessageId(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('resp_d_');
}

export function isManagedConversationId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[a-f\d]{8}-[a-f\d]{4}-8[a-f\d]{3}-a[a-f\d]{3}-[a-f\d]{12}$/i.test(value)
  );
}

export function createManagedMessageId(): string {
  return `resp_d_${randomUUID().replace(/-/g, '')}`;
}

/** A stable seed must be a server-owned operation identity, never a client conversation ID. */
export function createManagedConversationId(seed?: string): string {
  const hex = seed === undefined ? undefined : createHash('sha256').update(seed).digest('hex');
  const id =
    hex === undefined
      ? randomUUID()
      : `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  // The existing host subagent namespace uses v8+b; durable targets reserve v8+a.
  return `${id.slice(0, 14)}8${id.slice(15, 19)}a${id.slice(20)}`;
}

export const managedVisibilityFilter: { $or: Array<Record<string, unknown>> } = {
  $or: [{ _managed: { $exists: false } }, { '_managed.phase': 'published' }],
};

/** Control fields are never accepted through ordinary saves, edits or imports. */
export function isManagedControlField(field: string): boolean {
  return field === '_managed' || field.startsWith('_managed.');
}

export function stripManagedFields(record: Record<string, unknown>): void {
  for (const key of Object.keys(record)) {
    if (isManagedControlField(key)) delete record[key];
  }
}

/** Published cleanup identity is immutable through ordinary set and unset operations. */
export function stripManagedIdentityFields(record: Record<string, unknown>): void {
  for (const key of Object.keys(record)) {
    if (['_id', 'tenantId', 'user', 'messageId', 'conversationId'].includes(key.split('.')[0]))
      delete record[key];
  }
}

/** Allocation placeholders are never canonical identities, even through import or rename. */
export function isAllocationId(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(ALLOCATION_PREFIX);
}
