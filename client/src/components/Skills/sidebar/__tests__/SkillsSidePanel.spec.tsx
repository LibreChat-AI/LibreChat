import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import type { TSkillListResponse, TSkillSummary } from 'librechat-data-provider';
import SkillsSidePanel from '../SkillsSidePanel';

const mockFetchNextPage = jest.fn();
const mockRefetch = jest.fn();
let mockSidebarExpanded = true;
let mockHasAccess = true;
const mockUseNavScrolling = jest.fn((_options?: object) => ({
  containerRef: { current: null },
}));
const mockQuery = {
  data: { pages: [{ skills: [], has_more: true, after: 'cursor-2' }] } as {
    pages: TSkillListResponse[];
  },
  isFetchingNextPage: false,
  fetchNextPage: mockFetchNextPage,
  refetch: mockRefetch,
  isLoading: false,
  isError: false,
};
const mockUseSkillsInfiniteQuery = jest.fn((_params?: object, _config?: object) => mockQuery);

jest.mock('recoil', () => ({
  useRecoilValue: () => mockSidebarExpanded,
}));

jest.mock('~/store', () => ({
  __esModule: true,
  default: { sidebarExpanded: {} },
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useHasAccess: () => mockHasAccess,
  useDebounce: (value: string) => value,
  useNavScrolling: (options: object) => mockUseNavScrolling(options),
}));

jest.mock('~/data-provider', () => ({
  useSkillsInfiniteQuery: (params?: object, config?: object) =>
    mockUseSkillsInfiniteQuery(params, config),
}));

jest.mock('~/components/ui', () => {
  const ReactModule = jest.requireActual<typeof import('react')>('react');
  const PanelContent = ReactModule.forwardRef<
    HTMLDivElement,
    { children?: React.ReactNode; isLoading: boolean; skeleton: React.ReactNode }
  >(({ children, isLoading, skeleton }, ref) => (
    <div ref={ref}>{isLoading ? <div role="status">{skeleton}</div> : children}</div>
  ));
  const Collapse = ({ open, children }: { open: boolean; children?: React.ReactNode }) => (
    <div hidden={!open}>{children}</div>
  );
  const { default: ListLoading } = jest.requireActual<typeof import('~/components/ui/ListLoading')>(
    '~/components/ui/ListLoading',
  );
  return { PanelContent, Collapse, ListLoading };
});

jest.mock('../FilterSkills', () => ({
  __esModule: true,
  default: ({ searchTerm, onSearchChange }: {
    searchTerm: string;
    onSearchChange: React.ChangeEventHandler<HTMLInputElement>;
  }) => <input aria-label="filter skills" value={searchTerm} onChange={onSearchChange} />,
}));

jest.mock('../../lists/SkillListItem', () => ({
  __esModule: true,
  default: ({ skill }: { skill: { name: string } }) => <div>{skill.name}</div>,
}));

function renderPanel(visible?: boolean) {
  return render(<MemoryRouter><SkillsSidePanel visible={visible} /></MemoryRouter>);
}

describe('SkillsSidePanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHasAccess = true;
    mockSidebarExpanded = true;
    mockQuery.isLoading = false;
    mockQuery.isError = false;
    mockQuery.isFetchingNextPage = false;
    mockQuery.data = { pages: [{ skills: [], has_more: true, after: 'cursor-2' }] };
  });

  it('disables automatic pagination while My Skills is collapsed', () => {
    renderPanel();
    const toggle = screen.getByRole('button', { name: 'com_ui_my_skills' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(mockUseNavScrolling).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true }));
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(mockUseNavScrolling).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
    fireEvent.click(toggle);
    expect(mockUseNavScrolling).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true }));
  });

  it('asks for a first page large enough to fill a tall panel', () => {
    renderPanel();
    expect(mockUseSkillsInfiniteQuery).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50 }), { enabled: true },
    );
  });

  it('uses explicit page visibility when the sidebar is collapsed', () => {
    mockSidebarExpanded = false;
    renderPanel(true);
    expect(mockUseNavScrolling).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true }));
  });

  it('does not paginate a hidden retained host', () => {
    renderPanel(false);
    expect(mockUseNavScrolling).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
  });

  it('disables the query and does not display cached skills without USE permission', () => {
    mockHasAccess = false;
    renderPanel(true);
    expect(mockUseSkillsInfiniteQuery).toHaveBeenCalledWith(expect.anything(), { enabled: false });
    expect(screen.getByText('com_ui_feature_no_access')).toBeInTheDocument();
    expect(screen.queryByLabelText('filter skills')).not.toBeInTheDocument();
  });

  it('shows loading instead of an empty collection', () => {
    mockQuery.isLoading = true;
    renderPanel(true);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByText('com_ui_skills_empty')).not.toBeInTheDocument();
  });

  it('shows an empty collection and filters with the existing query', () => {
    renderPanel(true);
    expect(screen.getByText('com_ui_skills_empty')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('filter skills'), { target: { value: 'database' } });
    expect(mockUseSkillsInfiniteQuery).toHaveBeenLastCalledWith(
      { search: 'database', limit: 50 }, { enabled: true },
    );
    expect(screen.getByText('com_ui_no_results_found')).toBeInTheDocument();
  });

  it('renders loaded skills and retains them if a later page fails', () => {
    const skill: TSkillSummary = {
      _id: 'skill-1', name: 'database', description: 'Query databases', author: 'user',
      authorName: 'User', version: 1, source: 'inline', fileCount: 0,
      createdAt: '', updatedAt: '',
    };
    mockQuery.data = { pages: [{ skills: [skill], has_more: true, after: 'cursor-2' }] };
    mockQuery.isError = true;
    renderPanel(true);
    expect(screen.getByText('database')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'com_ui_retry' })).toBeInTheDocument();
  });

  it('keeps the filter and collapsed section while the retained host changes visibility', () => {
    const view = renderPanel(true);
    fireEvent.change(screen.getByLabelText('filter skills'), { target: { value: 'draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_my_skills' }));
    view.rerender(<MemoryRouter><SkillsSidePanel visible={false} /></MemoryRouter>);
    view.rerender(<MemoryRouter><SkillsSidePanel visible /></MemoryRouter>);
    expect(screen.getByLabelText('filter skills')).toHaveValue('draft');
    expect(screen.getByRole('button', { name: 'com_ui_my_skills' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('offers retry instead of claiming the collection is empty on failure', () => {
    mockQuery.isError = true;
    renderPanel(true);
    expect(screen.getByRole('alert')).toHaveTextContent('com_ui_collection_load_error');
    expect(screen.queryByText('com_ui_skills_empty')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
    expect(mockRefetch).toHaveBeenCalledTimes(1);
    expect(mockUseNavScrolling).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
  });

  it('shows the shared loading footer only while the next page loads', () => {
    const { rerender } = renderPanel();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    mockQuery.isFetchingNextPage = true;
    rerender(<MemoryRouter><SkillsSidePanel /></MemoryRouter>);
    expect(screen.getByRole('status')).toHaveTextContent('com_ui_loading');
  });
});
