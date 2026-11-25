import { Constants, EModelEndpoint } from 'librechat-data-provider';
import type { Agent, AgentDisplay, TConfig, TEndpointsConfig } from 'librechat-data-provider';
import type { ErrorEnvironment } from '../endpoint';
import {
  supportsCompaction,
  resolveErrorEndpoint,
  resolveErrorIdentity,
  isUserProvidedEndpointConfig,
} from '../endpoint';

const cfg = (overrides: Partial<TConfig> = {}): TConfig => ({ order: 0, ...overrides });

const endpointsConfig = {
  openAI: { userProvide: true, type: EModelEndpoint.openAI },
  anthropic: { userProvide: false },
  proxy: { userProvideURL: true },
  [EModelEndpoint.agents]: {},
} as unknown as TEndpointsConfig;

const saved = { id: 'agent_saved', provider: 'anthropic', model: 'claude-x' } as AgentDisplay;
const savedFull = { ...saved, support_contact: { name: 'Ops' } } as unknown as Agent;

const environment = (overrides: Partial<ErrorEnvironment> = {}): ErrorEnvironment => ({
  endpointsConfig,
  agentsMap: { agent_saved: saved },
  savedAgents: { agent_saved: savedFull },
  ...overrides,
});

describe('isUserProvidedEndpointConfig', () => {
  it('returns false for nullish config', () => {
    expect(isUserProvidedEndpointConfig(null)).toBe(false);
    expect(isUserProvidedEndpointConfig(undefined)).toBe(false);
  });

  it('returns true for an API key endpoint', () => {
    expect(isUserProvidedEndpointConfig(cfg({ userProvide: true }))).toBe(true);
  });

  it('returns true for a Bedrock credential endpoint', () => {
    expect(isUserProvidedEndpointConfig(cfg({ userProvideSecretAccessKey: true }))).toBe(true);
  });

  it('returns false for a user-provided base URL alone', () => {
    expect(isUserProvidedEndpointConfig(cfg({ userProvideURL: true }))).toBe(false);
  });

  it('returns false when no credential is user-provided', () => {
    expect(isUserProvidedEndpointConfig(cfg())).toBe(false);
  });
});

describe('supportsCompaction', () => {
  it('excludes the Assistants endpoints and an unknown endpoint', () => {
    expect(supportsCompaction('openAI')).toBe(true);
    expect(supportsCompaction(EModelEndpoint.assistants)).toBe(false);
    expect(supportsCompaction('')).toBe(false);
    expect(supportsCompaction(undefined)).toBe(false);
  });
});

describe('resolveErrorIdentity', () => {
  it('reads the row and never the conversation when there is a row', () => {
    expect(
      resolveErrorIdentity(
        { endpoint: 'openAI', model: 'gpt-x' },
        { endpoint: EModelEndpoint.anthropic, model: 'claude', agent_id: 'agent_saved' },
      ),
    ).toEqual({
      rowEndpoint: 'openAI',
      rowModel: 'gpt-x',
      conversationAgentId: undefined,
      partAgentId: undefined,
      agentKey: 'gpt-x',
    });
  });

  it('falls back to the conversation, but not to its ephemeral agent placeholder', () => {
    expect(
      resolveErrorIdentity(undefined, {
        endpoint: EModelEndpoint.agents,
        agent_id: 'agent_saved',
      }),
    ).toMatchObject({ conversationAgentId: 'agent_saved', agentKey: 'agent_saved' });
    expect(
      resolveErrorIdentity(undefined, {
        endpoint: EModelEndpoint.agents,
        agent_id: Constants.EPHEMERAL_AGENT_ID as string,
      }).conversationAgentId,
    ).toBeUndefined();
  });

  it('keys the agents map by the part agent first', () => {
    expect(
      resolveErrorIdentity({ endpoint: EModelEndpoint.agents, partAgentId: 'agent_lane' }, null)
        .agentKey,
    ).toBe('agent_lane');
  });
});

describe('resolveErrorEndpoint', () => {
  it('names a plain row’s provider and model, and who owns its key', () => {
    expect(
      resolveErrorEndpoint({ endpoint: 'openAI', model: 'gpt-x' }, undefined, environment()),
    ).toMatchObject({
      endpoint: 'openAI',
      endpointType: EModelEndpoint.openAI,
      provider: 'OpenAI',
      model: 'gpt-x',
      userProvidesCredentials: true,
      compactionAvailable: false,
    });
  });

  it('resolves a saved agent row to the agent’s own provider, model and record', () => {
    const resolved = resolveErrorEndpoint(
      { endpoint: EModelEndpoint.agents, model: 'agent_saved' },
      undefined,
      environment(),
    );
    expect(resolved).toMatchObject({
      endpoint: 'anthropic',
      provider: 'Anthropic',
      model: 'claude-x',
      userProvidesCredentials: false,
    });
    expect(resolved.agent).toBe(savedFull);
  });

  it('resolves an ephemeral agent through the endpoint and model its id encodes', () => {
    const resolved = resolveErrorEndpoint(
      { endpoint: EModelEndpoint.agents, model: 'ephemeral', partAgentId: 'openAI__gpt-x' },
      undefined,
      environment(),
    );
    expect(resolved).toMatchObject({ endpoint: 'openAI', model: 'gpt-x' });
    expect(resolved.agent).toBeUndefined();
  });

  it('names nothing for an agent id that resolves to nothing', () => {
    expect(
      resolveErrorEndpoint(
        { endpoint: EModelEndpoint.agents, model: 'agent_gone' },
        undefined,
        environment(),
      ),
    ).toMatchObject({ endpoint: undefined, provider: undefined, model: undefined });
  });

  it('lets an endpoint named by the payload outrank the row', () => {
    expect(
      resolveErrorEndpoint({ endpoint: 'anthropic', model: 'claude' }, 'proxy', environment()),
    ).toMatchObject({ endpoint: 'proxy', provider: 'proxy', userProvidesCredentials: true });
  });

  it('leaves key ownership unknown without a configuration, as on a shared link', () => {
    expect(
      resolveErrorEndpoint({ endpoint: 'openAI', model: 'gpt-x' }, undefined, {})
        .userProvidesCredentials,
    ).toBeUndefined();
  });

  it('offers compaction only where the environment does, and never for Assistants', () => {
    const on = environment({ compactionEnabled: true });
    expect(resolveErrorEndpoint({ endpoint: 'openAI' }, undefined, on).compactionAvailable).toBe(
      true,
    );
    expect(
      resolveErrorEndpoint({ endpoint: EModelEndpoint.assistants }, undefined, on)
        .compactionAvailable,
    ).toBe(false);
  });
});
