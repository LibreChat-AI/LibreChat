import { useMemo } from 'react';
import { useRecoilValue } from 'recoil';
import { BarChart3, MessagesSquare } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useUserKeyQuery } from 'librechat-data-provider/react-query';
import { getConfigDefaults, getEndpointField, resolveNavigation } from 'librechat-data-provider';
import type { TEndpointsConfig } from 'librechat-data-provider';
import type { NavLink } from '~/common';
import { useGetEndpointsQuery, useGetStartupConfig, useInsightsAccessQuery } from '~/data-provider';
import { getPageForNavId, getPageSettings } from '~/components/FeaturePresentation/registry';
import ConversationsSection from '~/components/UnifiedSidebar/ConversationsSection';
import { useFeaturePresentation } from '~/components/FeaturePresentation/Context';
import { useSideNavDestinations } from '~/hooks/Nav/useSideNavLinks';
import { getRoutePanelLinks } from './routePanels';
import { useAuthContext } from '~/hooks';
import store from '~/store';

const defaultInterface = { ...getConfigDefaults().interface, navigation: resolveNavigation() };

export function useSidebarDestinationState({ requestMCP = false } = {}) {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuthContext();
  /** Selector instead of the full conversation atom: the links only depend on
   * the endpoint, so parameter edits and other conversation writes stay out. */
  const endpoint = useRecoilValue(store.conversationEndpointByIndex(0)) ?? undefined;
  const { data: startupConfig } = useGetStartupConfig();
  const { data: endpointsConfig = {} as TEndpointsConfig } = useGetEndpointsQuery();

  const interfaceConfig = useMemo(
    () => startupConfig?.interface ?? defaultInterface,
    [startupConfig],
  );
  const insightsFeatureEnabled = startupConfig?.insightsEnabled === true;
  const isInsightsRoute = location.pathname.startsWith('/insights');
  const { data: insightsAccess, isLoading: isInsightsAccessLoading } = useInsightsAccessQuery(
    user?.id,
    {
      enabled: !!user && insightsFeatureEnabled && !isInsightsRoute,
    },
  );

  const endpointType = useMemo(
    () => getEndpointField(endpointsConfig, endpoint, 'type'),
    [endpoint, endpointsConfig],
  );

  const userProvidesKey = useMemo(
    () => !!(endpointsConfig?.[endpoint ?? '']?.userProvide ?? false),
    [endpointsConfig, endpoint],
  );

  const { data: keyExpiry = { expiresAt: undefined } } = useUserKeyQuery(endpoint ?? '');

  const keyProvided = useMemo(
    () => (userProvidesKey ? !!(keyExpiry.expiresAt ?? '') : true),
    [keyExpiry.expiresAt, userProvidesKey],
  );

  const { links: allSideNavLinks, mcpAvailability } = useSideNavDestinations({
    requestMCP,
    keyProvided,
    endpoint,
    endpointType,
    interfaceConfig,
    endpointsConfig,
    includeHidePanel: false,
  });
  const sideNavLinks = useMemo(
    () => getRoutePanelLinks(location.pathname, allSideNavLinks),
    [location.pathname, allSideNavLinks],
  );

  const links = useMemo(() => {
    const conversationLink: NavLink = {
      title: 'com_ui_chat_history',
      label: '',
      icon: MessagesSquare,
      id: 'conversations',
      Component: ConversationsSection,
    };

    if (
      !insightsFeatureEnabled ||
      (!isInsightsRoute && !isInsightsAccessLoading && insightsAccess?.access !== true)
    ) {
      return [conversationLink, ...sideNavLinks];
    }

    const insightsLink: NavLink = {
      title: 'com_insights_navigation',
      label: '',
      icon: BarChart3,
      id: 'insights',
      disabled: !isInsightsRoute && isInsightsAccessLoading,
      onClick: () => {
        if (!location.pathname.startsWith('/insights')) {
          navigate('/insights');
        }
      },
    };
    const mcpIndex = sideNavLinks.findIndex((link) => link.id === 'mcp-builder');
    const nextLinks = [...sideNavLinks];
    nextLinks.splice(mcpIndex >= 0 ? mcpIndex + 1 : nextLinks.length, 0, insightsLink);

    return [conversationLink, ...nextLinks];
  }, [
    insightsAccess?.access,
    insightsFeatureEnabled,
    isInsightsAccessLoading,
    isInsightsRoute,
    location.pathname,
    navigate,
    sideNavLinks,
  ]);

  return { links, mcpAvailability };
}

export function useSidebarDestinations() {
  return useSidebarDestinationState().links;
}

export default function useUnifiedSidebarLinks() {
  const presentation = useFeaturePresentation();
  const { data: startupConfig } = useGetStartupConfig();
  return useMemo(
    (): NavLink[] =>
      (presentation?.links ?? []).map((link) => {
        const page = getPageForNavId(link.id);
        if (presentation?.relatedPage && (link.Component || link.id === 'conversations') && !page) {
          return { ...link, view: 'panel', onClick: () => presentation.openPanel(link.id) };
        }
        if (
          !page ||
          !presentation ||
          (!presentation.relatedPage &&
            (!presentation.canOpenPage(page) ||
              getPageSettings(startupConfig?.interface?.navigation, page).defaultView !== 'page'))
        ) {
          return link;
        }
        const resourceEditor = presentation.relatedPage === page && presentation.page !== page;
        const view =
          !resourceEditor &&
          presentation.canOpenPage(page) &&
          getPageSettings(startupConfig?.interface?.navigation, page).defaultView === 'page'
            ? 'page'
            : 'panel';
        return { ...link, view, onClick: () => presentation.open(page) };
      }),
    [presentation, startupConfig?.interface?.navigation],
  );
}
