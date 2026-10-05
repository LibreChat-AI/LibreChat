import { renderHook } from '@testing-library/react';
import { EModelEndpoint } from 'librechat-data-provider';
import type { TSubmission } from 'librechat-data-provider';
import useResumableSSE from '../useResumableSSE';
import useAdaptiveSSE from '../useAdaptiveSSE';
import useSSE from '../useSSE';

jest.mock('../useSSE', () => jest.fn());
jest.mock('../useResumableSSE', () => jest.fn(() => ({ streamId: 'stream' })));

const helpers = {
  setMessages: jest.fn(),
  getMessages: jest.fn(),
  setConversation: jest.fn(),
  setIsSubmitting: jest.fn(),
  newConversation: jest.fn(),
};

beforeEach(() => jest.clearAllMocks());

it.each([
  { endpoint: EModelEndpoint.agents },
  { endpoint: 'custom', endpointType: EModelEndpoint.agents },
  { endpoint: EModelEndpoint.openAI },
])(
  'routes $endpoint through resumable lifecycle, never legacy local cancellation',
  (conversation) => {
    const submission = {
      conversation: { ...conversation, conversationId: 'saved' },
      codeEnvironmentMode: 'attached',
      codeWorkspaces: [{ environmentId: 'vm', workspaceId: 'repo' }],
    } as TSubmission;
    const { rerender } = renderHook(({ value }) => useAdaptiveSSE(value, helpers), {
      initialProps: { value: submission as TSubmission | null },
    });
    expect(useSSE).toHaveBeenLastCalledWith(null, helpers, false, 0);
    expect(useResumableSSE).toHaveBeenLastCalledWith(submission, helpers, false, 0);
    rerender({ value: null });
    expect(useSSE).toHaveBeenLastCalledWith(null, helpers, false, 0);
  },
);

it('preserves the Assistants transport and its server abort endpoint', () => {
  const submission = { conversation: { endpoint: EModelEndpoint.assistants } } as TSubmission;
  renderHook(() => useAdaptiveSSE(submission, helpers));
  expect(useSSE).toHaveBeenLastCalledWith(submission, helpers, false, 0);
  expect(useResumableSSE).toHaveBeenLastCalledWith(null, helpers, false, 0);
});
