export type ArtifactDeliveryFailure = {
  code: 'artifact_delivery_failed';
  status: 'partial' | 'failed';
  attempted: number;
  delivered: number;
  failed: number;
};

export function normalizeArtifactDeliveryFailure(
  value: unknown,
): ArtifactDeliveryFailure | undefined {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const candidate = value as Partial<ArtifactDeliveryFailure>;
  if (
    candidate.code !== 'artifact_delivery_failed' ||
    (candidate.status !== 'partial' && candidate.status !== 'failed') ||
    !Number.isSafeInteger(candidate.attempted) ||
    !Number.isSafeInteger(candidate.delivered) ||
    !Number.isSafeInteger(candidate.failed) ||
    candidate.attempted == null ||
    candidate.delivered == null ||
    candidate.failed == null ||
    candidate.attempted < 1 ||
    candidate.delivered < 0 ||
    candidate.failed < 1 ||
    candidate.attempted !== candidate.delivered + candidate.failed ||
    (candidate.status === 'failed' && candidate.delivered !== 0) ||
    (candidate.status === 'partial' && candidate.delivered === 0)
  ) {
    return undefined;
  }

  return {
    code: candidate.code,
    status: candidate.status,
    attempted: candidate.attempted,
    delivered: candidate.delivered,
    failed: candidate.failed,
  };
}
