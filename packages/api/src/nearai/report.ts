import { nearAIVerificationReportSchema } from 'librechat-data-provider';
import { isApiError, isVerificationError } from '@nearai/inference-sdk/node';
import type { VerifiedCompletionResult } from '@nearai/inference-sdk/node';
import type { TNearAIVerificationReport } from 'librechat-data-provider';

export function reportCheckedAt(reports: TNearAIVerificationReport[]): string {
  return reports.reduce(
    (earliest, report) => (report.verifiedAt < earliest ? report.verifiedAt : earliest),
    reports[0]?.verifiedAt ?? new Date().toISOString(),
  );
}

export function getVerificationErrorCode(error: unknown): string {
  if (isApiError(error) || isVerificationError(error)) return error.failure.code;
  if ((error instanceof Error || error instanceof DOMException) && error.name === 'TimeoutError') {
    return 'nearai_verification_timeout';
  }
  return 'unknown';
}

/** Project only approved display fields, without changing the SDK's verification verdict. */
export function createReplyReport(
  result: VerifiedCompletionResult,
  verifiedAt: string,
):
  | { ok: true; value: TNearAIVerificationReport }
  | { ok: false; error: { code: 'nearai_report_unavailable' } } {
  const modelScope = result.signatureKind === 'provider_tee';
  const parsed = nearAIVerificationReportSchema.safeParse({
    schemaVersion: 1,
    kind: 'reply',
    completionId: result.completionId,
    model: modelScope
      ? /^(.*):[a-f0-9]{64}:[a-f0-9]{64}$/i.exec(result.signature.signedText)?.[1]
      : undefined,
    scope: modelScope ? 'model' : 'gateway',
    status: modelScope ? 'verified' : 'partial',
    verifiedAt,
    signature: result.signature,
    attestation: result.attestation,
  });
  if (!parsed.success) return { ok: false, error: { code: 'nearai_report_unavailable' } };
  // BSON turns explicit undefined into null. Serialize only the whitelisted display fields.
  const snapshot: unknown = JSON.parse(JSON.stringify(parsed.data));
  return { ok: true, value: nearAIVerificationReportSchema.parse(snapshot) };
}

/** Missing context and unavailable services must not be presented as rejected evidence. */
export function createFailureReport(
  error: unknown,
  completionId: string | undefined,
  model: string,
  verifiedAt: string,
): TNearAIVerificationReport {
  const unavailable = new Set([
    'input.invalid',
    'ohttp.attestation_required',
    'quote.collateral_unavailable',
    'policy.gpu_evidence_required',
    'policy.model_attestation_required',
    'binding.spki_fingerprint_required',
    'gpu.nras_request_failed',
    'gpu.jwks_request_failed',
    'provenance.image_request_failed',
    'e2ee.model_public_key_required',
  ]);
  const failed =
    (isVerificationError(error) && !error.retryable && !unavailable.has(error.failure.code)) ||
    (isApiError(error) && error.failure.code === 'api.nonce_mismatch');
  return {
    schemaVersion: 1,
    ...(completionId === undefined
      ? { kind: 'model' as const, model }
      : { kind: 'reply' as const, completionId, model }),
    verifiedAt,
    scope: 'unknown',
    status: failed ? 'failed' : 'unverifiable',
    error: {
      code: getVerificationErrorCode(error),
      message: failed
        ? 'The SDK rejected the signature or verification evidence.'
        : 'The SDK could not obtain the context or evidence needed for verification.',
    },
  };
}
