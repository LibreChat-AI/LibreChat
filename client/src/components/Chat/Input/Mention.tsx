import { memo, useEffect } from 'react';
import { useRecoilValue, useSetRecoilState } from 'recoil';
import { MentionPopover } from '@librechat/chat/components';
import type { RecoilState } from 'recoil';
import type { ConvoGenerator } from '~/common';
import { useGetConversation, useLocalize, TranslationKeys } from '~/hooks';
import useWarnModelLocked from '~/hooks/Input/useWarnModelLocked';
import useSelectMention from '~/hooks/Input/useSelectMention';
import useIsModelLocked from '~/hooks/Input/useIsModelLocked';
import { useAssistantsMapContext } from '~/Providers';
import useMentions from '~/hooks/Input/useMentions';

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
  const isLockedForConversation = useIsModelLocked();
  const isModelLocked = commandChar === '@' && isLockedForConversation;
  const warnLocked = useWarnModelLocked();
  useEffect(() => {
    if (isModelLocked) {
      warnLocked();
      setShowPopover(false);
    }
  }, [isModelLocked, warnLocked, setShowPopover]);
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
    isModelLocked,
  });

  return (
    <MentionPopover
      textAreaRef={textAreaRef}
      commandChar={commandChar}
      placeholder={localize(placeholder)}
      options={options}
      isLoading={isLoading}
      agentsList={agentsList}
      assistantListMap={assistantListMap}
      modelsConfig={modelsConfig}
      onSelectMention={(option) => onSelectMention?.(option)}
      onClose={() => setShowPopover(false)}
    />
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
