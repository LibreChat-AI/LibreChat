import { useState, useRef, useEffect } from 'react';
import { useCombobox } from '@librechat/client';
import { EModelEndpoint } from 'librechat-data-provider';
import type { KeyboardEvent, MutableRefObject } from 'react';
import type { ReactNode } from 'react';
import type { CommandOption, CommandDismissReason } from './Command';
import type { CommandRange } from '../../../core/textarea';
import { removeCharIfLast } from '../../../core/textarea';
import useInitPopoverInput from '../../../react/popover';
import CommandPopover from './Command';

export interface MentionPopoverProps {
  textAreaRef: MutableRefObject<HTMLTextAreaElement | null>;
  /** The character that opened the popover; `+` adds a conversation instead of switching. */
  commandChar?: string;
  commandRange?: CommandRange;
  /** Localized placeholder for the search field. */
  placeholder: string;
  options: CommandOption[];
  isLoading: boolean;
  notice?: ReactNode;
  /** Options listed after picking the Agents endpoint. */
  agentsList?: CommandOption[] | null;
  /** Options listed after picking an Assistants endpoint, by endpoint. */
  assistantListMap: Partial<Record<string, CommandOption[] | undefined>>;
  /** Model names by endpoint, listed after picking any other endpoint. */
  modelsConfig?: Record<string, string[]> | null;
  /** A final pick: a model, preset, spec, agent or assistant. */
  onSelectMention: (option: CommandOption) => void;
  /** Hides the popover. */
  onClose: () => void;
}

/** The `@` (and `+`) popover: endpoints drill into their agents, assistants or models, and any
 *  other pick switches the conversation through `onSelectMention`. */
export default function MentionPopover({
  textAreaRef,
  commandChar = '@',
  commandRange,
  placeholder,
  options,
  isLoading,
  notice,
  agentsList,
  assistantListMap,
  modelsConfig,
  onSelectMention,
  onClose,
}: MentionPopoverProps): React.JSX.Element {
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [inputOptions, setInputOptions] = useState<CommandOption[]>(options);
  const [drilledIn, setDrilledIn] = useState(false);
  const commandText = useRef(
    commandRange
      ? textAreaRef.current?.value.slice(commandRange.start, commandRange.end)
      : undefined,
  );

  const { open, setOpen, searchValue, setSearchValue, matches } = useCombobox({
    value: '',
    options: drilledIn ? inputOptions : options,
  });

  const initInputRef = useInitPopoverInput({
    inputRef,
    textAreaRef,
    commandChar,
    commandRange,
    setSearchValue,
    setOpen,
  });

  useEffect(() => {
    if (!open) {
      setInputOptions(options);
      setDrilledIn(false);
      setActiveIndex(0);
    }
  }, [open, options]);

  const drillInto = (next: CommandOption[]) => {
    setDrilledIn(true);
    setSearchValue('');
    setInputOptions(next);
    setActiveIndex(0);
    inputRef.current?.focus();
  };

  const nextOptions = (mention: CommandOption): CommandOption[] | undefined => {
    if (mention.type !== 'endpoint') {
      return undefined;
    }
    if (mention.value === EModelEndpoint.agents) {
      return agentsList ?? [];
    }
    if (
      mention.value === EModelEndpoint.assistants ||
      mention.value === EModelEndpoint.azureAssistants
    ) {
      return assistantListMap[mention.value] ?? [];
    }
    return (modelsConfig?.[mention.value] ?? []).map((model) => ({
      value: mention.value,
      label: model,
      type: 'model',
    }));
  };

  const handleSelect = (mention: CommandOption, e?: KeyboardEvent<HTMLInputElement>) => {
    e?.preventDefault();
    const next = nextOptions(mention);
    if (next) {
      drillInto(next);
      return;
    }
    setSearchValue('');
    setOpen(false);
    onClose();
    if (commandRange && textAreaRef.current) {
      const textarea = textAreaRef.current;
      if (textarea.value.slice(commandRange.start, commandRange.end) === commandText.current) {
        textarea.value =
          textarea.value.slice(0, commandRange.start) + textarea.value.slice(commandRange.end);
        textarea.setSelectionRange(commandRange.start, commandRange.start);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      }
      textarea.focus();
    } else if (textAreaRef.current) {
      removeCharIfLast(textAreaRef.current, commandChar);
    }
    onSelectMention(mention);
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
      type={commandChar !== '@' ? 'add-convo' : 'mention'}
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
      notice={drilledIn ? undefined : notice}
      onSelect={handleSelect}
      onDismiss={handleDismiss}
    />
  );
}
