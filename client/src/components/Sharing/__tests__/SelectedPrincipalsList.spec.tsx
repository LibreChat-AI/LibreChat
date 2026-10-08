import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { AccessRoleIds, PrincipalType } from 'librechat-data-provider';
import type { TPrincipal } from 'librechat-data-provider';
import SelectedPrincipalsList from '../PeoplePicker/SelectedPrincipalsList';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('../AccessRolesPicker', () => ({
  __esModule: true,
  default: () => <div />,
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
