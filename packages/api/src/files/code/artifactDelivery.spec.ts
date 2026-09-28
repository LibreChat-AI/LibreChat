import { normalizeArtifactDeliveryFailure } from './artifactDelivery';

describe('normalizeArtifactDeliveryFailure', () => {
  it('retains only the bounded public contract', () => {
    expect(
      normalizeArtifactDeliveryFailure({
        code: 'artifact_delivery_failed',
        status: 'partial',
        attempted: 3,
        delivered: 2,
        failed: 1,
        detail: 'private storage failure',
      }),
    ).toEqual({
      code: 'artifact_delivery_failed',
      status: 'partial',
      attempted: 3,
      delivered: 2,
      failed: 1,
    });
  });

  it.each([
    null,
    { code: 'storage_error', status: 'failed', attempted: 1, delivered: 0, failed: 1 },
    { code: 'artifact_delivery_failed', status: 'failed', attempted: 2, delivered: 1, failed: 1 },
    { code: 'artifact_delivery_failed', status: 'partial', attempted: 1, delivered: 0, failed: 1 },
  ])('rejects malformed external values', (value) => {
    expect(normalizeArtifactDeliveryFailure(value)).toBeUndefined();
  });
});
