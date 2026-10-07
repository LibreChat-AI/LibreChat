import { memo, useId, useMemo, useRef, useState } from 'react';
import * as Ariakit from '@ariakit/react';
import { Ellipsis, Trash2 } from 'lucide-react';
import { DropdownPopup, buttonVariants } from '@librechat/client';
import type { TConversation } from 'librechat-data-provider';
import type { MenuItemProps } from '~/common';
import DeleteButton from '~/components/Conversations/ConvoOptions/DeleteButton';
import useProjectMenuItem from '~/hooks/Chat/useProjectMenuItem';
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
  const menuId = useId();
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const conversationId = conversation.conversationId ?? '';
  const chatProjectId = conversation.chatProjectId ?? null;
  const projectItem = useProjectMenuItem({
    conversationId,
    chatProjectId,
    enabled: isMenuOpen && conversationId !== '',
    onAssigned: () => setIsMenuOpen(false),
  });

  const menuItems = useMemo<MenuItemProps[]>(() => {
    if (!conversationId) {
      return [];
    }

    return [
      projectItem,
      {
        label: localize('com_ui_delete'),
        onClick: () => setShowDeleteDialog(true),
        hideOnClick: false,
        render: (props) => <button {...props} />,
        icon: <Trash2 className="text-text-secondary size-4" aria-hidden="true" />,
      },
    ];
  }, [conversationId, localize, projectItem]);

  return (
    <>
      <DropdownPopup
        portal={true}
        focusLoop={true}
        unmountOnHide={true}
        menuId={menuId}
        isOpen={isMenuOpen}
        setIsOpen={setIsMenuOpen}
        className="z-[125]"
        minWidth="11rem"
        iconClassName="mr-2 text-text-secondary"
        trigger={
          <Ariakit.MenuButton
            ref={menuButtonRef}
            aria-label={localize('com_nav_convo_menu_options')}
            className={cn(
              buttonVariants({ variant: 'row-action', size: 'icon-sm' }),
              'text-text-secondary rounded-lg',
              isMenuOpen && 'bg-surface-hover-alt text-text-primary',
            )}
          >
            <Ellipsis className="h-4 w-4" aria-hidden="true" />
          </Ariakit.MenuButton>
        }
        items={menuItems}
      />
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
