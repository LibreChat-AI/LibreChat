import { Navigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import ProjectWorkspace from './ProjectWorkspace';
import { useProjectsAccess } from '~/hooks';
import ProjectsView from './ProjectsView';

/** Sends a role without Chat Projects to a new chat instead of a page whose requests fail. */
function ProjectsGate({ children }: { children: ReactNode }) {
  const { loaded, canUse } = useProjectsAccess();
  if (!loaded) {
    return null;
  }
  if (!canUse) {
    return <Navigate to="/c/new" replace={true} />;
  }
  return <>{children}</>;
}

export function ProjectsRoute() {
  return (
    <ProjectsGate>
      <ProjectsView />
    </ProjectsGate>
  );
}

export function ProjectWorkspaceRoute() {
  return (
    <ProjectsGate>
      <ProjectWorkspace />
    </ProjectsGate>
  );
}
