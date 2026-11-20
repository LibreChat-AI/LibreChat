import { Input } from '@librechat/client';
import { useLocalize } from '~/hooks';

export const isBackupCode = (code: string): boolean =>
  /^(?:[a-f0-9]{8}|[a-f0-9]{32})$/.test(code.trim());

export default function BackupCodeInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const localize = useLocalize();
  return (
    <Input
      aria-label={localize('com_ui_backup_code_verification_required')}
      value={value}
      onChange={(event) => onChange(event.target.value.trim())}
      autoComplete="one-time-code"
      autoCapitalize="none"
      spellCheck={false}
    />
  );
}
