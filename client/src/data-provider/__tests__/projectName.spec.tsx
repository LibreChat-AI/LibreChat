import { QueryKeys, dataService } from 'librechat-data-provider';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ProjectListResponse, TChatProject } from 'librechat-data-provider';
import type { InfiniteData } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useProjectName, useProjectsInfiniteQuery } from '../Projects';
import ProjectNamesProvider from '~/Providers/ProjectNamesContext';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: { ...actual.dataService, getProjectById: jest.fn(), listProjects: jest.fn() },
  };
});

const getProjectById = dataService.getProjectById as jest.MockedFunction<
  typeof dataService.getProjectById
>;

const listProjects = dataService.listProjects as jest.MockedFunction<
  typeof dataService.listProjects
>;
const listParams = { sortBy: 'lastConversationAt', sortDirection: 'desc', limit: 25 } as const;

function SidebarProjects({ children }: { children: ReactNode }) {
  const { data, isLoading, isError } = useProjectsInfiniteQuery(listParams);
  return (
    <ProjectNamesProvider data={data} isPending={isLoading && !isError}>
      {children}
    </ProjectNamesProvider>
  );
}

const project = (id: string, name: string) =>
  ({ _id: id, name, conversationCount: 1 }) as TChatProject;

const renderName = (queryClient: QueryClient, projectId?: string | null) =>
  renderHook(() => useProjectName(projectId), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <SidebarProjects>{children}</SidebarProjects>
      </QueryClientProvider>
    ),
  });

const seedList = (queryClient: QueryClient, projects: TChatProject[]) =>
  queryClient.setQueryData<InfiniteData<ProjectListResponse>>([QueryKeys.projects, listParams], {
    pages: [{ projects, nextCursor: null } as ProjectListResponse],
    pageParams: [undefined],
  });

describe('useProjectName', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    jest.resetAllMocks();
    listProjects.mockResolvedValue({ projects: [], nextCursor: null });
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    queryClient.clear();
  });

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
  it('waits for the shared list on a cold load and reacts when it arrives', async () => {
    let resolveList!: (value: ProjectListResponse) => void;
    listProjects.mockReturnValue(
      new Promise((resolve) => {
        resolveList = resolve;
      }),
    );
    const { result } = renderName(queryClient, 'p1');
    expect(result.current).toBeUndefined();
    expect(getProjectById).not.toHaveBeenCalled();

    await act(async () => {
      resolveList({ projects: [project('p1', 'Scheduling')], nextCursor: null });
    });
    await waitFor(() => expect(result.current).toBe('Scheduling'));
    expect(getProjectById).not.toHaveBeenCalled();
    expect(listProjects).toHaveBeenCalledTimes(1);
  });

  it('reacts to a project name updated in the list', async () => {
    seedList(queryClient, [project('p1', 'Scheduling')]);
    const { result } = renderName(queryClient, 'p1');
    act(() => {
      seedList(queryClient, [project('p1', 'Cron jobs')]);
    });
    await waitFor(() => expect(result.current).toBe('Cron jobs'));
    expect(getProjectById).not.toHaveBeenCalled();
  });

  it.each([undefined, null, ''])('never fetches an absent project ID (%s)', async (id) => {
    seedList(queryClient, []);
    const { result } = renderName(queryClient, id);
    expect(result.current).toBeUndefined();
    expect(getProjectById).not.toHaveBeenCalled();
  });

  it('falls back after the list fails', async () => {
    listProjects.mockRejectedValue(new Error('List unavailable'));
    queryClient.setDefaultOptions({ queries: { retry: false } });
    getProjectById.mockResolvedValue(project('p9', 'Speed Chess'));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { result } = renderName(queryClient, 'p9');
      await waitFor(() => expect(result.current).toBe('Speed Chess'));
      expect(getProjectById).toHaveBeenCalledTimes(1);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('deduplicates fallback requests for multiple rows of the same project', async () => {
    seedList(queryClient, []);
    getProjectById.mockResolvedValue(project('p9', 'Speed Chess'));
    const first = renderName(queryClient, 'p9');
    const second = renderName(queryClient, 'p9');
    await waitFor(() => {
      expect(first.result.current).toBe('Speed Chess');
      expect(second.result.current).toBe('Speed Chess');
    });
    expect(getProjectById).toHaveBeenCalledTimes(1);
  });
});
