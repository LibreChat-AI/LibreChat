import { ChatOpenAI } from '@librechat/agents/llm/openai';
import { VerificationError } from '@nearai/inference-sdk/node';
import { nearAIConfigSchema, FileSources } from 'librechat-data-provider';
import type { GatewayAttestation, VerifiedGatewayAttestation } from '@nearai/inference-sdk/node';
import type { AppConfig } from '@librechat/data-schemas';
import type { NearAISDK } from './sdk';
import { createNearAIService, isNearAIBaseURL } from './attestation';
import { getNearAIVerificationConfig } from './handler';
import { resolveLangChainError } from '~/agents/errors';
import { getNearAICredentials } from './credentials';
import { nearAISDK } from './sdk';

const credentials = {
  apiKey: 'test-key',
  baseURL: 'https://cloud-stg-api.near.ai/v1',
  verificationTimeoutMs: 30,
};
const body = JSON.stringify({ model: 'model', messages: [] });

function setup(providerType = 'vllm') {
  const fetch = jest.fn(async () => new Response('{}'));
  const verify = jest.fn(async () => undefined);
  const sdk: NearAISDK = {
    ...nearAISDK,
    attestation: () => ({
      fetchModelMetadata: jest.fn(async () => ({
        providerType,
        attestationSupported: providerType === 'vllm',
      })),
      fetchGatewayAttestation: async () => {
        throw new Error('offline');
      },
      fetchModelAttestations: async () => {
        throw new Error('offline');
      },
    }),
    inference: jest.fn(() => ({
      fetch,
      verify,
      verifyResponse: async () => {
        throw new Error('offline');
      },
    })),
  };
  return { service: createNearAIService(sdk), sdk, fetch, verify };
}

it.each(['vllm', 'external', 'chutes'])(
  'uses metadata to select protection for %s',
  async (provider) => {
    const { service, sdk } = setup(provider);
    const result = await service.verify(credentials, 'model');
    expect(result.status).toBe(provider === 'vllm' ? 'verified' : 'partial');
    expect(sdk.inference).toHaveBeenCalledWith(credentials, provider === 'vllm');
  },
);

it('deduplicates session creation and isolates model, owner, credentials and environment', async () => {
  const { service, sdk } = setup();
  await Promise.all([service.verify(credentials, 'a'), service.verify(credentials, 'a')]);
  expect(sdk.inference).toHaveBeenCalledTimes(1);
  for (const [changes, model] of [
    [{}, 'b'],
    [{ owner: 'other' }, 'a'],
    [{ apiKey: 'different' }, 'a'],
    [{ baseURL: 'https://cloud-api.near.ai/v1' }, 'a'],
  ] as const) {
    await service.verify({ ...credentials, ...changes }, model);
  }
  expect(sdk.inference).toHaveBeenCalledTimes(5);
});

it('keeps the exact preflight session when the creation TTL expires before fetch', async () => {
  const { service, sdk, verify, fetch } = setup();
  let now = Date.now();
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  await service.verify(credentials, 'model');
  now += 60 * 60 * 1000 - 1;
  verify.mockImplementationOnce(async () => {
    now += 2;
  });
  await service.createFetch(credentials)('https://cloud-stg-api.near.ai/v1/chat/completions', {
    body,
  });
  expect(sdk.inference).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('bounds preflight, blocks inference on failure, and retries a timed-out session', async () => {
  const { service, sdk, verify, fetch } = setup();
  verify.mockImplementationOnce(() => new Promise(() => undefined));
  const result = await service.createFetch(credentials)(credentials.baseURL, { body });
  expect(result.status).toBe(403);
  expect(fetch).not.toHaveBeenCalled();
  await expect(service.verify(credentials, 'model')).resolves.toMatchObject({ status: 'verified' });
  expect(sdk.inference).toHaveBeenCalledTimes(2);
});

it('does not cap long inference at the preflight timeout', async () => {
  const { service, fetch } = setup();
  fetch.mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return new Response('{}');
  });
  await expect(
    service.createFetch(credentials)(credentials.baseURL, { body }),
  ).resolves.toMatchObject({ status: 200 });
});

it('rejects unsupported providers without sending chat and keeps explicit refresh separate from display reports', async () => {
  const unsupported = setup('untrusted');
  expect(
    (await unsupported.service.createFetch(credentials)(credentials.baseURL, { body })).status,
  ).toBe(403);
  expect(unsupported.fetch).not.toHaveBeenCalled();
  const { service, sdk } = setup();
  await service.verify(credentials, 'model');
  await service.reports(credentials, 'model');
  await service.reports(credentials, 'model', { force: true });
  await service.verify(credentials, 'model');
  expect(sdk.inference).toHaveBeenCalledTimes(1);
  await service.reports(credentials, 'model', { refresh: true });
  await service.verify(credentials, 'model');
  expect(sdk.inference).toHaveBeenCalledTimes(2);
});

function config(apiKey = 'test-key', nearai = true): AppConfig {
  return {
    config: {},
    fileStrategy: FileSources.local,
    imageOutputType: 'png',
    endpoints: {
      custom: [
        {
          name: 'Private',
          apiKey,
          nearai,
          baseURL: credentials.baseURL,
          models: { default: ['model'] },
        },
      ],
    },
  };
}

it('requires explicit enablement and trusted HTTPS hosts; resolves only the authenticated user key', async () => {
  for (const url of [
    'http://cloud-api.near.ai/v1',
    'https://cloud-api.near.ai.evil/v1',
    'https://k@cloud-api.near.ai/v1',
    'https://cloud-api.near.ai/v2',
  ])
    expect(isNearAIBaseURL(url)).toBe(false);
  expect(getNearAIVerificationConfig(config()).nearaiEndpoints).toEqual(['Private']);
  expect(getNearAIVerificationConfig(config('test-key', false)).nearaiEndpoints).toEqual([]);
  await expect(getNearAICredentials(config('test-key', false), 'Private')).resolves.toBeUndefined();
  const getUserKeyValues = jest.fn(async () => ({ apiKey: 'saved-key' }));
  await expect(
    getNearAICredentials(config('user_provided'), 'Private', {
      userId: 'alice',
      tenantId: 'tenant-a',
      getUserKeyValues,
    }),
  ).resolves.toMatchObject({ apiKey: 'saved-key', owner: '["tenant-a","alice"]' });
  expect(getUserKeyValues).toHaveBeenCalledWith({ userId: 'alice', name: 'Private' });
  await expect(getNearAICredentials(config('user_provided'), 'Private')).rejects.toThrow(
    'nearai_credentials_unavailable',
  );
  expect(nearAIConfigSchema.parse({}).verifyUrl).toBe('https://cloud.near.ai/verify');
});

it('preserves explicit rejected evidence as failed', async () => {
  const { service, verify } = setup();
  verify.mockRejectedValueOnce(
    new VerificationError({ code: 'policy.model_attestation_required' }),
  );
  await expect(service.verify(credentials, 'model')).resolves.toMatchObject({ status: 'failed' });
});

it('maps a real ChatOpenAI preflight rejection to the localized error contract without sending inference', async () => {
  const { service, verify, fetch } = setup();
  verify.mockRejectedValueOnce(
    new VerificationError({ code: 'policy.model_attestation_required' }),
  );
  const model = new ChatOpenAI({
    model: 'model',
    apiKey: credentials.apiKey,
    maxRetries: 0,
    configuration: { baseURL: credentials.baseURL, fetch: service.createFetch(credentials) },
  });
  await expect(
    model.invoke('Hello').catch((error: unknown) => {
      expect(resolveLangChainError(error)).toContain('"type":"nearai_attestation_failed"');
      expect(fetch).not.toHaveBeenCalled();
      throw error;
    }),
  ).rejects.toMatchObject({ status: 403 });
});

it('reuses report work only for the same environment, owner, credentials and model', async () => {
  const raw: GatewayAttestation = {
    nonce: 'nonce',
    intelQuote: 'quote',
    eventLog: '[]',
    appCompose: '{}',
    reportedQuoteData: 'data',
    signer: { signingAlgo: 'ed25519', signingAddress: 'a'.repeat(64) },
  };
  const verified: VerifiedGatewayAttestation = {
    signer: raw.signer,
    tcbStatus: 'UpToDate',
    advisoryIds: [],
    deploymentProvenance: 'verified',
    deployment: { appCompose: '{}', runtimeMeasurements: {} },
    tlsBinding: { kind: 'none' },
  };
  const { sdk } = setup('external');
  const gateway = jest.fn(async () => ({ attestation: raw, clientBinding: { nonce: raw.nonce } }));
  const base = sdk.attestation;
  sdk.attestation = (value) => ({ ...base(value), fetchGatewayAttestation: gateway });
  sdk.verifyGateway = async () => verified;
  const service = createNearAIService(sdk);
  await Promise.all([service.reports(credentials, 'a'), service.reports(credentials, 'a')]);
  await service.reports(credentials, 'a');
  expect(gateway).toHaveBeenCalledTimes(1);
  for (const [changes, model] of [
    [{}, 'b'],
    [{ owner: 'other' }, 'a'],
    [{ apiKey: 'different' }, 'a'],
    [{ baseURL: 'https://cloud-api.near.ai/v1' }, 'a'],
  ] as const)
    await service.reports({ ...credentials, ...changes }, model);
  expect(gateway).toHaveBeenCalledTimes(5);
});
