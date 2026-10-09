import { useState, useCallback, useMemo, useRef } from 'react';
import { useRecoilValue } from 'recoil';
import { BookmarkPlusIcon } from 'lucide-react';
import { useToastContext } from '@librechat/client';
import { useQueryClient } from '@tanstack/react-query';
import { BookmarkFilledIcon, BookmarkIcon } from '@radix-ui/react-icons';
import { Constants, QueryKeys, isForcedTemporaryRetention } from 'librechat-data-provider';
import type { TConversationTag } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type * as t from '~/common';
import {
  useConversationTagsQuery,
  useGetStartupConfig,
  useTagConversationMutation,
} from '~/data-provider';
import { BookmarkEditDialog } from '~/components/Bookmarks';
import { useBookmarkSuccess, useLocalize } from '~/hooks';
import { isTemporaryConversation, logger } from '~/utils';
import { NotificationSeverity } from '~/common';
import store from '~/store';

export type UseBookmarkItemsResult = {
  /** Bookmarks only apply to a saved, non-temporary conversation. */
  show: boolean;
  items: t.MenuItemProps[];
  bookmarks: TConversationTag[];
  hasBookmarks: boolean;
  isLoading: boolean;
  triggerAriaLabel: string;
  /** Rendered by whichever surface owns the menu; both need the same instance. */
  dialog: ReactNode;
};

/**
 * Bookmark tagging as menu items, so the desktop icon menu and the mobile
 * overflow menu share one set of items, one mutation, and one edit dialog.
 */
export default function useBookmarkItems({
  enabled = true,
}: { enabled?: boolean } = {}): UseBookmarkItemsResult {
  const localize = useLocalize();
  const queryClient = useQueryClient();
  const { showToast } = useToastContext();

  const { data: startupConfig } = useGetStartupConfig();
  const conversation = useRecoilValue(store.conversationByIndex(0)) || undefined;
  const conversationId = conversation?.conversationId ?? '';
  const updateConvoTags = useBookmarkSuccess(conversationId);
  const tags = conversation?.tags;
  /**
   * A pre-existing permanent chat loaded under forced (ephemeral) retention stays
   * non-temporary until the server converts it on the next write, so gate on the forced flag too
   * to keep permanent-chat bookmarking hidden on a chat that is already effectively temporary.
   */
  const isTemporary =
    isTemporaryConversation(conversation) ||
    isForcedTemporaryRetention(startupConfig?.interface?.retentionMode);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const newBookmarkRef = useRef<HTMLButtonElement>(null);

  const focusTag = useCallback((tag: string) => {
    const tagElement = document.getElementById(tag);
    if (tagElement) {
      setTimeout(() => tagElement.focus(), 2);
    }
  }, []);

  const mutation = useTagConversationMutation(conversationId, {
    onSuccess: (newTags: string[], vars) => {
      updateConvoTags(newTags);
      focusTag(vars.tag);
    },
    onError: () => {
      showToast({
        message: 'Error adding bookmark',
        severity: NotificationSeverity.ERROR,
      });
    },
    onMutate: (vars) => {
      focusTag(vars.tag);
    },
  });

  /** The tags endpoint is behind the bookmark permission, so an ungated query 403s. */
  const { data } = useConversationTagsQuery({ enabled });

  const isActiveConvo = Boolean(
    conversation &&
      conversationId &&
      conversationId !== Constants.NEW_CONVO &&
      conversationId !== 'search',
  );

  const handleSubmit = useCallback(
    (tag?: string) => {
      if (tag === undefined || tag === '' || !conversationId) {
        showToast({
          message: 'Invalid tag or conversationId',
          severity: NotificationSeverity.ERROR,
        });
        return;
      }

      logger.log('tag_mutation', 'BookmarkMenu - handleSubmit: tags before setting', tags);

      const allTags =
        queryClient.getQueryData<TConversationTag[]>([QueryKeys.conversationTags]) ?? [];
      const existingTags = allTags.map((t) => t.tag);
      const filteredTags = tags?.filter((t) => existingTags.includes(t));

      logger.log('tag_mutation', 'BookmarkMenu - handleSubmit: tags after filtering', filteredTags);
      const newTags =
        filteredTags?.includes(tag) === true
          ? filteredTags.filter((t) => t !== tag)
          : [...(filteredTags ?? []), tag];

      logger.log('tag_mutation', 'BookmarkMenu - handleSubmit: tags after', newTags);
      mutation.mutate({ tags: newTags, tag });
    },
    [tags, conversationId, mutation, queryClient, showToast],
  );

  const tagsCount = tags?.length ?? 0;

  const triggerAriaLabel = useMemo(() => {
    if (tagsCount > 0) {
      return localize('com_ui_bookmarks_count_selected', { count: tagsCount });
    }
    return localize('com_ui_bookmarks_add');
  }, [tagsCount, localize]);

  const items: t.MenuItemProps[] = useMemo(() => {
    const next: t.MenuItemProps[] = [
      {
        id: '%___new___bookmark___%',
        label: localize('com_ui_bookmarks_new'),
        icon: <BookmarkPlusIcon className="size-4" />,
        hideOnClick: false,
        ref: newBookmarkRef,
        render: (props) => <button {...props} />,
        onClick: () => setIsDialogOpen(true),
      },
    ];

    if (data) {
      for (const tag of data) {
        const isSelected = tags?.includes(tag.tag) === true;
        next.push({
          id: tag.tag,
          label: tag.tag,
          hideOnClick: false,
          icon: isSelected ? (
            <BookmarkFilledIcon className="size-4" />
          ) : (
            <BookmarkIcon className="size-4" />
          ),
          onClick: () => handleSubmit(tag.tag),
          disabled: mutation.isLoading,
          ariaChecked: isSelected,
        });
      }
    }

    return next;
  }, [tags, data, handleSubmit, mutation.isLoading, localize]);

  const dialog = (
    <BookmarkEditDialog
      tags={tags}
      open={isDialogOpen}
      setTags={updateConvoTags}
      setOpen={setIsDialogOpen}
      triggerRef={newBookmarkRef}
      conversationId={conversationId}
      context="BookmarkMenu - BookmarkEditDialog"
    />
  );

  return {
    show: enabled && isActiveConvo && !isTemporary,
    items,
    bookmarks: data ?? [],
    hasBookmarks: tagsCount > 0,
    isLoading: mutation.isLoading,
    triggerAriaLabel,
    dialog,
  };
}
