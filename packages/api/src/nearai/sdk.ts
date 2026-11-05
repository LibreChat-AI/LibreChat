import {
  AttestationClient,
  InferenceClient,
  VerificationError,
  verifyGatewayAttestation,
  verifyModelAttestation,
} from '@nearai/inference-sdk/node';
import type { NearAICredentials } from './types';

/** SDK construction belongs at the production composition boundary. */
export interface NearAISDK {
  attestation(
    credentials: NearAICredentials,
  ): Pick<
    AttestationClient,
    'fetchModelMetadata' | 'fetchGatewayAttestation' | 'fetchModelAttestations'
  >;
  inference(
    credentials: NearAICredentials,
    privateModel: boolean,
  ): Pick<InferenceClient, 'verify' | 'fetch' | 'verifyResponse'>;
  verificationError(code: 'policy.model_attestation_required'): VerificationError;
  verifyGateway: typeof verifyGatewayAttestation;
  verifyModel: typeof verifyModelAttestation;
}

export const nearAISDK: NearAISDK = {
  attestation: ({ apiKey, baseURL }: NearAICredentials) =>
    new AttestationClient({ apiKey, baseUrl: baseURL }),
  inference: ({ apiKey, baseURL }: NearAICredentials, privateModel: boolean) =>
    new InferenceClient({
      apiKey,
      baseUrl: baseURL,
      // The service owns expiration, so evidence cannot expire between preflight and inference.
      attestationCacheTimeToLiveMs: Infinity,
      e2ee: privateModel,
      signingAlgo: privateModel ? 'ed25519' : 'ecdsa',
    }),
  verificationError: (code: 'policy.model_attestation_required') => new VerificationError({ code }),
  verifyGateway: verifyGatewayAttestation,
  verifyModel: verifyModelAttestation,
};
