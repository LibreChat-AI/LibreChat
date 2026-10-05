import React from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import ArtifactAppsAdminSettings from './ArtifactAppsAdminSettings';

let mockRole = 'ADMIN';
const mockDefaultValues = {};

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useToastContext: () => ({ showToast: jest.fn() }),
}));

jest.mock('~/components/ui', () => {
  const ReactModule = jest.requireActual('react') as typeof React;
  const labels: Record<string, string> = {
    com_ui_artifacts_allow_use: 'Allow access to the artifact catalog',
    com_ui_artifacts_allow_create: 'Automatically save created artifacts',
    com_ui_artifacts_allow_share: 'Allow sharing artifacts with people and groups',
    com_ui_artifacts_allow_share_public: 'Allow sharing artifacts with everyone',
  };
  return {
    AdminSettingsDialog: ({
      trigger,
      permissions,
    }: {
      trigger: React.ReactElement;
      permissions: Array<{ labelKey: string }>;
    }) => {
      const [open, setOpen] = ReactModule.useState(false);
      if (mockRole !== 'ADMIN') {
        return null;
      }
      const heading = ['Admin Settings', 'Artifacts'].join(' - ');
      return (
        <>
          {ReactModule.cloneElement(trigger, { onClick: () => setOpen(true) })}
          {open && (
            <div role="dialog">
              <h2>{heading}</h2>
              {permissions.map(({ labelKey }) => (
                <span key={labelKey}>{labels[labelKey]}</span>
              ))}
            </div>
          )}
        </>
      );
    },
  };
});

jest.mock('~/hooks', () => ({
  useAuthContext: () => ({ user: { role: mockRole } }),
  useLocalize: () => (key: string, values?: { section?: string }) => {
    const translations: Record<string, string> = {
      com_ui_admin_settings: 'Admin Settings',
      com_ui_artifact_apps: 'Artifacts',
      com_ui_artifacts_allow_use: 'Allow access to the artifact catalog',
      com_ui_artifacts_allow_create: 'Automatically save created artifacts',
      com_ui_artifacts_allow_share: 'Allow sharing artifacts with people and groups',
      com_ui_artifacts_allow_share_public: 'Allow sharing artifacts with everyone',
    };
    if (key === 'com_ui_admin_settings_section') {
      return `Admin Settings - ${values?.section}`;
    }
    return translations[key] ?? key;
  },
  useRoleSelector: () => ({
    selectedRole: 'ADMIN',
    isSelectedCustomRole: false,
    isCustomRoleLoading: false,
    isCustomRoleError: false,
    defaultValues: mockDefaultValues,
    roleDropdownItems: [],
  }),
}));

jest.mock('~/data-provider', () => ({
  useUpdateArtifactPermissionsMutation: () => ({ mutate: jest.fn(), isLoading: false }),
}));

describe('ArtifactAppsAdminSettings', () => {
  beforeEach(() => {
    mockRole = 'ADMIN';
  });

  it('opens artifact permission settings for an administrator', async () => {
    const user = userEvent.setup();
    render(<ArtifactAppsAdminSettings />);

    await user.click(screen.getByRole('button', { name: 'Admin Settings' }));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Admin Settings - Artifacts')).toBeInTheDocument();
    expect(screen.getByText('Allow access to the artifact catalog')).toBeInTheDocument();
    expect(screen.getByText('Allow sharing artifacts with everyone')).toBeInTheDocument();
  });

  it('does not show the administration action to a non-administrator', () => {
    mockRole = 'USER';
    render(<ArtifactAppsAdminSettings />);

    expect(screen.queryByRole('button', { name: 'Admin Settings' })).not.toBeInTheDocument();
  });
});
