import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { TrackingProvider } from '~/Providers/TrackingContext';
import SkillsView from '../SkillsView';

const mockUseHasAccess = jest.fn((..._args: unknown[]) => true);
const mockUseMediaQuery = jest.fn((_query: string) => false);
const mockGetSkillByIdQuery = jest.fn(() => ({
  isLoading: false,
  isError: false,
  isSuccess: false,
  data: null as { _id: string; name: string } | null,
}));

jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
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
  useGetStartupConfig: () => ({ data: { productTracking: { enabled: true } } }),
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
    mockGetSkillByIdQuery.mockReturnValue({
      isLoading: false,
      isError: false,
      isSuccess: false,
      data: null,
    });
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
      isSuccess: true,
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

it.each([false, true])(
  'does not export an unvalidated route on query error=%s',
  async (isError) => {
    const track = jest.fn();
    mockGetSkillByIdQuery.mockReturnValue({
      isLoading: !isError,
      isError,
      isSuccess: false,
      data: null,
    });
    const router = createMemoryRouter([{ path: '/skills/:skillId', element: <SkillsView /> }], {
      initialEntries: ['/skills/private-user-text'],
    });
    render(
      <TrackingProvider track={track}>
        <RouterProvider router={router} />
      </TrackingProvider>,
    );
    await act(async () => {});
    expect(track).not.toHaveBeenCalled();
  },
);

it('emits one loaded detail open without an extra catalog event', async () => {
  const track = jest.fn();
  mockGetSkillByIdQuery.mockReturnValue({
    isLoading: false,
    isError: false,
    isSuccess: true,
    data: { _id: 'stored-id', name: 'private' },
  });
  const router = createMemoryRouter([{ path: '/skills/:skillId', element: <SkillsView /> }], {
    initialEntries: ['/skills/stored-id'],
  });
  render(
    <TrackingProvider track={track}>
      <RouterProvider router={router} />
    </TrackingProvider>,
  );
  await act(async () => {});
  expect(track).toHaveBeenCalledTimes(1);
  expect(track.mock.calls[0][0]).toEqual({
    name: 'librechat.skills.opened',
    feature: 'skills',
    entryPoint: 'route',
    skillId: 'stored-id',
  });
});
