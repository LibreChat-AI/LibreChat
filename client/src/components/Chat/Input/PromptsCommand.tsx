import { useState, useEffect, useMemo, memo, useCallback } from 'react';
import { useToastContext } from '@librechat/client';
import { useSetRecoilState, useRecoilValue } from 'recoil';
import { PromptsPopover } from '@librechat/chat/components';
import type { TPromptGroup } from 'librechat-data-provider';
import type { PromptOption } from '~/common';
import { detectVariables, isExternalPromptGroup, getPromptResolveErrorMessage } from '~/utils';
import { activateCatalog, useLocalize, usePromptContentResolver } from '~/hooks';
import useChatScopedRequest from '~/hooks/Prompts/useChatScopedRequest';
import { useRecordPromptUsage } from '~/data-provider';
import { VariableDialog } from '~/components/Prompts';
import { usePromptGroupsContext } from '~/Providers';
import store from '~/store';

const PopoverContainer = memo(
  ({
    index,
    children,
    isVariableDialogOpen,
    variableGroup,
    variableText,
    setVariableDialogOpen,
    textAreaRef,
  }: {
    index: number;
    children: React.ReactNode;
    isVariableDialogOpen: boolean;
    variableGroup: TPromptGroup | null;
    variableText: string | undefined;
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
          promptText={variableText}
        />
      </>
    );
  },
);

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
  const { showToast } = useToastContext();
  const { mutate: recordUsage } = useRecordPromptUsage();
  const resolvePromptContent = usePromptContentResolver();
  const promptGroupsContext = usePromptGroupsContext();
  const { allPromptGroups, hasAccess, requestAllPromptGroups } = promptGroupsContext ?? {};
  const { data, isLoading } = allPromptGroups ?? {};
  const showPromptsPopover = useRecoilValue(store.showPromptsPopoverFamily(index));

  const [isVariableDialogOpen, setVariableDialogOpen] = useState(false);
  const [variableGroup, setVariableGroup] = useState<TPromptGroup | null>(null);
  const [variableText, setVariableText] = useState<string | undefined>(undefined);
  const setShowPromptsPopover = useSetRecoilState(store.showPromptsPopoverFamily(index));

  /** A resolve that was started for one chat must not land on another; see
   *  `useChatScopedRequest` for the three cancellation keys. On cancel, a
   *  variable dialog opened from the stale read closes rather than
   *  surviving into the chat the user moved to. */
  const { begin, isCurrent, isMounted } = useChatScopedRequest(index, () => {
    setVariableDialogOpen(false);
  });

  const prompts = useMemo(() => data?.promptGroups, [data]);
  const promptsMap = useMemo(() => data?.promptsMap, [data]);

  const handleSelect = useCallback(
    async (mention: PromptOption, e?: React.KeyboardEvent<HTMLInputElement>) => {
      const group = promptsMap?.[mention.id];
      if (!group) {
        return;
      }

      const isLangfuse = isExternalPromptGroup(group);
      /** Native resolution is synchronous, so the dialog-vs-submit split is already
       *  known here; a Langfuse group's content (and so its variables) is unknown
       *  until it resolves, so Tab's default focus move is held off either way. */
      const hasKnownVariables =
        !isLangfuse && detectVariables(group.productionPrompt?.prompt ?? '');
      if (e && e.key === 'Tab' && (isLangfuse || hasKnownVariables)) {
        e.preventDefault();
      }

      /** Supersedes a resolve still pending for a prior selection: `begin`
       *  bumps the token, so that request's own guard above now discards it
       *  instead of this one waiting behind it. */
      const token = begin();
      if (isLangfuse) {
        showToast({ status: 'info', message: localize('com_ui_prompt_resolving') });
      }
      try {
        const text = await resolvePromptContent(group);
        /** The popover may have unmounted, or the active conversation may
         *  have changed, while the Langfuse resolve was in flight; a stale
         *  continuation must not submit, stage, or record for a chat the
         *  user left. */
        if (!isMounted() || !isCurrent(token)) {
          return;
        }
        if (!text?.trim()) {
          textAreaRef.current?.focus();
          return;
        }
        if (detectVariables(text)) {
          setVariableGroup(group);
          setVariableText(text);
          setVariableDialogOpen(true);
          return;
        }
        submitPrompt(text);
        if (group._id) {
          recordUsage(group._id);
        }
        textAreaRef.current?.focus();
      } catch (error) {
        if (isMounted() && isCurrent(token)) {
          showToast({ status: 'error', message: getPromptResolveErrorMessage(error, localize) });
          textAreaRef.current?.focus();
        }
      }
    },
    [
      textAreaRef,
      promptsMap,
      submitPrompt,
      recordUsage,
      resolvePromptContent,
      showToast,
      localize,
      begin,
      isCurrent,
      isMounted,
    ],
  );

  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) {
      return;
    }
    /** Opening the picker before background warmup starts the fetch now */
    activateCatalog('prompts');
    setVariableGroup(null);
    setVariableText(undefined);
  }, []);

  /** The full prompt list is fetched on first popover open, not at app startup */
  useEffect(() => {
    if (showPromptsPopover) {
      requestAllPromptGroups?.();
    }
  }, [showPromptsPopover, requestAllPromptGroups]);

  if (!hasAccess) {
    return null;
  }

  return (
    <PopoverContainer
      index={index}
      isVariableDialogOpen={isVariableDialogOpen}
      variableGroup={variableGroup}
      variableText={variableText}
      setVariableDialogOpen={setVariableDialogOpen}
      textAreaRef={textAreaRef}
    >
      <PromptsPopover
        textAreaRef={textAreaRef}
        placeholder={localize('com_ui_command_usage_placeholder')}
        prompts={prompts ?? []}
        isLoading={isLoading === true}
        onOpenChange={handleOpenChange}
        onSelectPrompt={handleSelect}
        onClose={() => setShowPromptsPopover(false)}
      />
    </PopoverContainer>
  );
}

export default memo(PromptsCommand);
