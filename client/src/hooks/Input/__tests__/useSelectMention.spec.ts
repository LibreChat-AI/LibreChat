import { renderHook } from '@testing-library/react';
import { EModelEndpoint } from 'librechat-data-provider';
import type { TPreset, TModelSpec, TConversation, TEndpointsConfig } from 'librechat-data-provider';
import type { MentionOption } from '~/common';
import useSelectMention, { mentionEndpoint } from '../useSelectMention';

let mockStoredModularChat = true;
jest.mock('recoil', () => ({
  useRecoilValue: (key: string) => (key === 'modularChat' ? mockStoredModularChat : []),
}));
jest.mock('react-router-dom', () => ({ useSearchParams: () => [new URLSearchParams()] }));
jest.mock('~/hooks', () => ({
  useDefaultConvo:
    () =>
    ({ conversation }: { conversation: Partial<TConversation> }) =>
      conversation,
}));
jest.mock('~/store', () => ({
  __esModule: true,
  default: { modularChat: 'modularChat', availableTools: 'availableTools' },
}));

const option = (type: string, value: string): MentionOption =>
  ({ type, value, label: value }) as MentionOption;

describe('mentionEndpoint', () => {
  const presets = [{ presetId: 'p-1', endpoint: EModelEndpoint.google }] as TPreset[];
  const modelSpecs = [
    { name: 'fast', preset: { endpoint: EModelEndpoint.anthropic } },
  ] as TModelSpec[];
  const from = (type: string, value: string) =>
    mentionEndpoint(option(type, value), { presets, modelSpecs });

  it('reads an endpoint and one of its models from the option itself', () => {
    expect(from('endpoint', EModelEndpoint.openAI)).toBe(EModelEndpoint.openAI);
    expect(from('model', 'Mistral')).toBe('Mistral');
  });

  it('reads a preset and a model spec from what they are set to', () => {
    expect(from('preset', 'p-1')).toBe(EModelEndpoint.google);
    expect(from('modelSpec', 'fast')).toBe(EModelEndpoint.anthropic);
  });

  it('names nothing for a preset or a model spec that is not there', () => {
    expect(from('preset', 'gone')).toBeUndefined();
    expect(from('modelSpec', 'gone')).toBeUndefined();
  });

  it('reads an agent and an assistant from the endpoint the option is listed under', () => {
    expect(from(EModelEndpoint.agents, 'agent_1')).toBe(EModelEndpoint.agents);
    expect(from(EModelEndpoint.assistants, 'asst_1')).toBe(EModelEndpoint.assistants);
  });
});

describe('useSelectMention', () => {
  const open = { conversationId: 'c-1', endpoint: EModelEndpoint.openAI } as TConversation;
  const endpointsConfig = {
    [EModelEndpoint.openAI]: { order: 0 },
    [EModelEndpoint.google]: { order: 1 },
  } as TEndpointsConfig;
  /** Picks another endpoint, and says which conversation the pick was handed to. */
  const pick = (modularChat?: boolean): string | null | undefined => {
    const newConversation = jest.fn();
    const { result } = renderHook(() =>
      useSelectMention({
        modularChat,
        modelSpecs: [],
        endpointsConfig,
        newConversation,
        getConversation: () => open,
      }),
    );
    result.current.onSelectMention?.(option('endpoint', EModelEndpoint.google));
    return newConversation.mock.calls[0][0].template.conversationId;
  };
  afterEach(() => {
    mockStoredModularChat = true;
  });

  it('follows the preference it is handed over the one the app has stored', () => {
    mockStoredModularChat = true;
    expect(pick(false)).toBe('new');
    mockStoredModularChat = false;
    expect(pick(true)).toBe('c-1');
  });

  it('reads the app’s own preference when it is handed none', () => {
    mockStoredModularChat = true;
    expect(pick()).toBe('c-1');
    mockStoredModularChat = false;
    expect(pick()).toBe('new');
  });
});
