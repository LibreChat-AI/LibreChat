import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import { artifactNavigationRequestAtom } from '~/components/ArtifactApps/navigation';
import Presentation from './Presentation';

const mockUseRecoilValue = jest.fn();
const mockUseAtomValue = jest.fn((_atom?: unknown): unknown => null);
let mockArtifactNavigationRequest: {
  conversationId: string;
  sourceKey: string;
} | null = null;

jest.mock('recoil', () => ({
  useRecoilValue: (atom: { key: string }) => mockUseRecoilValue(atom),
  useResetRecoilState: () => jest.fn(),
}));

jest.mock('jotai', () => ({
  ...jest.requireActual('jotai'),
  useAtomValue: (atom: unknown) => mockUseAtomValue(atom),
  useSetAtom: () => jest.fn(),
}));

jest.mock('~/store', () => ({
  __esModule: true,
  default: {
    artifactsState: { key: 'artifactsState' },
    artifactsVisibility: { key: 'artifactsVisibility' },
    currentArtifactId: { key: 'currentArtifactId' },
    conversationIdByIndex: () => ({ key: 'conversationId' }),
    effectiveEndpointByIndex: () => ({ key: 'conversationEndpoint' }),
    conversationAgentIdByIndex: () => ({ key: 'conversationAgentId' }),
  },
}));

jest.mock('~/hooks/Artifacts/useResetArtifactsOnConversationChange', () => () => undefined);
jest.mock('~/hooks', () => ({ useSetFilesToDelete: () => jest.fn() }));
jest.mock('~/data-provider', () => ({
  useDeleteFilesMutation: () => ({ mutateAsync: jest.fn() }),
}));
jest.mock('~/Providers', () => ({
  ArtifactsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  EditorProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock('~/components/Chat/Input/Files/DragDropWrapper', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock('~/components/Chat/Subagents/ParentSubagentsProvider', () => ({
  ParentSubagentsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock('~/components/Chat/Subagents/state', () => ({ activeSubagentPanel: {} }));
jest.mock('~/components/Chat/Surface', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock('~/components/SidePanel', () => ({
  SidePanelGroup: ({ panel, children }: { panel: React.ReactNode; children: React.ReactNode }) => (
    <>
      {panel}
      {children}
    </>
  ),
}));
jest.mock('~/components/Artifacts/Artifacts', () => ({
  __esModule: true,
  default: () => <div data-testid="artifacts-panel" />,
}));
jest.mock('~/components/ArtifactApps/ArtifactCatalogRegistrar', () => ({
  __esModule: true,
  default: () => null,
}));

describe('Presentation artifact catalog navigation', () => {
  beforeEach(() => {
    localStorage.clear();
    mockUseRecoilValue.mockImplementation(({ key }: { key: string }) => {
      if (key === 'artifactsState') {
        return { 'artifact-1': { id: 'artifact-1' } };
      }
      if (key === 'artifactsVisibility') {
        return true;
      }
      return null;
    });
    mockUseAtomValue.mockImplementation((atom) => {
      if (atom === artifactNavigationRequestAtom) {
        return mockArtifactNavigationRequest;
      }
      return null;
    });
    mockArtifactNavigationRequest = null;
  });

  it('mounts the artifact panel from a catalog navigation request after the query is stripped', async () => {
    mockArtifactNavigationRequest = {
      conversationId: 'conversation-1',
      sourceKey: 'identifier:artifact-1',
    };

    render(
      <MemoryRouter initialEntries={['/c/conversation-1']}>
        <Presentation>
          <div data-testid="conversation" />
        </Presentation>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('artifacts-panel')).toBeInTheDocument();
  });

  it('mounts the artifact panel while a catalog deep link is awaiting selection', async () => {
    render(
      <MemoryRouter initialEntries={['/c/conversation-1?artifact=artifact-1']}>
        <Presentation>
          <div data-testid="conversation" />
        </Presentation>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('artifacts-panel')).toBeInTheDocument();
  });

  it('keeps an idle history artifact closed without a catalog deep link', () => {
    render(
      <MemoryRouter initialEntries={['/c/conversation-1']}>
        <Presentation>
          <div data-testid="conversation" />
        </Presentation>
      </MemoryRouter>,
    );

    expect(screen.queryByTestId('artifacts-panel')).not.toBeInTheDocument();
  });
});
