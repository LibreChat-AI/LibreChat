import { memo, useMemo } from 'react';
import { useRecoilValue } from 'recoil';
import { useParams } from 'react-router-dom';
import {
  getConfigDefaults,
  Constants,
  PermissionTypes,
  Permissions,
  isForcedTemporaryRetention,
} from 'librechat-data-provider';
import { OpenSidebar, PresetsMenu, NewChat, HeaderMenu } from './Menus';
import { TemporaryChat, TemporaryChatIndicator } from './TemporaryChat';
import useDrawerViewport from '~/hooks/Nav/useDrawerViewport';
import ModelSelector from './Menus/Endpoints/ModelSelector';
import { BackgroundTasksButton } from './BackgroundTasks';
import { TraceButton, useTraceControl } from './Trace';
import { useGetStartupConfig } from '~/data-provider';
import ExportAndShareMenu from './ExportAndShareMenu';
import SubagentThreadLink from './SubagentThreadLink';
import BookmarkMenu from './Menus/BookmarkMenu';
import AddMultiConvo from './AddMultiConvo';
import { useHasAccess } from '~/hooks';
import { cn } from '~/utils';
import store from '~/store';

const defaultInterface = getConfigDefaults().interface;

/** Keep one DOM order while sharing the sidebar's scaled drawer breakpoint. */
function Header({
  parentConversationId,
  readOnly = false,
}: {
  parentConversationId?: string;
  readOnly?: boolean;
}) {
  const { data: startupConfig } = useGetStartupConfig();
  const navVisible = useRecoilValue(store.sidebarExpanded);
  const isSubmitting = useRecoilValue(store.isSubmittingFamily(0));
  const isSmallScreen = useDrawerViewport();

  /** The mobile row only offers a new chat when there is one to leave. Read
   *  from the route rather than the context conversation, which still holds the
   *  previous chat for a render after a history or link navigation. An unsaved
   *  conversation has no id in the route yet, so absence counts as new too. */
  const { conversationId: routeConversationId } = useParams();
  const isNewChat = routeConversationId == null || routeConversationId === Constants.NEW_CONVO;

  const interfaceConfig = useMemo(
    () => startupConfig?.interface ?? defaultInterface,
    [startupConfig],
  );

  const hasAccessToBookmarks = useHasAccess({
    permissionType: PermissionTypes.BOOKMARKS,
    permission: Permissions.USE,
  });

  const hasAccessToMultiConvo = useHasAccess({
    permissionType: PermissionTypes.MULTI_CONVO,
    permission: Permissions.USE,
  });

  const hasAccessToTemporaryChat = useHasAccess({
    permissionType: PermissionTypes.TEMPORARY_CHAT,
    permission: Permissions.USE,
  });
  /** An administrator-enforced mode is not a role grant, so it is overlaid here rather than
   *  written into the role's stored permissions; the control is read-only either way. */
  const showTemporaryChat =
    hasAccessToTemporaryChat === true || isForcedTemporaryRetention(interfaceConfig.retentionMode);

  /** Child threads are view-only records of their parent's run and have no trace of their own. */
  const trace = useTraceControl({
    conversationId: isNewChat ? null : routeConversationId,
    traceViewer: interfaceConfig.traceViewer,
    isSubmitting,
    enabled: parentConversationId == null,
  });

  /** The drawer covers the header on mobile; keep its controls out of the tab order. */
  const hiddenBehindNav = navVisible === true && isSmallScreen && 'hidden';

  return (
    /* The composer review is in a z-10 stacking context. Keep header controls
       above it when a tall review reaches the top of a short viewport. */
    <div className="from-surface-canvas via-surface-canvas/70 text-text-primary md:from-surface-canvas/80 md:via-surface-canvas/50 2xl:from-surface-canvas/0 absolute top-0 z-20 flex h-[3.25rem] w-full items-center gap-2 bg-gradient-to-b to-transparent p-2 font-semibold 2xl:via-transparent">
      <div className={cn('flex-shrink-0 items-center', isSmallScreen ? 'flex' : 'hidden')}>
        <OpenSidebar testId="header-open-sidebar-button" />
      </div>

      <div
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2',
          !isSmallScreen && 'pl-3 transition-all duration-200 ease-in-out',
          hiddenBehindNav,
        )}
      >
        {parentConversationId != null && (
          <SubagentThreadLink threadId={parentConversationId} labelClassName="hidden lg:inline" />
        )}
        {!readOnly && <ModelSelector startupConfig={startupConfig} />}
        {!readOnly && interfaceConfig.presets === true && interfaceConfig.modelSelect === true && (
          <PresetsMenu />
        )}
        {hasAccessToBookmarks === true && (
          <div className={cn('items-center', isSmallScreen ? 'hidden' : 'flex')}>
            <BookmarkMenu />
          </div>
        )}
        {hasAccessToMultiConvo === true && (
          <div className={cn('items-center', isSmallScreen ? 'hidden' : 'flex')}>
            <AddMultiConvo />
          </div>
        )}
      </div>

      <div className={cn('flex shrink-0 items-center gap-2', hiddenBehindNav)}>
        {showTemporaryChat && <TemporaryChatIndicator />}
        {!isNewChat && <NewChat className={isSmallScreen ? undefined : 'hidden'} />}
        {!isNewChat && parentConversationId == null && (
          <BackgroundTasksButton
            key={routeConversationId}
            conversationId={routeConversationId}
            isSubmitting={isSubmitting}
          />
        )}
        <HeaderMenu
          startupConfig={startupConfig}
          trace={trace}
          readOnly={readOnly}
          className={isSmallScreen ? undefined : 'hidden'}
        />
        <div className={cn('items-center gap-2', isSmallScreen ? 'hidden' : 'flex')}>
          {trace.show && <TraceButton onClick={trace.open} />}
          <ExportAndShareMenu
            isSharedButtonEnabled={startupConfig?.sharedLinksEnabled ?? false}
            readOnly={readOnly}
          />
          {showTemporaryChat && <TemporaryChat />}
        </div>
      </div>
    </div>
  );
}

const MemoizedHeader = memo(Header);
MemoizedHeader.displayName = 'Header';

export default MemoizedHeader;
