import React from 'react';
import { RecoilRoot } from 'recoil';
import { DndProvider } from 'react-dnd';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/extend-expect';
import ProjectsSection from '../ProjectsSection';

jest.mock('~/data-provider', () => ({
  useActiveJobs: () => ({ data: undefined }),
  useConversationsInfiniteQuery: () => ({ data: undefined, isLoading: false }),
  useProjectsInfiniteQuery: () => ({
    data: { pages: [{ projects: [], nextCursor: null }], pageParams: [undefined] },
    isLoading: false,
  }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useLocalStorage: jest.requireActual('~/hooks/useLocalStorage').default,
  useNewConvo: () => ({ newConversation: jest.fn() }),
}));

jest.mock('~/components/Projects/ProjectCreateDialog', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('~/components/Projects/ProjectDeleteDialog', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('~/components/Projects/ProjectEditDialog', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('../Convo', () => ({ __esModule: true, default: () => null }));

const renderSection = () =>
  render(
    <RecoilRoot>
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <DndProvider backend={HTML5Backend}>
            <ProjectsSection toggleNav={jest.fn()} isAuthenticated />
          </DndProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </RecoilRoot>,
  );

const sectionToggle = () => screen.getByRole('button', { name: 'com_ui_projects' });

describe('ProjectsSection', () => {
  beforeEach(() => localStorage.clear());

  it('starts expanded for an account with no projects', () => {
    renderSection();
    expect(sectionToggle()).toHaveAttribute('aria-expanded', 'true');
  });

  it('remembers a collapse across mounts', async () => {
    const { unmount } = renderSection();
    await userEvent.click(sectionToggle());
    expect(sectionToggle()).toHaveAttribute('aria-expanded', 'false');

    unmount();
    renderSection();
    expect(sectionToggle()).toHaveAttribute('aria-expanded', 'false');
  });
});
