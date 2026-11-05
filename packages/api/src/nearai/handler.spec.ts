import express from 'express';
import request from 'supertest';
import { FileSources, EModelEndpoint } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import { createNearAIHandlers, getNearAIVerificationConfig } from './handler';
import { initializeCustom } from '~/endpoints/custom/initialize';
import { createNearAIService } from './attestation';
import { nearAISDK } from './sdk';

function config(
  key = 'user_provided',
  enabled = true,
  baseURL = 'https://cloud-stg-api.near.ai/v1',
  provider?: EModelEndpoint.anthropic,
): AppConfig {
  return {
    config: {},
    fileStrategy: FileSources.local,
    imageOutputType: 'png',
    endpoints: {
      custom: [
        {
          name: 'Private',
          apiKey: key,
          nearai: enabled,
          baseURL,
          provider,
          models: { default: ['model'] },
        },
      ],
    },
  };
}

function setup(appConfig = config()) {
  const service = createNearAIService(nearAISDK);
  const getUserKeyValues = jest.fn(async () => ({ apiKey: 'saved-key' }));
  const verify = jest.spyOn(service, 'verify').mockResolvedValue({
    model: 'model',
    status: 'verified',
    checkedAt: '2026-11-05T08:00:00.000Z',
  });
  const app = express();
  const handler = createNearAIHandlers(service, getUserKeyValues);
  app.get('/attestation', async (req, res) => {
    await handler(
      { query: req.query, config: appConfig, user: { id: 'alice', tenantId: 'tenant-a' } },
      res,
    );
  });
  return { app, service, verify, getUserKeyValues };
}

it('resolves the authenticated user key, separates scope, and uses evidence time', async () => {
  const { app, service, getUserKeyValues } = setup();
  const reports = jest.spyOn(service, 'reports').mockResolvedValue([
    {
      schemaVersion: 1,
      kind: 'model',
      model: 'model',
      scope: 'gateway',
      status: 'partial',
      verifiedAt: '2026-11-05T07:00:00.000Z',
    },
  ]);
  const response = await request(app)
    .get('/attestation')
    .query({ endpoint: 'Private', model: 'model', reports: '1', scope: 'gateway' });
  expect(response.status).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body).toMatchObject({
    status: 'partial',
    checkedAt: '2026-11-05T07:00:00.000Z',
    expiresAt: '2026-11-05T07:05:00.000Z',
  });
  expect(reports).toHaveBeenCalledWith(
    expect.objectContaining({ apiKey: 'saved-key', owner: '["tenant-a","alice"]' }),
    'model',
    { scope: 'gateway', refresh: false },
  );
  expect(getUserKeyValues).toHaveBeenCalledWith({ userId: 'alice', name: 'Private' });
});

it('forwards explicit report bypass without treating it as a Chat session refresh', async () => {
  const { app, service, verify } = setup();
  const reports = jest.spyOn(service, 'reports').mockResolvedValue([]);
  await request(app).get('/attestation').query({
    endpoint: 'Private',
    model: 'model',
    reports: '1',
    force: '1',
  });
  expect(reports).toHaveBeenCalledWith(expect.any(Object), 'model', {
    scope: undefined,
    refresh: false,
    force: true,
  });
  expect(verify).not.toHaveBeenCalled();
});

it.each([config('default-key', false), config('default-key', true, 'https://api.openai.com/v1')])(
  'does not verify unrelated or disabled endpoints',
  async (appConfig) => {
    const { app, verify } = setup(appConfig);
    expect((await request(app).get('/attestation?endpoint=Private&model=model')).body).toEqual({
      enabled: false,
    });
    expect(verify).not.toHaveBeenCalled();
  },
);

it('returns safe non-success errors for missing credentials and invalid input', async () => {
  const { app, getUserKeyValues, verify } = setup();
  getUserKeyValues.mockRejectedValue(new Error('secret provider payload with saved-key'));
  expect((await request(app).get('/attestation?endpoint=Private&model=model')).body).toEqual({
    error: { code: 'nearai_verification_unavailable' },
  });
  expect((await request(app).get('/attestation')).status).toBe(400);
  expect(verify).not.toHaveBeenCalled();
});

it('rejects native Anthropic transport instead of advertising or sending unverified NEAR AI chat', async () => {
  const appConfig = config(
    'default-key',
    true,
    'https://cloud-stg-api.near.ai/v1',
    EModelEndpoint.anthropic,
  );
  const { app, service, verify } = setup(appConfig);
  expect(getNearAIVerificationConfig(appConfig).nearaiEndpoints).toEqual([]);
  expect((await request(app).get('/attestation?endpoint=Private&model=model')).body).toEqual({
    enabled: false,
  });
  expect(verify).not.toHaveBeenCalled();
  await expect(
    initializeCustom({
      endpoint: 'Private',
      model_parameters: { model: 'model' },
      runtime: { appConfig, requestBody: {} },
      db: { getUserKey: async () => '', getUserKeyValues: async () => ({}) },
      nearai: service,
    }),
  ).rejects.toThrow('OpenAI-compatible');
});

it.each(['default-key', 'user_provided'])(
  'wires verified inference into the existing custom client with %s',
  async (key) => {
    const service = createNearAIService(nearAISDK);
    const createFetch = jest.spyOn(service, 'createFetch');
    const options = await initializeCustom({
      endpoint: 'Private',
      model_parameters: { model: 'openai/gpt-4.1-mini' },
      runtime: { appConfig: config(key), requestBody: {} },
      db: {
        getUserKey: async () => 'saved-key',
        getUserKeyValues: async () => ({ apiKey: 'saved-key' }),
      },
      nearai: service,
    });
    expect(createFetch).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: key === 'user_provided' ? 'saved-key' : key }),
    );
    expect(options.configOptions?.fetch).toBe(createFetch.mock.results[0].value);
    expect(options.llmConfig).not.toHaveProperty('user');
  },
);
