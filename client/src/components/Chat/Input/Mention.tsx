import { memo, useMemo, useState } from 'react';
import { findMentionRange } from '@librechat/chat';
import { useRecoilValue, useSetRecoilState } from 'recoil';
import { MentionPopover } from '@librechat/chat/components';
import type { RecoilState } from 'recoil';
import type { ConvoGenerator } from '~/common';
import { useGetConversation, useLocalize, TranslationKeys } from '~/hooks';
import useSelectMention from '~/hooks/Input/useSelectMention';
import useMCPMentions from '~/hooks/Input/useMCPMentions';
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
  mcpMentionsEnabled?: boolean;
};

function MentionContent({
  popoverAtom,
  newConversation,
  textAreaRef,
  commandChar = '@',
  placeholder = 'com_ui_mention',
  includeAssistants = true,
  mcpMentionsEnabled = false,
}: Omit<MentionProps, 'index'>) {
  const localize = useLocalize();
  const getConversation = useGetConversation(0);
  const assistantsMap = useAssistantsMapContext();
  const setShowPopover = useSetRecoilState(popoverAtom);
  const enabled = commandChar === '@' && mcpMentionsEnabled;
  const [commandRange] = useState(() => {
    const textarea = textAreaRef.current;
    return enabled && textarea
      ? findMentionRange(textarea.value, textarea.selectionStart, textarea.selectionEnd)
      : undefined;
  });
  const mcp = useMCPMentions(enabled);
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
  const mentionOptions = useMemo(
    () => (commandRange && commandRange.start > 0 ? mcp.options : [...options, ...mcp.options]),
    [commandRange, mcp.options, options],
  );

  return (
    <MentionPopover
      textAreaRef={textAreaRef}
      commandChar={commandChar}
      commandRange={commandRange}
      placeholder={localize(
        commandRange && commandRange.start > 0 ? 'com_ui_mcp_mention' : placeholder,
      )}
      options={mentionOptions}
      isLoading={isLoading || mcp.isLoading}
      notice={mcp.notice}
      agentsList={agentsList}
      assistantListMap={assistantListMap}
      modelsConfig={modelsConfig}
      onSelectMention={(option) => {
        if (enabled && option.type === 'mcp') {
          mcp.selectServer?.(option.value);
          return;
        }
        onSelectMention?.(option);
      }}
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
