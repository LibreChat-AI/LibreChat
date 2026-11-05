import { hasVerifiedReports, DEFAULT_NEAR_AI_REPORT_CACHE_TTL_MS } from 'librechat-data-provider';
import type {
  TMessage,
  TNearAIReceipt,
  TNearAIAttestationParams,
  TNearAIAttestationResponse,
  TNearAIVerificationReport,
} from 'librechat-data-provider';
import type { QueryStatus } from '@tanstack/react-query';

export function getReceipts(message: TMessage): TNearAIReceipt[] {
  if (
    message.isCreatedByUser ||
    message.error ||
    message.unfinished ||
    message.isUserSubmitted ||
    message.userSubmittedPaths?.length ||
    message.userSubmittedMessageFieldPaths?.length
  ) {
    return [];
  }
  const nearai = message.metadata?.nearai as { receipts?: TNearAIReceipt[] } | undefined;
  return Array.isArray(nearai?.receipts) ? nearai.receipts : [];
}

export function replyReport(receipt: TNearAIReceipt) {
  return receipt.report?.kind === 'reply' && receipt.report.completionId === receipt.completionId
    ? receipt.report
    : undefined;
}

export function replyEnvironment(
  endpoint: string | null | undefined,
  receipt: TNearAIReceipt,
): Pick<TNearAIAttestationParams, 'endpoint' | 'model' | 'scope'> | undefined {
  const report = replyReport(receipt);
  if (!endpoint || !report?.signature || !report.attestation) return;
  return {
    endpoint,
    model: report.model ?? receipt.model,
    scope: report.scope === 'gateway' ? 'gateway' : undefined,
  };
}

export function reportStaleTime(
  data: TNearAIAttestationResponse | undefined,
  queryStatus?: QueryStatus,
  dataUpdatedAt = Date.now(),
): number {
  if (queryStatus === 'error' || !data?.enabled || data.status === 'failed') return 0;
  if (!hasVerifiedReports(data.reports)) return 0;
  if (!data.expiresAt) return DEFAULT_NEAR_AI_REPORT_CACHE_TTL_MS;
  const expiresAt = Date.parse(data.expiresAt);
  return Number.isFinite(expiresAt)
    ? Math.max(0, Math.min(DEFAULT_NEAR_AI_REPORT_CACHE_TTL_MS, expiresAt - dataUpdatedAt))
    : 0;
}

export function hardwareVerifiedAt(reports?: TNearAIVerificationReport[]): string | undefined {
  let earliest: string | undefined;
  for (const report of reports ?? []) {
    if (report.kind !== 'model' || !Number.isFinite(Date.parse(report.verifiedAt))) continue;
    if (!earliest || Date.parse(report.verifiedAt) < Date.parse(earliest)) {
      earliest = report.verifiedAt;
    }
  }
  return earliest;
}

/** Match the example: enrich matching hardware without changing the saved signature or verdict. */
export function combineReplyReports(
  reply: TNearAIVerificationReport,
  environment: TNearAIVerificationReport[],
): TNearAIVerificationReport[] {
  environment = environment.filter(
    (entry) => entry.kind === 'model' && (reply.model == null || entry.model === reply.model),
  );
  const attestation = reply.attestation;
  const measurements = attestation?.deployment.runtimeMeasurements;
  const identity = (value: string) => value.replace(/^0x/i, '').toLowerCase();
  const matched =
    attestation && measurements?.osImageHash && measurements.composeHash
      ? environment.find((entry) => {
          const hardware = entry.attestation;
          return (
            entry.scope === reply.scope &&
            (entry.status === 'verified' || entry.status === 'partial') &&
            hardware &&
            hardware.signer.signingAlgo === attestation.signer.signingAlgo &&
            identity(hardware.signer.signingAddress) ===
              identity(attestation.signer.signingAddress) &&
            hardware.deployment.runtimeMeasurements.osImageHash === measurements.osImageHash &&
            hardware.deployment.runtimeMeasurements.composeHash === measurements.composeHash
          );
        })
      : undefined;
  return [
    matched
      ? {
          ...reply,
          attestation: matched.attestation,
          ...(matched.evidence ? { evidence: matched.evidence } : {}),
        }
      : reply,
    ...environment.filter((entry) => entry !== matched),
  ];
}
