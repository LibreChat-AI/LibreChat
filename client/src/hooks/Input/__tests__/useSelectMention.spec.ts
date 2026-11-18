import { renderHook, act } from '@testing-library/react';
import { EModelEndpoint } from 'librechat-data-provider';
import type { TConversation, TModelSpec, TPreset, TEndpointsConfig } from 'librechat-data-provider';

const mockNewConversation = jest.fn();
const mockGetConversation = jest.fn();
const mockGetDefaultConversation = jest.fn();

jest.mock('react-router-dom', () => ({
  useSearchParams: () => [new URLSearchParams()],
}));

jest.mock('recoil', () => ({
  useRecoilValue: jest.fn(() => false),
}));

jest.mock('~/hooks', () => ({
  useDefaultConvo: jest.fn(() => mockGetDefaultConversation),
}));

jest.mock('~/store', () => ({
  __esModule: true,
  default: {
    modularChat: 'modularChat',
    availableTools: 'availableTools',
  },
}));

jest.mock('~/utils', () => {
  const actual = jest.requireActual('~/utils');
  return {
    ...actual,
    logger: { info: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  };
});

import useSelectMention from '../useSelectMention';

describe('useSelectMention', () => {
  const mockEndpointsConfig: TEndpointsConfig = {
    [EModelEndpoint.openAI]: { type: EModelEndpoint.openAI, order: 0 },
    [EModelEndpoint.custom]: { type: EModelEndpoint.custom, order: 1 },
  };

  const greetingSpec: TModelSpec = {
    name: 'greeting-spec',
    label: 'Greeting Spec',
    preset: {
      endpoint: EModelEndpoint.openAI,
      model: 'gpt-4o',
      greeting: 'This greeting belongs to Greeting Spec only.',
    },
  };

  const plainSpec: TModelSpec = {
    name: 'plain-spec',
    label: 'Plain Spec',
    preset: {
      endpoint: EModelEndpoint.openAI,
      model: 'gpt-4o',
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetConversation.mockReturnValue({
      conversationId: 'convo-1',
      endpoint: EModelEndpoint.openAI,
      spec: 'greeting-spec',
      iconURL: '/assets/spec.png',
      modelLabel: 'Greeting Spec',
      greeting: 'This greeting belongs to Greeting Spec only.',
    } as TConversation);
    mockGetDefaultConversation.mockImplementation(
      ({
        conversation,
        preset,
      }: {
        conversation: Partial<TConversation>;
        preset: Partial<TConversation>;
      }) => ({
        ...conversation,
        ...preset,
      }),
    );
  });

  it('clears spec display fields including greeting when switching to an endpoint', () => {
    const { result } = renderHook(() =>
      useSelectMention({
        modelSpecs: [greetingSpec, plainSpec],
        endpointsConfig: mockEndpointsConfig,
        getConversation: mockGetConversation,
        newConversation: mockNewConversation,
        returnHandlers: true,
      }),
    );

    act(() => {
      result.current.onSelectEndpoint?.(EModelEndpoint.custom, { model: 'mock-agent-a' });
    });

    expect(mockNewConversation).toHaveBeenCalledTimes(1);
    const callArgs = mockNewConversation.mock.calls[0][0];

    expect(callArgs.template).toMatchObject({
      spec: null,
      iconURL: null,
      modelLabel: null,
      greeting: undefined,
    });
    expect(callArgs.preset).toMatchObject({
      endpoint: EModelEndpoint.custom,
      model: 'mock-agent-a',
      spec: null,
      iconURL: null,
      modelLabel: null,
      greeting: undefined,
    });
  });

  it('clears greeting when switching to a model spec without greeting', () => {
    const { result } = renderHook(() =>
      useSelectMention({
        modelSpecs: [greetingSpec, plainSpec],
        endpointsConfig: mockEndpointsConfig,
        getConversation: mockGetConversation,
        newConversation: mockNewConversation,
        returnHandlers: true,
      }),
    );

    act(() => {
      result.current.onSelectSpec?.(plainSpec);
    });

    expect(mockNewConversation).toHaveBeenCalledTimes(1);
    const callArgs = mockNewConversation.mock.calls[0][0];

    expect(callArgs.template).toMatchObject({
      spec: 'plain-spec',
    });
    expect(callArgs.template.greeting).toBeUndefined();
    expect(callArgs.preset).toMatchObject({
      spec: 'plain-spec',
    });
    expect(callArgs.preset.greeting).toBeUndefined();
  });

  it('applies spec greeting when switching to a model spec with greeting', () => {
    mockGetConversation.mockReturnValue({
      conversationId: 'convo-1',
      endpoint: EModelEndpoint.openAI,
      spec: 'plain-spec',
      greeting: undefined,
    } as TConversation);

    const { result } = renderHook(() =>
      useSelectMention({
        modelSpecs: [greetingSpec, plainSpec],
        endpointsConfig: mockEndpointsConfig,
        getConversation: mockGetConversation,
        newConversation: mockNewConversation,
        returnHandlers: true,
      }),
    );

    act(() => {
      result.current.onSelectSpec?.(greetingSpec);
    });

    expect(mockNewConversation).toHaveBeenCalledTimes(1);
    const callArgs = mockNewConversation.mock.calls[0][0];

    expect(callArgs.template).toMatchObject({
      spec: 'greeting-spec',
      greeting: 'This greeting belongs to Greeting Spec only.',
    });
    expect(callArgs.preset).toMatchObject({
      spec: 'greeting-spec',
      greeting: 'This greeting belongs to Greeting Spec only.',
    });
  });

  it('clears greeting and spec fields when selecting an endpoint via onSelectMention option', () => {
    const { result } = renderHook(() =>
      useSelectMention({
        modelSpecs: [greetingSpec, plainSpec],
        endpointsConfig: mockEndpointsConfig,
        getConversation: mockGetConversation,
        newConversation: mockNewConversation,
      }),
    );

    act(() => {
      result.current.onSelectMention?.({
        type: 'model',
        value: EModelEndpoint.custom,
        label: 'mock-agent-a',
      });
    });

    expect(mockNewConversation).toHaveBeenCalledTimes(1);
    const callArgs = mockNewConversation.mock.calls[0][0];

    expect(callArgs.template).toMatchObject({
      spec: null,
      iconURL: null,
      modelLabel: null,
      greeting: undefined,
    });
    expect(callArgs.preset).toMatchObject({
      endpoint: EModelEndpoint.custom,
      model: 'mock-agent-a',
      spec: null,
      iconURL: null,
      modelLabel: null,
      greeting: undefined,
    });
  });

  it('clears greeting when selecting a preset without greeting', () => {
    const plainPreset: TPreset = {
      presetId: 'preset-plain',
      title: 'Plain Preset',
      endpoint: EModelEndpoint.openAI,
      model: 'gpt-4o',
    };

    const { result } = renderHook(() =>
      useSelectMention({
        presets: [plainPreset],
        modelSpecs: [greetingSpec, plainSpec],
        endpointsConfig: mockEndpointsConfig,
        getConversation: mockGetConversation,
        newConversation: mockNewConversation,
      }),
    );

    act(() => {
      result.current.onSelectMention?.({
        type: 'preset',
        value: 'preset-plain',
      });
    });

    expect(mockNewConversation).toHaveBeenCalledTimes(1);
    const callArgs = mockNewConversation.mock.calls[0][0];

    expect(callArgs.preset.spec).toBeNull();
    expect(callArgs.preset.greeting).toBeUndefined();
  });

  it('applies preset greeting when selecting a preset with greeting', () => {
    const customGreetingPreset: TPreset = {
      presetId: 'preset-greet',
      title: 'Greeting Preset',
      endpoint: EModelEndpoint.openAI,
      model: 'gpt-4o',
      greeting: 'Welcome from preset!',
    };

    const { result } = renderHook(() =>
      useSelectMention({
        presets: [customGreetingPreset],
        modelSpecs: [greetingSpec, plainSpec],
        endpointsConfig: mockEndpointsConfig,
        getConversation: mockGetConversation,
        newConversation: mockNewConversation,
      }),
    );

    act(() => {
      result.current.onSelectMention?.({
        type: 'preset',
        value: 'preset-greet',
      });
    });

    expect(mockNewConversation).toHaveBeenCalledTimes(1);
    const callArgs = mockNewConversation.mock.calls[0][0];

    expect(callArgs.preset.spec).toBeNull();
    expect(callArgs.preset.greeting).toBe('Welcome from preset!');
  });
});
