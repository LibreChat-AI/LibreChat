import { renderHook, act } from '@testing-library/react';
import { EModelEndpoint } from 'librechat-data-provider';

const mockNewConversation = jest.fn();
const mockGetDefaultConversation = jest.fn();

jest.mock('~/Providers/ChatContext', () => ({
  useChatContext: jest.fn(() => ({
    conversation: {
      endpoint: 'assistants',
      spec: 'Assistant Spec',
      iconURL: '/images/assistant.svg',
      modelLabel: 'Assistant Spec',
    },
    newConversation: mockNewConversation,
  })),
}));

jest.mock('~/hooks/Conversations/useDefaultConvo', () => ({
  __esModule: true,
  default: jest.fn(() => mockGetDefaultConversation),
}));

jest.mock('../useAssistantListMap', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    assistants: {
      'assistant-1': { id: 'assistant-1', model: 'gpt-4' },
    },
  })),
}));

jest.mock('~/utils', () => ({
  logger: { log: jest.fn() },
  mapAssistants: jest.fn(),
  specDisplayFieldReset: {
    spec: null,
    iconURL: null,
    modelLabel: null,
    greeting: undefined,
  },
}));

import useSelectAssistant from '../useSelectAssistant';

describe('useSelectAssistant', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetDefaultConversation.mockImplementation(({ conversation, preset }) => ({
      ...conversation,
      ...preset,
    }));
  });

  it('clears model spec display fields when selecting an assistant', () => {
    const { result } = renderHook(() => useSelectAssistant(EModelEndpoint.assistants));

    act(() => {
      result.current.onSelect('assistant-1');
    });

    expect(mockNewConversation).toHaveBeenCalledWith({
      template: expect.objectContaining({
        endpoint: EModelEndpoint.assistants,
        assistant_id: 'assistant-1',
        spec: null,
        iconURL: null,
        modelLabel: null,
      }),
      preset: expect.objectContaining({
        spec: null,
        iconURL: null,
        modelLabel: null,
      }),
    });
  });
});
