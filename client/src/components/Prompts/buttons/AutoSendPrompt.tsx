import { useRecoilState } from 'recoil';
import { Button, CheckboxGlyph } from '@librechat/client';
import { useLocalize } from '~/hooks';
import store from '~/store';

export default function AutoSendPrompt({
  onCheckedChange,
}: {
  onCheckedChange?: (value: boolean) => void;
}) {
  const [autoSendPrompts, setAutoSendPrompts] = useRecoilState<boolean>(store.autoSendPrompts);
  const localize = useLocalize();

  const handleCheckedChange = (value: boolean) => {
    setAutoSendPrompts(value);
    if (onCheckedChange) {
      onCheckedChange(value);
    }
  };

  return (
    <Button
      size="sm"
      variant="outline"
      onClick={() => handleCheckedChange(!autoSendPrompts)}
      aria-label={localize('com_nav_auto_send_prompts')}
      aria-pressed={autoSendPrompts}
      className={`border-border-light relative h-9 w-full gap-2 rounded-lg font-medium ${autoSendPrompts ? 'bg-surface-hover hover:bg-surface-hover' : ''}`}
    >
      {/* The button owns the state through `aria-pressed`; this is the mark, not a
          second control inside it. */}
      <CheckboxGlyph checked={autoSendPrompts} />
      {localize('com_nav_auto_send_prompts')}
    </Button>
  );
}
