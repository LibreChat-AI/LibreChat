import { memo, useState, useRef, useEffect } from 'react';
import { AutoSizer, List } from 'react-virtualized';
import { EModelEndpoint } from 'librechat-data-provider';
import { useRecoilValue, useSetRecoilState } from 'recoil';
import { Input, Spinner, useCombobox } from '@librechat/client';
import type { RecoilState } from 'recoil';
import type { MentionOption, ConvoGenerator } from '~/common';
import { useGetConversation, useLocalize, TranslationKeys } from '~/hooks';
import useInitPopoverInput from '~/hooks/Input/useInitPopoverInput';
import useSelectMention from '~/hooks/Input/useSelectMention';
import { useAssistantsMapContext } from '~/Providers';
import useMentions from '~/hooks/Input/useMentions';
import { removeCharIfLast } from '~/utils';
import MentionItem from './MentionItem';

const ROW_HEIGHT = 44;

type MentionProps = {
  index: number;
  popoverAtom: RecoilState<boolean>;
  newConversation: ConvoGenerator;
  textAreaRef: React.MutableRefObject<HTMLTextAreaElement | null>;
  commandChar?: string;
  placeholder?: TranslationKeys;
  includeAssistants?: boolean;
};

function MentionContent({
  popoverAtom,
  newConversation,
  textAreaRef,
  commandChar = '@',
  placeholder = 'com_ui_mention',
  includeAssistants = true,
}: Omit<MentionProps, 'index'>) {
  const localize = useLocalize();
  const getConversation = useGetConversation(0);
  const assistantsMap = useAssistantsMapContext();
  const setShowPopover = useSetRecoilState(popoverAtom);
  const {
    options,
    presets,
    isLoading,
    modelSpecs,
    agentsList,
    modelsConfig,
    endpointsConfig,
    assistantListMap,
  } = useMentions({ assistantMap: assistantsMap || {}, includeAssistants });
  const { onSelectMention } = useSelectMention({
    presets,
    modelSpecs,
    assistantsMap,
    endpointsConfig,
    getConversation,
    newConversation,
  });

  const [activeIndex, setActiveIndex] = useState(0);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [inputOptions, setInputOptions] = useState<MentionOption[]>(options);

  const { open, setOpen, searchValue, setSearchValue, matches } = useCombobox({
    value: '',
    options: inputOptions,
  });

  const initInputRef = useInitPopoverInput({
    inputRef,
    textAreaRef,
    commandChar,
    setSearchValue,
    setOpen,
  });

  const handleSelect = (mention?: MentionOption) => {
    if (!mention) {
      return;
    }

    const defaultSelect = () => {
      setSearchValue('');
      setOpen(false);
      setShowPopover(false);
      onSelectMention?.(mention);

      if (textAreaRef.current) {
        removeCharIfLast(textAreaRef.current, commandChar);
      }
    };

    if (mention.type === 'endpoint' && mention.value === EModelEndpoint.agents) {
      setSearchValue('');
      setInputOptions(agentsList ?? []);
      setActiveIndex(0);
      inputRef.current?.focus();
    } else if (mention.type === 'endpoint' && mention.value === EModelEndpoint.assistants) {
      setSearchValue('');
      setInputOptions(assistantListMap[EModelEndpoint.assistants] ?? []);
      setActiveIndex(0);
      inputRef.current?.focus();
    } else if (mention.type === 'endpoint' && mention.value === EModelEndpoint.azureAssistants) {
      setSearchValue('');
      setInputOptions(assistantListMap[EModelEndpoint.azureAssistants] ?? []);
      setActiveIndex(0);
      inputRef.current?.focus();
    } else if (mention.type === 'endpoint') {
      const models = (modelsConfig?.[mention.value || ''] ?? []).map((model) => ({
        value: mention.value,
        label: model,
        type: 'model',
      }));

      setActiveIndex(0);
      setSearchValue('');
      setInputOptions(models);
      inputRef.current?.focus();
    } else {
      defaultSelect();
    }
  };

  useEffect(() => {
    if (!open) {
      setInputOptions(options);
      setActiveIndex(0);
    }
  }, [open, options]);

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

  const type = commandChar !== '@' ? 'add-convo' : 'mention';
  useEffect(() => {
    const currentActiveItem = document.getElementById(`${type}-item-${activeIndex}`);
    currentActiveItem?.scrollIntoView({ behavior: 'instant', block: 'nearest' });
  }, [type, activeIndex]);

  const rowRenderer = ({
    index,
    key,
    style,
  }: {
    index: number;
    key: string;
    style: React.CSSProperties;
  }) => {
    const mention = matches[index] as MentionOption;
    return (
      <MentionItem
        type={type}
        index={index}
        key={key}
        style={style}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
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
    <div className="absolute bottom-28 z-10 w-full space-y-2">
      <div className="popover border-border-light bg-surface-secondary rounded-2xl border p-2 shadow-lg">
        <Input
          ref={initInputRef}
          placeholder={localize(placeholder)}
          className="bg-surface-secondary text-text-primary mb-1 h-auto w-full rounded-none border-0 p-2 text-sm"
          autoComplete="off"
          value={searchValue}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setOpen(false);
              setShowPopover(false);
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
                setShowPopover(false);
                textAreaRef.current?.focus();
                return;
              }
              const mentionOption = matches[activeIndex] as MentionOption | undefined;
              if (mentionOption?.type === 'endpoint') {
                e.preventDefault();
              } else if (e.key === 'Enter') {
                e.preventDefault();
              }
              handleSelect(matches[activeIndex] as MentionOption);
            } else if (e.key === 'Backspace' && searchValue === '') {
              setOpen(false);
              setShowPopover(false);
              textAreaRef.current?.focus();
            }
          }}
          onChange={(e) => setSearchValue(e.target.value)}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            timeoutRef.current = setTimeout(() => {
              setOpen(false);
              setShowPopover(false);
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
  );
}

const MentionPopoverContainer = memo(function MentionPopoverContainer({
  index: _index,
  popoverAtom,
  ...rest
}: MentionProps) {
  const show = useRecoilValue(popoverAtom);
  if (!show) {
    return null;
  }
  return <MentionContent popoverAtom={popoverAtom} {...rest} />;
});

export default MentionPopoverContainer;
