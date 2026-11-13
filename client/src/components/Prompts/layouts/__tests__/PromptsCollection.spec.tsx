import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import type { TPromptGroup } from 'librechat-data-provider';
import PromptsCollection from '../PromptsCollection';

const mockActivateCatalog = jest.fn();
const mockRefetch = jest.fn();
const mockSetName = jest.fn();
const mockUseNavScrolling = jest.fn((_options: object) => ({ containerRef: { current: null } }));
let mockSidebarExpanded = false;
let mockCanCreate = true;
const mockContext = {
  hasAccess: true,
  name: '',
  setName: mockSetName,
  promptGroups: [] as TPromptGroup[],
  groupsQuery: { isLoading: false, isError: false, refetch: mockRefetch },
  nextCursor: null,
  isFetchingNextPage: false,
};

jest.mock('~/Providers', () => ({ usePromptGroupsContext: () => mockContext }));
jest.mock('~/store', () => ({
  __esModule: true,
  default: { sidebarExpanded: {}, promptsCategory: {} },
}));
jest.mock('recoil', () => ({
  useRecoilValue: () => mockSidebarExpanded,
  useRecoilState: () => jest.requireActual<typeof import('react')>('react').useState(''),
}));
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useHasAccess: () => mockCanCreate,
  useCategories: () => ({ categories: [] }),
  useDebounce: (value: string) => value,
  useNavScrolling: (options: object) => mockUseNavScrolling(options),
  activateCatalog: (catalog: string) => mockActivateCatalog(catalog),
}));
jest.mock('librechat-data-provider/react-query', () => ({
  useGetAllEffectivePermissionsQuery: () => ({ data: {} }),
}));
jest.mock('~/components/ui', () => {
  const ReactModule = jest.requireActual<typeof import('react')>('react');
  return {
    PanelHeader: jest.requireActual('~/components/ui/PanelHeader').default,
    PanelContent: ReactModule.forwardRef<HTMLDivElement, {
      children?: React.ReactNode;
      isLoading: boolean;
      skeleton: React.ReactNode;
    }>(({ children, isLoading, skeleton }, ref) => (
      <div ref={ref}>{isLoading ? <div role="status">{skeleton}</div> : children}</div>
    )),
  };
});
jest.mock('../../dialogs/CreatePromptDialog', () => {
  const { OGDialog } = jest.requireActual('@librechat/client');
  return {
    __esModule: true,
    default: ({ children }: { children: React.ReactNode }) => <OGDialog>{children}</OGDialog>,
  };
});
jest.mock('../../lists/ChatGroupItem', () => ({
  __esModule: true,
  default: ({ group, isChatRoute }: { group: TPromptGroup; isChatRoute: boolean }) => (
    <div data-testid="prompt-row" data-chat-route={String(isChatRoute)}>{group.name}</div>
  ),
}));
jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  TooltipAnchor: ({ render: content }: { render: React.ReactNode }) => content,
}));

function renderCollection() {
  return render(<MemoryRouter initialEntries={['/prompts']}><PromptsCollection /></MemoryRouter>);
}

describe('PromptsCollection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockContext.hasAccess = true;
    mockContext.name = '';
    mockContext.promptGroups = [];
    mockContext.groupsQuery.isLoading = false;
    mockContext.groupsQuery.isError = false;
    mockSidebarExpanded = false;
    mockCanCreate = true;
  });

  it('provides Create and filter controls, and activates the visible page despite a collapsed sidebar', () => {
    renderCollection();
    expect(screen.getByRole('button', { name: 'com_ui_create_prompt' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'com_ui_filter_prompts_name' }), {
      target: { value: 'research' },
    });
    expect(mockSetName).toHaveBeenLastCalledWith('research');
    expect(mockActivateCatalog).toHaveBeenCalledWith('prompts');
    expect(mockUseNavScrolling).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true }));
  });

  it('does not release a hidden retained collection catalog', () => {
    render(<MemoryRouter><PromptsCollection visible={false} /></MemoryRouter>);
    expect(mockActivateCatalog).not.toHaveBeenCalled();
    expect(mockUseNavScrolling).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
  });

  it('shows loading instead of an empty list', () => {
    mockContext.groupsQuery.isLoading = true;
    renderCollection();
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByText('com_ui_no_prompts_title')).not.toBeInTheDocument();
  });

  it('shows a useful empty collection', () => {
    renderCollection();
    expect(screen.getByText('com_ui_no_prompts_title')).toBeInTheDocument();
  });

  it('distinguishes no search matches from no saved prompts', () => {
    mockContext.name = 'missing';
    renderCollection();
    expect(screen.getByText('com_ui_no_results_found')).toBeInTheDocument();
    expect(screen.queryByText('com_ui_add_first_prompt')).not.toBeInTheDocument();
  });

  it('renders loaded rows in management mode, not submission mode', () => {
    mockContext.promptGroups = [{ _id: 'group-1', name: 'Research' } as TPromptGroup];
    renderCollection();
    expect(screen.getByTestId('prompt-row')).toHaveAttribute('data-chat-route', 'false');
    expect(screen.getByText('Research')).toBeInTheDocument();
  });

  it('shows failure and retries the existing collection query', () => {
    mockContext.groupsQuery.isError = true;
    renderCollection();
    expect(screen.getByRole('alert')).toHaveTextContent('com_ui_collection_load_error');
    expect(screen.queryByText('com_ui_no_prompts_title')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
    expect(mockRefetch).toHaveBeenCalledTimes(1);
    expect(mockUseNavScrolling).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
  });

  it('keeps loaded rows when fetching another page fails', () => {
    mockContext.groupsQuery.isError = true;
    mockContext.promptGroups = [{ _id: 'group-1', name: 'Research' } as TPromptGroup];
    renderCollection();
    expect(screen.getByText('Research')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'com_ui_retry' })).toBeInTheDocument();
  });

  it('does not show or activate a collection without USE permission', () => {
    mockContext.hasAccess = false;
    renderCollection();
    expect(screen.getByText('com_ui_feature_no_access')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(mockActivateCatalog).not.toHaveBeenCalled();
  });

  it('hides Create without blocking browsing for a USE-only role', () => {
    mockCanCreate = false;
    renderCollection();
    expect(screen.queryByRole('button', { name: 'com_ui_create_prompt' })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'com_ui_filter_prompts_name' })).toBeInTheDocument();
  });
});
