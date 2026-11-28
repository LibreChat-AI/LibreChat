import React from 'react';
import { render } from '@testing-library/react';
import { PermissionBits } from 'librechat-data-provider';
import type { Agent, AgentListResponse } from 'librechat-data-provider';
import { ModelSelectorProvider } from '../ModelSelectorContext';

type SelectAgents = (data: AgentListResponse) => Agent[] | undefined;

const mockUseListAgentsQuery = jest.fn();
let mockFavorites: Array<Record<string, string>> = [];
let mockPermissionLevel = PermissionBits.EDIT;

jest.mock('~/data-provider', () => ({
  useGetEndpointsQuery: () => ({ data: {} }),
  useListAgentsQuery: (...args: unknown[]) => mockUseListAgentsQuery(...args),
}));

jest.mock('~/Providers', () => ({
  useAgentsMapContext: () => ({}),
  useAssistantsMapContext: () => ({}),
  useLiveAnnouncer: () => ({ announcePolite: jest.fn() }),
}));

jest.mock('~/hooks', () => ({
  useAgentDefaultPermissionLevel: () => mockPermissionLevel,
  useSelectorEffects: () => undefined,
  useKeyDialog: () => ({}),
  useEndpoints: () => ({ mappedEndpoints: [], endpointRequiresUserKey: () => false }),
  useLocalize: () => (key: string) => key,
  useFavorites: () => ({ favorites: mockFavorites }),
}));

jest.mock('../ModelSelectorChatContext', () => ({
  useModelSelectorChatContext: () => ({
    getConversation: jest.fn(() => null),
    newConversation: jest.fn(),
  }),
}));

jest.mock('~/hooks/Input/useSelectMention', () => ({
  __esModule: true,
  default: () => ({ onSelectEndpoint: jest.fn(), onSelectSpec: jest.fn() }),
}));

jest.mock('~/hooks/useCatalogWarmup', () => ({ useCatalogReady: () => true }));

jest.mock('~/hooks/Agents/specs', () => ({ __esModule: true, default: () => [] }));

const own = { id: 'agent_own', name: 'Own', isEditable: true } as Agent;
const pinnedShared = { id: 'agent_pinned', name: 'Pinned', isEditable: false } as Agent;
const otherShared = { id: 'agent_other', name: 'Other', isEditable: false } as Agent;
const response = { data: [own, pinnedShared, otherShared] } as AgentListResponse;

/** Renders the provider and returns the `select` it passed to the agent list query. */
const renderAndGetSelect = (): SelectAgents => {
  render(
    <ModelSelectorProvider startupConfig={undefined}>
      <div />
    </ModelSelectorProvider>,
  );
  const calls = mockUseListAgentsQuery.mock.calls;
  return calls[calls.length - 1][1].select as SelectAgents;
};

describe('ModelSelectorProvider agent list', () => {
  beforeEach(() => {
    mockUseListAgentsQuery.mockReset();
    mockUseListAgentsQuery.mockReturnValue({ data: undefined });
    mockFavorites = [];
    mockPermissionLevel = PermissionBits.EDIT;
  });

  it('lists pinned agents the user cannot edit when the marketplace limits it to editable agents', () => {
    mockFavorites = [{ agentId: 'agent_pinned' }, { model: 'gpt-x', endpoint: 'openAI' }];
    expect(renderAndGetSelect()(response)).toEqual([own, pinnedShared]);
  });

  it('keeps unpinned agents the user cannot edit out of the list', () => {
    expect(renderAndGetSelect()(response)).toEqual([own]);
  });

  it('lists every viewable agent when the marketplace is off', () => {
    mockPermissionLevel = PermissionBits.VIEW;
    expect(renderAndGetSelect()(response)).toEqual([own, pinnedShared, otherShared]);
  });
});
