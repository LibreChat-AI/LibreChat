import { useCallback, useState, useEffect, useRef, memo } from 'react';
import { useAtom } from 'jotai';
import { useForm } from 'react-hook-form';
import { ChatProvider } from '@librechat/chat/react';
import { useLocation, useNavigate } from 'react-router-dom';
import { pxToRem, useRemScale, useMediaQuery } from '@librechat/client';
import type { ReactNode } from 'react';
import type { ChatFormValues } from '~/common';
import {
  COLLAPSED_WIDTH,
  EXPANDED_MIN,
  TRANSITION_MS,
  EASING,
  MOBILE_DRAWER_TRANSITION,
  DRAWER_Z_INDEX,
  MOBILE_DRAWER_ID,
  MOBILE_DRAWER_WIDTH,
  DRAWER_UNPAINTED,
} from './constants';
import { filesDialogTriggerAtom, showFilesDialogAtom } from '~/store/filesDialog';
import { useFeaturePresentation } from '~/components/FeaturePresentation/Context';
import { MobileHeader, MobileBottomBar, MobileShortcutTargets } from './mobile';
import AgentMarketplaceButton from '~/components/Nav/AgentMarketplaceButton';
import { MyFilesModal } from '~/components/Chat/Input/Files/MyFilesModal';
import { pageRegistry } from '~/components/FeaturePresentation/registry';
import useUnifiedSidebarLinks from '~/hooks/Nav/useUnifiedSidebarLinks';
import { ChatFormProvider, ActivePanelProvider } from '~/Providers';
import useSidebarToggle from '~/hooks/Nav/useSidebarToggle';
import useSidebarState from '~/hooks/Nav/useSidebarState';
import SidePanelNav from '~/components/SidePanel/Nav';
import { cn, DEFAULT_APP_TITLE } from '~/utils';
import { createResizeMeasure } from './resize';
import { CONSOLE_PANEL_ID } from './Console';
import { useLocalize } from '~/hooks';
import Navigation from './Navigation';
import Sidebar from './Sidebar';

function getInitialWidth(): number {
  const saved = localStorage.getItem('side:width');
  return saved ? Math.max(Number(saved), EXPANDED_MIN) : EXPANDED_MIN;
}

/**
 * Isolates the root pane's chat contract subscriptions from the sidebar layout.
 * Atom changes (e.g. during streaming) only re-render `ChatProvider` and the
 * active panel, not the sidebar shell, resize logic, or icon strip, because
 * atom subscriptions don't propagate to parent components.
 */
function SidebarChatProvider({ children }: { children: ReactNode }) {
  const sidebarFormMethods = useForm<ChatFormValues>({ defaultValues: { text: '' } });
  return (
    <ChatFormProvider {...sidebarFormMethods}>
      <ChatProvider index={0}>{children}</ChatProvider>
    </ChatFormProvider>
  );
}

function UnifiedSidebar({
  isSliding = false,
  switchToHistory,
  layout = 'current',
  appTitle = DEFAULT_APP_TITLE,
  routeActiveId,
  onSelect,
}: {
  isSliding?: boolean;
  /** Host-selected layout. Runtime configuration is resolved outside this component. */
  layout?: 'current' | 'console';
  appTitle?: string;
  /** The host's full-page destination, when it replaces the secondary panel. */
  routeActiveId?: string;
  /** Console destination adapter, including route-backed feature links. */
  onSelect?: (id: string) => void;
  /** The user's "new chat returns to the chat list" preference. App-global
   *  shell state the sidebar only reads, so the host passes it in. */
  switchToHistory: boolean;
}) {
  const localize = useLocalize();
  const location = useLocation();
  const navigate = useNavigate();
  const { isSmallScreen, expanded } = useSidebarState();
  const [showFiles, setShowFiles] = useAtom(showFilesDialogAtom);
  const [filesDialogTrigger, setFilesDialogTrigger] = useAtom(filesDialogTriggerAtom);
  const { setSidebarOpen } = useSidebarToggle();
  const prefersReducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const [sidebarWidth, setSidebarWidth] = useState(getInitialWidth);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const remScale = useRemScale();
  const [isResizing, setIsResizing] = useState(false);
  const resizeHandlers = useRef<{ move: (e: MouseEvent) => void; up: () => void } | null>(null);

  const panelContainerRef = useRef<HTMLElement>(null);
  const panelToggleRef = useRef<HTMLButtonElement>(null);
  const consoleLayout = layout === 'console' && !isSmallScreen;

  const links = useUnifiedSidebarLinks();
  const presentation = useFeaturePresentation();
  const isInsightsRoute = location.pathname.startsWith('/insights');
  const pageActiveId =
    routeActiveId ??
    (presentation?.page
      ? pageRegistry[presentation.page].navId
      : isInsightsRoute
        ? 'insights'
        : undefined);
  const panelExpanded = expanded && pageActiveId == null;
  const collapsedWidth = consoleLayout ? 0 : COLLAPSED_WIDTH;

  useEffect(() => {
    if (
      consoleLayout &&
      !panelExpanded &&
      panelContainerRef.current?.contains(document.activeElement)
    ) {
      panelToggleRef.current?.focus();
    }
  }, [consoleLayout, panelExpanded]);

  /** The aside's max width is a viewport percentage, so the announced range has to track
   *  the viewport rather than a render-time snapshot of it. */
  useEffect(() => {
    const handleViewportResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', handleViewportResize);
    return () => window.removeEventListener('resize', handleViewportResize);
  }, []);

  /** Keep the handle's announced range in the same baseline units as stored widths. */
  const resizeMax = (viewportWidth * 0.4) / remScale;
  const resizeMin = Math.min(EXPANDED_MIN, resizeMax);
  const resizeNow = panelExpanded
    ? Math.min(Math.max(sidebarWidth, resizeMin), resizeMax)
    : collapsedWidth;

  const handleCollapse = useCallback(
    (afterSlide?: () => void) => {
      setSidebarOpen(false, afterSlide);
    },
    [setSidebarOpen],
  );

  const handleExpand = useCallback(() => {
    setSidebarOpen(true);
  }, [setSidebarOpen]);

  const handleLeaveInsights = useCallback(() => {
    navigate('/c/new');
  }, [navigate]);

  const handlePanelExpand = useCallback(() => {
    if (isInsightsRoute) {
      handleLeaveInsights();
    }
    handleExpand();
  }, [handleExpand, handleLeaveInsights, isInsightsRoute]);

  const handleResizeStart = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      setIsResizing(true);
      document.body.style.userSelect = 'none';
      const maxWidth = (window.innerWidth * 0.4) / remScale;
      /** The scaled minimum can exceed the viewport cap, so it yields to the cap. */
      const minWidth = Math.min(EXPANDED_MIN, maxWidth);
      const measure = createResizeMeasure(event.currentTarget);
      let rafId: number | null = null;

      const move = (e: MouseEvent) => {
        if (rafId != null) {
          return;
        }
        rafId = requestAnimationFrame(() => {
          rafId = null;
          const next = Math.max(minWidth, Math.min(measure(e.clientX) / remScale, maxWidth));
          setSidebarWidth(next);
        });
      };

      const up = () => {
        if (rafId != null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        document.body.style.userSelect = '';
        setIsResizing(false);
        resizeHandlers.current = null;
        setSidebarWidth((w) => {
          localStorage.setItem('side:width', String(Math.round(w)));
          return w;
        });
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      };

      resizeHandlers.current = { move, up };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    },
    [remScale],
  );

  const handleResizeKeyboard = useCallback(
    (direction: 'shrink' | 'grow') => {
      setSidebarWidth((w) => {
        const maxWidth = (window.innerWidth * 0.4) / remScale;
        /** A width stored at a lower scale can exceed the current maximum, so it
         *  is brought into range before stepping rather than crawling down by 20. */
        const current = Math.min(w, maxWidth);
        const next =
          direction === 'shrink'
            ? Math.max(current - 20, Math.min(EXPANDED_MIN, maxWidth))
            : Math.min(current + 20, maxWidth);
        localStorage.setItem('side:width', String(Math.round(next)));
        return next;
      });
    },
    [remScale],
  );

  useEffect(() => {
    return () => {
      if (resizeHandlers.current) {
        document.removeEventListener('mousemove', resizeHandlers.current.move);
        document.removeEventListener('mouseup', resizeHandlers.current.up);
      }
    };
  }, []);

  useEffect(() => {
    if (!isSmallScreen || !expanded) {
      return;
    }
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') {
        return;
      }
      /**
       * A layer above the drawer already took this Escape: a dialog opened from
       * the drawer dismisses itself and marks the event handled. Collapsing the
       * drawer too would close two levels for one keystroke and drop the focus
       * the dialog hands back to its trigger.
       */
      if (e.defaultPrevented) {
        return;
      }
      /**
       * Menus opened from the drawer portal out of it, so their Escape still
       * reaches this listener. Dismissing the whole drawer would skip the level
       * the user meant to leave.
       *
       * Presence alone is not the signal: not every menu unmounts when closed —
       * the account menu stays mounted and merely `hidden` — so matching those
       * too would suppress Escape for the drawer permanently.
       */
      if (document.querySelector('[role="menu"]:not([hidden])') != null) {
        return;
      }
      handleCollapse();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isSmallScreen, expanded, handleCollapse]);

  const sidebarContent = isSmallScreen ? (
    <div
      id={MOBILE_DRAWER_ID}
      className={cn(
        /** The close swipe reads horizontal touches here (the drawer holds no
         * horizontal scrollers), while pinch-zoom stays with the browser:
         * this full-height surface must not disable zooming entirely.
         * Absolute in the app container rather than fixed to the viewport, so
         * a site banner above that container stays above the drawer too
         * instead of covering its header strip, as it already does for the
         * scrim and the pane. */
        'bg-surface-sidebar text-text-primary absolute inset-y-0 inset-s-0 flex touch-pan-y touch-pinch-zoom flex-col',
        /** In dark mode the scrim and the drawer are both near-black, and no
         *  scrim opacity separates them by 3:1, so the drawer draws its own
         *  edge. Light palettes get that separation from the scrim, so the
         *  `drawer-edge` role defaults to the drawer's own fill there. */
        'border-drawer-edge border-e',
        expanded ? 'translate-x-0' : '-translate-x-full rtl:translate-x-full',
      )}
      style={{
        width: MOBILE_DRAWER_WIDTH,
        /** The strip setting changes the width without passing through the
         * snap path, so the preference has to reach the declarative style
         * too or that one change still animates. */
        transition: prefersReducedMotion ? undefined : MOBILE_DRAWER_TRANSITION,
        zIndex: DRAWER_Z_INDEX,
        /** Why a closed drawer is not painted at all: see DRAWER_UNPAINTED.
         * The travel stays painted — `isSliding` covers the frames Recoil's
         * deferred flip leaves uncovered at both ends, and a drag claims
         * painting inline (see useDrawerSwipe), which hands this value back
         * explicitly because React cannot re-assert it on its own. */
        visibility: expanded || isSliding ? undefined : DRAWER_UNPAINTED,
      }}
      inert={!expanded ? '' : undefined}
    >
      <SidebarChatProvider>
        <ActivePanelProvider>
          <MobileHeader
            links={links}
            expanded={expanded}
            onClose={handleCollapse}
            onNewChat={handleCollapse}
            switchToHistory={switchToHistory}
            onLeaveInsights={handleLeaveInsights}
            routeActiveId={isInsightsRoute ? 'insights' : undefined}
          />
          {/* Above the panel rather than inside it: the marketplace is a
              destination like the panels themselves, not a row of whichever
              list happens to be showing, so it stays put while they change and
              does not scroll away with the chats. */}
          <div className="shrink-0 px-3 pt-2 empty:hidden">
            <AgentMarketplaceButton layout="row" onNavigate={handleCollapse} />
          </div>
          <nav id="chat-history-nav" className="bg-surface-sidebar min-h-0 flex-1 overflow-hidden">
            <SidePanelNav links={links} visible={panelExpanded} />
          </nav>
          <MobileShortcutTargets
            links={links}
            onLeaveInsights={handleLeaveInsights}
            routeActiveId={isInsightsRoute ? 'insights' : undefined}
          />
          <MobileBottomBar links={links} />
        </ActivePanelProvider>
      </SidebarChatProvider>
    </div>
  ) : (
    <SidebarChatProvider>
      <ActivePanelProvider>
        {consoleLayout && (
          <Navigation
            links={links}
            panelExpanded={panelExpanded}
            onExpand={handleExpand}
            onCollapse={handleCollapse}
            onLeavePage={handleLeaveInsights}
            routeActiveId={pageActiveId}
            panelToggleRef={panelToggleRef}
            switchToHistory={switchToHistory}
            appTitle={appTitle}
            onSelect={onSelect}
          />
        )}
        <aside
          ref={panelContainerRef}
          aria-hidden={consoleLayout && !panelExpanded ? true : undefined}
          inert={consoleLayout && !panelExpanded ? '' : undefined}
          className="relative flex h-full shrink-0 overflow-hidden"
          style={{
            width: pxToRem(panelExpanded ? sidebarWidth : collapsedWidth),
            minWidth: panelExpanded
              ? `min(${pxToRem(EXPANDED_MIN)}, 40%)`
              : pxToRem(collapsedWidth),
            maxWidth: panelExpanded ? '40%' : pxToRem(collapsedWidth),
            transition:
              isResizing || prefersReducedMotion
                ? 'none'
                : `width ${TRANSITION_MS}ms ${EASING}, min-width ${TRANSITION_MS}ms ${EASING}, max-width ${TRANSITION_MS}ms ${EASING}`,
          }}
          aria-label={localize('com_nav_control_panel')}
        >
          <Sidebar
            links={links}
            hideNavigation={consoleLayout}
            reducedMotion={prefersReducedMotion}
            panelId={consoleLayout ? CONSOLE_PANEL_ID : undefined}
            expanded={panelExpanded}
            width={resizeNow}
            minWidth={panelExpanded ? resizeMin : collapsedWidth}
            maxWidth={panelExpanded ? resizeMax : collapsedWidth}
            onCollapse={handleCollapse}
            onExpand={handlePanelExpand}
            onLeaveInsights={handleLeaveInsights}
            switchToHistory={switchToHistory}
            onResizeStart={handleResizeStart}
            onResizeKeyboard={handleResizeKeyboard}
          />
        </aside>
      </ActivePanelProvider>
    </SidebarChatProvider>
  );

  const closeFiles = useCallback(
    (open: boolean) => {
      setShowFiles(open);
      if (!open) {
        /** A stale opener would capture focus for the NEXT open, which the
         *  shortcut path deliberately leaves to the composer. */
        setFilesDialogTrigger(null);
      }
    },
    [setFilesDialogTrigger, setShowFiles],
  );

  return (
    <>
      {sidebarContent}
      {showFiles && (
        <MyFilesModal
          open={showFiles}
          onOpenChange={closeFiles}
          triggerRef={filesDialogTrigger ?? undefined}
        />
      )}
    </>
  );
}

export default memo(UnifiedSidebar);
