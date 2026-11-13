import React from 'react';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import InlinePromptsView from '../InlinePromptsView';

let mockHasAccess = true;
let mockRolesLoaded = true;

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useHasAccess: () => mockHasAccess,
  useAuthContext: () => ({
    user: { role: 'USER' },
    roles: mockRolesLoaded ? { USER: {} } : undefined,
  }),
}));
jest.mock('../PromptsCollection', () => ({
  __esModule: true,
  default: () => <div data-testid="prompts-collection" />,
}));
jest.mock('../../forms/PromptForm', () => ({
  __esModule: true,
  default: ({ promptId }: { promptId: string }) => <div data-testid="prompt-form">{promptId}</div>,
}));

function renderView(path: string) {
  const router = createMemoryRouter(
    [
      { path: '/prompts', element: <InlinePromptsView /> },
      { path: '/prompts/:promptId', element: <InlinePromptsView /> },
      { path: '/c/new', element: <div>{'chat'}</div> },
    ],
    { initialEntries: [path] },
  );
  return render(<RouterProvider router={router} />);
}

beforeEach(() => {
  mockHasAccess = true;
  mockRolesLoaded = true;
});

it('renders the standalone collection when no prompt is selected', () => {
  renderView('/prompts');
  expect(screen.getByTestId('prompts-collection')).toBeInTheDocument();
  expect(screen.queryByTestId('prompt-form')).not.toBeInTheDocument();
});

it('keeps the existing prompt detail URL and forwards its id to PromptForm', () => {
  renderView('/prompts/group-1');
  expect(screen.getByTestId('prompt-form')).toHaveTextContent('group-1');
  expect(screen.queryByTestId('prompts-collection')).not.toBeInTheDocument();
});

it('does not mount collection content before role permissions are available', () => {
  mockRolesLoaded = false;
  mockHasAccess = false;
  renderView('/prompts');
  expect(screen.queryByTestId('prompts-collection')).not.toBeInTheDocument();
  expect(screen.queryByText('chat')).not.toBeInTheDocument();
  expect(screen.getByLabelText('com_ui_loading')).toBeInTheDocument();
});

it('preserves permission denial for prompt management', () => {
  mockHasAccess = false;
  renderView('/prompts/group-1');
  expect(screen.getByText('chat')).toBeInTheDocument();
  expect(screen.queryByTestId('prompt-form')).not.toBeInTheDocument();
});
