import { EModelEndpoint, getResponseSender, encodeEphemeralAgentId } from 'librechat-data-provider';
import type { TEndpointOption } from 'librechat-data-provider';
import { resolveSender } from './sender';

/** Custom endpoints carry their configured name (e.g. "Together AI") in
 *  `endpoint` at runtime, which `TEndpointOption` types as `EModelEndpoint`. */
const customOption = (
  model: string,
  labels: Partial<Pick<TEndpointOption, 'modelLabel' | 'modelDisplayLabel'>> = {},
): Partial<TEndpointOption> => ({
  endpoint: 'Together AI' as EModelEndpoint,
  endpointType: EModelEndpoint.custom,
  model,
  ...labels,
});

const ephemeralAgent = (model: string, sender?: string) => ({
  id: encodeEphemeralAgentId({ endpoint: 'Together AI', model, sender }),
});

describe('resolveSender', () => {
  test('prefers a real agent name over everything else', () => {
    expect(
      resolveSender({
        agent: { id: 'agent_abc123', name: 'My Agent' },
        endpointOption: { endpoint: EModelEndpoint.anthropic },
      }),
    ).toBe('My Agent');
  });

  test('returns an empty-string name as-is, preserving legacy `??` semantics', () => {
    expect(
      resolveSender({
        agent: { id: 'agent_abc123', name: '' },
        endpointOption: { endpoint: EModelEndpoint.anthropic },
      }),
    ).toBe('');
  });

  test('skips the label chain for a nameless real agent', () => {
    expect(
      resolveSender({
        agent: { id: 'agent_abc123', name: null },
        specLabel: 'Spec Label',
        endpointOption: { endpoint: EModelEndpoint.agents, modelLabel: 'A Label' },
      }),
    ).toBe('');
  });

  test('resolves the modelLabel for an ephemeral agent', () => {
    expect(
      resolveSender({
        agent: ephemeralAgent('Qwen/Qwen2.5-72B-Instruct', 'My Qwen'),
        endpointOption: customOption('Qwen/Qwen2.5-72B-Instruct', { modelLabel: 'My Qwen' }),
      }),
    ).toBe('My Qwen');
  });

  test('persists delimiter-heavy labels verbatim instead of decoding the lossy id', () => {
    for (const modelLabel of ['A___B', 'My__Bot', 'v2____3']) {
      expect(
        resolveSender({
          agent: ephemeralAgent('Qwen/Qwen2.5-72B-Instruct', modelLabel),
          endpointOption: customOption('Qwen/Qwen2.5-72B-Instruct', { modelLabel }),
        }),
      ).toBe(modelLabel);
    }
  });

  test('falls back to the spec label, then the endpoint display label', () => {
    expect(
      resolveSender({
        agent: ephemeralAgent('Qwen/Qwen2.5-72B-Instruct', 'Spec Label'),
        specLabel: 'Spec Label',
        endpointOption: customOption('Qwen/Qwen2.5-72B-Instruct', {
          modelDisplayLabel: 'Together',
        }),
      }),
    ).toBe('Spec Label');
    expect(
      resolveSender({
        agent: ephemeralAgent('mistralai/Mixtral-8x7B-Instruct-v0.1', 'Together'),
        endpointOption: customOption('mistralai/Mixtral-8x7B-Instruct-v0.1', {
          modelDisplayLabel: 'Together',
        }),
      }),
    ).toBe('Together');
  });

  test('keeps the family heuristic for a label-less custom endpoint', () => {
    expect(
      resolveSender({
        agent: ephemeralAgent('mistralai/Mixtral-8x7B-Instruct-v0.1'),
        endpointOption: customOption('mistralai/Mixtral-8x7B-Instruct-v0.1'),
      }),
    ).toBe('Mistral');
  });

  test('keeps the model-derived name for a label-less anthropic agent', () => {
    expect(
      resolveSender({
        agent: {
          id: encodeEphemeralAgentId({
            endpoint: EModelEndpoint.anthropic,
            model: 'claude-sonnet-5',
          }),
        },
        endpointOption: { endpoint: EModelEndpoint.anthropic, model: 'claude-sonnet-5' },
      }),
    ).toBe('Claude');
  });

  test('matches getResponseSender exactly for an unknown label-less custom model', () => {
    const endpointOption = customOption('some-unknown-model');
    expect(resolveSender({ agent: ephemeralAgent('some-unknown-model'), endpointOption })).toBe(
      getResponseSender(endpointOption),
    );
  });
});
