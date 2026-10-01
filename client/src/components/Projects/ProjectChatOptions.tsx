import { memo, useId, useMemo, useRef, useState } from 'react';
import * as Ariakit from '@ariakit/react';
import { Ellipsis, FolderInput, FolderX, Trash2 } from 'lucide-react';
import { DropdownPopup, Spinner, useToastContext } from '@librechat/client';
import type { TConversation } from 'librechat-data-provider';
import type { MenuItemProps } from '~/common';
import ProjectButton from '~/components/Conversations/ConvoOptions/ProjectButton';
import DeleteButton from '~/components/Conversations/ConvoOptions/DeleteButton';
import { useAssignConversationToProjectMutation } from '~/data-provider';
import { NotificationSeverity } from '~/common';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

type ProjectChatOptionsProps = {
  conversation: TConversation;
  isMenuOpen: boolean;
  setIsMenuOpen: (open: boolean) => void;
};

const noop = () => {};

function ProjectChatOptions({ conversation, isMenuOpen, setIsMenuOpen }: ProjectChatOptionsProps) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const menuId = useId();
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showProjectDialog, setShowProjectDialog] = useState(false);

  const conversationId = conversation.conversationId ?? '';
  const chatProjectId = conversation.chatProjectId ?? null;
  const assignConversationToProject = useAssignConversationToProjectMutation();

  const menuItems = useMemo<MenuItemProps[]>(() => {
    if (!conversationId) {
      return [];
    }

    return [
      {
        label: localize('com_ui_change_project'),
        onClick: () => setShowProjectDialog(true),
        icon: <FolderInput className="text-text-secondary size-4" aria-hidden="true" />,
        /** Hiding the menu here restores focus to the trigger, which the dialog
         *  mounting alongside it reads as an outside interaction and closes on.
         *  Both dialogs receive setIsMenuOpen and close the menu themselves. */
        hideOnClick: false,
        render: (props) => <button {...props} />,
      },
      {
        label: localize('com_ui_remove_from_project'),
        show: Boolean(chatProjectId),
        onClick: () => {
          assignConversationToProject.mutate(
            { conversationId, projectId: null },
            {
              onSuccess: () => {
                setIsMenuOpen(false);
                showToast({
                  message: localize('com_ui_project_updated'),
                  severity: NotificationSeverity.SUCCESS,
                  showIcon: true,
                });
              },
              onError: () => {
                showToast({
                  message: localize('com_ui_project_update_error'),
                  severity: NotificationSeverity.ERROR,
                  showIcon: true,
                });
              },
            },
          );
        },
        hideOnClick: false,
        icon: assignConversationToProject.isLoading ? (
          <Spinner className="size-4" />
        ) : (
          <FolderX className="text-text-secondary size-4" aria-hidden="true" />
        ),
      },
      {
        label: localize('com_ui_delete'),
        onClick: () => setShowDeleteDialog(true),
        hideOnClick: false,
        render: (props) => <button {...props} />,
        icon: <Trash2 className="text-text-secondary size-4" aria-hidden="true" />,
      },
    ];
  }, [
    assignConversationToProject,
    chatProjectId,
    conversationId,
    localize,
    setIsMenuOpen,
    showToast,
  ]);

  return (
    <>
      <DropdownPopup
        portal={true}
        focusLoop={true}
        unmountOnHide={true}
        menuId={menuId}
        isOpen={isMenuOpen}
        setIsOpen={setIsMenuOpen}
        className="z-[125] min-w-44"
        iconClassName="mr-2 text-text-secondary"
        trigger={
          <Ariakit.MenuButton
            ref={menuButtonRef}
            aria-label={localize('com_nav_convo_menu_options')}
            className={cn(
              'text-text-secondary flex h-8 w-8 shrink-0 items-center justify-center rounded-full outline-hidden transition-colors',
              'hover:bg-surface-hover hover:text-text-primary',
              'focus-visible:ring-text-primary focus-visible:ring-2 focus-visible:ring-inset',
              isMenuOpen && 'bg-surface-hover text-text-primary',
            )}
          >
            <Ellipsis className="h-4 w-4" aria-hidden="true" />
          </Ariakit.MenuButton>
        }
        items={menuItems}
      />
      {showProjectDialog ? (
        <ProjectButton
          conversationId={conversationId}
          chatProjectId={chatProjectId}
          setMenuOpen={setIsMenuOpen}
          triggerRef={menuButtonRef}
          showProjectDialog={showProjectDialog}
          setShowProjectDialog={setShowProjectDialog}
        />
      ) : null}
      {showDeleteDialog ? (
        <DeleteButton
          title={conversation.title ?? ''}
          retainView={noop}
          triggerRef={menuButtonRef}
          setMenuOpen={setIsMenuOpen}
          showDeleteDialog={showDeleteDialog}
          conversationId={conversationId}
          setShowDeleteDialog={setShowDeleteDialog}
        />
      ) : null}
    </>
  );
}

export default memo(ProjectChatOptions);
