import { classificationSchema } from 'librechat-data-provider';
import type { TClassificationConfig, TClassificationProviderConfig } from 'librechat-data-provider';
import type { ProviderFetch } from './providers/transport';
import { PRESETS, presetFor, mergeSettings } from './registry';
import { resolveClassifier } from './resolve';
import { boolean } from './questions';

type Captured = { url: string; body: Record<string, unknown> };

function recorder(response: unknown) {
  const calls: Captured[] = [];
  const fetch: ProviderFetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(response),
    };
  };
  return { calls, fetch };
}

function configFor(
  provider: string,
  settings?: TClassificationProviderConfig,
): TClassificationConfig {
  return classificationSchema.parse({
    enabled: true,
    provider,
    providers: settings == null ? {} : { [provider]: settings },
  });
}

const NOUL = { model: 'jev-1.13.0', answers: { d: { type: 'noul', noul: 0.8 } }, usage: {} };

describe('presets', () => {
  it('ships every known host as settings, not as code', () => {
    expect(Object.keys(PRESETS).sort()).toEqual(['cloudflare', 'http', 'openrouter', 'typesafe']);
  });

  it('lets an operator override any field of a preset', () => {
    const merged = mergeSettings(presetFor('typesafe'), { model: 'jev-1.13', timeoutMs: 9000 });

    expect(merged.model).toBe('jev-1.13');
    expect(merged.timeoutMs).toBe(9000);
    expect(merged.baseURL).toBe('https://api.typesafe.ai/v1/systemone');
  });

  it('sends the System One vocabulary for the typesafe preset', async () => {
    const { calls, fetch } = recorder(NOUL);
    const classifier = resolveClassifier({ config: configFor('typesafe'), apiKey: 'k', fetch });

    const result = await classifier!.classify({ state: {}, questions: { d: boolean('durable?') } });

    expect(calls[0].url).toBe('https://api.typesafe.ai/v1/systemone');
    expect((calls[0].body.questions as Record<string, { type: string }>).d.type).toBe('noul');
    expect(result.answers.d).toEqual({ type: 'boolean', probability: 0.8 });
  });

  it('nests the body and unwraps the envelope for the cloudflare preset', async () => {
    const { calls, fetch } = recorder({ result: NOUL, success: true });
    const config = configFor('cloudflare', {
      baseURL: 'https://api.cloudflare.com/client/v4/accounts/abc/ai/run',
    });

    const classifier = resolveClassifier({ config, apiKey: 'k', fetch });
    const result = await classifier!.classify({ state: {}, questions: { d: boolean('durable?') } });

    expect(calls[0].body).toHaveProperty('input.questions.d.type', 'noul');
    expect(calls[0].body.model).toBe('typesafe/jev');
    expect(result.answers.d).toEqual({ type: 'boolean', probability: 0.8 });
  });

  it('still reads a bare body when the host does not wrap it', async () => {
    const { fetch } = recorder(NOUL);
    const config = configFor('cloudflare', {
      baseURL: 'https://api.cloudflare.com/client/v4/accounts/abc/ai/run',
    });

    const classifier = resolveClassifier({ config, apiKey: 'k', fetch });
    const result = await classifier!.classify({ state: {}, questions: { d: boolean('durable?') } });

    expect(result.answers.d).toEqual({ type: 'boolean', probability: 0.8 });
  });

  it('sends a flat body for the openrouter preset', async () => {
    const { calls, fetch } = recorder(NOUL);
    const classifier = resolveClassifier({ config: configFor('openrouter'), apiKey: 'k', fetch });

    await classifier!.classify({ state: {}, questions: { d: boolean('durable?') } });

    expect(calls[0].url).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(calls[0].body).not.toHaveProperty('input');
    expect(calls[0].body.model).toBe('~typesafe/jev-latest');
  });

  it('builds a host it has never heard of from config alone', async () => {
    const { calls, fetch } = recorder({ data: NOUL });
    const config = configFor('somethingnew', {
      baseURL: 'https://classify.internal/v1/run',
      model: 'house-classifier',
      dialect: 'systemone',
      requestKey: 'payload',
      responseKey: 'data',
    });

    const classifier = resolveClassifier({ config, apiKey: 'k', fetch });
    const result = await classifier!.classify({ state: {}, questions: { d: boolean('durable?') } });

    expect(calls[0].url).toBe('https://classify.internal/v1/run');
    expect(calls[0].body).toHaveProperty('payload.questions.d.type', 'noul');
    expect(result.answers.d).toEqual({ type: 'boolean', probability: 0.8 });
  });

  it('stays off for an unknown name with no baseURL to go on', () => {
    expect(resolveClassifier({ config: configFor('mystery'), apiKey: 'k' })).toBeNull();
  });

  it('stays off when a preset needs a baseURL the operator did not give', () => {
    expect(resolveClassifier({ config: configFor('cloudflare'), apiKey: 'k' })).toBeNull();
  });
});
