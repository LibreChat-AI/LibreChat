import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { RecoilRoot, useRecoilValue } from 'recoil';
import { act, renderHook } from '@testing-library/react';
import { EModelEndpoint, LocalStorageKeys } from 'librechat-data-provider';
import type {
  TPreset,
  TModelSpec,
  TConversation,
  TModelsConfig,
  TEndpointsConfig,
} from 'librechat-data-provider';
import { useGetEndpointsQuery, useGetStartupConfig } from '~/data-provider';
import useSelectMention from '../useSelectMention';
import useNewConvo from '~/hooks/useNewConvo';
import store from '~/store';

/**
 * Selections run through the real useDefaultConvo and useNewConvo, and the assertions read the
 * conversation they store, so the defaulting and parsing in buildDefaultConvo is part of the test.
 * Only the queries, providers and side-effect hooks around them are stubbed.
 */
jest.mock('~/data-provider', () => ({
  useGetStartupConfig: jest.fn(),
  useGetEndpointsQuery: jest.fn(),
  useDeleteFilesMutation: () => ({ mutateAsync: jest.fn() }),
}));

jest.mock('librechat-data-provider/react-query', () => ({
  ...jest.requireActual('librechat-data-provider/react-query'),
  useGetModelsQuery: () => ({ data: mockModelsConfig }),
}));

jest.mock('~/hooks', () => ({
  useDefaultConvo: jest.requireActual('~/hooks/Conversations/useDefaultConvo').default,
  useHasAccess: () => true,
}));

jest.mock('~/Providers', () => ({
  useAgentsMapContext: () => ({}),
}));

jest.mock('~/hooks/Agents', () => ({
  useApplyModelSpecEffects: () => jest.fn(),
}));

jest.mock('~/hooks/Audio', () => ({
  usePauseGlobalAudio: () => ({ pauseGlobalAudio: jest.fn() }),
}));

jest.mock('~/hooks/Assistants/useAssistantListMap', () => () => ({}));

jest.mock('~/hooks/Files/useFileHandling', () => ({
  clearUploadRecovery: jest.fn(),
}));

jest.mock('~/hooks/Conversations/useNavigateToConvo', () => ({
  supersedeNavigation: jest.fn(),
}));

const mockModelsConfig: TModelsConfig = {
  [EModelEndpoint.azureOpenAI]: ['gpt-6-luna-dz', 'gpt-5.4-dz'],
  [EModelEndpoint.openAI]: ['gpt-5.4-dz'],
  [EModelEndpoint.agents]: [],
};

const endpointsConfig = {
  [EModelEndpoint.azureOpenAI]: { order: 1 },
  [EModelEndpoint.openAI]: { order: 2 },
  [EModelEndpoint.agents]: { order: 3 },
} as unknown as TEndpointsConfig;

const SAVED_BUDGET = 950000;

const azureConversation = {
  conversationId: 'convo-1',
  endpoint: EModelEndpoint.azureOpenAI,
  model: 'gpt-6-luna-dz',
  maxContextTokens: SAVED_BUDGET,
} as TConversation;

/** Saved agents carry no conversation-level model; the agent supplies it. */
const agentConversation = {
  conversationId: 'convo-2',
  endpoint: EModelEndpoint.agents,
  agent_id: 'agent_A',
  maxContextTokens: SAVED_BUDGET,
} as TConversation;

const gpt54Spec: TModelSpec = {
  name: 'gpt-5.4-dz',
  label: 'GPT 5.4',
  preset: { endpoint: EModelEndpoint.azureOpenAI, model: 'gpt-5.4-dz' },
};

const lunaSpec: TModelSpec = {
  name: 'gpt-6-luna-dz',
  label: 'GPT 6 luna',
  preset: { endpoint: EModelEndpoint.azureOpenAI, model: 'gpt-6-luna-dz' },
};

const gpt54Preset = {
  presetId: 'preset-gpt54',
  title: 'GPT 5.4',
  endpoint: EModelEndpoint.azureOpenAI,
  model: 'gpt-5.4-dz',
} as TPreset;

const gpt54PresetWithBudget = {
  ...gpt54Preset,
  presetId: 'preset-gpt54-budget',
  maxContextTokens: 200000,
} as TPreset;

/** Names only the endpoint; buildDefaultConvo picks the last-selected or first available model. */
const endpointOnlyPreset = {
  presetId: 'preset-azure-default',
  title: 'Azure default',
  endpoint: EModelEndpoint.azureOpenAI,
} as TPreset;

const setLastSelectedModel = (model: string) =>
  localStorage.setItem(
    LocalStorageKeys.LAST_MODEL,
    JSON.stringify({ [EModelEndpoint.azureOpenAI]: model }),
  );

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <RecoilRoot>
    <MemoryRouter>{children}</MemoryRouter>
  </RecoilRoot>
);

const renderSelection = (
  conversation: TConversation,
  resetMaxContextTokensOnModelSwitch?: boolean,
) => {
  (useGetStartupConfig as jest.Mock).mockReturnValue({
    data: { interface: { resetMaxContextTokensOnModelSwitch } },
  });
  const { result } = renderHook(
    () => {
      const { newConversation } = useNewConvo();
      const options = {
        presets: [gpt54Preset, gpt54PresetWithBudget, endpointOnlyPreset],
        modelSpecs: [gpt54Spec, lunaSpec],
        endpointsConfig,
        getConversation: () => conversation,
        newConversation,
      };
      return {
        handlers: useSelectMention({ ...options, returnHandlers: true }),
        mention: useSelectMention(options),
        stored: useRecoilValue(store.conversationByIndex(0)),
      };
    },
    { wrapper },
  );

  const select = async (choose: (current: (typeof result)['current']) => void) => {
    await act(async () => {
      choose(result.current);
    });
    const stored = result.current.stored;
    expect(stored).not.toBeNull();
    return stored as TConversation;
  };
  return { select };
};

type Selection = Parameters<ReturnType<typeof renderSelection>['select']>[0];

const pickGpt54FromMenu: Selection = ({ handlers }) =>
  handlers.onSelectEndpoint?.(EModelEndpoint.azureOpenAI, { model: 'gpt-5.4-dz' });
const switchToOpenAI: Selection = ({ handlers }) =>
  handlers.onSelectEndpoint?.(EModelEndpoint.openAI, { model: 'gpt-5.4-dz' });
const choosePreset =
  (preset: TPreset): Selection =>
  ({ mention }) =>
    mention.onSelectMention?.({
      type: 'preset',
      value: preset.presetId as string,
      label: 'GPT 5.4',
    });
const switchToAgentB: Selection = ({ handlers }) =>
  handlers.onSelectEndpoint?.(EModelEndpoint.agents, { agent_id: 'agent_B' });

/** Each switch that, left alone, hands the previous model's budget to the new conversation. */
const staleBudgetSwitches: [string, TConversation, Selection][] = [
  ['picking another model from the endpoint menu', azureConversation, pickGpt54FromMenu],
  ['changing the endpoint', azureConversation, switchToOpenAI],
  ['selecting a preset without its own budget', azureConversation, choosePreset(gpt54Preset)],
  [
    'switching between saved agents without a conversation model',
    agentConversation,
    switchToAgentB,
  ],
];

describe('the conversation after a model switch drops the previous Max Context Tokens', () => {
  beforeEach(() => {
    (useGetEndpointsQuery as jest.Mock).mockReturnValue({ data: endpointsConfig });
  });

  afterEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
  });

  describe('with the setting on', () => {
    it.each(staleBudgetSwitches)('%s leaves no budget', async (_name, conversation, choose) => {
      const { select } = renderSelection(conversation, true);
      const convo = await select(choose);
      expect(convo.maxContextTokens).toBeUndefined();
    });

    it('selecting a spec with another model leaves no budget', async () => {
      const { select } = renderSelection(azureConversation, true);
      const convo = await select(({ handlers }) => handlers.onSelectSpec?.(gpt54Spec));
      expect(convo.model).toBe('gpt-5.4-dz');
      expect(convo.maxContextTokens).toBeUndefined();
    });

    it('lands on the newly selected model and agent', async () => {
      const model = await renderSelection(azureConversation, true).select(pickGpt54FromMenu);
      expect(model.model).toBe('gpt-5.4-dz');
      const endpoint = await renderSelection(azureConversation, true).select(switchToOpenAI);
      expect(endpoint.endpoint).toBe(EModelEndpoint.openAI);
      const agent = await renderSelection(agentConversation, true).select(switchToAgentB);
      expect(agent.agent_id).toBe('agent_B');
    });

    it("selecting a preset with its own budget applies the preset's value", async () => {
      const { select } = renderSelection(azureConversation, true);
      const convo = await select(choosePreset(gpt54PresetWithBudget));
      expect(convo.maxContextTokens).toBe(200000);
    });

    it('keeps the budget when a preset without a model resolves to the current model', async () => {
      setLastSelectedModel('gpt-6-luna-dz');
      const { select } = renderSelection(azureConversation, true);
      const convo = await select(choosePreset(endpointOnlyPreset));
      expect(convo.model).toBe('gpt-6-luna-dz');
      expect(convo.maxContextTokens).toBe(SAVED_BUDGET);
    });

    it('keeps the budget when a preset without a model falls back to the current model', async () => {
      const { select } = renderSelection(azureConversation, true);
      const convo = await select(choosePreset(endpointOnlyPreset));
      expect(convo.model).toBe('gpt-6-luna-dz');
      expect(convo.maxContextTokens).toBe(SAVED_BUDGET);
    });

    it('clears the budget when a preset without a model resolves to another model', async () => {
      setLastSelectedModel('gpt-5.4-dz');
      const { select } = renderSelection(azureConversation, true);
      const convo = await select(choosePreset(endpointOnlyPreset));
      expect(convo.model).toBe('gpt-5.4-dz');
      expect(convo.maxContextTokens).toBeUndefined();
    });

    it('keeps the budget when the same model is picked again', async () => {
      const { select } = renderSelection(azureConversation, true);
      const convo = await select(({ handlers }) =>
        handlers.onSelectEndpoint?.(EModelEndpoint.azureOpenAI, { model: 'gpt-6-luna-dz' }),
      );
      expect(convo.maxContextTokens).toBe(SAVED_BUDGET);
    });

    it('keeps the budget when the same agent is selected again', async () => {
      const { select } = renderSelection(agentConversation, true);
      const convo = await select(({ handlers }) =>
        handlers.onSelectEndpoint?.(EModelEndpoint.agents, { agent_id: 'agent_A' }),
      );
      expect(convo.maxContextTokens).toBe(SAVED_BUDGET);
    });
  });

  /** Controls: the same switches carry the previous model's budget forward without the setting. */
  describe.each([
    ['off', false],
    ['absent', undefined],
  ])('with the setting %s', (_label, enabled) => {
    it.each(staleBudgetSwitches)(
      '%s keeps the previous budget',
      async (_name, conversation, choose) => {
        const { select } = renderSelection(conversation, enabled);
        const convo = await select(choose);
        expect(convo.maxContextTokens).toBe(SAVED_BUDGET);
      },
    );
  });
});
