import '@testing-library/jest-dom/extend-expect';
import { fireEvent, render, screen } from '@testing-library/react';
import VersionContent from '../VersionContent';
import VersionPanel from '../VersionPanel';
import { Panel } from '~/common/types';

const mockAgentData = {
  name: 'Test Agent',
  description: 'Test Description',
  instructions: 'Test Instructions',
  tools: ['tool1', 'tool2'],
  capabilities: ['capability1', 'capability2'],
  edges: [{ from: 'agent-123', to: 'agent-specialist', edgeType: 'handoff' }],
};

const mockVersions = [
  {
    name: 'Version 1',
    description: 'Description 1',
    instructions: 'Instructions 1',
    tools: ['tool1'],
    capabilities: ['capability1'],
    createdAt: '2023-01-01T00:00:00Z',
    updatedAt: '2023-01-01T00:00:00Z',
  },
  {
    name: 'Version 2',
    description: 'Description 2',
    instructions: 'Instructions 2',
    tools: ['tool1', 'tool2'],
    capabilities: ['capability1', 'capability2'],
    createdAt: '2023-01-02T00:00:00Z',
    updatedAt: '2023-01-02T00:00:00Z',
  },
];

jest.mock('~/data-provider', () => ({
  useGetExpandedAgentByIdQuery: jest.fn(() => ({
    data: mockAgentData,
    isLoading: false,
    error: null,
    refetch: jest.fn(),
  })),
  useGetAgentVersionsQuery: jest.fn(() => ({
    data: mockVersions,
    isLoading: false,
    error: null,
    refetch: jest.fn(),
  })),
  useRevertAgentVersionMutation: jest.fn(() => ({
    mutate: jest.fn(),
    isLoading: false,
  })),
}));

jest.mock('../VersionContent', () => ({
  __esModule: true,
  default: jest.fn(() => <div data-testid="version-content" />),
}));

jest.mock('~/hooks', () => ({
  useLocalize: jest.fn().mockImplementation(() => (key) => key),
  useToast: jest.fn(() => ({ showToast: jest.fn() })),
}));

// Mock the AgentPanelContext
jest.mock('~/Providers/AgentPanelContext', () => ({
  ...jest.requireActual('~/Providers/AgentPanelContext'),
  useAgentPanelContext: jest.fn(),
}));

describe('VersionPanel', () => {
  const mockSetActivePanel = jest.fn();
  const mockUseAgentPanelContext = jest.requireMock(
    '~/Providers/AgentPanelContext',
  ).useAgentPanelContext;

  const mockUseGetExpandedAgentByIdQuery =
    jest.requireMock('~/data-provider').useGetExpandedAgentByIdQuery;
  const mockUseGetAgentVersionsQuery = jest.requireMock('~/data-provider').useGetAgentVersionsQuery;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUseGetExpandedAgentByIdQuery.mockReturnValue({
      data: mockAgentData,
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });
    mockUseGetAgentVersionsQuery.mockReturnValue({
      data: mockVersions,
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });

    // Set up the default context mock
    mockUseAgentPanelContext.mockReturnValue({
      setActivePanel: mockSetActivePanel,
      agent_id: 'agent-123',
      activePanel: Panel.version,
    });
  });

  test('renders panel UI and handles navigation', () => {
    render(<VersionPanel />);
    expect(screen.getByText('com_ui_agent_version_history')).toBeInTheDocument();
    expect(screen.getByTestId('version-content')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button'));
    expect(mockSetActivePanel).toHaveBeenCalledWith(Panel.builder);
  });

  test('VersionContent receives correct props', () => {
    render(<VersionPanel />);
    expect(VersionContent).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedAgentId: 'agent-123',
        isLoading: false,
        error: null,
        versionContext: expect.objectContaining({
          currentAgent: expect.any(Object),
          versions: expect.any(Array),
          versionIds: expect.any(Array),
        }),
      }),
      expect.anything(),
    );
  });

  test('handles data state variations', () => {
    // Test with empty agent_id
    mockUseAgentPanelContext.mockReturnValueOnce({
      setActivePanel: mockSetActivePanel,
      agent_id: '',
      activePanel: Panel.version,
    });
    render(<VersionPanel />);
    expect(VersionContent).toHaveBeenCalledWith(
      expect.objectContaining({ selectedAgentId: '' }),
      expect.anything(),
    );

    // Test with null data
    mockUseGetExpandedAgentByIdQuery.mockReturnValueOnce({
      data: null,
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });
    mockUseGetAgentVersionsQuery.mockReturnValueOnce({
      data: null,
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });
    mockUseAgentPanelContext.mockReturnValueOnce({
      setActivePanel: mockSetActivePanel,
      agent_id: 'agent-123',
      activePanel: Panel.version,
    });
    render(<VersionPanel />);
    expect(VersionContent).toHaveBeenCalledWith(
      expect.objectContaining({
        versionContext: expect.objectContaining({
          versions: [],
          versionIds: [],
          currentAgent: null,
        }),
      }),
      expect.anything(),
    );

    // 3. versions is undefined
    mockUseGetAgentVersionsQuery.mockReturnValueOnce({
      data: undefined,
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });
    render(<VersionPanel />);
    expect(VersionContent).toHaveBeenCalledWith(
      expect.objectContaining({
        versionContext: expect.objectContaining({ versions: [] }),
      }),
      expect.anything(),
    );

    // 4. loading state
    mockUseGetAgentVersionsQuery.mockReturnValueOnce({
      data: null,
      isLoading: true,
      error: null,
      refetch: jest.fn(),
    });
    render(<VersionPanel />);
    expect(VersionContent).toHaveBeenCalledWith(
      expect.objectContaining({ isLoading: true }),
      expect.anything(),
    );

    // 5. error state
    const testError = new Error('Test error');
    mockUseGetAgentVersionsQuery.mockReturnValueOnce({
      data: null,
      isLoading: false,
      error: testError,
      refetch: jest.fn(),
    });
    render(<VersionPanel />);
    expect(VersionContent).toHaveBeenCalledWith(
      expect.objectContaining({ error: testError }),
      expect.anything(),
    );
  });

  test('memoizes agent data correctly', () => {
    mockUseGetExpandedAgentByIdQuery.mockReturnValueOnce({
      data: mockAgentData,
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });
    mockUseGetAgentVersionsQuery.mockReturnValueOnce({
      data: mockVersions,
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });

    render(<VersionPanel />);
    expect(VersionContent).toHaveBeenCalledWith(
      expect.objectContaining({
        versionContext: expect.objectContaining({
          currentAgent: expect.objectContaining({
            name: 'Test Agent',
            description: 'Test Description',
            instructions: 'Test Instructions',
            edges: [{ from: 'agent-123', to: 'agent-specialist', edgeType: 'handoff' }],
          }),
          versions: expect.arrayContaining([
            expect.objectContaining({ name: 'Version 2' }),
            expect.objectContaining({ name: 'Version 1' }),
          ]),
        }),
      }),
      expect.anything(),
    );
  });

  test('treats versions as different when only the linked prompt differs', () => {
    const linkA = {
      source: 'native',
      groupId: 'group-a',
      selection: { type: 'production' },
    };
    const linkB = {
      source: 'native',
      groupId: 'group-b',
      selection: { type: 'production' },
    };
    const baseVersion = {
      name: mockAgentData.name,
      description: mockAgentData.description,
      instructions: mockAgentData.instructions,
      tools: mockAgentData.tools,
      capabilities: mockAgentData.capabilities,
      edges: mockAgentData.edges,
    };

    mockUseGetExpandedAgentByIdQuery.mockReturnValueOnce({
      data: { ...mockAgentData, instructionsPrompt: linkA },
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });
    mockUseGetAgentVersionsQuery.mockReturnValueOnce({
      data: [
        { ...baseVersion, instructionsPrompt: linkA, updatedAt: '2023-01-02T00:00:00Z' },
        { ...baseVersion, instructionsPrompt: linkB, updatedAt: '2023-01-01T00:00:00Z' },
      ],
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });

    render(<VersionPanel />);
    expect(VersionContent).toHaveBeenCalledWith(
      expect.objectContaining({
        versionContext: expect.objectContaining({
          activeVersion: expect.objectContaining({ instructionsPrompt: linkA }),
          versionIds: [
            expect.objectContaining({ isActive: true }),
            expect.objectContaining({ isActive: false }),
          ],
        }),
      }),
      expect.anything(),
    );
  });

  test('shows the Current badge on whichever restricted version the server flags as matchesCurrent, even the older one after a revert', () => {
    const restrictedStub = { source: 'native', restricted: true };
    const baseVersion = {
      name: mockAgentData.name,
      description: mockAgentData.description,
      instructions: mockAgentData.instructions,
      tools: mockAgentData.tools,
      capabilities: mockAgentData.capabilities,
      edges: mockAgentData.edges,
    };

    mockUseGetExpandedAgentByIdQuery.mockReturnValueOnce({
      data: { ...mockAgentData, instructionsPrompt: { ...restrictedStub } },
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });
    mockUseGetAgentVersionsQuery.mockReturnValueOnce({
      // Raw, append order. `revertAgentVersion` `$set`s the document without
      // appending a version, so the current link can equal the *older*, not
      // latest-appended, entry — the server reflects that via `matchesCurrent`
      // on each stub rather than position.
      data: [
        {
          ...baseVersion,
          instructionsPrompt: { ...restrictedStub, matchesCurrent: true },
          updatedAt: '2023-01-01T00:00:00Z',
        },
        {
          ...baseVersion,
          instructionsPrompt: { ...restrictedStub, matchesCurrent: false },
          updatedAt: '2023-01-02T00:00:00Z',
        },
      ],
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });

    render(<VersionPanel />);
    expect(VersionContent).toHaveBeenCalledWith(
      expect.objectContaining({
        versionContext: expect.objectContaining({
          activeVersion: expect.objectContaining({
            instructionsPrompt: { ...restrictedStub, matchesCurrent: true },
            updatedAt: '2023-01-01T00:00:00Z',
          }),
          // Display order is newest-first; the older (matching) entry is second.
          versionIds: [
            expect.objectContaining({ isActive: false }),
            expect.objectContaining({ isActive: true }),
          ],
        }),
      }),
      expect.anything(),
    );
  });

  test('treats versions with identical linked prompts as active', () => {
    const link = {
      source: 'native',
      groupId: 'group-a',
      selection: { type: 'production' },
    };
    const baseVersion = {
      name: mockAgentData.name,
      description: mockAgentData.description,
      instructions: mockAgentData.instructions,
      tools: mockAgentData.tools,
      capabilities: mockAgentData.capabilities,
      edges: mockAgentData.edges,
    };

    mockUseGetExpandedAgentByIdQuery.mockReturnValueOnce({
      data: { ...mockAgentData, instructionsPrompt: link },
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });
    mockUseGetAgentVersionsQuery.mockReturnValueOnce({
      data: [
        { ...baseVersion, instructionsPrompt: { ...link }, updatedAt: '2023-01-01T00:00:00Z' },
      ],
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });

    render(<VersionPanel />);
    expect(VersionContent).toHaveBeenCalledWith(
      expect.objectContaining({
        versionContext: expect.objectContaining({
          activeVersion: expect.objectContaining({ instructionsPrompt: link }),
          versionIds: [expect.objectContaining({ isActive: true })],
        }),
      }),
      expect.anything(),
    );
  });
});
