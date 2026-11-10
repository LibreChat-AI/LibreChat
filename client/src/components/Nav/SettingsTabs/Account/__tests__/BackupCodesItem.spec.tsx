import React from 'react';
import { RecoilRoot } from 'recoil';
import { render, screen } from '@testing-library/react';
import BackupCodesItem from '../BackupCodesItem';

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useToastContext: () => ({ showToast: jest.fn() }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => (key === 'com_ui_manage' ? 'Gérer' : key),
  useAuthContext: () => ({ user: { twoFactorEnabled: true, backupCodes: [] } }),
}));

jest.mock('~/data-provider', () => ({
  useRegenerateBackupCodesMutation: () => ({ mutate: jest.fn(), isLoading: false }),
}));

describe('BackupCodesItem', () => {
  it('names the manage button with its localized visible text', () => {
    render(
      <RecoilRoot>
        <BackupCodesItem />
      </RecoilRoot>,
    );

    expect(screen.getByRole('button', { name: 'Gérer' })).toHaveTextContent('Gérer');
  });
});
