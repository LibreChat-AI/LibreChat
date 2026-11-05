import { nearAIVerificationReportSchema } from 'librechat-data-provider';
import type {
  AttestationClient,
  ModelAttestation,
  GatewayAttestation,
  VerifiedModelAttestation,
  VerifiedGatewayAttestation,
} from '@nearai/inference-sdk/node';
import type { TNearAIVerificationReport } from 'librechat-data-provider';
import type { NearAISDK } from './sdk';
import { detachOnAbort } from '~/utils/promises';
import { createFailureReport } from './report';

export async function verifyModelReports(
  sdk: NearAISDK,
  client: Pick<
    AttestationClient,
    'fetchGatewayAttestation' | 'fetchModelAttestations' | 'fetchModelMetadata'
  >,
  model: string,
  scope?: 'gateway',
  signal?: AbortSignal,
): Promise<TNearAIVerificationReport[]> {
  if (scope !== 'gateway') {
    try {
      const metadata = await detachOnAbort(client.fetchModelMetadata(model), signal);
      if (metadata.providerType.trim().toLowerCase() !== 'vllm' || !metadata.attestationSupported) {
        scope = 'gateway';
      }
    } catch (error) {
      return [createFailureReport(error, undefined, model, new Date().toISOString())];
    }
  }
  const failure = (error: unknown, scope: 'model' | 'gateway'): TNearAIVerificationReport => ({
    ...createFailureReport(error, undefined, model, new Date().toISOString()),
    scope,
  });
  const check = async (
    scope: 'model' | 'gateway',
    verify: () => Promise<{
      verified: VerifiedModelAttestation | VerifiedGatewayAttestation;
      raw: ModelAttestation | GatewayAttestation;
    }>,
  ): Promise<TNearAIVerificationReport> => {
    try {
      signal?.throwIfAborted();
      const { verified, raw } = await detachOnAbort(verify(), signal);
      return nearAIVerificationReportSchema.parse({
        schemaVersion: 1,
        kind: 'model',
        model,
        scope,
        status: scope === 'model' ? 'verified' : 'partial',
        verifiedAt: new Date().toISOString(),
        attestation: verified,
        evidence: {
          intelQuote: raw.intelQuote,
          nonce: raw.nonce,
          eventLog: typeof raw.eventLog === 'string' ? raw.eventLog : JSON.stringify(raw.eventLog),
          reportedQuoteData: raw.reportedQuoteData,
          nvidiaPayload: 'nvidiaPayload' in raw ? raw.nvidiaPayload : undefined,
        },
      });
    } catch (error) {
      return failure(error, scope);
    }
  };
  const gateway = check('gateway', async () => {
    const fetched = await detachOnAbort(
      client.fetchGatewayAttestation({ signingAlgo: 'ed25519' }),
      signal,
    );
    signal?.throwIfAborted();
    return { verified: await sdk.verifyGateway(fetched), raw: fetched.attestation };
  });
  if (scope === 'gateway') return [await gateway];
  const models = detachOnAbort(
    client.fetchModelAttestations({ model, signingAlgo: 'ed25519' }),
    signal,
  )
    .then((fetched) => {
      if (fetched.attestations.length === 0) {
        throw sdk.verificationError('policy.model_attestation_required');
      }
      return Promise.all(
        fetched.attestations.map((attestation) =>
          check('model', async () => ({
            raw: attestation,
            verified: await sdk.verifyModel({
              attestation,
              clientBinding: fetched.clientBinding,
              policy: { gpuEvidence: 'required' },
            }),
          })),
        ),
      );
    })
    .catch((error: unknown) => [failure(error, 'model')]);
  return [await gateway, ...(await models)];
}
