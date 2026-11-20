import { render, screen, fireEvent } from '@testing-library/react';
import { DisablePhase } from '~/components/Nav/SettingsTabs/Account/TwoFactorPhases/DisablePhase';
import { BackupPhase } from '~/components/Nav/SettingsTabs/Account/TwoFactorPhases/BackupPhase';
import BackupCodeInput, { isBackupCode } from '../BackupCodeInput';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));

describe('backup-code form validation', () => {
  it('shows the complete long code in a wrapping single-column layout', () => {
    const code = '0123456789abcdef0123456789abcdef';
    const { container } = render(
      <BackupPhase
        backupCodes={[code]}
        downloaded
        onNext={jest.fn()}
        onDownload={jest.fn()}
        onError={jest.fn()}
      />,
    );
    expect(screen.getByText(code)).toHaveClass('break-all', 'min-w-0');
    expect(container.querySelector('.grid')).toHaveClass('grid-cols-1');
  });
  it('does not truncate whitespace-padded input before normalization', () => {
    const onChange = jest.fn();
    render(<BackupCodeInput value="" onChange={onChange} />);
    const input = screen.getByRole('textbox');
    expect(input).not.toHaveAttribute('maxlength');
    fireEvent.change(input, { target: { value: ' 0123456789abcdef0123456789abcdef\n' } });
    expect(onChange).toHaveBeenCalledWith('0123456789abcdef0123456789abcdef');
  });
  it.each(['deadbeef', '0123456789abcdef0123456789abcdef'])(
    'allows disabling 2FA with either backup-code format: %s',
    (code) => {
      const onDisable = jest.fn();
      render(<DisablePhase onDisable={onDisable} isDisabling={false} />);
      fireEvent.click(screen.getByRole('button', { name: 'com_ui_use_backup_code' }));
      const submit = screen.getByRole('button', { name: 'com_ui_2fa_disable' });
      expect(submit).toBeDisabled();
      fireEvent.change(
        screen.getByRole('textbox', { name: 'com_ui_backup_code_verification_required' }),
        { target: { value: code } },
      );
      expect(submit).toBeEnabled();
      fireEvent.click(submit);
      expect(onDisable).toHaveBeenCalledWith(code, true);
    },
  );
  it.each(['deadbeef', '0123456789abcdef0123456789abcdef', ' deadbeef '])(
    'accepts legacy and current codes: %s',
    (code) => {
      expect(isBackupCode(code)).toBe(true);
    },
  );
  it.each(['', 'deadbee', 'deadbeef0', 'a'.repeat(31), 'a'.repeat(33), 'g'.repeat(32)])(
    'rejects incomplete and malformed codes: %s',
    (code) => {
      expect(isBackupCode(code)).toBe(false);
    },
  );
});
