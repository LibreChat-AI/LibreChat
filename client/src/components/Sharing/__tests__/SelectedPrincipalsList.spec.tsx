import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { AccessRoleIds, PrincipalType, ResourceType } from 'librechat-data-provider';
import type { TPrincipal } from 'librechat-data-provider';
import SelectedPrincipalsList from '../PeoplePicker/SelectedPrincipalsList';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('../AccessRolesPicker', () => ({
  __esModule: true,
  default: () => <div data-testid="access-role-picker" />,
}));

jest.mock('../PrincipalAvatar', () => ({
  __esModule: true,
  default: () => <div />,
}));

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  TooltipAnchor: ({ render: trigger }: { render: React.ReactNode }) => trigger,
  useMediaQuery: () => false,
}));

describe('SelectedPrincipalsList', () => {
  it('hides access roles when sharing uses a fixed role', () => {
    const artifactViewer: TPrincipal = {
      type: PrincipalType.USER,
      id: 'artifact-viewer',
      name: 'Artifact Viewer',
      accessRoleId: AccessRoleIds.ARTIFACT_APP_VIEWER,
    };

    render(
      <SelectedPrincipalsList
        principles={[artifactViewer]}
        onRemoveHandler={jest.fn()}
        onRoleChange={jest.fn()}
        allowRoleSelection={false}
      />,
    );

    expect(screen.queryByTestId('access-role-picker')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'com_ui_remove_user' })).toBeInTheDocument();
  });

  it('labels and locks an artifact owner while leaving viewers removable', () => {
    const owner: TPrincipal = {
      type: PrincipalType.USER,
      id: 'artifact-owner',
      name: 'Artifact Owner',
      accessRoleId: AccessRoleIds.ARTIFACT_APP_OWNER,
    };
    const viewer: TPrincipal = {
      type: PrincipalType.USER,
      id: 'artifact-viewer',
      name: 'Artifact Viewer',
      accessRoleId: AccessRoleIds.ARTIFACT_APP_VIEWER,
    };
    const onRemoveHandler = jest.fn();

    render(
      <SelectedPrincipalsList
        principles={[owner, viewer]}
        onRemoveHandler={onRemoveHandler}
        allowRoleSelection={false}
        resourceType={ResourceType.ARTIFACT_APP}
      />,
    );

    const ownerRow = screen.getByText('Artifact Owner').closest('.rounded-xl');
    const viewerRow = screen.getByText('Artifact Viewer').closest('.rounded-xl');
    expect(ownerRow).not.toBeNull();
    expect(viewerRow).not.toBeNull();
    expect(ownerRow).toHaveTextContent('com_ui_role_owner');
    expect(ownerRow?.querySelector('button')).toBeNull();

    const removeViewer = viewerRow?.querySelector('button');
    expect(removeViewer).not.toBeNull();
    fireEvent.click(removeViewer as HTMLButtonElement);
    expect(onRemoveHandler).toHaveBeenCalledWith('user-artifact-viewer');
  });

  it('keys Insights changes by role ID when source IDs are absent', () => {
    const roles: TPrincipal[] = [
      {
        type: PrincipalType.ROLE,
        id: 'role-one',
        name: 'Role One',
        accessRoleId: AccessRoleIds.AGENT_VIEWER,
      },
      {
        type: PrincipalType.ROLE,
        id: 'role-two',
        name: 'Role Two',
        accessRoleId: AccessRoleIds.AGENT_VIEWER,
      },
    ];
    const onInsightsAccessChange = jest.fn();

    render(
      <SelectedPrincipalsList
        principles={roles}
        onRemoveHandler={jest.fn()}
        onInsightsAccessChange={onInsightsAccessChange}
        showInsightsAccess
      />,
    );

    fireEvent.click(screen.getAllByRole('checkbox')[1]);

    expect(onInsightsAccessChange).toHaveBeenCalledTimes(1);
    expect(onInsightsAccessChange).toHaveBeenCalledWith('role-role-two', true);
  });

  it('shows administrator Insights access as checked and read-only', () => {
    const onInsightsAccessChange = jest.fn();
    const admin: TPrincipal = {
      type: PrincipalType.USER,
      id: 'admin-user',
      name: 'Admin User',
      accessRoleId: AccessRoleIds.AGENT_OWNER,
      viewInsights: false,
      isAdmin: true,
    };

    render(
      <SelectedPrincipalsList
        principles={[admin]}
        onRemoveHandler={jest.fn()}
        onInsightsAccessChange={onInsightsAccessChange}
        showInsightsAccess
      />,
    );

    const checkbox = screen.getByRole('checkbox', { name: 'com_ui_view_agent_insights' });
    expect(checkbox).toBeChecked();
    expect(checkbox).toBeDisabled();

    fireEvent.click(checkbox);
    expect(onInsightsAccessChange).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: 'com_ui_view_agent_insights_admin_description' }),
    ).toBeInTheDocument();
  });
});
