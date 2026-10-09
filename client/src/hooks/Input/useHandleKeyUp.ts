import { useCallback, useEffect, useMemo } from 'react';
import { useSetAtom } from 'jotai';
import { useSetRecoilState, useRecoilValue } from 'recoil';
import { PermissionTypes, Permissions, isAssistantsEndpoint } from 'librechat-data-provider';
import { showSkillsPopoverFamily } from '~/components/Chat/Input/skillsState';
import { useGetLatestMessage } from '~/hooks/Messages/useLatestMessage';
import useAgentCapabilities from '~/hooks/Agents/useAgentCapabilities';
import useGetAgentsConfig from '~/hooks/Agents/useGetAgentsConfig';
import useHasAccess from '~/hooks/Roles/useHasAccess';
import store from '~/store';

/** Event keys that shouldn't trigger a command */
const invalidKeys = {
  Escape: true,
  Backspace: true,
  Enter: true,
  ArrowUp: true,
  ArrowLeft: true,
  ArrowRight: true,
  ArrowDown: true,
  Home: true,
  End: true,
  Delete: true,
};

/**
 * Determines if a command popover should trigger.
 * Uses `startPos === 1` for normal typing speed (cursor right after the command char)
 * and a short text-length fallback for fast typists whose keyup fires after the cursor
 * has already moved past position 1. The length cap prevents false triggers from
 * pasted content that happens to start with a command character.
 */
const MAX_COMMAND_TRIGGER_LENGTH = 5;
const shouldTriggerCommand = (
  textAreaRef: React.RefObject<HTMLTextAreaElement>,
  commandChar: string,
) => {
  const text = textAreaRef.current?.value;
  if (typeof text !== 'string' || text.length === 0 || text[0] !== commandChar) {
    return false;
  }

  const startPos = textAreaRef.current?.selectionStart;
  if (typeof startPos !== 'number') {
    return false;
  }

  return startPos === 1 || (startPos === text.length && text.length <= MAX_COMMAND_TRIGGER_LENGTH);
};

/**
 * Custom hook for handling key up events with command triggers.
 */
const useHandleKeyUp = ({
  index,
  textAreaRef,
}: {
  index: number;
  textAreaRef: React.RefObject<HTMLTextAreaElement>;
}) => {
  const hasPromptsAccess = useHasAccess({
    permissionType: PermissionTypes.PROMPTS,
    permission: Permissions.USE,
  });
  const hasMultiConvoAccess = useHasAccess({
    permissionType: PermissionTypes.MULTI_CONVO,
    permission: Permissions.USE,
  });
  const hasSkillsAccess = useHasAccess({
    permissionType: PermissionTypes.SKILLS,
    permission: Permissions.USE,
  });
  const { agentsConfig } = useGetAgentsConfig();
  const { skillsEnabled } = useAgentCapabilities(agentsConfig?.capabilities);
  const getLatestMessage = useGetLatestMessage(index);
  const endpoint = useRecoilValue(store.effectiveEndpointByIndex(index));
  const setShowMentionPopover = useSetRecoilState(store.showMentionPopoverFamily(index));
  const setShowPlusPopover = useSetRecoilState(store.showPlusPopoverFamily(index));
  const setShowPromptsPopover = useSetRecoilState(store.showPromptsPopoverFamily(index));
  const setShowSkillsPopover = useSetAtom(showSkillsPopoverFamily(index));

  const atCommandEnabled = useRecoilValue(store.atCommand);
  const plusCommandEnabled = useRecoilValue(store.plusCommand);
  const slashCommandEnabled = useRecoilValue(store.slashCommand);
  const dollarCommandEnabled = useRecoilValue(store.dollarCommand);

  useEffect(() => {
    if (isAssistantsEndpoint(endpoint)) {
      setShowPlusPopover(false);
      setShowSkillsPopover(false);
    }
  }, [endpoint, setShowPlusPopover, setShowSkillsPopover]);

  const handleAtCommand = useCallback(() => {
    if (atCommandEnabled && shouldTriggerCommand(textAreaRef, '@')) {
      setShowMentionPopover(true);
    }
  }, [textAreaRef, setShowMentionPopover, atCommandEnabled]);

  const handlePlusCommand = useCallback(() => {
    if (!hasMultiConvoAccess || !plusCommandEnabled || isAssistantsEndpoint(endpoint)) {
      return;
    }
    if (shouldTriggerCommand(textAreaRef, '+')) {
      setShowPlusPopover(true);
    }
  }, [textAreaRef, setShowPlusPopover, plusCommandEnabled, hasMultiConvoAccess, endpoint]);

  const handlePromptsCommand = useCallback(() => {
    if (!hasPromptsAccess || !slashCommandEnabled) {
      return;
    }
    if (shouldTriggerCommand(textAreaRef, '/')) {
      setShowPromptsPopover(true);
    }
  }, [textAreaRef, hasPromptsAccess, setShowPromptsPopover, slashCommandEnabled]);

  const handleSkillsCommand = useCallback(() => {
    if (
      !hasSkillsAccess ||
      !skillsEnabled ||
      !dollarCommandEnabled ||
      isAssistantsEndpoint(endpoint)
    ) {
      return;
    }
    if (shouldTriggerCommand(textAreaRef, '$')) {
      setShowSkillsPopover(true);
    }
  }, [
    textAreaRef,
    hasSkillsAccess,
    skillsEnabled,
    setShowSkillsPopover,
    dollarCommandEnabled,
    endpoint,
  ]);

  const commandHandlers = useMemo(
    () => ({
      '@': handleAtCommand,
      '+': handlePlusCommand,
      '/': handlePromptsCommand,
      $: handleSkillsCommand,
    }),
    [handleAtCommand, handlePlusCommand, handlePromptsCommand, handleSkillsCommand],
  );

  const handleUpArrow = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const latestMessage = getLatestMessage();
      if (!latestMessage) {
        return;
      }

      const element = document.getElementById(`edit-${latestMessage.parentMessageId}`);
      if (!element) {
        return;
      }
      event.preventDefault();
      element.click();
    },
    [getLatestMessage],
  );

  /**
   * Main key up handler.
   */
  const handleKeyUp = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const text = textAreaRef.current?.value;
      if (event.key === 'ArrowUp' && text?.length === 0) {
        handleUpArrow(event);
        return;
      }
      if (typeof text !== 'string' || text.length === 0) {
        return;
      }

      if (invalidKeys[event.key as keyof typeof invalidKeys]) {
        return;
      }

      const firstChar = text[0];
      const handler = commandHandlers[firstChar as keyof typeof commandHandlers];

      if (typeof handler === 'function') {
        handler();
      }
    },
    [textAreaRef, commandHandlers, handleUpArrow],
  );

  return handleKeyUp;
};

export default useHandleKeyUp;
