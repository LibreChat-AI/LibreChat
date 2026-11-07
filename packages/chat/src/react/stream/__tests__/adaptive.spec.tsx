/**
 * @jest-environment jsdom
 */
import React from 'react';
import { renderHook } from '@testing-library/react';
import { EModelEndpoint } from 'librechat-data-provider';
import type { TSubmission } from 'librechat-data-provider';
import type { StreamHost } from '../host';
import { StreamHostProvider } from '../host';
import useResumableSSE from '../resumable';
import useAdaptiveSSE from '../adaptive';

jest.mock('../resumable', () => jest.fn(() => ({ streamId: 'stream' })));

const useLegacyStream = jest.fn();
const host: StreamHost = {
  useResumableServices: () => () => {
    throw new Error('the resumable binding is replaced in this spec');
  },
  useLegacyStream,
  useTransport: () => null,
  useQueuedTurnReceipts: () => ({ data: undefined, dataUpdatedAt: 0 }),
  useActiveJobs: () => ({ data: undefined, dataUpdatedAt: 0 }),
  extendActiveJobsGrace: () => undefined,
  useStreamStatus: () => ({
    data: undefined,
    dataUpdatedAt: 0,
    isSuccess: false,
    isFetching: false,
  }),
  useResumeSettings: () => ({ configLoaded: true, conversation: null }),
};

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <StreamHostProvider host={host}>{children}</StreamHostProvider>
);

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
    const { rerender, result } = renderHook(({ value }) => useAdaptiveSSE(value, helpers), {
      initialProps: { value: submission as TSubmission | null },
      wrapper,
    });
    expect(useLegacyStream).toHaveBeenLastCalledWith(null, helpers, false, 0);
    expect(useResumableSSE).toHaveBeenLastCalledWith(submission, helpers, false, 0);
    expect(result.current).toEqual({ streamId: 'stream', resumableEnabled: true });
    rerender({ value: null });
    expect(useLegacyStream).toHaveBeenLastCalledWith(null, helpers, false, 0);
  },
);

it('preserves the Assistants transport and its server abort endpoint', () => {
  const submission = { conversation: { endpoint: EModelEndpoint.assistants } } as TSubmission;
  renderHook(() => useAdaptiveSSE(submission, helpers), { wrapper });
  expect(useLegacyStream).toHaveBeenLastCalledWith(submission, helpers, false, 0);
  expect(useResumableSSE).toHaveBeenLastCalledWith(null, helpers, false, 0);
});
