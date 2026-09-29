import { AsyncLocalStorage } from 'async_hooks';
import { logger } from '@librechat/data-schemas';
import type { FilterPiiAction } from 'librechat-data-provider';
import type { ContentFieldMap, ContentProvenance, ContentSource } from './types';

export interface AuditFindingMetadata {
  readonly action: FilterPiiAction;
  readonly detectorId: string;
  readonly ruleId: string;
  readonly label: string;
  readonly source: ContentSource;
  readonly field: ContentFieldMap[ContentSource];
  readonly provenance: ContentProvenance;
}

interface AggregatedAuditFinding {
  readonly metadata: AuditFindingMetadata;
  occurrences: number;
}

interface AuditFindingAggregation {
  readonly findings: Map<string, AggregatedAuditFinding>;
  untrackedOccurrences: number;
}

/**
 * Audit metadata carries no inspected content, so its cardinality is bounded by
 * the configured rules rather than by the text they match. The cap only guards
 * against an unforeseen source of distinct keys.
 */
const MAX_AGGREGATED_AUDIT_FINDINGS = 1_024;

const auditAggregationStorage = new AsyncLocalStorage<AuditFindingAggregation>();

/** Serialized rather than joined: configured rule ids and labels may contain any character. */
function aggregationKey(metadata: AuditFindingMetadata): string {
  return JSON.stringify([
    metadata.action,
    metadata.detectorId,
    metadata.ruleId,
    metadata.label,
    metadata.source,
    metadata.field,
    metadata.provenance,
  ]);
}

function emitAuditFinding(metadata: AuditFindingMetadata, occurrences: number): void {
  const auditMetadata = { ...metadata, occurrences };
  logger.info(
    `[content-filter] Audit-only finding ${JSON.stringify(auditMetadata)}`,
    auditMetadata,
  );
}

function flushAuditFindings(aggregation: AuditFindingAggregation): void {
  for (const { metadata, occurrences } of aggregation.findings.values()) {
    emitAuditFinding(metadata, occurrences);
  }
  aggregation.findings.clear();
  const { untrackedOccurrences } = aggregation;
  if (untrackedOccurrences === 0) {
    return;
  }
  aggregation.untrackedOccurrences = 0;
  const untrackedMetadata = {
    action: 'audit',
    untrackedOccurrences,
    trackedFindings: MAX_AGGREGATED_AUDIT_FINDINGS,
  };
  logger.info(
    `[content-filter] Audit-only findings untracked ${JSON.stringify(untrackedMetadata)}`,
    untrackedMetadata,
  );
}

/**
 * Reports an audit-only finding. Within an aggregation scope the finding is
 * counted and reported once per distinct rule/source/field/provenance key when
 * the scope ends, so caller-supplied content cannot turn a single request into
 * one log write per matching fragment.
 */
export function recordAuditFinding(metadata: AuditFindingMetadata): void {
  const aggregation = auditAggregationStorage.getStore();
  if (aggregation == null) {
    emitAuditFinding(metadata, 1);
    return;
  }
  const key = aggregationKey(metadata);
  const aggregated = aggregation.findings.get(key);
  if (aggregated != null) {
    aggregated.occurrences += 1;
    return;
  }
  if (aggregation.findings.size >= MAX_AGGREGATED_AUDIT_FINDINGS) {
    aggregation.untrackedOccurrences += 1;
    return;
  }
  aggregation.findings.set(key, { metadata, occurrences: 1 });
}

function createAuditFindingAggregation(): AuditFindingAggregation {
  return { findings: new Map<string, AggregatedAuditFinding>(), untrackedOccurrences: 0 };
}

/**
 * Bounds audit logging for one inspection pass over caller-supplied content.
 * Nested scopes reuse the outermost aggregation, so a single request reports
 * each distinct audit finding once, with its occurrence count, on completion.
 */
export async function aggregateAuditFindings<T>(inspect: () => Promise<T>): Promise<T> {
  if (auditAggregationStorage.getStore() != null) {
    return inspect();
  }
  const aggregation = createAuditFindingAggregation();
  try {
    return await auditAggregationStorage.run(aggregation, inspect);
  } finally {
    flushAuditFindings(aggregation);
  }
}

/** Synchronous counterpart of {@link aggregateAuditFindings}. */
export function aggregateAuditFindingsSync<T>(inspect: () => T): T {
  if (auditAggregationStorage.getStore() != null) {
    return inspect();
  }
  const aggregation = createAuditFindingAggregation();
  try {
    return auditAggregationStorage.run(aggregation, inspect);
  } finally {
    flushAuditFindings(aggregation);
  }
}
