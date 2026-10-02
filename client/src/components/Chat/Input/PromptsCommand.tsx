import { useState, useRef, useEffect, useMemo, memo, useCallback } from 'react';
import { AutoSizer, List } from 'react-virtualized';
import { useSetRecoilState, useRecoilValue } from 'recoil';
import { Input, Spinner, useCombobox } from '@librechat/client';
import type { TPromptGroup } from 'librechat-data-provider';
import type { PromptOption } from '~/common';
import useInitPopoverInput from '~/hooks/Input/useInitPopoverInput';
import { removeCharIfLast, detectVariables } from '~/utils';
import { useRecordPromptUsage } from '~/data-provider';
import { VariableDialog } from '~/components/Prompts';
import { usePromptGroupsContext } from '~/Providers';
import { activateCatalog } from '~/hooks';
import MentionItem from './MentionItem';
import { useLocalize } from '~/hooks';
import store from '~/store';

const commandChar = '/';

const PopoverContainer = memo(
  ({
    index,
    children,
    isVariableDialogOpen,
    variableGroup,
    setVariableDialogOpen,
    textAreaRef,
  }: {
    index: number;
    children: React.ReactNode;
    isVariableDialogOpen: boolean;
    variableGroup: TPromptGroup | null;
    setVariableDialogOpen: (isOpen: boolean) => void;
    textAreaRef: React.MutableRefObject<HTMLTextAreaElement | null>;
  }) => {
    const showPromptsPopover = useRecoilValue(store.showPromptsPopoverFamily(index));
    return (
      <>
        {showPromptsPopover ? children : null}
        <VariableDialog
          open={isVariableDialogOpen}
          onClose={() => {
            setVariableDialogOpen(false);
            requestAnimationFrame(() => {
              textAreaRef.current?.focus();
            });
          }}
          group={variableGroup}
        />
      </>
    );
  },
);

const ROW_HEIGHT = 44;

function PromptsCommand({
  index,
  textAreaRef,
  submitPrompt,
}: {
  index: number;
  textAreaRef: React.MutableRefObject<HTMLTextAreaElement | null>;
  submitPrompt: (textPrompt: string) => void;
}) {
  const localize = useLocalize();
  const { mutate: recordUsage } = useRecordPromptUsage();
  const promptGroupsContext = usePromptGroupsContext();
  const { allPromptGroups, hasAccess, requestAllPromptGroups } = promptGroupsContext ?? {};
  const { data, isLoading } = allPromptGroups ?? {};
  const showPromptsPopover = useRecoilValue(store.showPromptsPopoverFamily(index));

  const [activeIndex, setActiveIndex] = useState(0);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isVariableDialogOpen, setVariableDialogOpen] = useState(false);
  const [variableGroup, setVariableGroup] = useState<TPromptGroup | null>(null);
  const setShowPromptsPopover = useSetRecoilState(store.showPromptsPopoverFamily(index));

  const prompts = useMemo(() => data?.promptGroups, [data]);
  const promptsMap = useMemo(() => data?.promptsMap, [data]);

  const { open, setOpen, searchValue, setSearchValue, matches } = useCombobox({
    value: '',
    options: prompts ?? [],
  });

  const initInputRef = useInitPopoverInput({
    inputRef,
    textAreaRef,
    commandChar,
    setSearchValue,
    setOpen,
  });

  const handleSelect = useCallback(
    (mention?: PromptOption, e?: React.KeyboardEvent<HTMLInputElement>) => {
      if (!mention) {
        return;
      }

      setSearchValue('');
      setOpen(false);
      setShowPromptsPopover(false);

      if (textAreaRef.current) {
        removeCharIfLast(textAreaRef.current, commandChar);
      }

      const group = promptsMap?.[mention.id];
      if (!group) {
        return;
      }

      const hasVariables = detectVariables(group.productionPrompt?.prompt ?? '');
      if (hasVariables) {
        if (e && e.key === 'Tab') {
          e.preventDefault();
        }
        setVariableGroup(group);
        setVariableDialogOpen(true);
        return;
      } else {
        submitPrompt(group.productionPrompt?.prompt ?? '');
        if (group._id) {
          recordUsage(group._id);
        }
      }
    },
    [
      setSearchValue,
      setOpen,
      setShowPromptsPopover,
      textAreaRef,
      promptsMap,
      submitPrompt,
      recordUsage,
    ],
  );

  useEffect(() => {
    if (!open) {
      setActiveIndex(0);
      setSearchValue('');
    } else {
      /** Opening the picker before background warmup starts the fetch now */
      activateCatalog('prompts');
      setVariableGroup(null);
    }
  }, [open, setSearchValue]);

  /** The full prompt list is fetched on first popover open, not at app startup */
  useEffect(() => {
    if (showPromptsPopover) {
      requestAllPromptGroups?.();
    }
  }, [showPromptsPopover, requestAllPromptGroups]);

  useEffect(() => {
    setActiveIndex((prev) => Math.min(prev, Math.max(matches.length - 1, 0)));
  }, [matches.length]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const currentActiveItem = document.getElementById(`prompt-item-${activeIndex}`);
    currentActiveItem?.scrollIntoView({ behavior: 'instant', block: 'nearest' });
  }, [activeIndex]);

  if (!hasAccess) {
    return null;
  }

  const rowRenderer = ({
    index,
    key,
    style,
  }: {
    index: number;
    key: string;
    style: React.CSSProperties;
  }) => {
    const mention = matches[index] as PromptOption;
    return (
      <MentionItem
        index={index}
        type="prompt"
        key={key}
        style={style}
        onClick={() => {
          if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
          }
          timeoutRef.current = null;
          handleSelect(mention);
        }}
        name={mention.label ?? ''}
        icon={mention.icon}
        description={mention.description}
        isActive={index === activeIndex}
      />
    );
  };

  return (
    <PopoverContainer
      index={index}
      isVariableDialogOpen={isVariableDialogOpen}
      variableGroup={variableGroup}
      setVariableDialogOpen={setVariableDialogOpen}
      textAreaRef={textAreaRef}
    >
      <div className="absolute bottom-28 z-10 w-full space-y-2">
        <div className="popover border-border-light bg-surface-tertiary-alt rounded-2xl border p-2 shadow-lg">
          <Input
            ref={initInputRef}
            placeholder={localize('com_ui_command_usage_placeholder')}
            className="bg-surface-tertiary-alt text-text-primary mb-1 h-auto w-full rounded-none border-0 p-2 text-sm"
            autoComplete="off"
            value={searchValue}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setOpen(false);
                setShowPromptsPopover(false);
                textAreaRef.current?.focus();
              }
              if (e.key === 'ArrowDown') {
                if (matches.length === 0) {
                  return;
                }
                setActiveIndex((prevIndex) => (prevIndex + 1) % matches.length);
              } else if (e.key === 'ArrowUp') {
                if (matches.length === 0) {
                  return;
                }
                setActiveIndex((prevIndex) => (prevIndex - 1 + matches.length) % matches.length);
              } else if (e.key === 'Enter' || e.key === 'Tab') {
                if (matches.length === 0) {
                  e.preventDefault();
                  setOpen(false);
                  setShowPromptsPopover(false);
                  textAreaRef.current?.focus();
                  return;
                }
                if (e.key === 'Enter') {
                  e.preventDefault();
                }
                handleSelect(matches[activeIndex] as PromptOption | undefined, e);
              } else if (e.key === 'Backspace' && searchValue === '') {
                setOpen(false);
                setShowPromptsPopover(false);
                textAreaRef.current?.focus();
              }
            }}
            onChange={(e) => setSearchValue(e.target.value)}
            onFocus={() => setOpen(true)}
            onBlur={() => {
              timeoutRef.current = setTimeout(() => {
                setOpen(false);
                setShowPromptsPopover(false);
              }, 150);
            }}
          />
          {open && isLoading && matches.length === 0 && (
            <div className="text-text-primary flex h-32 items-center justify-center">
              <Spinner />
            </div>
          )}
          {open && matches.length > 0 && (
            <div className="max-h-40">
              <AutoSizer disableHeight>
                {({ width }) => (
                  <List
                    width={width}
                    overscanRowCount={5}
                    rowHeight={ROW_HEIGHT}
                    rowCount={matches.length}
                    rowRenderer={rowRenderer}
                    scrollToIndex={activeIndex}
                    height={Math.min(matches.length * ROW_HEIGHT, 160)}
                  />
                )}
              </AutoSizer>
            </div>
          )}
        </div>
      </div>
    </PopoverContainer>
  );
}

export default memo(PromptsCommand);
