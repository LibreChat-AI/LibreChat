import type { PromptGroupRecord, PromptRecord } from './types';

const ID_FIELDS = ['_id', 'groupId', 'author', 'productionId'] as const;

function withStringIds(record: object): Record<string, unknown> {
  const plain: Record<string, unknown> = { ...record };
  for (const field of ID_FIELDS) {
    const value = plain[field];
    if (value != null && typeof value !== 'string') {
      plain[field] = String(value);
    }
  }
  return plain;
}

/**
 * Converts a stored revision to plain data with string IDs. Other fields, such as dates,
 * `__v` and `tenantId`, stay as stored, so the JSON response does not change.
 */
export function toPromptRecord(record: object): PromptRecord {
  return withStringIds(record) as unknown as PromptRecord;
}

/** Converts a stored group, and its Production revision when present, to string IDs. */
export function toPromptGroupRecord(record: object): PromptGroupRecord {
  const plain = withStringIds(record);
  const production = plain.productionPrompt;
  if (production != null && typeof production === 'object') {
    plain.productionPrompt = withStringIds(production);
  }
  return plain as unknown as PromptGroupRecord;
}
