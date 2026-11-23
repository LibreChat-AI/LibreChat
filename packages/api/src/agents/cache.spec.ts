import { Providers, initializeModel } from '@librechat/agents';
import { AIMessage } from '@librechat/agents/langchain/messages';
import type { UsageMetadata } from '~/stream/interfaces/IJobStore';
import type { OpenAIConfiguration } from '~/types';
import { getModelEndUsage, recordCollectedUsage, computeUsageCostUSD } from './usage';
import { createTxMethods } from '../../../data-schemas/src/methods/tx';
import { matchModelName, findMatchingPattern } from '~/utils/tokens';

const model = 'gpt-6-cyber';
const pricing = createTxMethods({} as typeof import('mongoose'), {
  matchModelName: (name) => matchModelName(name),
  findMatchingPattern: (name, values) => findMatchingPattern(name, values) ?? undefined,
});

async function getSDKUsage(
  streaming: boolean,
  input: number,
  write: number,
  twelveHour: number,
  read = 0,
) {
  const response = {
    id: 'resp_cache',
    object: 'response',
    status: 'completed',
    model,
    output: [],
    usage: {
      input_tokens: input,
      output_tokens: 0,
      total_tokens: input,
      input_tokens_details: {
        cached_tokens: read,
        cache_write_tokens: write,
        cache_write_tokens_details: {
          ttl_30m_tokens: write - twelveHour,
          ttl_12h_tokens: twelveHour,
        },
      },
    },
  };
  const fetch: NonNullable<NonNullable<OpenAIConfiguration>['fetch']> = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    expect(body.prompt_cache_options.ttl).toBe('12h');
    expect(body.stream).toBe(streaming);
    if (!streaming) return Response.json(response);
    return new Response(
      [
        { type: 'response.created', response: { ...response, status: 'in_progress' } },
        { type: 'response.completed', response },
      ]
        .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        .join(''),
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  };
  const llm = initializeModel({
    provider: Providers.OPENAI,
    clientOptions: {
      model,
      apiKey: 'test-key',
      streaming,
      useResponsesApi: true,
      modelKwargs: { prompt_cache_options: { ttl: '12h' } },
      configuration: { fetch },
    },
  });
  const collected: UsageMetadata[] = [];
  const output = await llm.invoke('Verify the patch.', {
    callbacks: [
      {
        handleLLMEnd(result) {
          for (const generations of result.generations) {
            for (const generation of generations) {
              if ('message' in generation && generation.message instanceof AIMessage) {
                const usage = getModelEndUsage(
                  generation.message as Parameters<typeof getModelEndUsage>[0],
                );
                if (usage) collected.push(usage);
              }
            }
          }
        },
      },
    ],
  });
  expect(collected).toHaveLength(1);
  const usage = collected[0];
  expect(usage).toEqual(getModelEndUsage(output));
  expect(usage?.input_token_details?.cache_creation).toBe(write);
  expect(output.usage_metadata?.input_token_details).toMatchObject({
    cache_creation: write,
    cache_creation_12h: twelveHour,
  });
  expect(usage.input_token_details?.cache_creation_12h).toBe(twelveHour);
  return { ...usage, model, provider: Providers.OPENAI };
}

describe.each([false, true])('SDK cache accounting (streaming=%s)', (streaming) => {
  it.each([
    { input: 10000, write: 10000, twelveHour: 10000, read: 0, debit: 500000 },
    { input: 12000, write: 7000, twelveHour: 4000, read: 4000, debit: 303000 },
    { input: 272000, write: 7000, twelveHour: 4000, read: 4000, debit: 5503000 },
    { input: 272001, write: 7000, twelveHour: 4000, read: 4000, debit: 10736040 },
    { input: 10000, write: 10000, twelveHour: 0, read: 0, debit: 250000 },
  ])(
    'bills SDK-reported 12-hour writes once: %j',
    async ({ input, write, twelveHour, read, debit }) => {
      const usage = await getSDKUsage(streaming, input, write, twelveHour, read);
      const spendStructuredTokens = jest.fn().mockResolvedValue(undefined);
      const insertMany = jest.fn().mockResolvedValue(undefined);
      const updateBalance = jest.fn().mockResolvedValue(undefined);
      const deps = { spendTokens: jest.fn(), spendStructuredTokens };
      const params = {
        user: 'cache-user',
        conversationId: 'cache-conversation',
        model,
        balance: { enabled: true },
        collectedUsage: [usage],
      };

      await recordCollectedUsage(deps, params);
      expect(spendStructuredTokens).toHaveBeenCalledWith(expect.objectContaining({ model }), {
        promptTokens: {
          input: input - write - read,
          write,
          read,
          ...(twelveHour > 0 && { write12h: twelveHour }),
        },
        completionTokens: 0,
      });
      await recordCollectedUsage(
        { ...deps, pricing, bulkWriteOps: { insertMany, updateBalance } },
        params,
      );
      expect(insertMany).toHaveBeenCalledTimes(1);
      expect(insertMany).toHaveBeenCalledWith([
        expect.objectContaining({ rawAmount: -input, writeTokens: -write, tokenValue: -debit }),
      ]);
      expect(updateBalance).toHaveBeenCalledTimes(1);
      expect(updateBalance).toHaveBeenCalledWith(
        expect.objectContaining({ user: 'cache-user', incrementValue: -debit }),
      );
      expect(computeUsageCostUSD(usage, pricing)).toBe(debit / 1e6);
      if (input > 272000) {
        expect(
          pricing.getCacheMultiplier({ model, cacheType: 'write12h', inputTokenCount: input }),
        ).toBeNull();
        expect(insertMany.mock.calls[0][0][0].rateDetail.write12h).toBe(40);
      }
    },
  );
});

it.each([-1, 0, 20000])('bounds the 12-hour subset to aggregate writes: %i', (twelveHour) => {
  const usage = getModelEndUsage({
    usage_metadata: { input_tokens: 10000, input_token_details: { cache_creation: 10000 } },
    response_metadata: {
      usage: {
        input_tokens_details: { cache_write_tokens_details: { ttl_12h_tokens: twelveHour } },
      },
    },
  });
  expect(computeUsageCostUSD({ ...usage, model, provider: Providers.OPENAI }, pricing)).toBe(
    twelveHour > 0 ? 0.5 : 0.25,
  );
});

it('keeps Anthropic 5-minute and 1-hour writes as disjoint shares of aggregate writes', () => {
  const usage = getModelEndUsage({
    usage_metadata: { input_tokens: 3000, input_token_details: { cache_creation: 3000 } },
    response_metadata: {
      usage: {
        cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 },
      },
    },
  });
  expect(
    computeUsageCostUSD(
      { ...usage, model: 'claude-sonnet-4-5', provider: Providers.ANTHROPIC },
      pricing,
    ),
  ).toBeCloseTo((1000 * 3.75 + 2000 * 6) / 1e6);
});

it('preserves legacy OpenAI usage without a cache-write TTL breakdown', () => {
  const usage_metadata: UsageMetadata = {
    input_tokens: 1000,
    provider: Providers.OPENAI,
    model: 'gpt-4o',
  };
  expect(getModelEndUsage({ usage_metadata })).toBe(usage_metadata);
  expect(computeUsageCostUSD(usage_metadata, pricing)).toBe(0.0025);
});

it('preserves SDK-normalized twelve-hour usage without raw response metadata', () => {
  const usage_metadata: UsageMetadata = {
    input_tokens: 10000,
    input_token_details: { cache_creation: 10000, cache_creation_12h: 10000 },
    model,
    provider: Providers.OPENAI,
  };
  expect(getModelEndUsage({ usage_metadata })).toBe(usage_metadata);
  expect(computeUsageCostUSD(usage_metadata, pricing)).toBe(0.5);
});
