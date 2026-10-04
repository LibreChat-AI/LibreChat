import { render, screen, fireEvent } from '@testing-library/react';
import { DisablePhase } from '~/components/Nav/SettingsTabs/Account/TwoFactorPhases/DisablePhase';
import { isBackupCode } from '../BackupCodeInput';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));

describe('backup-code form validation', () => {
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
