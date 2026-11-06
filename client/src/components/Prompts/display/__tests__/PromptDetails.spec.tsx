import React from 'react';
import '@testing-library/jest-dom/extend-expect';
import { dataService, SystemRoles } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { TPromptGroup, TResolvedLangfusePrompt } from 'librechat-data-provider';
import PromptDetails from '../PromptDetails';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      resolvePromptGroup: jest.fn(),
    },
  };
});

const resolvePromptGroup = dataService.resolvePromptGroup as jest.MockedFunction<
  typeof dataService.resolvePromptGroup
>;

const mockSubmitPrompt = jest.fn();
const mockRecordUsage = jest.fn();
// Mutable so individual tests can exercise an admin vs. a regular user.
let mockUser: { id: string; role?: string } = { id: 'user-1', role: SystemRoles.USER };

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${JSON.stringify(values)}` : key,
  useAuthContext: () => ({ user: mockUser }),
  useSubmitMessage: () => ({ submitPrompt: mockSubmitPrompt }),
  // The real hook: the point of these tests is to exercise its loading,
  // success and error outcomes end-to-end, including the "no request for a
  // native group" guarantee.
  usePromptContent: jest.requireActual('~/hooks/Prompts/usePromptContent').default,
}));

jest.mock('~/data-provider', () => {
  const actual = jest.requireActual('~/data-provider');
  return {
    ...actual,
    useRecordPromptUsage: () => ({ mutate: mockRecordUsage }),
  };
});

// SharePrompt pulls in ACL/resource-permission hooks unrelated to this
// component's own behavior; stubbed the same way `PromptForm.spec.tsx` stubs
// its sibling dialogs.
jest.mock('../../dialogs/SharePrompt', () => ({
  __esModule: true,
  default: () => <button type="button" data-testid="share-prompt" />,
}));

function makeGroup(overrides: Partial<TPromptGroup> = {}): TPromptGroup {
  return {
    _id: 'group-1',
    name: 'Example Group',
    author: 'author-1',
    authorName: 'Author',
    source: 'native',
    productionPrompt: { prompt: 'Native production text' },
    ...overrides,
  } as TPromptGroup;
}

function langfuseResolved(
  overrides: Partial<TResolvedLangfusePrompt> = {},
): TResolvedLangfusePrompt {
  return {
    source: 'langfuse',
    groupId: 'group-1',
    prompt: 'Live Langfuse text',
    type: 'text',
    version: 3,
    labels: ['production', 'latest'],
    sourceUrl: 'https://cloud.langfuse.test/project/project-1/prompts/greeting',
    ...overrides,
  };
}

const createQueryClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

function renderDetails(group: TPromptGroup) {
  const queryClient = createQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <PromptDetails group={group} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUser = { id: 'user-1', role: SystemRoles.USER };
});

// `PromptDetailHeader`'s source badge is a bare `<svg aria-label>` (matching
// the existing `EarthIcon` global badge beside it); jsdom's role computation
// has no implicit "img" mapping for a plain `<svg>`, so presence is checked
// by its `aria-label` attribute directly rather than through `getByRole`.
const findSourceBadge = (container: HTMLElement) =>
  container.querySelector('[aria-label="com_ui_prompt_source_langfuse"]');

describe('PromptDetails', () => {
  it('renders a native group synchronously with no resolve request', () => {
    const { container } = renderDetails(makeGroup());

    expect(screen.getByText('Native production text')).toBeInTheDocument();
    expect(resolvePromptGroup).not.toHaveBeenCalled();
    expect(findSourceBadge(container)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'com_ui_use_prompt' })).toBeEnabled();
  });

  it('shows the resolving label and disables Use while a Langfuse group is loading', () => {
    resolvePromptGroup.mockReturnValue(new Promise(() => {}));
    const { container } = renderDetails(makeGroup({ source: 'langfuse', productionPrompt: null }));

    expect(screen.getByText('com_ui_prompt_resolving')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'com_ui_use_prompt' })).toBeDisabled();
    expect(findSourceBadge(container)).toBeInTheDocument();
  });

  it('renders the resolved text, variables and version/labels line on success', async () => {
    resolvePromptGroup.mockResolvedValue(langfuseResolved({ prompt: 'Hello {{name}}' }));
    renderDetails(makeGroup({ source: 'langfuse', productionPrompt: null }));

    await waitFor(() => expect(screen.getByText(/Hello/)).toBeInTheDocument());

    expect(screen.getByRole('list', { name: 'com_ui_prompt_variables_list' })).toBeInTheDocument();
    expect(
      screen.getByText('com_ui_prompt_version {"0":3} · production, latest'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'com_ui_use_prompt' })).toBeEnabled();
  });

  it('renders the error copy with role=alert and disables Use on a failed resolution', async () => {
    resolvePromptGroup.mockRejectedValue(new Error('resolve failed'));
    renderDetails(makeGroup({ source: 'langfuse', productionPrompt: null }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('com_ui_langfuse_prompt_error_fallback');
    expect(screen.getByRole('button', { name: 'com_ui_use_prompt' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'com_ui_retry' })).toBeInTheDocument();
  });

  it('retries the resolve on click, rendering the text and enabling Use on success', async () => {
    resolvePromptGroup.mockRejectedValueOnce(new Error('resolve failed'));
    resolvePromptGroup.mockResolvedValueOnce(langfuseResolved({ prompt: 'Recovered text' }));
    renderDetails(makeGroup({ source: 'langfuse', productionPrompt: null }));

    await screen.findByRole('alert');
    expect(resolvePromptGroup).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));

    await waitFor(() => expect(screen.getByText(/Recovered text/)).toBeInTheDocument());
    expect(resolvePromptGroup).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'com_ui_use_prompt' })).toBeEnabled();
  });

  it('shows the Open in Langfuse link for an admin', async () => {
    mockUser = { id: 'admin-1', role: SystemRoles.ADMIN };
    resolvePromptGroup.mockResolvedValue(langfuseResolved());
    renderDetails(makeGroup({ source: 'langfuse', productionPrompt: null }));

    expect(
      await screen.findByRole('link', { name: 'com_ui_prompt_open_in_langfuse' }),
    ).toHaveAttribute('href', 'https://cloud.langfuse.test/project/project-1/prompts/greeting');
  });

  it('hides the Open in Langfuse link for a regular user, for whom the server strips sourceUrl', async () => {
    const resolvedWithoutSourceUrl: TResolvedLangfusePrompt = {
      ...langfuseResolved(),
      sourceUrl: undefined,
    };
    resolvePromptGroup.mockResolvedValue(resolvedWithoutSourceUrl);
    renderDetails(makeGroup({ source: 'langfuse', productionPrompt: null }));

    await waitFor(() => expect(screen.getByText(/com_ui_prompt_version/)).toBeInTheDocument());
    expect(
      screen.queryByRole('link', { name: 'com_ui_prompt_open_in_langfuse' }),
    ).not.toBeInTheDocument();
  });

  it('hides the Open in Langfuse link for an admin when the resolved response has no sourceUrl', async () => {
    mockUser = { id: 'admin-1', role: SystemRoles.ADMIN };
    const resolvedWithoutSourceUrl: TResolvedLangfusePrompt = {
      ...langfuseResolved(),
      sourceUrl: undefined,
    };
    resolvePromptGroup.mockResolvedValue(resolvedWithoutSourceUrl);
    renderDetails(makeGroup({ source: 'langfuse', productionPrompt: null }));

    await waitFor(() => expect(screen.getByText(/com_ui_prompt_version/)).toBeInTheDocument());
    expect(
      screen.queryByRole('link', { name: 'com_ui_prompt_open_in_langfuse' }),
    ).not.toBeInTheDocument();
  });
});
