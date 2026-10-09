import type { TUserMemory } from 'librechat-data-provider';

export type MemoryAddress = { id: string } | { key: string };
export type MemoryUpdateAddress =
  | { id: string; key?: string }
  | { key: string; originalKey?: string };

/** Uses the opaque record id whenever the key cannot safely address the record. */
export function getMemoryAddress(memory: TUserMemory): MemoryAddress | null {
  if (memory._id && (memory.contentFilterBlocked === true || memory.key.trim() === '')) {
    return { id: memory._id };
  }
  if (memory.key.trim() !== '') {
    return { key: memory.key };
  }
  if (memory._id) {
    return { id: memory._id };
  }
  return null;
}

export function getMemoryListKey(memory: TUserMemory): string {
  const address = getMemoryAddress(memory);
  if (address && 'id' in address) {
    return `id:${address.id}`;
  }
  if (address) {
    return `key:${memory.agentId ?? ''}:${address.key}`;
  }
  return `unaddressable:${memory.agentId ?? ''}:${memory.updated_at}`;
}

export function getMemoryUpdateAddress(
  memory: TUserMemory,
  submittedKey: string,
): MemoryUpdateAddress | null {
  const address = getMemoryAddress(memory);
  const key = submittedKey.trim();
  if (address && 'id' in address) {
    return { id: address.id, ...(key && key !== memory.key ? { key } : {}) };
  }
  if (!address || !key) {
    return null;
  }
  return { key, ...(key !== memory.key ? { originalKey: memory.key } : {}) };
}
