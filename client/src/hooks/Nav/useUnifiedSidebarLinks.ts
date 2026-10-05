import { useMemo } from 'react';
import { useRecoilValue } from 'recoil';
import { useLocation, useNavigate } from 'react-router-dom';
import { BarChart3, MessagesSquare, Images } from 'lucide-react';
import { useUserKeyQuery } from 'librechat-data-provider/react-query';
import { getConfigDefaults, getEndpointField } from 'librechat-data-provider';
import type { TEndpointsConfig } from 'librechat-data-provider';
import type { NavLink } from '~/common';
import {
  useGetEndpointsQuery,
  useGetStartupConfig,
  useInsightsAccessQuery,
  useMediaActivity,
  useMediaEvents,
} from '~/data-provider';
import ConversationsSection from '~/components/UnifiedSidebar/ConversationsSection';
import { useMediaSessionGuard } from '~/components/Media/session';
import { useMediaAccess } from '~/hooks/Media/useMediaAccess';
import MediaSettingsPanel from '~/components/Media/Panel';
import useSideNavLinks from '~/hooks/Nav/useSideNavLinks';
import { useAuthContext, useLocalize } from '~/hooks';
import store from '~/store';

const defaultInterface = getConfigDefaults().interface;

/** Reserve the saved panel width while access resolves without mounting feature queries. */
function MediaSettingsPlaceholder() {
  return null;
}

export default function useUnifiedSidebarLinks() {
  const navigate = useNavigate();
  const localize = useLocalize();
  const location = useLocation();
  const { user, token } = useAuthContext();
  /** Selector instead of the full conversation atom: the links only depend on
   * the endpoint, so parameter edits and other conversation writes stay out. */
  const endpoint = useRecoilValue(store.conversationEndpointByIndex(0)) ?? undefined;
  const { data: startupConfig } = useGetStartupConfig();
  const { data: endpointsConfig = {} as TEndpointsConfig } = useGetEndpointsQuery();

  const interfaceConfig = useMemo(
    () => startupConfig?.interface ?? defaultInterface,
    [startupConfig],
  );
  const { studio: mediaVisible, scope: mediaScope, isAuthenticated } = useMediaAccess();
  const isStudioRoute = location.pathname === '/studio' || location.pathname.startsWith('/studio/');
  const isCurrentSession = useMediaSessionGuard(mediaScope, isAuthenticated);
  const mediaActivityHost = {
    scope: mediaScope ?? '',
    userId: user?.id,
    pollIntervalMs: startupConfig?.media?.clientPollIntervalMs ?? 0,
    catchUpIntervalMs: startupConfig?.media?.clientCatchUpIntervalMs ?? 0,
    isCurrentSession,
  };
  const mediaActivity = useMediaActivity(mediaActivityHost, mediaVisible);
  // Settle the initial snapshot before opening a persistent connection; SSE ready catches up gaps.
  useMediaEvents(
    mediaActivityHost,
    token,
    mediaVisible && mediaActivity.isFetched && startupConfig?.media?.events === true,
  );
  const mediaActivityCount = `${mediaActivity.count}${mediaActivity.hasMore ? '+' : ''}`;
  const mediaActivityLabel =
    mediaActivity.count > 0
      ? localize('com_media_activity_unfinished', { total: mediaActivityCount })
      : undefined;
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

  const sideNavLinks = useSideNavLinks({
    keyProvided,
    endpoint,
    endpointType,
    interfaceConfig,
    endpointsConfig,
    includeHidePanel: false,
  });

  const links = useMemo(() => {
    const conversationLink: NavLink = {
      title: 'com_ui_chat_history',
      label: '',
      icon: MessagesSquare,
      id: 'conversations',
      Component: ConversationsSection,
    };

    const nextLinks = [...sideNavLinks];
    if (mediaVisible || isStudioRoute) {
      const agentIndex = nextLinks.findIndex((link) => link.id === 'agents');
      nextLinks.splice(agentIndex >= 0 ? agentIndex + 1 : nextLinks.length, 0, {
        title: 'com_media_studio',
        label: '',
        activity: mediaActivityLabel
          ? { count: mediaActivityCount, label: mediaActivityLabel }
          : undefined,
        icon: Images,
        id: 'media-studio',
        Component: mediaVisible ? MediaSettingsPanel : MediaSettingsPlaceholder,
        disabled: !mediaVisible,
        route: '/studio',
        onClick: () => {
          if (!location.pathname.startsWith('/studio')) navigate('/studio');
        },
      });
    }

    if (
      !insightsFeatureEnabled ||
      (!isInsightsRoute && !isInsightsAccessLoading && insightsAccess?.access !== true)
    ) {
      return [conversationLink, ...nextLinks];
    }

    const insightsLink: NavLink = {
      title: 'com_insights_navigation',
      label: '',
      icon: BarChart3,
      id: 'insights',
      route: '/insights',
      disabled: !isInsightsRoute && isInsightsAccessLoading,
      onClick: () => {
        if (!location.pathname.startsWith('/insights')) {
          navigate('/insights');
        }
      },
    };
    const mcpIndex = nextLinks.findIndex((link) => link.id === 'mcp-builder');
    nextLinks.splice(mcpIndex >= 0 ? mcpIndex + 1 : nextLinks.length, 0, insightsLink);

    return [conversationLink, ...nextLinks];
  }, [
    mediaVisible,
    isStudioRoute,
    mediaActivityCount,
    mediaActivityLabel,
    insightsAccess?.access,
    insightsFeatureEnabled,
    isInsightsAccessLoading,
    isInsightsRoute,
    location.pathname,
    navigate,
    sideNavLinks,
  ]);

  return links;
}
