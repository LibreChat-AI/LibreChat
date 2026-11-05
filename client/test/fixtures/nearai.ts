import type { TNearAIReceipt, TNearAIVerificationReport } from 'librechat-data-provider';

export const viewerUrl = 'https://cloud-stg.near.ai/verify?model=z-ai/glm-5.3-flash';
export const report: TNearAIVerificationReport = {
  schemaVersion: 1,
  kind: 'reply',
  completionId: 'completion-1',
  model: 'z-ai/glm-5.3-flash',
  scope: 'model',
  status: 'verified',
  verifiedAt: '2026-10-27T10:00:00.000Z',
  signature: {
    kind: 'provider_tee',
    signer: { signingAlgo: 'ed25519', signingAddress: '1'.repeat(64) },
    signedText: `z-ai/glm-5.3-flash:${'2'.repeat(64)}:${'3'.repeat(64)}`,
    signature: '4'.repeat(128),
  },
  attestation: {
    signer: { signingAlgo: 'ed25519', signingAddress: '1'.repeat(64) },
    tcbStatus: 'UpToDate',
    advisoryIds: [],
    deploymentProvenance: 'not_checked',
    deployment: {
      runtimeMeasurements: { osImageHash: '5'.repeat(64), composeHash: '6'.repeat(64) },
    },
    gpuEvidence: 'verified',
  },
};

export const receipt: TNearAIReceipt = {
  completionId: report.completionId,
  model: 'z-ai/glm-5.3-flash',
  status: 'verified',
  verifiedAt: report.verifiedAt,
  signatureKind: 'provider_tee',
  signingAlgo: 'ed25519',
  signingAddress: report.signature?.signer.signingAddress,
  signedText: report.signature?.signedText,
  signature: report.signature?.signature,
  report,
};

export const modelReport: TNearAIVerificationReport = {
  schemaVersion: 1,
  kind: 'model',
  model: 'z-ai/glm-5.3-flash',
  scope: 'model',
  status: 'verified',
  verifiedAt: report.verifiedAt,
  attestation: report.attestation,
};

export const gatewayReport: TNearAIVerificationReport = {
  schemaVersion: 1,
  kind: 'model',
  model: 'z-ai/glm-5.3-flash',
  scope: 'gateway',
  status: 'partial',
  verifiedAt: '2026-10-27T11:00:00.000Z',
  attestation: {
    signer: { signingAlgo: 'ed25519', signingAddress: '7'.repeat(64) },
    tcbStatus: 'UpToDate',
    advisoryIds: [],
    deploymentProvenance: 'not_checked',
    deployment: {
      runtimeMeasurements: { osImageHash: '8'.repeat(64), composeHash: '9'.repeat(64) },
    },
    tlsBinding: { kind: 'attested', spkiFingerprint: 'a'.repeat(64) },
  },
};
