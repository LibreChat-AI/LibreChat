import { classificationSchema } from 'librechat-data-provider';
import type { TClassificationConfig } from 'librechat-data-provider';
import type { ProviderFetch } from './providers/transport';
import { resolveClassifier } from './resolve';
import { boolean } from './questions';

/**
 * Covers the path an operator's `librechat.yaml` actually travels: the zod
 * schema, then the resolver, then the bytes on the wire. A field that parses
 * but never reaches the request is the failure this file exists to catch.
 */

const ANSWER = { model: 'jev-1.13.0', answers: { d: { type: 'noul', noul: 0.8 } }, usage: {} };

function recorder(response: unknown = ANSWER) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
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

function parse(raw: unknown): TClassificationConfig {
  return classificationSchema.parse(raw);
}

describe('classification config', () => {
  it('parses an unset block into every capability off', () => {
    const config = parse({});

    expect(config.enabled).toBe(false);
    expect(config.provider).toBe('http');
    expect(config.providers).toEqual({});
  });

  it('keeps the wire-shape fields through parsing', () => {
    const config = parse({
      enabled: true,
      provider: 'cloudflare',
      providers: {
        cloudflare: {
          baseURL: 'https://api.cloudflare.com/client/v4/accounts/abc/ai/run',
          model: 'typesafe/jev',
          dialect: 'systemone',
          requestKey: 'input',
          responseKey: 'result',
          apiKeyEnv: 'CLOUDFLARE_API_TOKEN',
          timeoutMs: 9000,
          maxRetries: 1,
        },
      },
    });

    expect(config.providers.cloudflare).toEqual({
      baseURL: 'https://api.cloudflare.com/client/v4/accounts/abc/ai/run',
      model: 'typesafe/jev',
      dialect: 'systemone',
      requestKey: 'input',
      responseKey: 'result',
      apiKeyEnv: 'CLOUDFLARE_API_TOKEN',
      timeoutMs: 9000,
      maxRetries: 1,
    });
  });

  it('rejects a dialect it does not implement', () => {
    const result = classificationSchema.safeParse({
      enabled: true,
      provider: 'x',
      providers: { x: { baseURL: 'https://x.test/run', dialect: 'logprobs' } },
    });

    expect(result.success).toBe(false);
  });

  it('rejects a misspelled key instead of dropping it', () => {
    const result = classificationSchema.safeParse({
      enabled: true,
      provider: 'x',
      providers: { x: { baseURL: 'https://x.test/run', requestkey: 'input' } },
    });

    expect(result.success).toBe(false);
  });

  it('rejects a baseURL that is not a URL', () => {
    const result = classificationSchema.safeParse({
      enabled: true,
      provider: 'x',
      providers: { x: { baseURL: 'classify.internal' } },
    });

    expect(result.success).toBe(false);
  });

  it('carries a parsed config all the way onto the wire', async () => {
    const config = parse({
      enabled: true,
      provider: 'cloudflare',
      providers: {
        cloudflare: { baseURL: 'https://api.cloudflare.com/client/v4/accounts/abc/ai/run' },
      },
    });
    const { calls, fetch } = recorder({ result: ANSWER });

    const classifier = resolveClassifier({ config, apiKey: 'k', fetch });
    const result = await classifier!.classify({ state: {}, questions: { d: boolean('durable?') } });

    expect(calls[0].url).toBe('https://api.cloudflare.com/client/v4/accounts/abc/ai/run');
    expect(calls[0].body).toHaveProperty('input.questions.d.type', 'noul');
    expect(result.answers.d).toEqual({ type: 'boolean', probability: 0.8 });
  });

  it('lets a parsed override beat the preset it sits on', async () => {
    const config = parse({
      enabled: true,
      provider: 'typesafe',
      providers: { typesafe: { baseURL: 'https://proxy.internal/systemone', model: 'jev-1.13' } },
    });
    const { calls, fetch } = recorder();

    const classifier = resolveClassifier({ config, apiKey: 'k', fetch });
    await classifier!.classify({ state: {}, questions: { d: boolean('durable?') } });

    expect(calls[0].url).toBe('https://proxy.internal/systemone');
    expect(calls[0].body.model).toBe('jev-1.13');
    expect((calls[0].body.questions as Record<string, { type: string }>).d.type).toBe('noul');
  });
});
