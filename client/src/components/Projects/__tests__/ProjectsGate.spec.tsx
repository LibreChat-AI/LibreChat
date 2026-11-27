import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ProjectsRoute, ProjectWorkspaceRoute } from '../ProjectsGate';

const mockAccess = { current: { loaded: true, canUse: true, canCreate: true } };

jest.mock('~/hooks', () => ({
  useProjectsAccess: () => mockAccess.current,
}));
jest.mock('../ProjectsView', () => () => <div data-testid="projects-page" />);
jest.mock('../ProjectWorkspace', () => () => <div data-testid="project-workspace" />);

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/projects" element={<ProjectsRoute />} />
        <Route path="/projects/:projectId" element={<ProjectWorkspaceRoute />} />
        <Route path="/c/new" element={<div data-testid="new-chat" />} />
      </Routes>
    </MemoryRouter>,
  );

describe('ProjectsGate', () => {
  afterEach(() => {
    mockAccess.current = { loaded: true, canUse: true, canCreate: true };
  });

  it('shows the projects pages to a role that may use them', () => {
    renderAt('/projects');
    expect(screen.getByTestId('projects-page')).toBeInTheDocument();
  });

  it.each(['/projects', '/projects/abc'])('sends %s to a new chat without PROJECTS.USE', (path) => {
    mockAccess.current = { loaded: true, canUse: false, canCreate: false };
    renderAt(path);
    expect(screen.getByTestId('new-chat')).toBeInTheDocument();
    expect(screen.queryByTestId('projects-page')).not.toBeInTheDocument();
    expect(screen.queryByTestId('project-workspace')).not.toBeInTheDocument();
  });

  it('waits for the role instead of redirecting a deep link early', () => {
    mockAccess.current = { loaded: false, canUse: false, canCreate: false };
    renderAt('/projects/abc');
    expect(screen.queryByTestId('new-chat')).not.toBeInTheDocument();
    expect(screen.queryByTestId('project-workspace')).not.toBeInTheDocument();
  });
});
