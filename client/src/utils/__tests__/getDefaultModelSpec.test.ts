import { Constants, EModelEndpoint, LocalStorageKeys } from 'librechat-data-provider';
import type {
  TModelSpec,
  TStartupConfig,
  TEndpointsConfig,
  TAgentsMap,
} from 'librechat-data-provider';
import { getDefaultModelSpec, defaultSpecAwaitsAgents } from '../endpoints';

const createModelSpec = (name: string, overrides: Partial<TModelSpec> = {}): TModelSpec =>
  ({
    name,
    label: name,
    preset: {
      endpoint: EModelEndpoint.openAI,
      model: name,
    },
    ...overrides,
  }) as TModelSpec;

const createStartupConfig = (
  list: TModelSpec[],
  {
    prioritize = true,
    modelSelect = true,
    addedEndpoints,
  }: { prioritize?: boolean; modelSelect?: boolean; addedEndpoints?: string[] } = {},
): TStartupConfig =>
  ({
    interface: {
      modelSelect,
    },
    modelSpecs: {
      prioritize,
      list,
      ...(addedEndpoints ? { addedEndpoints } : {}),
    },
  }) as TStartupConfig;

const fullEndpointsConfig: TEndpointsConfig = {
  [EModelEndpoint.openAI]: { order: 0 },
  [EModelEndpoint.agents]: { order: 1 },
};

const agentsOnlyEndpointsConfig: TEndpointsConfig = {
  [EModelEndpoint.agents]: { order: 0 },
};

const writeLastModel = (endpoint: string, model: string) => {
  const stored = JSON.parse(localStorage.getItem(LocalStorageKeys.LAST_MODEL) ?? '{}') as Record<
    string,
    string
  >;
  stored[endpoint] = model;
  localStorage.setItem(LocalStorageKeys.LAST_MODEL, JSON.stringify(stored));
};

/** Mirrors what the conversation effect persists after a spec preset is applied */
const persistAppliedSpec = (spec: TModelSpec, conversationId: string = Constants.NEW_CONVO) => {
  localStorage.setItem(LocalStorageKeys.LAST_SPEC, spec.name);
  writeLastModel(spec.preset.endpoint as string, spec.preset.model as string);
  localStorage.setItem(
    `${LocalStorageKeys.LAST_CONVO_SETUP}_0`,
    JSON.stringify({
      conversationId,
      endpoint: spec.preset.endpoint,
      model: spec.preset.model,
      spec: spec.name,
    }),
  );
};

/** Mirrors what the conversation effect persists after the user selects an agent */
const persistAgentSelection = (agentId: string) => {
  localStorage.setItem(`${LocalStorageKeys.AGENT_ID_PREFIX}0`, agentId);
  localStorage.setItem(
    `${LocalStorageKeys.LAST_CONVO_SETUP}_0`,
    JSON.stringify({
      endpoint: EModelEndpoint.agents,
      agent_id: agentId,
      model: null,
      spec: null,
    }),
  );
};

/** Mirrors what the conversation effect persists after an ephemeral endpoint → model pick */
const persistEphemeralSelection = (endpoint: string, model: string) => {
  writeLastModel(endpoint, model);
  localStorage.setItem(
    `${LocalStorageKeys.LAST_CONVO_SETUP}_0`,
    JSON.stringify({ endpoint, model, spec: null }),
  );
};

describe('getDefaultModelSpec', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('uses the soft default for a fresh user with no prior selection', () => {
    const regularSpec = createModelSpec('regular-spec');
    const softSpec = createModelSpec('soft-spec', { softDefault: true });

    const result = getDefaultModelSpec(createStartupConfig([regularSpec, softSpec]));

    expect(result).toEqual({ softDefault: softSpec });
  });

  it('keeps the last selected spec before applying the soft default', () => {
    const lastSpec = createModelSpec('last-spec');
    const softSpec = createModelSpec('soft-spec', { softDefault: true });
    persistAppliedSpec(lastSpec);

    const result = getDefaultModelSpec(createStartupConfig([softSpec, lastSpec]));

    expect(result).toEqual({ last: lastSpec });
  });

  it('does not apply the soft default when a prior model selection exists', () => {
    const softSpec = createModelSpec('soft-spec', { softDefault: true });
    persistEphemeralSelection(EModelEndpoint.openAI, 'gpt-4o');

    const result = getDefaultModelSpec(createStartupConfig([softSpec]), fullEndpointsConfig);

    expect(result).toBeUndefined();
  });

  it('does not apply the soft default when a prior agent selection exists', () => {
    const softSpec = createModelSpec('soft-spec', { softDefault: true });
    persistAgentSelection('agent_123');

    const result = getDefaultModelSpec(createStartupConfig([softSpec]), fullEndpointsConfig);

    expect(result).toBeUndefined();
  });

  it('keeps hard admin defaults ahead of user history and soft defaults', () => {
    const hardSpec = createModelSpec('hard-spec', { default: true });
    const softSpec = createModelSpec('soft-spec', { softDefault: true });
    persistAppliedSpec(softSpec);

    const result = getDefaultModelSpec(createStartupConfig([softSpec, hardSpec]));

    expect(result).toEqual({ default: hardSpec });
  });

  it('preserves the legacy first-spec fallback when no soft default is configured', () => {
    const firstSpec = createModelSpec('first-spec');
    const secondSpec = createModelSpec('second-spec');

    const result = getDefaultModelSpec(createStartupConfig([firstSpec, secondSpec]));

    expect(result).toEqual({ default: firstSpec });
  });

  describe('soft default auto-application residue', () => {
    const softSpec = createModelSpec('soft-spec', { softDefault: true });
    const otherSpec = createModelSpec('other-spec');

    it('stays soft after its own application is persisted (prioritized config)', () => {
      persistAppliedSpec(softSpec);

      const result = getDefaultModelSpec(
        createStartupConfig([otherSpec, softSpec]),
        fullEndpointsConfig,
      );

      expect(result).toEqual({ softDefault: softSpec });
    });

    it('stays soft after its own application is persisted (modelSelect config)', () => {
      persistAppliedSpec(softSpec);

      const result = getDefaultModelSpec(
        createStartupConfig([otherSpec, softSpec], { prioritize: false }),
        fullEndpointsConfig,
      );

      expect(result).toEqual({ softDefault: softSpec });
    });

    it('yields to an agent selected after the soft default was applied', () => {
      persistAppliedSpec(softSpec);
      persistAgentSelection('agent_abc');

      const result = getDefaultModelSpec(
        createStartupConfig([otherSpec, softSpec], { prioritize: false }),
        fullEndpointsConfig,
      );

      expect(result).toBeUndefined();
    });

    it('yields to an agent selection even with the prioritized config', () => {
      persistAppliedSpec(softSpec);
      persistAgentSelection('agent_abc');

      const result = getDefaultModelSpec(
        createStartupConfig([otherSpec, softSpec]),
        fullEndpointsConfig,
      );

      expect(result).toBeUndefined();
    });

    it('yields to an ephemeral endpoint → model pick after the soft default was applied', () => {
      persistAppliedSpec(softSpec);
      persistEphemeralSelection(EModelEndpoint.openAI, 'gpt-4o');

      const result = getDefaultModelSpec(
        createStartupConfig([otherSpec, softSpec], { prioritize: false }),
        fullEndpointsConfig,
      );

      expect(result).toBeUndefined();
    });

    it('yields to a different spec selected after the soft default was applied', () => {
      persistAppliedSpec(softSpec);
      persistAppliedSpec(otherSpec);

      const result = getDefaultModelSpec(
        createStartupConfig([otherSpec, softSpec], { prioritize: false }),
        fullEndpointsConfig,
      );

      expect(result).toEqual({ last: otherSpec });
    });

    it('treats a matching stored agent as residue when the soft default points to an agent', () => {
      const softAgentSpec = createModelSpec('soft-agent-spec', {
        softDefault: true,
        preset: { endpoint: EModelEndpoint.agents, agent_id: 'agent_soft' },
      } as Partial<TModelSpec>);
      persistAppliedSpec(softAgentSpec);

      const result = getDefaultModelSpec(
        createStartupConfig([softAgentSpec], { prioritize: false }),
        fullEndpointsConfig,
      );

      expect(result).toEqual({ softDefault: softAgentSpec });
    });

    it('treats a stored model matching the soft default preset as residue', () => {
      persistAppliedSpec(softSpec);

      const result = getDefaultModelSpec(
        createStartupConfig([otherSpec, softSpec], { prioritize: false }),
        fullEndpointsConfig,
      );

      expect(result).toEqual({ softDefault: softSpec });
    });

    it('stays soft after the first conversation is sent', () => {
      persistAppliedSpec(softSpec, 'a8b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d');

      const result = getDefaultModelSpec(
        createStartupConfig([otherSpec, softSpec], { prioritize: false }),
        fullEndpointsConfig,
      );

      expect(result).toEqual({ softDefault: softSpec });
    });

    it('re-arms after viewing the soft conversation, even when an ephemeral pick lingers', () => {
      persistEphemeralSelection(EModelEndpoint.anthropic, 'claude-sonnet-4-6');
      persistAppliedSpec(softSpec, 'a8b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d');

      const result = getDefaultModelSpec(
        createStartupConfig([otherSpec, softSpec], { prioritize: false }),
        fullEndpointsConfig,
      );

      expect(result).toEqual({ softDefault: softSpec });
    });

    it('re-arms after viewing the soft conversation, even when an agent pick lingers', () => {
      localStorage.setItem(`${LocalStorageKeys.AGENT_ID_PREFIX}0`, 'agent_abc');
      persistAppliedSpec(softSpec, 'a8b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d');

      const result = getDefaultModelSpec(
        createStartupConfig([otherSpec, softSpec], { prioritize: false }),
        fullEndpointsConfig,
      );

      expect(result).toEqual({ softDefault: softSpec });
    });

    it('yields when a different agent is stored than the soft default agent spec', () => {
      const softAgentSpec = createModelSpec('soft-agent-spec', {
        softDefault: true,
        preset: { endpoint: EModelEndpoint.agents, agent_id: 'agent_soft' },
      } as Partial<TModelSpec>);
      persistAgentSelection('agent_other');

      const result = getDefaultModelSpec(
        createStartupConfig([softAgentSpec], { prioritize: false }),
        fullEndpointsConfig,
      );

      expect(result).toBeUndefined();
    });
  });

  describe('soft default endpoint outside an added-endpoints allow-list', () => {
    // Mirrors a softDefault spec on `bedrock` with `addedEndpoints: [agents, <custom>]`.
    // The custom endpoint turns on the ephemeral-options gate, and a model used on
    // that endpoint lingers under a different key than the spec preset — which used
    // to suppress the soft default and strand New Chat on the unselectable bedrock.
    const softSpec = createModelSpec('clickhouse-agent', {
      softDefault: true,
      preset: { endpoint: 'bedrock', model: 'claude-sonnet-4-6' },
    } as Partial<TModelSpec>);
    const otherSpec = createModelSpec('other-spec');
    const allowListConfig = { addedEndpoints: ['agents', 'ClickHouse'] };
    const allowListEndpoints = {
      bedrock: { order: 0 },
      ClickHouse: { order: 1 },
      [EModelEndpoint.agents]: { order: 2 },
    } as TEndpointsConfig;

    it('re-arms on New Chat after viewing the soft conversation last', () => {
      writeLastModel('ClickHouse', 'kimi-k2p7-code');
      persistAppliedSpec(softSpec, 'a8b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d');

      const result = getDefaultModelSpec(
        createStartupConfig([otherSpec, softSpec], allowListConfig),
        allowListEndpoints,
      );

      expect(result).toEqual({ softDefault: softSpec });
    });

    it('still yields when a selectable endpoint was the last conversation', () => {
      persistAppliedSpec(softSpec, 'a8b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d');
      persistEphemeralSelection('ClickHouse', 'kimi-k2p7-code');

      const result = getDefaultModelSpec(
        createStartupConfig([otherSpec, softSpec], allowListConfig),
        allowListEndpoints,
      );

      expect(result).toBeUndefined();
    });
  });

  describe('explicit soft default selection', () => {
    const softSpec = createModelSpec('soft-spec', { softDefault: true });
    const otherSpec = createModelSpec('other-spec');

    it('keeps the soft default selected over older model history (prioritized config)', () => {
      persistEphemeralSelection(EModelEndpoint.openAI, 'gpt-4o');
      persistAppliedSpec(softSpec);

      const result = getDefaultModelSpec(
        createStartupConfig([otherSpec, softSpec]),
        fullEndpointsConfig,
      );

      expect(result).toEqual({ softDefault: softSpec });
    });

    it('keeps the soft default selected over older model history (modelSelect config)', () => {
      persistEphemeralSelection(EModelEndpoint.openAI, 'gpt-4o');
      persistAppliedSpec(softSpec);

      const result = getDefaultModelSpec(
        createStartupConfig([otherSpec, softSpec], { prioritize: false }),
        fullEndpointsConfig,
      );

      expect(result).toEqual({ softDefault: softSpec });
    });
  });

  describe('no ephemeral endpoint → model options (edge case)', () => {
    const softSpec = createModelSpec('soft-spec', { softDefault: true });
    const otherSpec = createModelSpec('other-spec');

    it('applies the soft default despite a stored agent when modelSelect is disabled', () => {
      persistAgentSelection('agent_abc');

      const result = getDefaultModelSpec(
        createStartupConfig([otherSpec, softSpec], { modelSelect: false }),
        fullEndpointsConfig,
      );

      expect(result).toEqual({ softDefault: softSpec });
    });

    it('yields to a stored agent when addedEndpoints only includes agents', () => {
      persistAgentSelection('agent_abc');

      const result = getDefaultModelSpec(
        createStartupConfig([otherSpec, softSpec], {
          prioritize: false,
          addedEndpoints: [EModelEndpoint.agents],
        }),
        fullEndpointsConfig,
      );

      expect(result).toBeUndefined();
    });

    it('yields to a stored agent when agents is the only endpoint', () => {
      persistAgentSelection('agent_abc');

      const result = getDefaultModelSpec(
        createStartupConfig([otherSpec, softSpec], { prioritize: false }),
        agentsOnlyEndpointsConfig,
      );

      expect(result).toBeUndefined();
    });

    it('yields to a stored agent under a prioritized agents-only allow-list', () => {
      persistAgentSelection('agent_abc');

      const result = getDefaultModelSpec(
        createStartupConfig([otherSpec, softSpec], {
          addedEndpoints: [EModelEndpoint.agents],
        }),
        agentsOnlyEndpointsConfig,
      );

      expect(result).toBeUndefined();
    });

    it('yields to a stored assistant when assistants is the only added endpoint', () => {
      localStorage.setItem(
        `${LocalStorageKeys.LAST_CONVO_SETUP}_0`,
        JSON.stringify({
          endpoint: EModelEndpoint.assistants,
          assistant_id: 'asst_abc',
          model: null,
          spec: null,
        }),
      );

      const result = getDefaultModelSpec(
        createStartupConfig([otherSpec, softSpec], {
          prioritize: false,
          addedEndpoints: [EModelEndpoint.assistants],
        }),
        { [EModelEndpoint.assistants]: { order: 0 } } as TEndpointsConfig,
      );

      expect(result).toBeUndefined();
    });

    it('applies the soft default over a stored ephemeral agent id in an agents-only allow-list', () => {
      persistAgentSelection(Constants.EPHEMERAL_AGENT_ID);

      const result = getDefaultModelSpec(
        createStartupConfig([otherSpec, softSpec], {
          prioritize: false,
          addedEndpoints: [EModelEndpoint.agents],
        }),
        fullEndpointsConfig,
      );

      expect(result).toEqual({ softDefault: softSpec });
    });

    it('applies the soft default over endpoint → model residue in an agents-only allow-list', () => {
      persistEphemeralSelection('bedrock', 'claude-sonnet-4-6');

      const result = getDefaultModelSpec(
        createStartupConfig([otherSpec, softSpec], {
          addedEndpoints: [EModelEndpoint.agents],
        }),
        agentsOnlyEndpointsConfig,
      );

      expect(result).toEqual({ softDefault: softSpec });
    });

    it('applies the soft default over a stored agent when the endpoints config lacks agents', () => {
      persistAgentSelection('agent_abc');

      const result = getDefaultModelSpec(
        createStartupConfig([otherSpec, softSpec], {
          prioritize: false,
          addedEndpoints: [EModelEndpoint.agents],
        }),
        { [EModelEndpoint.openAI]: { order: 0 } } as TEndpointsConfig,
      );

      expect(result).toEqual({ softDefault: softSpec });
    });

    it('still defers to the last selected spec', () => {
      persistAppliedSpec(otherSpec);

      const result = getDefaultModelSpec(
        createStartupConfig([otherSpec, softSpec], { prioritize: false }),
        agentsOnlyEndpointsConfig,
      );

      expect(result).toEqual({ last: otherSpec });
    });

    it('keeps the selection gate when addedEndpoints includes ephemeral endpoints', () => {
      persistAgentSelection('agent_abc');

      const result = getDefaultModelSpec(
        createStartupConfig([otherSpec, softSpec], {
          prioritize: false,
          addedEndpoints: [EModelEndpoint.agents, EModelEndpoint.openAI],
        }),
        fullEndpointsConfig,
      );

      expect(result).toBeUndefined();
    });

    it('keeps the selection gate while the endpoints config has not loaded', () => {
      persistAgentSelection('agent_abc');

      const result = getDefaultModelSpec(
        createStartupConfig([otherSpec, softSpec], { prioritize: false }),
        undefined,
      );

      expect(result).toBeUndefined();
    });

    it('detects an agents-only allow-list before the endpoints config loads', () => {
      persistEphemeralSelection('bedrock', 'claude-sonnet-4-6');

      const result = getDefaultModelSpec(
        createStartupConfig([otherSpec, softSpec], {
          prioritize: false,
          addedEndpoints: [EModelEndpoint.agents],
        }),
        undefined,
      );

      expect(result).toEqual({ softDefault: softSpec });
    });

    it('yields to a stored agent in an agents-only allow-list before the endpoints config loads', () => {
      persistAgentSelection('agent_abc');

      const result = getDefaultModelSpec(
        createStartupConfig([otherSpec, softSpec], {
          prioritize: false,
          addedEndpoints: [EModelEndpoint.agents],
        }),
        undefined,
      );

      expect(result).toBeUndefined();
    });
  });

  describe('stored agent picks validated against the agent list', () => {
    const softSpec = createModelSpec('soft-spec', { softDefault: true });
    const liveAgentsMap = { agent_123: { id: 'agent_123' } } as unknown as TAgentsMap;

    it('yields to a stored agent present in the loaded agent list', () => {
      persistAgentSelection('agent_123');

      const result = getDefaultModelSpec(
        createStartupConfig([softSpec]),
        fullEndpointsConfig,
        liveAgentsMap,
      );

      expect(result).toBeUndefined();
    });

    it('re-arms the soft default when the stored agent is missing from the agent list', () => {
      persistAgentSelection('agent_other_org');

      const result = getDefaultModelSpec(
        createStartupConfig([softSpec]),
        fullEndpointsConfig,
        liveAgentsMap,
      );

      expect(result).toEqual({ softDefault: softSpec });
    });

    it('re-arms the soft default over a stored agent when the agent list is empty', () => {
      persistAgentSelection('agent_123');

      const result = getDefaultModelSpec(createStartupConfig([softSpec]), fullEndpointsConfig, {});

      expect(result).toEqual({ softDefault: softSpec });
    });

    it('re-arms in an agents-only allow-list when the stored agent is missing', () => {
      persistAgentSelection('agent_other_org');

      const result = getDefaultModelSpec(
        createStartupConfig([softSpec], { addedEndpoints: [EModelEndpoint.agents] }),
        agentsOnlyEndpointsConfig,
        liveAgentsMap,
      );

      expect(result).toEqual({ softDefault: softSpec });
    });

    it('trusts the stored agent while the agent list is unknown', () => {
      persistAgentSelection('agent_other_org');

      const result = getDefaultModelSpec(
        createStartupConfig([softSpec]),
        fullEndpointsConfig,
        undefined,
      );

      expect(result).toBeUndefined();
    });
  });
});

describe('defaultSpecAwaitsAgents', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  const softSpec = createModelSpec('soft-spec', { softDefault: true });

  it('awaits the agent list for a stored agent pick with a soft default configured', () => {
    persistAgentSelection('agent_123');

    expect(defaultSpecAwaitsAgents(createStartupConfig([softSpec]), fullEndpointsConfig)).toBe(
      true,
    );
  });

  it('does not await without a stored agent pick', () => {
    expect(defaultSpecAwaitsAgents(createStartupConfig([softSpec]), fullEndpointsConfig)).toBe(
      false,
    );
  });

  it('does not await when a stored spec decides first', () => {
    persistAppliedSpec(softSpec);

    expect(defaultSpecAwaitsAgents(createStartupConfig([softSpec]), fullEndpointsConfig)).toBe(
      false,
    );
  });

  it('does not await when a hard default decides first', () => {
    const hardSpec = createModelSpec('hard-spec', { default: true });
    persistAgentSelection('agent_123');

    expect(
      defaultSpecAwaitsAgents(createStartupConfig([hardSpec, softSpec]), fullEndpointsConfig),
    ).toBe(false);
  });

  it('does not await without a soft default configured', () => {
    const regularSpec = createModelSpec('regular-spec');
    persistAgentSelection('agent_123');

    expect(defaultSpecAwaitsAgents(createStartupConfig([regularSpec]), fullEndpointsConfig)).toBe(
      false,
    );
  });

  it('does not await when the endpoints config lacks agents', () => {
    persistAgentSelection('agent_123');

    expect(
      defaultSpecAwaitsAgents(createStartupConfig([softSpec]), {
        [EModelEndpoint.openAI]: { order: 0 },
      } as TEndpointsConfig),
    ).toBe(false);
  });

  it('does not await for an ephemeral stored agent id', () => {
    persistAgentSelection('ephemeral_agent_123');

    expect(defaultSpecAwaitsAgents(createStartupConfig([softSpec]), fullEndpointsConfig)).toBe(
      false,
    );
  });

  it('does not await when model selection is disabled', () => {
    persistAgentSelection('agent_123');

    expect(
      defaultSpecAwaitsAgents(
        createStartupConfig([softSpec], { modelSelect: false }),
        fullEndpointsConfig,
      ),
    ).toBe(false);
  });
});
