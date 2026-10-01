import { useId, useState, useEffect } from 'react';
import { Input } from '@librechat/client';
import { SquareSlash } from 'lucide-react';
import { Constants } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

const Command = ({
  initialValue,
  onValueChange,
  disabled,
  tabIndex,
  labelBgClassName = 'bg-surface-primary-alt',
}: {
  initialValue?: string;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
  tabIndex?: number;
  /** Surface the floating label notches out of; must match whatever sits behind the field */
  labelBgClassName?: string;
}) => {
  const localize = useLocalize();
  const commandId = useId();
  const [command, setCommand] = useState(initialValue || '');
  const [charCount, setCharCount] = useState(initialValue?.length || 0);

  useEffect(() => {
    setCommand(initialValue || '');
    setCharCount(initialValue?.length || 0);
  }, [initialValue]);

  useEffect(() => {
    setCharCount(command.length);
  }, [command]);

  const handleInputChange: React.ChangeEventHandler<HTMLInputElement> = (e) => {
    let newValue = e.target.value.toLowerCase();

    newValue = newValue.replace(/\s/g, '-').replace(/[^a-z0-9-]/g, '');

    if (newValue.length <= Constants.COMMANDS_MAX_LENGTH) {
      setCommand(newValue);
      onValueChange?.(newValue);
    }
  };

  if (disabled === true && !command) {
    return null;
  }

  return (
    <div className="border-border-medium rounded-xl border">
      <label htmlFor={commandId} className="text-text-secondary block px-4 pt-2 text-sm md:hidden">
        {localize('com_ui_command_placeholder')}
      </label>
      <div className="text-text-secondary relative flex h-10 items-center gap-1 pr-2 pl-4 text-sm">
        <SquareSlash className="icon-sm shrink-0" aria-hidden="true" />
        <div className="relative min-w-0 flex-1">
          <Input
            type="text"
            id={commandId}
            tabIndex={tabIndex}
            disabled={disabled}
            placeholder=" "
            value={command}
            onChange={handleInputChange}
            className="peer w-full border-none pr-14"
            aria-label={localize('com_ui_command_placeholder')}
          />
          <label
            htmlFor={commandId}
            className={cn(
              'text-text-secondary peer-focus:text-text-primary pointer-events-none absolute top-0.5 left-0 hidden max-w-[calc(100%-3.5rem)] origin-[0] translate-y-2 scale-100 rounded px-1 text-sm transition-transform duration-200 peer-placeholder-shown:translate-y-2 peer-placeholder-shown:scale-100 peer-focus:-translate-y-3 peer-focus:scale-75 peer-[:not(:placeholder-shown)]:-translate-y-3 peer-[:not(:placeholder-shown)]:scale-75 md:block',
              labelBgClassName,
            )}
          >
            {localize('com_ui_command_placeholder')}
          </label>
        </div>
        {disabled !== true && (
          <span className="text-text-secondary absolute right-2 shrink-0 text-xs md:text-sm">{`${charCount}/${Constants.COMMANDS_MAX_LENGTH}`}</span>
        )}
      </div>
    </div>
  );
};

export default Command;
