import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { PermissionBits, PermissionTypes, Permissions, SystemRoles } from 'librechat-data-provider';
import type { TArtifactApp } from 'librechat-data-provider';
import ArtifactAppShareDialog from './Share';

const mockUseAuthContext = jest.fn();
const mockUseHasAccess = jest.fn();

jest.mock('~/hooks', () => ({
  useAuthContext: () => mockUseAuthContext(),
  useHasAccess: (args: { permissionType: string; permission: string }) => mockUseHasAccess(args),
}));

jest.mock('~/components/Sharing', () => ({
  GenericGrantAccessDialog: ({
    resourceDbId,
    resourceId,
    resourceName,
    defaultOpen,
    children,
  }: {
    resourceDbId?: string;
    resourceId?: string;
    resourceName?: string;
    defaultOpen?: boolean;
    children?: React.ReactNode;
  }) => (
    <div
      data-testid="artifact-share-dialog"
      data-resource-db-id={resourceDbId}
      data-resource-id={resourceId}
      data-default-open={defaultOpen ? 'true' : 'false'}
    >
      {resourceName}
      {children}
    </div>
  ),
}));

const app = {
  id: 'db-revenue-chart',
  artifactAppId: 'revenue-chart',
  createdBy: 'user-1',
  title: 'Revenue chart',
} as TArtifactApp;

function mockAccess({
  share = true,
  viewUsers = false,
  viewGroups = false,
  viewRoles = false,
  sharePublic = false,
}: {
  share?: boolean;
  viewUsers?: boolean;
  viewGroups?: boolean;
  viewRoles?: boolean;
  sharePublic?: boolean;
} = {}) {
  mockUseHasAccess.mockImplementation(
    ({ permissionType, permission }: { permissionType: string; permission: string }) => {
      if (permissionType === PermissionTypes.ARTIFACTS && permission === Permissions.SHARE) {
        return share;
      }
      if (permissionType === PermissionTypes.ARTIFACTS && permission === Permissions.SHARE_PUBLIC) {
        return sharePublic;
      }
      if (
        permissionType === PermissionTypes.PEOPLE_PICKER &&
        permission === Permissions.VIEW_USERS
      ) {
        return viewUsers;
      }
      if (
        permissionType === PermissionTypes.PEOPLE_PICKER &&
        permission === Permissions.VIEW_GROUPS
      ) {
        return viewGroups;
      }
      if (
        permissionType === PermissionTypes.PEOPLE_PICKER &&
        permission === Permissions.VIEW_ROLES
      ) {
        return viewRoles;
      }
      return false;
    },
  );
}

describe('ArtifactAppShareDialog', () => {
  beforeEach(() => {
    mockUseAuthContext.mockReturnValue({ user: { id: 'user-1', role: SystemRoles.USER } });
    mockAccess({ share: true, viewUsers: true });
  });

  it('exposes the share dialog for the artifact owner without a per-resource permission fetch', () => {
    render(<ArtifactAppShareDialog app={app} />);

    const dialog = screen.getByTestId('artifact-share-dialog');
    expect(dialog).toHaveAttribute('data-resource-db-id', 'db-revenue-chart');
    expect(dialog).toHaveAttribute('data-resource-id', 'revenue-chart');
    expect(dialog).toHaveTextContent('Revenue chart');
  });

  it('exposes the share dialog for an admin who does not own the artifact', () => {
    mockUseAuthContext.mockReturnValue({ user: { id: 'admin-1', role: SystemRoles.ADMIN } });

    render(<ArtifactAppShareDialog app={app} />);

    expect(screen.getByTestId('artifact-share-dialog')).toBeInTheDocument();
  });

  it('exposes the share dialog when the catalog entry already includes SHARE', () => {
    mockUseAuthContext.mockReturnValue({ user: { id: 'user-2', role: SystemRoles.USER } });

    render(<ArtifactAppShareDialog app={{ ...app, permissionBits: PermissionBits.SHARE }} />);

    expect(screen.getByTestId('artifact-share-dialog')).toBeInTheDocument();
  });

  it('hides the share dialog from a viewer whose catalog entry only includes VIEW', () => {
    mockUseAuthContext.mockReturnValue({ user: { id: 'user-2', role: SystemRoles.USER } });

    render(<ArtifactAppShareDialog app={{ ...app, permissionBits: PermissionBits.VIEW }} />);

    expect(screen.queryByTestId('artifact-share-dialog')).not.toBeInTheDocument();
  });

  it('hides the share dialog when the ARTIFACTS SHARE permission is denied', () => {
    mockAccess({ share: false, viewUsers: true });

    render(<ArtifactAppShareDialog app={app} />);

    expect(screen.queryByTestId('artifact-share-dialog')).not.toBeInTheDocument();
  });

  it('hides the share dialog when no user, group, or public destination is permitted', () => {
    mockAccess({ share: true, viewRoles: true });

    render(<ArtifactAppShareDialog app={app} />);

    expect(screen.queryByTestId('artifact-share-dialog')).not.toBeInTheDocument();
  });

  it('exposes the share dialog when only people-picker users are permitted', () => {
    mockAccess({ share: true, viewUsers: true });

    render(<ArtifactAppShareDialog app={app} />);

    expect(screen.getByTestId('artifact-share-dialog')).toBeInTheDocument();
  });

  it('exposes the share dialog when only people-picker groups are permitted', () => {
    mockAccess({ share: true, viewGroups: true });

    render(<ArtifactAppShareDialog app={app} />);

    expect(screen.getByTestId('artifact-share-dialog')).toBeInTheDocument();
  });

  it('exposes the share dialog when only public sharing is permitted', () => {
    mockAccess({ share: true, sharePublic: true });

    render(<ArtifactAppShareDialog app={app} />);

    expect(screen.getByTestId('artifact-share-dialog')).toBeInTheDocument();
  });
});
