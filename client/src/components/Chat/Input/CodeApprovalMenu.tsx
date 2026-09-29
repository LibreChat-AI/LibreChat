import * as Ariakit from '@ariakit/react';
import { useQueryClient } from '@tanstack/react-query';
import { QueryKeys, Constants } from 'librechat-data-provider';
import { TooltipAnchor, composerControlClasses } from '@librechat/client';
import { Check, ChevronDown, FilePen, FileQuestionMark, FileTerminal } from 'lucide-react';
import type { CodeApprovalMode, TConversation } from 'librechat-data-provider';
import type { LucideIcon } from 'lucide-react';
import type { SetterOrUpdater } from 'recoil';
import type { TranslationKeys } from '~/hooks';
import { useCodeApprovalModePreference } from '~/hooks/Agents/codeApprovalPreference';
import { useCodeApprovalMode, useLocalize } from '~/hooks';
import { cn } from '~/utils';

/** The modes answer one question — what may happen to the workspace without the
 *  reader — so they share the document glyph and differ only in what is drawn on
 *  it, escalating with what each mode permits: a question the reader answers, a
 *  pen for writes that need no answer, a prompt for commands that need none
 *  either. The shield stays with the pending review button, which sits in this
 *  same row. */
const modeOptions: Record<
  CodeApprovalMode,
  { icon: LucideIcon; label: TranslationKeys; description: TranslationKeys }
> = {
  ask: {
    icon: FileQuestionMark,
    label: 'com_ui_code_approval_ask',
    description: 'com_ui_code_approval_ask_description',
  },
  acceptEdits: {
    icon: FilePen,
    label: 'com_ui_code_approval_accept_edits',
    description: 'com_ui_code_approval_accept_edits_description',
  },
  fullAccess: {
    icon: FileTerminal,
    label: 'com_ui_code_approval_full_access',
    description: 'com_ui_code_approval_full_access_description',
  },
};

export default function CodeApprovalMenu({
  conversation,
  addedConversation,
  setConversation,
  disabled,
}: {
  conversation: TConversation | null;
  addedConversation?: TConversation | null;
  setConversation: SetterOrUpdater<TConversation | null>;
  disabled: boolean;
}) {
  const localize = useLocalize();
  const queryClient = useQueryClient();
  const { available, modes, selected } = useCodeApprovalMode(conversation, addedConversation);
  const preference = useCodeApprovalModePreference();
  const menuStore = Ariakit.useMenuStore({ focusLoop: true, placement: 'top-start' });
  const isOpen = menuStore.useState('open');

  if (!available || selected == null) {
    return null;
  }

  /** Navigation and run recovery rebuild the conversation from its detail
   *  cache, so the pick lands there too, seeding the record from the live
   *  conversation when none exists yet (the resumable transport seeds the same
   *  key optimistically). A chat that has no id yet keeps the pick in
   *  conversation state alone until the run assigns one. The pick is also this
   *  browser's remembered default, so the next chat opens on it rather than back
   *  at `ask`; policy is re-checked before it is ever shown or submitted. */
  const selectMode = (mode: CodeApprovalMode) => {
    if (!modes.includes(mode)) {
      return;
    }
    preference.remember(mode);
    setConversation((current) =>
      current == null ? current : { ...current, codeApprovalMode: mode },
    );
    const record = conversation;
    const conversationId = record?.conversationId;
    if (record == null || conversationId == null || conversationId === Constants.NEW_CONVO) {
      return;
    }
    queryClient.setQueryData<TConversation>([QueryKeys.conversation, conversationId], (cached) => ({
      ...(cached ?? record),
      codeApprovalMode: mode,
    }));
  };

  const SelectedIcon = modeOptions[selected].icon;

  return (
    <Ariakit.MenuProvider store={menuStore}>
      <TooltipAnchor
        description={localize('com_ui_code_approval_mode')}
        disabled={isOpen}
        render={
          <Ariakit.MenuButton
            disabled={disabled}
            data-testid="code-approval-mode"
            aria-label={`${localize('com_ui_code_approval_mode')}: ${localize(
              modeOptions[selected].label,
            )}`}
            className={cn(
              composerControlClasses(),
              'min-w-0 max-w-full px-2.5 md:px-theme-normal',
              isOpen && 'bg-surface-hover',
              disabled && 'cursor-not-allowed opacity-50',
            )}
          />
        }
      >
        <SelectedIcon className="size-4 shrink-0 text-text-secondary" aria-hidden="true" />
        <span className="min-w-0 max-w-[12rem] truncate">
          {localize(modeOptions[selected].label)}
        </span>
        <ChevronDown
          className={cn(
            'size-3 shrink-0 text-text-secondary transition-transform',
            isOpen && 'rotate-180',
          )}
          aria-hidden="true"
        />
      </TooltipAnchor>
      <Ariakit.Menu
        portal={true}
        gutter={8}
        unmountOnHide={true}
        className={cn(
          'z-50 flex min-w-[280px] max-w-[min(320px,calc(100vw-2rem))] flex-col rounded-xl',
          'max-h-[var(--popover-available-height)] overflow-y-auto border border-border-light bg-presentation p-1.5 shadow-lg',
          'origin-bottom opacity-0 transition-[opacity,transform] duration-200 ease-out',
          'data-[enter]:scale-100 data-[enter]:opacity-100',
          'scale-95 data-[leave]:scale-95 data-[leave]:opacity-0',
        )}
      >
        {/* Names the menu without adding an `h1` to the page outline. */}
        <Ariakit.MenuHeading
          render={<div />}
          className="px-2.5 py-1.5 text-xs font-medium text-text-secondary"
        >
          {localize('com_ui_code_approval_mode')}
        </Ariakit.MenuHeading>
        {modes.map((mode) => {
          const { icon: Icon, label, description } = modeOptions[mode];
          const isSelected = mode === selected;
          return (
            <Ariakit.MenuItemRadio
              key={mode}
              name="codeApprovalMode"
              value={mode}
              checked={isSelected}
              hideOnClick={true}
              onChange={() => selectMode(mode)}
              className={cn(
                'group flex w-full cursor-pointer items-start gap-3 rounded-lg px-2.5 py-2',
                'outline-none transition-colors duration-theme-fast',
                'hover:bg-surface-hover data-[active-item]:bg-surface-hover',
                isSelected && 'bg-surface-active-alt',
              )}
            >
              <Icon className="mt-0.5 size-4 shrink-0 text-text-secondary" aria-hidden="true" />
              <div className="min-w-0 flex-1 text-left">
                <div className="text-sm font-medium text-text-primary">{localize(label)}</div>
                <p className="text-xs text-text-secondary">{localize(description)}</p>
              </div>
              {isSelected && (
                <Check className="mt-0.5 size-4 shrink-0 text-text-primary" aria-hidden="true" />
              )}
            </Ariakit.MenuItemRadio>
          );
        })}
      </Ariakit.Menu>
    </Ariakit.MenuProvider>
  );
}
