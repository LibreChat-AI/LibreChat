import { EModelEndpoint } from 'librechat-data-provider';
import type { TCustomConfig } from 'librechat-data-provider';
import { processModelSpecs } from './specs';

const specsConfig = (list: unknown[]): TCustomConfig['modelSpecs'] =>
  ({ enforce: false, prioritize: true, list }) as TCustomConfig['modelSpecs'];

describe('processModelSpecs', () => {
  it('returns undefined without model specs', () => {
    expect(processModelSpecs(undefined, undefined, undefined)).toBeUndefined();
  });

  it('keeps specs targeting system endpoints', () => {
    const result = processModelSpecs(
      undefined,
      specsConfig([
        { name: 'openai-spec', label: 'OpenAI', preset: { endpoint: EModelEndpoint.openAI } },
      ]),
      undefined,
    );

    expect(result?.list).toHaveLength(1);
  });

  /**
   * The missing-endpoint guard runs after materialization, so an agent spec
   * that omits its endpoint is inferred rather than skipped.
   */
  it('materializes the agents endpoint for agent specs before the missing-endpoint guard', () => {
    const result = processModelSpecs(
      undefined,
      specsConfig([{ name: 'agent-spec', label: 'Agent Spec', preset: { agent_id: 'agent_abc' } }]),
      undefined,
    );

    expect(result?.list).toHaveLength(1);
    expect(result?.list?.[0]?.preset?.endpoint).toBe(EModelEndpoint.agents);
    expect(result?.list?.[0]?.preset?.agent_id).toBe('agent_abc');
  });

  it('still skips endpoint-less specs that name no agent', () => {
    const result = processModelSpecs(
      undefined,
      specsConfig([
        { name: 'dead-spec', label: 'Dead Spec', preset: { model: 'gpt-4o' } },
        { name: 'live-spec', label: 'Live Spec', preset: { endpoint: EModelEndpoint.openAI } },
      ]),
      undefined,
    );

    expect(result?.list?.map((spec) => spec?.name)).toEqual(['live-spec']);
  });

  /** Prior behavior for previously valid configs: a null endpoint means skip, even with an agent. */
  it('still skips specs with an explicit null endpoint, even when they name an agent', () => {
    const result = processModelSpecs(
      undefined,
      specsConfig([
        {
          name: 'null-agent-spec',
          label: 'Null Agent Spec',
          preset: { endpoint: null, agent_id: 'agent_abc' },
        },
      ]),
      undefined,
    );

    expect(result?.list).toHaveLength(0);
  });

  it('keeps an explicit endpoint over the inferred one', () => {
    const result = processModelSpecs(
      undefined,
      specsConfig([
        {
          name: 'explicit-spec',
          label: 'Explicit Spec',
          preset: { endpoint: EModelEndpoint.openAI, agent_id: 'agent_abc' },
        },
      ]),
      undefined,
    );

    expect(result?.list?.[0]?.preset?.endpoint).toBe(EModelEndpoint.openAI);
  });
});
