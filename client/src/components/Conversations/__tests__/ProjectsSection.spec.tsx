import { MemoryRouter } from 'react-router-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type Page = { conversations: { conversationId: string; title: string }[]; nextCursor: null };

const mockListChats = jest.fn<Promise<Page>, [string]>();

const mockProjects = [
  { _id: 'p1', name: 'Home' },
  { _id: 'p2', name: 'Guardrails' },
];

jest.mock('~/data-provider', () => {
  const { useInfiniteQuery } = jest.requireActual('@tanstack/react-query');
  return {
    useActiveJobs: () => ({ data: undefined }),
    useProjectsInfiniteQuery: () => ({
      data: { pages: [{ projects: mockProjects, nextCursor: null }] },
      isLoading: false,
    }),
    /** The real observer, so the spec sees what a disabled query actually reports. */
    useConversationsInfiniteQuery: (params: { projectId: string }, config: object) =>
      useInfiniteQuery({
        queryKey: ['project-chats', params.projectId],
        queryFn: () => mockListChats(params.projectId),
        ...config,
      }),
  };
});

jest.mock('react-dnd', () => ({
  useDrop: () => [{ isDropOver: false, canDrop: false }, () => undefined],
}));

jest.mock('../dnd', () => ({
  CONVERSATION_DRAG_TYPE: 'conversation',
  markExternalHover: () => undefined,
  useAssignDroppedConversation: () => () => Promise.resolve(true),
  useEffectiveProjectId: () => () => null,
}));

jest.mock('recoil', () => ({ useRecoilValue: () => null }));

jest.mock('~/store', () => ({
  __esModule: true,
  default: { conversationIdByIndex: () => null, conversationByIndex: () => null },
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useLocalStorage: () => [true, () => undefined],
  useNewConvo: () => ({ newConversation: () => undefined }),
}));

jest.mock('~/utils', () => ({
  clearMessagesCache: () => undefined,
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(' '),
  rowActionClasses: () => '',
}));

jest.mock('~/components/ui', () => ({
  Collapse: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

jest.mock('@librechat/client', () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
  Skeleton: () => <div />,
  Spinner: () => <div />,
  TooltipAnchor: ({ render: anchor }: { render: React.ReactNode }) => <>{anchor}</>,
  DropdownPopup: () => null,
  NewChatIcon: () => null,
  buttonVariants: () => '',
}));

jest.mock('~/components/Projects/ProjectCreateDialog', () => () => null);
jest.mock('~/components/Projects/ProjectDeleteDialog', () => () => null);
jest.mock('~/components/Projects/ProjectEditDialog', () => () => null);

jest.mock('../Convo', () => ({
  __esModule: true,
  default: ({ conversation }: { conversation: { title: string } }) => (
    <div>{conversation.title}</div>
  ),
}));

import ProjectsSection from '../ProjectsSection';

const renderSection = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter>
        <ProjectsSection toggleNav={() => undefined} isAuthenticated />
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe('ProjectsSection closed projects', () => {
  let resolveChats: (page: Page) => void;

  beforeEach(() => {
    mockListChats.mockImplementation(
      () =>
        new Promise<Page>((resolve) => {
          resolveChats = resolve;
        }),
    );
  });

  it('mounts neither skeletons nor an empty notice for a project that was never opened', () => {
    renderSection();

    expect(screen.queryByTestId('project-chats-loading-p1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('project-chats-loading-p2')).not.toBeInTheDocument();
    expect(screen.queryByText('com_ui_no_project_chats')).not.toBeInTheDocument();
    expect(mockListChats).not.toHaveBeenCalled();
  });

  it('shows skeletons the moment a project opens, then its chats', async () => {
    renderSection();

    fireEvent.click(screen.getByRole('button', { name: 'Home' }));

    expect(screen.getByTestId('project-chats-loading-p1')).toBeInTheDocument();
    expect(screen.queryByTestId('project-chats-loading-p2')).not.toBeInTheDocument();
    expect(mockListChats).toHaveBeenCalledWith('p1');

    await act(async () => {
      resolveChats({ conversations: [{ conversationId: 'c1', title: 'First' }], nextCursor: null });
    });

    expect(await screen.findByTestId('project-chats-p1')).toHaveTextContent('First');
    expect(screen.queryByTestId('project-chats-loading-p1')).not.toBeInTheDocument();
  });

  it('calls a project empty only once its chats came back empty', async () => {
    renderSection();

    fireEvent.click(screen.getByRole('button', { name: 'Home' }));
    expect(screen.queryByText('com_ui_no_project_chats')).not.toBeInTheDocument();

    await act(async () => {
      resolveChats({ conversations: [], nextCursor: null });
    });

    expect(await screen.findByText('com_ui_no_project_chats')).toBeInTheDocument();
  });
});
