import { QueryKeys, dataService } from 'librechat-data-provider';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ProjectListResponse, TChatProject } from 'librechat-data-provider';
import type { InfiniteData } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useProjectName } from '../Projects';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: { ...actual.dataService, getProjectById: jest.fn() },
  };
});

const getProjectById = dataService.getProjectById as jest.MockedFunction<
  typeof dataService.getProjectById
>;

const project = (id: string, name: string) =>
  ({ _id: id, name, conversationCount: 1 }) as TChatProject;

const renderName = (queryClient: QueryClient, projectId: string) =>
  renderHook(() => useProjectName(projectId), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });

const seedList = (queryClient: QueryClient, projects: TChatProject[]) =>
  queryClient.setQueryData<InfiniteData<ProjectListResponse>>(
    [QueryKeys.projects, { sortBy: 'lastConversationAt', sortDirection: 'desc', limit: 25 }],
    { pages: [{ projects, nextCursor: null } as ProjectListResponse], pageParams: [undefined] },
  );

describe('useProjectName', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    jest.resetAllMocks();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    queryClient.clear();
  });

  /* Every project chat under Chats carries a badge; a request per project would turn the
     list into a burst of reads the sidebar's own project list already answers. */
  it('names a project the sidebar has listed without asking the server', () => {
    seedList(queryClient, [project('p1', 'Scheduling'), project('p2', 'Subagents')]);
    const { result } = renderName(queryClient, 'p2');

    expect(result.current).toBe('Subagents');
    expect(getProjectById).not.toHaveBeenCalled();
  });

  it('fetches a project past the listed ones', async () => {
    seedList(queryClient, [project('p1', 'Scheduling')]);
    getProjectById.mockResolvedValue(project('p9', 'Speed Chess'));
    const { result } = renderName(queryClient, 'p9');

    await waitFor(() => expect(result.current).toBe('Speed Chess'));
    expect(getProjectById).toHaveBeenCalledTimes(1);
    expect(getProjectById).toHaveBeenCalledWith('p9');
  });

  it('prefers a record written by id, such as a rename', async () => {
    seedList(queryClient, [project('p1', 'Scheduling')]);
    const { result } = renderName(queryClient, 'p1');

    act(() => {
      queryClient.setQueryData([QueryKeys.project, 'p1'], project('p1', 'Cron jobs'));
    });

    await waitFor(() => expect(result.current).toBe('Cron jobs'));
    expect(getProjectById).not.toHaveBeenCalled();
  });
});
