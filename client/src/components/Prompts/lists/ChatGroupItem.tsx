import { useState, memo, useRef, useCallback, useId, useMemo } from 'react';
import * as Ariakit from '@ariakit/react';
import { useNavigate, useParams } from 'react-router-dom';
import { Ellipsis, Eye, SquarePen, Trash, EarthIcon, Cloud, User } from 'lucide-react';
import {
  Label,
  Button,
  Spinner,
  OGDialog,
  TooltipAnchor,
  DropdownPopup,
  OGDialogTemplate,
  useToastContext,
} from '@librechat/client';
import type { TPromptGroup } from 'librechat-data-provider';
import {
  cn,
  detectVariables,
  getPromptMutationErrorKey,
  getPromptGroupPermissions,
  getPromptResolveErrorMessage,
  rowActionClasses,
  rowActionSlotClasses,
} from '~/utils';
import { useLocalize, useAuthContext, useSubmitMessage, usePromptContentResolver } from '~/hooks';
import { useRecordPromptUsage, useDeletePromptGroup } from '~/data-provider';
import useChatScopedRequest from '~/hooks/Prompts/useChatScopedRequest';
import { useLiveAnnouncer, useChatContext } from '~/Providers';
import VariableDialog from '../dialogs/VariableDialog';
import PreviewPrompt from '../dialogs/PreviewPrompt';
import CategoryIcon from '../utils/CategoryIcon';

const PROMPT_PATH = '/prompts';

function ChatGroupItem({
  group,
  isChatRoute = true,
  permissionBits = 0,
}: {
  group: TPromptGroup;
  isChatRoute?: boolean;
  permissionBits?: number;
}) {
  const localize = useLocalize();
  const navigate = useNavigate();
  const params = useParams();
  const { user } = useAuthContext();
  const { submitPrompt } = useSubmitMessage();
  const recordUsage = useRecordPromptUsage();
  const resolvePromptContent = usePromptContentResolver();
  const { announcePolite } = useLiveAnnouncer();
  const { index } = useChatContext();

  const { showToast } = useToastContext();
  const menuId = useId();
  const isSharedPrompt = group.author !== user?.id && Boolean(group.authorName);
  const [menuOpen, setMenuOpen] = useState(false);
  const [isPreviewDialogOpen, setPreviewDialogOpen] = useState(false);
  const [isVariableDialogOpen, setVariableDialogOpen] = useState(false);
  const [variablePromptText, setVariablePromptText] = useState<string | undefined>(undefined);
  const [isResolving, setIsResolving] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  /** A resolve that was started for one chat must not land on another; see
   *  `useChatScopedRequest` for the three cancellation keys. On cancel, the
   *  row's spinner clears (its own `finally` will not run for a discarded
   *  request) and a variable dialog opened from the stale read closes rather
   *  than surviving into the chat the user moved to. */
  const { begin, isCurrent, isMounted } = useChatScopedRequest(index, () => {
    setIsResolving(false);
    setVariableDialogOpen(false);
  });

  const groupIsGlobal = group.isPublic === true;
  const { isExternal, canEdit, canDelete } = getPromptGroupPermissions(group, permissionBits);

  const menuButtonRef = useRef<HTMLButtonElement | null>(null);

  const deleteGroup = useDeletePromptGroup({
    onSuccess: () => {
      setDeleteOpen(false);
      announcePolite({
        message: localize('com_ui_prompt_deleted_group', { 0: group.name }),
        isStatus: true,
      });
      if (!isChatRoute && params.promptId === group._id) {
        navigate(PROMPT_PATH, { replace: true });
      }
    },
    onError: (error) => {
      showToast({
        status: 'error',
        message: localize(getPromptMutationErrorKey(error, 'com_ui_prompt_delete_error')),
      });
    },
  });

  const handleDelete = () => {
    if (!group._id) {
      return;
    }
    deleteGroup.mutate({ id: group._id });
  };

  const onCardClick = useCallback(async () => {
    if (!isChatRoute) {
      navigate(`${PROMPT_PATH}/${group._id}`, { replace: true });
      return;
    }

    if (isResolving) {
      return;
    }

    const token = begin();
    if (isExternal) {
      setIsResolving(true);
    }
    try {
      const text = await resolvePromptContent(group);
      /** The row may have unmounted, or the active conversation may have
       *  changed, while the Langfuse resolve was in flight; a stale
       *  continuation must not submit, stage, or record for a chat the
       *  user left. */
      if (!isMounted() || !isCurrent(token)) {
        return;
      }
      if (!text?.trim()) {
        return;
      }

      if (detectVariables(text)) {
        setVariablePromptText(text);
        setVariableDialogOpen(true);
        return;
      }

      submitPrompt(text);
      if (group._id) {
        recordUsage.mutate(group._id);
      }
    } catch (error) {
      if (isMounted() && isCurrent(token)) {
        showToast({ status: 'error', message: getPromptResolveErrorMessage(error, localize) });
      }
    } finally {
      if (isExternal && isMounted() && isCurrent(token)) {
        setIsResolving(false);
      }
    }
  }, [
    group,
    submitPrompt,
    recordUsage,
    isChatRoute,
    navigate,
    isResolving,
    isExternal,
    resolvePromptContent,
    showToast,
    localize,
    begin,
    isCurrent,
    isMounted,
  ]);

  const productionText = group.productionPrompt?.prompt ?? '';
  const hasOneliner = typeof group.oneliner === 'string' && group.oneliner.length > 0;
  let snippet = '';
  if (hasOneliner) {
    snippet = group.oneliner as string;
  } else if (productionText.length > 0) {
    snippet = productionText;
  }

  const ariaLabel = group.category
    ? localize('com_ui_prompt_group_button', { name: group.name, category: group.category })
    : localize('com_ui_prompt_group_button_no_category', { name: group.name });

  const dropdownItems = useMemo(() => {
    const items = [
      {
        label: localize('com_ui_preview'),
        onClick: () => setPreviewDialogOpen(true),
        icon: <Eye className="icon-sm text-text-primary mr-2" aria-hidden="true" />,
      },
    ];
    if (canEdit) {
      items.push({
        label: localize('com_ui_edit'),
        onClick: () => navigate(`${PROMPT_PATH}/${group._id}`),
        icon: <SquarePen className="icon-sm text-text-primary mr-2" aria-hidden="true" />,
      });
    }
    if (canDelete) {
      items.push({
        label: localize('com_ui_delete'),
        onClick: () => setDeleteOpen(true),
        icon: <Trash className="icon-sm text-text-primary mr-2" aria-hidden="true" />,
      });
    }
    return items;
  }, [localize, canEdit, canDelete, group._id, navigate]);

  return (
    <>
      <div
        className={cn(
          'group relative mb-0.5 rounded-lg bg-transparent',
          !isChatRoute && params.promptId === group._id
            ? 'bg-surface-nav-selected'
            : 'hover:bg-surface-nav-hover',
        )}
        aria-busy={isResolving}
      >
        {/* Clickable overlay for card */}
        <button
          type="button"
          className="focus-visible:ring-ring-primary absolute inset-0 z-0 rounded-xl focus:outline-hidden focus-visible:ring-2"
          onClick={onCardClick}
          aria-label={ariaLabel}
          disabled={isResolving}
        />
        <div className="flex items-start gap-2.5 px-3 py-2.5">
          {isResolving ? (
            <Spinner className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          ) : (
            <CategoryIcon
              category={group.category ?? ''}
              className="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <TooltipAnchor
                description={group.name}
                side="top"
                render={
                  <span className="text-text-primary truncate text-sm font-medium">
                    {group.name}
                  </span>
                }
              />
              {isSharedPrompt && (
                <TooltipAnchor
                  description={localize('com_ui_by_author', { 0: group.authorName })}
                  side="top"
                  render={
                    <span
                      tabIndex={0}
                      role="img"
                      aria-label={localize('com_ui_by_author', { 0: group.authorName })}
                      className="flex shrink-0 items-center"
                    >
                      <User className="text-text-secondary size-3.5" aria-hidden="true" />
                    </span>
                  }
                />
              )}
              {groupIsGlobal && (
                <TooltipAnchor
                  description={localize('com_ui_sr_global_prompt')}
                  side="top"
                  render={
                    <span
                      tabIndex={0}
                      role="img"
                      aria-label={localize('com_ui_sr_global_prompt')}
                      className="flex shrink-0 items-center"
                    >
                      <EarthIcon className="text-accent-primary size-3.5" aria-hidden="true" />
                    </span>
                  }
                />
              )}
              {isExternal && (
                <TooltipAnchor
                  description={localize('com_ui_prompt_source_langfuse')}
                  side="top"
                  render={
                    <span
                      tabIndex={0}
                      role="img"
                      aria-label={localize('com_ui_prompt_source_langfuse')}
                      className="flex shrink-0 items-center"
                    >
                      <Cloud className="text-text-secondary size-3.5" aria-hidden="true" />
                    </span>
                  }
                />
              )}
              {/* The menu shares the title's line, so only the title gives way to it.
                  The snippet below keeps the full width of the row either way. */}
              <div
                className={cn(rowActionSlotClasses({ open: menuOpen }), 'relative z-10 ml-auto')}
              >
                <DropdownPopup
                  portal={true}
                  menuId={menuId}
                  focusLoop={true}
                  className="z-[125]"
                  unmountOnHide={true}
                  isOpen={menuOpen}
                  setIsOpen={setMenuOpen}
                  trigger={
                    <Ariakit.MenuButton
                      ref={menuButtonRef}
                      aria-label={localize('com_nav_convo_menu_options')}
                      className={rowActionClasses({ open: menuOpen })}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Ellipsis className="size-4" aria-hidden="true" />
                    </Ariakit.MenuButton>
                  }
                  items={dropdownItems}
                />
              </div>
            </div>
            <p className="text-text-secondary mt-0.5 line-clamp-2 text-xs leading-relaxed">
              {snippet}
            </p>
          </div>
        </div>
      </div>
      <PreviewPrompt
        group={group}
        chatIndex={index}
        open={isPreviewDialogOpen}
        onOpenChange={setPreviewDialogOpen}
        onCloseAutoFocus={() => {
          requestAnimationFrame(() => {
            menuButtonRef.current?.focus({ preventScroll: true });
          });
        }}
      />
      {isChatRoute && (
        <VariableDialog
          open={isVariableDialogOpen}
          onClose={() => setVariableDialogOpen(false)}
          group={group}
          promptText={variablePromptText}
        />
      )}
      <OGDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <OGDialogTemplate
          title={localize('com_ui_delete_prompt')}
          className="w-11/12 max-w-md"
          main={<Label>{localize('com_ui_prompt_delete_confirm', { 0: group.name })}</Label>}
          selection={
            <Button onClick={handleDelete} variant="destructive" disabled={deleteGroup.isLoading}>
              {deleteGroup.isLoading ? <Spinner /> : localize('com_ui_delete')}
            </Button>
          }
        />
      </OGDialog>
    </>
  );
}

export default memo(ChatGroupItem);
