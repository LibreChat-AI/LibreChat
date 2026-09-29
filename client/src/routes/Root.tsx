import { useState, useEffect, useRef, useCallback, startTransition } from 'react';
import { useRecoilValue } from 'recoil';
import { Outlet } from 'react-router-dom';
import { useMediaQuery } from '@librechat/client';
import {
  UnifiedSidebar,
  SIDEBAR_TRANSITION,
  MOBILE_DRAWER_WIDTH_VAR,
  MOBILE_DRAWER_STRIP_WIDTH,
  MOBILE_DRAWER_FULL_WIDTH,
  MOBILE_PANE_SHIFT,
} from '~/components/UnifiedSidebar';
import {
  CodeHighlightThrottleContext,
  normalizeCodeHighlightThrottleMs,
} from '~/components/Chat/Messages/Content/Parts/useLazyHighlight';
import {
  PromptGroupsProvider,
  AssistantsMapContext,
  AgentsMapContext,
  SetConvoProvider,
  FileMapContext,
} from '~/Providers';
import {
  useSearchEnabled,
  useAssistantsMap,
  useAuthContext,
  useCatalogWarmup,
  useAgentsMap,
  useFileMap,
} from '~/hooks';
import KeyboardShortcutsDialog from '~/components/Nav/KeyboardShortcutsDialog';
import KeyboardDeleteDialog from '~/components/Nav/KeyboardDeleteDialog';
import { useUserTermsQuery, useGetStartupConfig } from '~/data-provider';
import { MobileDrawerScrim } from '~/components/UnifiedSidebar/mobile';
import useKeyboardShortcuts from '~/hooks/useKeyboardShortcuts';
import useDrawerDismiss from '~/hooks/Nav/useDrawerDismiss';
import useSidebarToggle from '~/hooks/Nav/useSidebarToggle';
import useSidebarState from '~/hooks/Nav/useSidebarState';
import { TermsAndConditionsModal } from '~/components/ui';
import useDrawerSwipe from '~/hooks/Nav/useDrawerSwipe';
import { useHealthCheck } from '~/data-provider';
import { Banner } from '~/components/Banners';
import store from '~/store';

/** Isolates keyboard shortcut listeners so they only mount after auth. */
function KeyboardShortcutsProvider() {
  useKeyboardShortcuts();
  return (
    <>
      <KeyboardShortcutsDialog />
      <KeyboardDeleteDialog />
    </>
  );
}

export default function Root() {
  const [showTerms, setShowTerms] = useState(false);
  const [bannerHeight, setBannerHeight] = useState(0);
  /** Shared with the drawer so the two agree on the breakpoint-transition frame. */
  const {
    isSmallScreen,
    expanded: sidebarExpanded,
    setExpanded: setSidebarExpanded,
  } = useSidebarState();
  /** The one path drawer mutations take: it kicks the slide imperatively and
   *  defers the Recoil flip, so a large conversation cannot stall first motion. */
  const { setSidebarOpen } = useSidebarToggle();
  /** The drawer and pane snap under reduced motion (see kickDrawerAnimation),
   *  so the scrim must not keep fading on its own. */
  const prefersReducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  /** Off by default, matching the drawer that covers the screen and closes by
   *  swipe. Opting in narrows it and gives the strip a dismiss target. */
  const drawerStrip = useRecoilValue(store.mobileDrawerStrip);
  const paneRef = useRef<HTMLDivElement>(null);
  /** Keyed off the committed state rather than the scrim's own click, because
   *  the header button, Escape, conversation selection and the bottom bar all
   *  close the drawer too. */
  const { isSliding, onScrimClick } = useDrawerDismiss({
    expanded: sidebarExpanded,
    isSmallScreen,
    prefersReducedMotion,
    paneRef,
    setOpen: setSidebarOpen,
  });
  /** Focus handoff lives in the drawer header's own expanded-effect — the
   * commit drives it, so every opener (button, swipe) is covered without a
   * timer racing the deferred state flip. */
  const handleDrawerOpenChange = useCallback(
    (next: boolean) => {
      startTransition(() => {
        setSidebarExpanded(next);
      });
    },
    [setSidebarExpanded],
  );
  const { isAuthenticated, logout } = useAuthContext();
  /** Releases feature-catalog queries after first paint on browser idle. */
  useCatalogWarmup(isAuthenticated);

  useDrawerSwipe({
    paneRef,
    /** Auth gates the whole tree below (`return null`), so the swipe surfaces
     * only exist once authenticated — enabling earlier would attach to
     * nothing and never re-run when they mount. */
    enabled: isSmallScreen && isAuthenticated,
    open: sidebarExpanded,
    onOpenChange: handleDrawerOpenChange,
  });

  useHealthCheck(isAuthenticated);

  const assistantsMap = useAssistantsMap({ isAuthenticated });
  const agentsMap = useAgentsMap({ isAuthenticated });
  const fileMap = useFileMap({ isAuthenticated });

  const { data: config } = useGetStartupConfig();
  const { data: termsData } = useUserTermsQuery({
    enabled: isAuthenticated && config?.interface?.termsOfService?.modalAcceptance === true,
  });
  const highlightThrottleMs = normalizeCodeHighlightThrottleMs(
    config?.interface?.codeHighlightThrottleMs,
  );

  useSearchEnabled(isAuthenticated);

  useEffect(() => {
    if (termsData) {
      setShowTerms(!termsData.termsAccepted);
    }
  }, [termsData]);

  const handleAcceptTerms = () => {
    setShowTerms(false);
  };

  const handleDeclineTerms = () => {
    setShowTerms(false);
    logout('/login?redirect=false');
  };

  if (!isAuthenticated) {
    return null;
  }

  return (
    <CodeHighlightThrottleContext.Provider value={highlightThrottleMs}>
      <SetConvoProvider>
        <FileMapContext.Provider value={fileMap}>
          <AssistantsMapContext.Provider value={assistantsMap}>
            <AgentsMapContext.Provider value={agentsMap}>
              <PromptGroupsProvider>
                <Banner onHeightChange={setBannerHeight} />
                <div className="flex" style={{ height: `calc(100dvh - ${bannerHeight}px)` }}>
                  <div
                    className="relative z-0 flex h-full w-full overflow-hidden"
                    /** The drawer and the pane both read this, so their travel
                     *  cannot disagree about how far the drawer opens. */
                    style={
                      {
                        [MOBILE_DRAWER_WIDTH_VAR]: drawerStrip
                          ? MOBILE_DRAWER_STRIP_WIDTH
                          : MOBILE_DRAWER_FULL_WIDTH,
                      } as React.CSSProperties
                    }
                  >
                    {/* The drawer stops being painted once it is closed and
                        settled, so it needs the same travel window the scrim and
                        the pane's `inert` read. */}
                    <UnifiedSidebar isSliding={isSliding} />
                    <div
                      ref={paneRef}
                      /** Focus target of last resort when the drawer closes on a
                       *  route that renders no opener. Not in the tab order. */
                      tabIndex={-1}
                      className="relative flex h-full max-w-full flex-1 flex-col overflow-hidden focus:outline-none"
                      style={{
                        /** A percentage of the pane's own width, so it tracks the
                         *  drawer without a literal and survives rotation. */
                        transform: isSmallScreen && sidebarExpanded ? MOBILE_PANE_SHIFT : 'none',
                        transition: prefersReducedMotion ? undefined : SIDEBAR_TRANSITION,
                      }}
                      /** Recoil's flip is deferred past the opening frames and
                       *  the closing transition outlives it at the other end, so
                       *  `isSliding` covers the travel `sidebarExpanded` brackets
                       *  too late and drops too early. */
                      inert={isSmallScreen && (sidebarExpanded || isSliding) ? '' : undefined}
                    >
                      <Outlet />
                    </div>
                    {/* Without the strip the scrim exists only for the travel:
                      through a close that began while the strip was still on
                      (disabling it unmounts the scrim at once, but the drawer
                      needs the whole transition to widen), and through an open
                      the deferred flip has not committed yet. Once expanded
                      lands, a full-width drawer covers it, so keeping it
                      mounted would only expose a duplicate dismiss control. */}
                    {isSmallScreen && (drawerStrip || (isSliding && !sidebarExpanded)) && (
                      <MobileDrawerScrim
                        expanded={sidebarExpanded}
                        isSliding={isSliding}
                        prefersReducedMotion={prefersReducedMotion}
                        onClick={onScrimClick}
                      />
                    )}
                  </div>
                </div>
              </PromptGroupsProvider>
              <KeyboardShortcutsProvider />
            </AgentsMapContext.Provider>
            {config?.interface?.termsOfService?.modalAcceptance === true && (
              <TermsAndConditionsModal
                open={showTerms}
                onOpenChange={setShowTerms}
                onAccept={handleAcceptTerms}
                onDecline={handleDeclineTerms}
                title={config.interface.termsOfService.modalTitle}
                modalContent={config.interface.termsOfService.modalContent}
              />
            )}
          </AssistantsMapContext.Provider>
        </FileMapContext.Provider>
      </SetConvoProvider>
    </CodeHighlightThrottleContext.Provider>
  );
}
