import { useState, useRef, useEffect } from 'react';
import { useCombobox } from '@librechat/client';
import type { KeyboardEvent, MutableRefObject } from 'react';
import type { CommandOption, CommandDismissReason } from './Command';
import { removeCharIfLast } from '../../../core/textarea';
import useInitPopoverInput from '../../../react/popover';
import CommandPopover from './Command';

const COMMAND_CHAR = '/';

export interface PromptsPopoverProps<T extends CommandOption> {
  textAreaRef: MutableRefObject<HTMLTextAreaElement | null>;
  /** Localized placeholder for the search field. */
  placeholder: string;
  prompts: T[];
  isLoading: boolean;
  /** The search field opened or closed; the host loads its catalog on open. */
  onOpenChange?: (open: boolean) => void;
  /** A prompt was picked; the popover has already closed and dropped the `/`. A Tab pick passes
   *  its event so the host can keep focus for a dialog that follows. */
  onSelectPrompt: (prompt: T, event?: KeyboardEvent<HTMLInputElement>) => void;
  /** Hides the popover. */
  onClose: () => void;
}

/** The `/` popover: filters the user's prompts and hands the pick to the host, which resolves
 *  its text and either submits it or asks for its variables. */
export default function PromptsPopover<T extends CommandOption>({
  textAreaRef,
  placeholder,
  prompts,
  isLoading,
  onOpenChange,
  onSelectPrompt,
  onClose,
}: PromptsPopoverProps<T>): React.JSX.Element {
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const { open, setOpen, searchValue, setSearchValue, matches } = useCombobox({
    value: '',
    options: prompts,
  });

  const initInputRef = useInitPopoverInput({
    inputRef,
    textAreaRef,
    commandChar: COMMAND_CHAR,
    setSearchValue,
    setOpen,
  });

  const openChangeRef = useRef(onOpenChange);
  openChangeRef.current = onOpenChange;

  useEffect(() => {
    if (!open) {
      setActiveIndex(0);
      setSearchValue('');
    }
    openChangeRef.current?.(open);
  }, [open, setSearchValue]);

  const handleSelect = (prompt: CommandOption, e?: KeyboardEvent<HTMLInputElement>) => {
    if (e?.key === 'Enter') {
      e.preventDefault();
    }
    setSearchValue('');
    setOpen(false);
    onClose();
    if (textAreaRef.current) {
      removeCharIfLast(textAreaRef.current, COMMAND_CHAR);
    }
    onSelectPrompt(prompt as T, e);
  };

  const handleDismiss = (reason: CommandDismissReason, e?: KeyboardEvent<HTMLInputElement>) => {
    if (reason === 'commit') {
      e?.preventDefault();
    }
    setOpen(false);
    onClose();
    if (reason !== 'blur') {
      textAreaRef.current?.focus();
    }
  };

  return (
    <CommandPopover
      type="prompt"
      placeholder={placeholder}
      inputRef={initInputRef}
      searchValue={searchValue}
      onSearchChange={setSearchValue}
      open={open}
      onOpen={() => setOpen(true)}
      matches={matches as CommandOption[]}
      activeIndex={activeIndex}
      onActiveIndexChange={setActiveIndex}
      isLoading={isLoading}
      onSelect={handleSelect}
      onDismiss={handleDismiss}
    />
  );
}
