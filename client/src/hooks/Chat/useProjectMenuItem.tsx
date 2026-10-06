import { useId, useRef } from 'react';
import { Spinner, useToastContext } from '@librechat/client';
import { Check, Folder, FolderInput, FolderX } from 'lucide-react';
import type * as t from '~/common';
import { useAssignConversationToProjectMutation, useProjectsInfiniteQuery } from '~/data-provider';
import { NotificationSeverity } from '~/common';
import { useLocalize } from '~/hooks';

const iconClass = 'size-4 text-text-secondary';

type ProjectMenuItemParams = {
  conversationId: string;
  chatProjectId: string | null;
  /** The project list is only fetched, and its rows only built, while the menu that shows it is open. */
  enabled: boolean;
  /** Called once an assignment has landed, with `null` when the chat left its project. */
  onAssigned: (projectId: string | null) => void;
};

/**
 * One "Change project" menu item whose submenu lists every project, marks the current one,
 * and offers removal from it. Picking a project assigns it immediately.
 */
export default function useProjectMenuItem({
  conversationId,
  chatProjectId,
  enabled,
  onAssigned,
}: ProjectMenuItemParams): t.MenuItemProps {
  const localize = useLocalize();
  const idPrefix = useId();
  const { showToast } = useToastContext();
  const assignMutation = useAssignConversationToProjectMutation();
  const { data, isError, isFetching, isFetchingNextPage, hasNextPage, fetchNextPage, refetch } =
    useProjectsInfiniteQuery({ sortBy: 'name', sortDirection: 'asc', limit: 100 }, { enabled });
  /** `isError` alone cannot say whether a page request or a refresh of the loaded pages failed,
   *  and Retry has to repeat the one that did. */
  const failedPageRequest = useRef(false);

  const pending = assignMutation.isLoading;
  const pendingProjectId = assignMutation.variables?.projectId;
  const busy = isFetching || isFetchingNextPage;
  /** Ids are the row identity: positions shift as pages are appended, and a focused control has
   *  to stay the same element when that happens. */
  const rowId = (suffix: string) => `${idPrefix}-${suffix}`;

  const assign = (projectId: string | null) => {
    if (pending) {
      return;
    }
    assignMutation.mutate(
      { conversationId, projectId },
      {
        onSuccess: () => {
          onAssigned(projectId);
          showToast({
            message: localize('com_ui_project_updated'),
            severity: NotificationSeverity.SUCCESS,
            showIcon: true,
          });
        },
        onError: () =>
          showToast({
            message: localize('com_ui_project_update_error'),
            severity: NotificationSeverity.ERROR,
            showIcon: true,
          }),
      },
    );
  };

  const request = async (nextPage: boolean) => {
    const result = await (nextPage ? fetchNextPage() : refetch());
    failedPageRequest.current = nextPage && result.isError;
  };

  const trigger: t.MenuItemProps = {
    label: localize('com_ui_change_project'),
    icon: <FolderInput className={iconClass} aria-hidden="true" />,
  };
  /** A disabled query still exposes cached data, and every row of the project page mounts this hook,
   *  so a closed menu builds nothing: the items exist only while their menu is open. */
  if (!enabled) {
    return { ...trigger, subItems: [{ label: localize('com_ui_loading'), disabled: true }] };
  }

  const projects = data?.pages.flatMap((page) => page.projects) ?? [];
  const subItems: t.MenuItemProps[] = [];
  if (projects.length > 0) {
    for (const project of projects) {
      const isCurrent = project._id === chatProjectId;
      const isPendingTarget = pending && pendingProjectId === project._id;
      let icon = <Folder className={iconClass} aria-hidden="true" />;
      if (isPendingTarget) {
        icon = <Spinner className="size-4" />;
      } else if (isCurrent) {
        icon = <Check className={iconClass} aria-hidden="true" />;
      }
      subItems.push({
        id: rowId(`project-${project._id}`),
        label: project.name,
        /** The current project stays in the arrow-key order, which a disabled item would leave. */
        onClick: () => {
          if (!isCurrent) {
            assign(project._id);
          }
        },
        disabled: pending,
        ariaChecked: isCurrent,
        ariaRole: 'menuitemradio',
        icon,
      });
    }
  } else {
    let statusKey: Parameters<typeof localize>[0] = 'com_ui_loading';
    if (isError && !busy) {
      statusKey = 'com_ui_projects_load_error';
    } else if (data != null && !isError) {
      statusKey = 'com_ui_no_projects';
    }
    subItems.push({ id: rowId('status'), label: localize(statusKey), disabled: true });
  }

  /** One paging row with one id, whatever it currently says, so the focus the user put on it
   *  follows it from "Load more" to the loading state to "Retry". While a request runs it stays
   *  focusable and does nothing: a disabled item would be dropped from keyboard navigation. */
  if (isError && !busy) {
    if (projects.length > 0) {
      subItems.push({
        id: rowId('status'),
        label: localize('com_ui_projects_load_error'),
        disabled: true,
      });
    }
    subItems.push({
      id: rowId('paging'),
      label: localize('com_ui_retry'),
      onClick: () => request(failedPageRequest.current),
      hideOnClick: false,
    });
  } else if (projects.length > 0 && (hasNextPage || isError)) {
    subItems.push({
      id: rowId('paging'),
      label: localize(busy ? 'com_ui_loading' : 'com_ui_load_more'),
      onClick: busy ? undefined : () => request(true),
      hideOnClick: false,
    });
  }

  if (chatProjectId != null) {
    subItems.push(
      { separate: true },
      {
        id: rowId('remove'),
        label: localize('com_ui_remove_from_project'),
        onClick: () => assign(null),
        disabled: pending,
        icon:
          pending && pendingProjectId === null ? (
            <Spinner className="size-4" />
          ) : (
            <FolderX className={iconClass} aria-hidden="true" />
          ),
      },
    );
  }

  return { ...trigger, subItems };
}
