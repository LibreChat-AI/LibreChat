import React from 'react';
import { getDefaultStore } from 'jotai';
import { ReasoningEffort } from 'librechat-data-provider';
import { render, screen, waitFor, act } from '@testing-library/react';
import { getReasoningStateKey, pendingReasoningOverrideFamily } from '@librechat/chat/react';
import type { TConversation, TStartupConfig } from 'librechat-data-provider';
import Thinking from '../Thinking';

const mockEndpoints = {};
const mockAgentsMap = {};
let mockConversation: TConversation;
let mockStartupConfig: TStartupConfig;

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: mockStartupConfig }),
  useGetAgentByIdQuery: () => ({ data: undefined }),
  useGetEndpointsQuery: () => ({ data: mockEndpoints }),
  useReasoningCapabilitiesQuery: () => ({ data: undefined, isError: false, isFetching: false }),
}));

jest.mock('~/Providers', () => ({
  useAgentsMapContext: () => mockAgentsMap,
  useChatContext: () => ({
    conversation: mockConversation,
    latestMessageId: undefined,
    getMessages: () => [],
  }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('@librechat/chat/react', () => ({
  ...jest.requireActual('@librechat/chat/react'),
  useReducedMotion: () => true,
}));

const store = getDefaultStore();
const stagedAtom = pendingReasoningOverrideFamily(getReasoningStateKey('convo-1', 0));
const staged = { key: 'reasoning_effort', value: ReasoningEffort.high } as const;

const spec = (name: string, preset: Record<string, unknown> = {}) => ({
  name,
  label: name,
  preset: { endpoint: 'openAI', model: 'gpt-5', ...preset },
});

function configure({ enforce, list }: { enforce: boolean; list: ReturnType<typeof spec>[] }) {
  mockStartupConfig = {
    interface: { parameters: true },
    modelSpecs: { enforce, prioritize: true, list },
  } as unknown as TStartupConfig;
}

function renderThinking() {
  return render(<Thinking index={0} disabled={false} hasAddedConversation={false} />);
}

const thinkingButton = () => screen.queryByTestId('composer-thinking-button');

describe('Thinking model spec locks', () => {
  beforeEach(() => {
    mockConversation = {
      conversationId: 'convo-1',
      endpoint: 'openAI',
      model: 'gpt-5',
      spec: 'hidden-spec',
    } as TConversation;
    store.set(stagedAtom, undefined);
  });

  it('offers no control when enforcement is on and the active spec is not served', () => {
    configure({ enforce: true, list: [spec('listed-spec')] });
    renderThinking();

    expect(thinkingButton()).not.toBeInTheDocument();
  });

  it('offers no control when every spec is hidden and the served list is empty', () => {
    configure({ enforce: true, list: [] });
    renderThinking();

    expect(thinkingButton()).not.toBeInTheDocument();
  });

  it('withdraws a level staged for a spec whose locks are unknown', async () => {
    configure({ enforce: true, list: [spec('listed-spec')] });
    store.set(stagedAtom, staged);
    renderThinking();

    await waitFor(() => expect(store.get(stagedAtom)).toBeUndefined());
  });

  it('hides the control for a served spec whose preset sets the effort', () => {
    mockConversation = { ...mockConversation, spec: 'locked-spec' } as TConversation;
    configure({
      enforce: true,
      list: [spec('locked-spec', { reasoning_effort: ReasoningEffort.low })],
    });
    renderThinking();

    expect(thinkingButton()).not.toBeInTheDocument();
  });

  it('keeps the control and a staged level for a served spec that leaves the effort free', async () => {
    mockConversation = { ...mockConversation, spec: 'free-spec' } as TConversation;
    configure({ enforce: true, list: [spec('free-spec')] });
    store.set(stagedAtom, staged);
    renderThinking();
    await act(async () => {});

    expect(thinkingButton()).toBeInTheDocument();
    expect(store.get(stagedAtom)).toEqual(staged);
  });

  it('keeps the control and a staged level when enforcement is off', async () => {
    configure({ enforce: false, list: [spec('listed-spec')] });
    store.set(stagedAtom, staged);
    renderThinking();
    await act(async () => {});

    expect(thinkingButton()).toBeInTheDocument();
    expect(store.get(stagedAtom)).toEqual(staged);
  });

  it('keeps the control for an enforced conversation that names no spec', () => {
    mockConversation = { ...mockConversation, spec: undefined } as TConversation;
    configure({ enforce: true, list: [spec('listed-spec')] });
    renderThinking();

    expect(thinkingButton()).toBeInTheDocument();
  });
});
