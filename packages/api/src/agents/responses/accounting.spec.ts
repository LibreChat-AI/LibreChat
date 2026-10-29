import type { UsageMetadata } from '~/stream/interfaces/IJobStore';
import type { AccountingQuote } from './accounting';
import type { PricingFns } from '../transactions';
import {
  buildCollectedResponseAccounting,
  buildPersistedResponseAccounting,
  createApplicationBillingQuote,
  createResponseAccountingCollector,
} from './accounting';

const usage: UsageMetadata = {
  input_tokens: 100,
  output_tokens: 20,
  total_tokens: 120,
  provider: 'openAI',
  model: 'gpt-4o',
};

describe('Responses accounting', () => {
  it('does not add metadata when no collected usage exists', () => {
    expect(buildPersistedResponseAccounting({ emittedUsage: [] })).toEqual({});
    expect(buildPersistedResponseAccounting({ collectedUsage: [], emittedUsage: [] })).toEqual({});
  });

  it('only quotes persisted accounting when application billing is explicitly enabled', () => {
    const getValueKey = jest.fn(() => 'gpt-4o');
    const billing = {
      getValueKey,
      pricing: {
        getMultiplier: () => 1,
        getCacheMultiplier: () => 1,
      },
    };
    const disabled = buildPersistedResponseAccounting({
      collectedUsage: [usage],
      emittedUsage: [],
      billing,
    });
    expect(disabled.accounting).toMatchObject({ status: 'unavailable' });
    expect(disabled.accounting).not.toHaveProperty('amount');
    expect(getValueKey).not.toHaveBeenCalled();

    const enabled = buildPersistedResponseAccounting({
      collectedUsage: [usage],
      emittedUsage: [],
      billing,
      billingEnabled: true,
    });
    expect(getValueKey).toHaveBeenCalledWith('gpt-4o');
    expect(enabled.accounting).toMatchObject({ status: 'available', basis: 'application_billing' });
  });

  it('does not claim zero dollars when no model usage was reported', () => {
    expect(createResponseAccountingCollector().snapshot()).toEqual({
      status: 'unavailable',
      currency: 'USD',
      coverage: 'none',
      reason: 'usage_unavailable',
      calls: [],
    });
  });

  it('retains actual models and marks configured fallbacks honestly', () => {
    const collector = createResponseAccountingCollector();
    collector.record(
      usage,
      { ls_model_name: 'actual-model' },
      {
        clientOptions: { model: 'configured-model' },
      },
    );
    collector.record({ input_tokens: 1, output_tokens: 2 }, undefined, {
      provider: 'anthropic',
      clientOptions: { model: 'configured-model' },
    });
    expect(collector.snapshot().calls).toEqual([
      expect.objectContaining({ model: 'actual-model', modelSource: 'runtime_reported' }),
      expect.objectContaining({ model: 'configured-model', modelSource: 'configured' }),
    ]);
    expect(collector.snapshot()).not.toHaveProperty('amount');
  });

  it('adds decimal quotes exactly and reports their billing basis', () => {
    const collector = createResponseAccountingCollector({
      quote: (entry) => ({
        amount: entry.output_tokens === 20 ? '0.1' : '0.2',
        basis: 'application_billing',
      }),
    });
    collector.record(usage);
    collector.record({ ...usage, output_tokens: 21 });
    expect(collector.snapshot()).toMatchObject({
      status: 'available',
      coverage: 'complete',
      amount: '0.3',
      basis: 'application_billing',
    });
  });

  it('quotes handoffs using their own agent configuration rather than the primary model', () => {
    const quote = jest.fn((): AccountingQuote => ({ amount: '0', basis: 'application_billing' }));
    const collector = createResponseAccountingCollector({ quote });
    collector.record(usage, { __invoked_model: 'handoff-model' }, { agentId: 'handoff-agent' });
    expect(quote).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'handoff-model',
        agentId: 'handoff-agent',
      }),
    );
    expect(collector.snapshot()).toMatchObject({ status: 'available', amount: '0' });
  });

  it('dedupes stable model response IDs but not distinct identical calls', () => {
    const collector = createResponseAccountingCollector({
      quote: () => ({ amount: '0.01', basis: 'provider_reported' }),
    });
    collector.record(usage, undefined, undefined, 'model-call-1');
    collector.record(usage, undefined, undefined, 'model-call-1');
    collector.record(usage, undefined, undefined, 'model-call-2');
    expect(collector.snapshot().calls).toHaveLength(2);
    expect(collector.snapshot().amount).toBe('0.02');
  });

  it('fails closed on conflicting repeated model responses', () => {
    const collector = createResponseAccountingCollector({
      quote: () => ({ amount: '1', basis: 'provider_reported' }),
    });
    collector.record(usage, undefined, undefined, 'same');
    collector.record({ ...usage, output_tokens: 40 }, undefined, undefined, 'same');
    expect(collector.snapshot()).toMatchObject({
      status: 'unavailable',
      reason: 'conflicting_usage',
    });
    expect(collector.snapshot()).not.toHaveProperty('amount');
  });

  it('does not publish partial or mixed-basis quotes as a run total', () => {
    const quote = jest
      .fn<AccountingQuote | undefined, [UsageMetadata]>()
      .mockReturnValueOnce({ amount: '0.2', basis: 'provider_reported' })
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({ amount: '0.3', basis: 'application_billing' });
    const collector = createResponseAccountingCollector({ quote });
    collector.record(usage);
    collector.record({ ...usage, usage_type: 'subagent' });
    expect(collector.snapshot()).toMatchObject({ coverage: 'partial', reason: 'partial_coverage' });
    expect(collector.snapshot()).not.toHaveProperty('amount');
    collector.record(usage);
    expect(collector.snapshot().reason).toBe('mixed_bases');
    expect(collector.snapshot()).not.toHaveProperty('amount');
  });

  it('keeps subagent and summarization cache accounting provider-aware', () => {
    const collector = createResponseAccountingCollector();
    collector.record({ ...usage, usage_type: 'subagent', input_token_details: { cache_read: 30 } });
    collector.record({
      ...usage,
      provider: 'bedrock',
      usage_type: 'summarization',
      total_tokens: 155,
      input_token_details: { cache_read: 30, cache_creation: 5 },
    });
    expect(collector.snapshot().calls).toEqual([
      expect.objectContaining({ usageType: 'subagent', inputTokens: 100, cacheReadTokens: 30 }),
      expect.objectContaining({
        usageType: 'summarization',
        inputTokens: 135,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheWriteTokens: 5,
      }),
    ]);
  });

  it('treats missing/invalid usage and failed pricing as unavailable, not free', () => {
    const quote = jest.fn(() => {
      throw new Error('pricing unavailable');
    });
    const collector = createResponseAccountingCollector({ quote });
    collector.record(undefined);
    collector.record({ ...usage, input_tokens: -1 });
    collector.record(usage);
    expect(quote).toHaveBeenCalledTimes(1);
    expect(collector.snapshot().calls.map((call) => call.reason)).toEqual([
      'usage_unavailable',
      'invalid_usage',
      'pricing_unavailable',
    ]);
    expect(collector.snapshot()).not.toHaveProperty('amount');
  });

  it.each(['-1', 'NaN', 'Infinity', '1e-4', '0.1234567890123456789'])(
    'rejects invalid USD quote %s',
    (amount) => {
      const collector = createResponseAccountingCollector({
        quote: () => ({ amount, basis: 'provider_reported' }),
      });
      collector.record(usage);
      expect(collector.snapshot().status).toBe('unavailable');
    },
  );

  it('returns defensive snapshots', () => {
    const collector = createResponseAccountingCollector();
    collector.record(usage);
    collector.snapshot().calls[0].model = 'tampered';
    expect(collector.snapshot().calls[0].model).toBe('gpt-4o');
  });

  it('persists real parent/child provenance and includes auxiliary calls without guessing their endpoint price', () => {
    const result = buildCollectedResponseAccounting(
      [usage, { ...usage, model: 'child-model', usage_type: 'subagent' }],
      [
        {
          input_tokens: 2,
          output_tokens: 1,
          provider: 'openAI',
          model: 'label-model',
          usage_type: 'activity-label',
          runId: 'label',
          seq: -1,
        },
      ],
      { quote: () => ({ amount: '0.1', basis: 'application_billing' }) },
    );
    expect(result.coverage).toBe('partial');
    expect(result).not.toHaveProperty('amount');
    expect(result.calls.map((call) => [call.model, call.usageType, call.modelSource])).toEqual([
      ['gpt-4o', 'message', 'runtime_reported'],
      ['child-model', 'subagent', 'runtime_reported'],
      ['label-model', 'activity-label', 'runtime_reported'],
    ]);
  });
});

describe('application-billing quotes', () => {
  const pricing: PricingFns = {
    getMultiplier: ({ tokenType }) => (tokenType === 'prompt' ? 2 : 4),
    getCacheMultiplier: ({ cacheType }) => {
      if (cacheType === 'write1h') return 5;
      return cacheType === 'write' ? 3 : 1;
    },
  };

  it('uses the existing billing computation and identifies its basis', () => {
    const quote = createApplicationBillingQuote({ pricing, getValueKey: () => 'gpt-4o' });
    expect(quote(usage)).toEqual({ amount: '0.000280000000', basis: 'application_billing' });
    expect(
      quote({ ...usage, input_token_details: { cache_read: 20, cache_creation: 10 } }),
    ).toEqual({ amount: '0.000270000000', basis: 'application_billing' });
  });

  it('does not mistake the unknown-model default multiplier for a real price', () => {
    const quote = createApplicationBillingQuote({ pricing, getValueKey: () => undefined });
    expect(quote({ ...usage, model: 'unknown-model' })).toBeUndefined();
    expect(quote({ ...usage, model: undefined })).toBeUndefined();
  });

  it('preserves the distinct one-hour cache-write rate from model-end usage', () => {
    const quote = createApplicationBillingQuote({ pricing, getValueKey: () => 'gpt-4o' });
    expect(
      quote({
        ...usage,
        input_token_details: { cache_read: 20, cache_creation: 10, cache_creation_1h: 5 },
      }),
    ).toEqual({ amount: '0.000280000000', basis: 'application_billing' });
  });

  it('supports explicit endpoint prices for nonstandard models', () => {
    const quote = createApplicationBillingQuote({
      pricing,
      getValueKey: () => undefined,
      resolveEndpointTokenConfig: () => ({ custom: { prompt: 2, completion: 4, context: 1000 } }),
    });
    expect(quote({ ...usage, model: 'custom' })?.basis).toBe('application_billing');
  });
});
