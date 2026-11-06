import { memo, useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { Constants } from 'librechat-data-provider';
import { ThinkingControl } from '@librechat/chat/components';
import { queuedMessagesByConvoId } from '@librechat/chat/react';
import { getBranchReasoning, getAppendParentMessageId } from '@librechat/chat';
import { ReasoningControl, useComposerReasoning } from '../Reasoning';
import { useGetStartupConfig } from '~/data-provider';
import { useChatContext } from '~/Providers';
import { getModelSpec } from '~/utils';

/**
 * Reasoning effort in the composer footer, the one model parameter worth
 * reaching for mid-conversation, which otherwise lives three clicks away in the
 * parameters panel under a different name per provider.
 *
 * Model and agent selection deliberately stay in the header; this owns effort
 * only. Renders nothing at all for models that expose no reasoning parameter,
 * and nothing when `interface.parameters` is off (the same gate as the
 * Parameters side panel; model specs default that flag to false).
 *
 * Split in two so the control's hooks are never behind that early return.
 */
interface ThinkingProps {
  index: number;
  disabled: boolean;
  hasAddedConversation: boolean;
}

function Thinking({ index, disabled, hasAddedConversation }: ThinkingProps) {
  const { conversation, latestMessageId, getMessages } = useChatContext();
  const { data: startupConfig } = useGetStartupConfig();
  const parametersEnabled = startupConfig?.interface?.parameters;
  const modelSpec = getModelSpec({ specName: conversation?.spec, startupConfig });
  const blockedReasoningKeys = useMemo(() => {
    if (startupConfig?.modelSpecs?.enforce !== true || modelSpec?.preset == null) {
      return undefined;
    }
    return new Set(Object.keys(modelSpec.preset));
  }, [modelSpec?.preset, startupConfig?.modelSpecs?.enforce]);
  const queueKey =
    conversation?.conversationId != null && conversation.conversationId !== ''
      ? conversation.conversationId
      : Constants.NEW_CONVO;
  const queued = useAtomValue(queuedMessagesByConvoId(queueKey));
  /* The server runs a turn without its own pick at the level its branch last ran at, so the
     button names that level: the latest pick still waiting in the queue, otherwise the one the
     branch the composer extends carries. */
  const queuedReasoning = useMemo(() => {
    for (let i = queued.length - 1; i >= 0; i--) {
      const row = queued[i];
      /* A held row waits for an explicit send, so it is not the turn that runs next. */
      if (row.heldByUser === true || row.needsExplicitSend === true) {
        continue;
      }
      if (row.reasoningOverride != null) {
        return row.reasoningOverride;
      }
    }
    return undefined;
  }, [queued]);
  const branchReasoning = useMemo(() => {
    if (queuedReasoning != null) {
      return queuedReasoning;
    }
    const messages = getMessages(conversation?.conversationId) ?? [];
    const latestMessage = messages.find((message) => message.messageId === latestMessageId);
    return getBranchReasoning(
      messages,
      getAppendParentMessageId({ latestMessage: latestMessage ?? null, currentMessages: messages }),
    );
  }, [conversation?.conversationId, getMessages, latestMessageId, queuedReasoning]);
  const reasoning = useComposerReasoning({
    conversation: conversation ?? null,
    index,
    hasAddedConversation,
    enabled: parametersEnabled,
    blockedReasoningKeys,
    branchReasoning,
  });

  if (parametersEnabled !== true || reasoning == null) {
    return null;
  }

  if (reasoning.setting.type !== 'enum' || reasoning.setting.options?.length === 0) {
    return (
      <ReasoningControl
        index={index}
        setting={reasoning.setting}
        value={reasoning.value}
        disabled={disabled}
        onChange={reasoning.setValue}
      />
    );
  }

  return (
    <ThinkingControl
      index={index}
      setting={reasoning.setting}
      conversation={conversation ?? null}
      value={reasoning.value}
      disabled={disabled}
      onChange={reasoning.setValue}
    />
  );
}

export default memo(Thinking);
