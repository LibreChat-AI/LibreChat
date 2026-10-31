import { useState, useRef, useEffect } from 'react';
import { useCombobox } from '@librechat/client';
import type { KeyboardEvent, MutableRefObject } from 'react';
import type { CommandOption, CommandDismissReason } from './Command';
import useInitPopoverInput from '../../../react/popover';
import CommandPopover from './Command';

const COMMAND_CHAR = '$';

/** Localized messages the skills popover shows in place of a list. */
export interface SkillsPopoverNotices {
  /** The skills failed to load. */
  error: string;
  /** The user has no skills to offer here. */
  empty: string;
  /** The search matched none of them. */
  noMatch: string;
}

export interface SkillsPopoverProps {
  textAreaRef: MutableRefObject<HTMLTextAreaElement | null>;
  /** Localized placeholder for the search field. */
  placeholder: string;
  skills: CommandOption[];
  /** True while any page of the catalog is still loading. */
  isLoading: boolean;
  isError: boolean;
  notices: SkillsPopoverNotices;
  /** A skill was picked; the popover has already closed and the draft keeps its text. */
  onSelectSkill: (skill: CommandOption) => void;
  /** Hides the popover. */
  onClose: () => void;
}

/** The `$` popover: picks a skill to invoke on the next turn. Text typed after the `$` stays in
 *  the draft, and the pick is handed to the host rather than written into the text. */
export default function SkillsPopover({
  textAreaRef,
  placeholder,
  skills,
  isLoading,
  isError,
  notices,
  onSelectSkill,
  onClose,
}: SkillsPopoverProps): React.JSX.Element {
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const { open, setOpen, searchValue, setSearchValue, matches } = useCombobox({
    value: '',
    options: skills,
  });

  const initInputRef = useInitPopoverInput({
    inputRef,
    textAreaRef,
    commandChar: COMMAND_CHAR,
    preserveTextAfterCursor: true,
    setSearchValue,
    setOpen,
  });

  useEffect(() => {
    if (!open) {
      setActiveIndex(0);
    }
  }, [open]);

  const handleSelect = (skill: CommandOption, e?: KeyboardEvent<HTMLInputElement>) => {
    e?.preventDefault();
    setSearchValue('');
    setOpen(false);
    onClose();
    onSelectSkill(skill);
    textAreaRef.current?.focus();
  };

  const handleDismiss = (reason: CommandDismissReason, e?: KeyboardEvent<HTMLInputElement>) => {
    if (reason === 'commit' && e?.key === 'Enter') {
      e.preventDefault();
    }
    setOpen(false);
    onClose();
    if (reason !== 'blur') {
      textAreaRef.current?.focus();
    }
  };

  const notice = (() => {
    if (isError) {
      return notices.error;
    }
    if (isLoading || matches.length > 0) {
      return undefined;
    }
    return searchValue ? notices.noMatch : notices.empty;
  })();

  return (
    <CommandPopover
      type="skill"
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
      notice={notice}
      onSelect={handleSelect}
      onDismiss={handleDismiss}
    />
  );
}
