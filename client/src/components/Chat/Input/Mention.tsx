import { memo, useMemo } from 'react';
import { useRecoilValue, useSetRecoilState } from 'recoil';
import { MentionPopover } from '@librechat/chat/components';
import type { RecoilState } from 'recoil';
import type { ConvoGenerator } from '~/common';
import useSelectMention, { mentionEndpoint } from '~/hooks/Input/useSelectMention';
import { useComposerPreferences } from '~/Providers/ComposerPreferencesContext';
import { useGetConversation, useLocalize, TranslationKeys } from '~/hooks';
import { getConvoSwitchLogic, switchesInPlace } from '~/utils';
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
  /**
   * Offers only the choices that change the pane's conversation in place, for a pane that
   * cannot start another one: a conversation open beside the chat.
   */
  inPlace?: boolean;
};

function MentionContent({
  index,
  popoverAtom,
  newConversation,
  textAreaRef,
  commandChar = '@',
  placeholder = 'com_ui_mention',
  includeAssistants = true,
  inPlace = false,
}: MentionProps) {
  const localize = useLocalize();
  const getConversation = useGetConversation(index);
  /** The reader's preference as the chat view handed it down, for the list and the pick alike. */
  const { modularChat } = useComposerPreferences();
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
    modularChat,
    endpointsConfig,
    getConversation,
    newConversation,
  });

  /** Decided by the rule the selection itself follows, so what is offered is what is done. */
  const offered = useMemo(() => {
    if (!inPlace) {
      return options;
    }
    const conversation = getConversation();
    return options.filter((option) => {
      const newEndpoint = mentionEndpoint(option, { presets, modelSpecs });
      return (
        newEndpoint != null &&
        newEndpoint !== '' &&
        switchesInPlace(
          getConvoSwitchLogic({ newEndpoint, modularChat, conversation, endpointsConfig }),
        )
      );
    });
  }, [inPlace, options, presets, modelSpecs, modularChat, endpointsConfig, getConversation]);

  return (
    <MentionPopover
      textAreaRef={textAreaRef}
      commandChar={commandChar}
      placeholder={localize(placeholder)}
      options={offered}
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
