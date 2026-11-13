import React from 'react';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import SkillsView from '../SkillsView';

const mockUseHasAccess = jest.fn((..._args: unknown[]) => true);
const mockUseMediaQuery = jest.fn((_query: string) => false);
const mockGetSkillByIdQuery = jest.fn(() => ({
  isLoading: false,
  isError: false,
  data: null as { _id: string; name: string } | null,
}));

jest.mock('librechat-data-provider', () => ({
  PermissionTypes: { SKILLS: 'skills' },
  Permissions: { USE: 'use', CREATE: 'create' },
}));

jest.mock('@librechat/client', () => ({
  Spinner: () => <div data-testid="spinner" />,
  useMediaQuery: (query: string) => mockUseMediaQuery(query),
  useRemScale: () => 1,
}));

jest.mock('~/components/Chat/Menus/OpenSidebar', () => ({
  __esModule: true,
  default: () => <div data-testid="open-sidebar" />,
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useHasAccess: (...args: unknown[]) => mockUseHasAccess(...args),
  useAuthContext: () => ({
    user: { role: 'admin' },
    roles: { admin: {} },
  }),
}));

jest.mock('~/data-provider', () => ({
  useGetSkillByIdQuery: () => mockGetSkillByIdQuery(),
}));

jest.mock('../SkillsCollection', () => ({
  __esModule: true,
  default: () => <div data-testid="skills-collection" />,
}));

jest.mock('~/components/Skills/forms', () => ({
  CreateSkillForm: () => <div data-testid="create-skill-form" />,
  SkillForm: () => <div data-testid="skill-form" />,
}));

jest.mock(
  '~/components/Skills/display/SkillFileViewer',
  () =>
    ({ skill, relativePath }: { skill?: { name: string }; relativePath: string }) => (
      <div data-testid="skill-file-viewer">{`${skill?.name}:${relativePath}`}</div>
    ),
);
jest.mock('~/components/Skills/display/SkillDetail', () => () => (
  <div data-testid="skill-detail" />
));
jest.mock('~/components/Skills/display/SkillState', () => ({ title }: { title: string }) => (
  <div>{title}</div>
));

describe('SkillsView', () => {
  beforeEach(() => {
    mockUseHasAccess.mockReset();
    mockUseHasAccess.mockReturnValue(true);
    mockUseMediaQuery.mockReset();
    mockUseMediaQuery.mockReturnValue(false);
    mockGetSkillByIdQuery.mockReset();
    mockGetSkillByIdQuery.mockReturnValue({ isLoading: false, isError: false, data: null });
  });

  it('renders the collection for /skills instead of a no-selection screen', () => {
    const router = createMemoryRouter([{ path: '/skills', element: <SkillsView /> }], {
      initialEntries: ['/skills'],
    });
    render(<RouterProvider router={router} />);
    expect(screen.getByTestId('skills-collection')).toBeInTheDocument();
    expect(mockGetSkillByIdQuery).not.toHaveBeenCalled();
  });

  it('keeps the existing edit route', () => {
    const router = createMemoryRouter(
      [{ path: '/skills/:skillId/edit', element: <SkillsView /> }],
      {
        initialEntries: ['/skills/skill-id/edit'],
      },
    );
    render(<RouterProvider router={router} />);
    expect(screen.getByTestId('skill-form')).toBeInTheDocument();
    expect(screen.queryByTestId('skills-collection')).not.toBeInTheDocument();
  });

  it('keeps the existing detail route', () => {
    mockGetSkillByIdQuery.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { _id: 'skill-id', name: 'stored skill' },
    });
    const router = createMemoryRouter([{ path: '/skills/:skillId', element: <SkillsView /> }], {
      initialEntries: ['/skills/skill-id'],
    });
    render(<RouterProvider router={router} />);
    expect(screen.getByTestId('skill-detail')).toBeInTheDocument();
  });

  it('does not mount collection queries without the independent SKILLS capability', () => {
    mockUseHasAccess.mockReturnValue(false);
    const router = createMemoryRouter(
      [
        { path: '/skills', element: <SkillsView /> },
        { path: '/c/new', element: <div>{'chat'}</div> },
      ],
      { initialEntries: ['/skills'] },
    );
    render(<RouterProvider router={router} />);
    expect(screen.getByText('chat')).toBeInTheDocument();
    expect(screen.queryByTestId('skills-collection')).not.toBeInTheDocument();
  });

  it('renders the create skill form for /skills/new', () => {
    const router = createMemoryRouter([{ path: '/skills/new', element: <SkillsView /> }], {
      initialEntries: ['/skills/new'],
    });

    render(<RouterProvider router={router} />);

    expect(screen.getByTestId('create-skill-form')).toBeInTheDocument();
  });

  it('passes the loaded skill and selected nested file to the live viewer', () => {
    mockGetSkillByIdQuery.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { _id: 'skill-id', name: 'stored skill' },
    });
    const router = createMemoryRouter([{ path: '/skills/:skillId', element: <SkillsView /> }], {
      initialEntries: ['/skills/skill-id?file=references%2Fqueries.md'],
    });

    render(<RouterProvider router={router} />);

    expect(screen.getByTestId('skill-file-viewer')).toHaveTextContent(
      'stored skill:references/queries.md',
    );
  });

  it('renders the sidebar toggle on small screens', () => {
    mockUseMediaQuery.mockReturnValue(true);
    const router = createMemoryRouter([{ path: '/skills', element: <SkillsView /> }], {
      initialEntries: ['/skills'],
    });

    render(<RouterProvider router={router} />);

    expect(screen.getByTestId('open-sidebar')).toBeInTheDocument();
  });

  it('does not render the sidebar toggle on large screens', () => {
    const router = createMemoryRouter([{ path: '/skills', element: <SkillsView /> }], {
      initialEntries: ['/skills'],
    });

    render(<RouterProvider router={router} />);

    expect(screen.queryByTestId('open-sidebar')).not.toBeInTheDocument();
  });
});
