import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { nearAIVerificationReportSchema } from 'librechat-data-provider';
import {
  ApiError,
  VerificationError,
  verifyModelResponse,
  verifyGatewayResponse,
} from '@nearai/inference-sdk/node';
import type {
  VerifiedModelCompletionResult,
  VerifiedGatewayCompletionResult,
} from '@nearai/inference-sdk/node';
import { createReplyReport, createFailureReport } from './report';

const model = 'z-ai/glm-5.3-flash';
const verifiedAt = '2026-10-27T10:00:00.000Z';
const requestBody = Buffer.from(JSON.stringify({ model, messages: [] }));
const responseBody = Buffer.from(JSON.stringify({ id: 'completion-1', choices: [] }));
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const keys = generateKeyPairSync('ed25519');
const signingAddress = keys.publicKey.export({ format: 'jwk' }).x!;
const publicKeyHex = Buffer.from(signingAddress, 'base64url').toString('hex');

function verifiedModel(): VerifiedModelCompletionResult {
  const signedText = `${model}:${hash(requestBody)}:${hash(responseBody)}`;
  const signer = { signingAlgo: 'ed25519', signingAddress: publicKeyHex } as const;
  const result: VerifiedModelCompletionResult = {
    completionId: 'completion-1',
    signatureKind: 'provider_tee',
    signature: {
      kind: 'provider_tee',
      signer,
      signedText,
      signature: sign(null, Buffer.from(signedText), keys.privateKey).toString('hex'),
    },
    attestation: {
      signer,
      tcbStatus: 'UpToDate',
      advisoryIds: [],
      deploymentProvenance: 'not_checked',
      deployment: {
        appCompose: 'SECRET DEPLOYMENT CONFIG',
        runtimeMeasurements: { osImageHash: 'a'.repeat(64), composeHash: 'b'.repeat(64) },
      },
      gpuEvidence: 'verified',
      signingPublicKey: publicKeyHex,
    },
  };
  verifyModelResponse({ requestBody, responseBody, ...result });
  return result;
}

describe('reply verification reports', () => {
  it('requires a model for deployment reports and a completion ID for reply reports', () => {
    const base = {
      schemaVersion: 1,
      scope: 'unknown',
      status: 'unverifiable',
      verifiedAt,
    };
    expect(nearAIVerificationReportSchema.safeParse({ ...base, kind: 'model' }).success).toBe(
      false,
    );
    expect(
      nearAIVerificationReportSchema.safeParse({ ...base, kind: 'model', model }).success,
    ).toBe(true);
    expect(
      nearAIVerificationReportSchema.safeParse({ ...base, kind: 'reply', model }).success,
    ).toBe(false);
  });

  it('projects a real SDK-verified model signature without deployment config or unknown fields', () => {
    const result = verifiedModel();
    const input = { ...result, apiKey: 'SECRET API KEY' };
    const report = createReplyReport(input, verifiedAt);
    expect(report.ok).toBe(true);
    if (!report.ok) {
      throw new Error('Expected a report');
    }
    expect(report.value).toMatchObject({
      kind: 'reply',
      scope: 'model',
      status: 'verified',
      completionId: result.completionId,
      model,
      verifiedAt,
      signature: result.signature,
      attestation: { signer: result.attestation.signer, gpuEvidence: 'verified' },
    });
    expect(JSON.stringify(report)).not.toContain('SECRET');
    expect(report.value.attestation?.deployment).not.toHaveProperty('appCompose');
  });

  it('keeps gateway signatures partial and omits an unsigned model name', () => {
    const source = verifiedModel();
    const signedText = `${hash(requestBody)}:${hash(responseBody)}`;
    const result: VerifiedGatewayCompletionResult = {
      completionId: source.completionId,
      signatureKind: 'gateway',
      signature: {
        ...source.signature,
        kind: 'gateway',
        signedText,
        signature: sign(null, Buffer.from(signedText), keys.privateKey).toString('hex'),
      },
      attestation: {
        signer: source.attestation.signer,
        tcbStatus: 'UpToDate',
        advisoryIds: [],
        deploymentProvenance: 'not_checked',
        deployment: source.attestation.deployment,
        tlsBinding: { kind: 'attested', spkiFingerprint: 'f'.repeat(64) },
      },
    };
    verifyGatewayResponse({ requestBody, responseBody, ...result });
    const report = createReplyReport(result, verifiedAt);
    expect(report).toMatchObject({ ok: true, value: { scope: 'gateway', status: 'partial' } });
    if (report.ok) {
      expect(report.value).not.toHaveProperty('model');
      expect(report.value.attestation?.tlsBinding).toEqual(result.attestation.tlsBinding);
    }
  });

  it('leaves payload and signer consistency checks to the real SDK', () => {
    const result = verifiedModel();
    expect(() =>
      verifyModelResponse({
        ...result,
        requestBody: Buffer.from(JSON.stringify({ model: 'other', messages: [] })),
        responseBody,
      }),
    ).toThrow(VerificationError);
    expect(() =>
      verifyModelResponse({
        ...result,
        requestBody,
        responseBody,
        attestation: {
          ...result.attestation,
          signer: { signingAlgo: 'ed25519', signingAddress: '1'.repeat(64) },
        },
      }),
    ).toThrow(VerificationError);
  });

  it('strips secrets at the browser boundary and bounds report size', () => {
    const report = createReplyReport(verifiedModel(), verifiedAt);
    if (!report.ok) {
      throw new Error('Expected a report');
    }
    const input = {
      ...report.value,
      apiKey: 'SECRET',
      evidence: {
        intelQuote: 'public quote',
        nonce: 'public nonce',
        eventLog: '[]',
        apiKey: 'SECRET',
      },
      attestation: {
        ...report.value.attestation,
        deployment: { ...report.value.attestation?.deployment, appCompose: 'SECRET' },
      },
    };
    expect(JSON.stringify(nearAIVerificationReportSchema.parse(input))).not.toContain('SECRET');
    expect(
      nearAIVerificationReportSchema.safeParse({ ...input, completionId: '中'.repeat(400_000) })
        .success,
    ).toBe(false);
  });

  it.each([
    [
      new VerificationError({ code: 'signature.invalid', details: { signingAlgo: 'ed25519' } }),
      'failed',
    ],
    [
      new ApiError({ code: 'api.nonce_mismatch', details: { resource: 'model_attestation' } }),
      'failed',
    ],
    [new ApiError({ code: 'api.completion_not_found' }), 'unverifiable'],
    [
      new VerificationError({ code: 'quote.collateral_unavailable', retryable: true }),
      'unverifiable',
    ],
    [new Error('SECRET provider payload and credentials'), 'unverifiable'],
  ])('classifies SDK failures and never discloses raw errors (%s)', (error, status) => {
    const report = createFailureReport(error, 'completion-1', model, verifiedAt);
    expect(report.status).toBe(status);
    expect(nearAIVerificationReportSchema.safeParse(report).success).toBe(true);
    expect(JSON.stringify(report)).not.toContain('SECRET');
  });
});
