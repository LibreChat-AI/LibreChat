import { useCallback } from 'react';
import { useSetAtom } from 'jotai';
import { useForm } from 'react-hook-form';
import { useLocation } from 'react-router-dom';
import { ChatProvider } from '@librechat/chat/react';
import type { ReactNode } from 'react';
import type { ChatFormValues } from '~/common';
import { useSidebarDestinationState } from '~/hooks/Nav/useUnifiedSidebarLinks';
import { AgentEditor } from '~/components/SidePanel/Agents/AgentPanelSwitch';
import { useGetStartupConfig, useGetEndpointsQuery } from '~/data-provider';
import { activePanelAtom } from '~/Providers/ActivePanelContext';
import { ChatFormProvider } from '~/Providers/ChatFormContext';
import { getPageSettings, getPageForPath } from './registry';
import useSidebarToggle from '~/hooks/Nav/useSidebarToggle';
import { FeaturePresentationProvider } from './Context';
import useRevealChat from '~/hooks/Nav/useRevealChat';
import { featureContent } from './Content';
import { useAuthContext } from '~/hooks';

function AgentSession({ visible }: { visible: boolean }) {
  const methods = useForm<ChatFormValues>({ defaultValues: { text: '' } });
  return (
    <ChatFormProvider {...methods}>
      <ChatProvider index={0}>
        <AgentEditor visible={visible} />
      </ChatProvider>
    </ChatFormProvider>
  );
}

const features = { ...featureContent, agentBuilder: AgentSession };

export default function PresentationHost({ children }: { children: ReactNode }) {
  const { data: config, isError: configError, refetch: refetchConfig } = useGetStartupConfig();
  const {
    data: endpoints,
    isError: endpointsError,
    refetch: refetchEndpoints,
  } = useGetEndpointsQuery();
  const configReady = config != null;
  const endpointsReady = endpoints != null;
  const retryStartup = useCallback(() => {
    if (!configReady) void refetchConfig();
    if (!endpointsReady) void refetchEndpoints();
  }, [configReady, endpointsReady, refetchConfig, refetchEndpoints]);
  const startupFailed = (!configReady && configError) || (!endpointsReady && endpointsError);
  const { pathname } = useLocation();
  const mcpPage =
    getPageForPath(pathname) === 'mcpSettings' &&
    getPageSettings(config?.interface?.navigation, 'mcpSettings').enabled;
  const { links, mcpAvailability } = useSidebarDestinationState({ requestMCP: mcpPage });
  const { user, roles } = useAuthContext();
  const rolesReady = roles?.USER != null && (!user?.role || roles?.[user.role] != null);
  const setActive = useSetAtom(activePanelAtom);
  const revealPage = useRevealChat();
  const { setSidebarOpen } = useSidebarToggle();
  const onPanelOpen = useCallback(
    (id: string) => {
      setActive(id);
      setSidebarOpen(true);
    },
    [setActive, setSidebarOpen],
  );
  return (
    <FeaturePresentationProvider
      ready={configReady && endpointsReady && rolesReady}
      startupError={startupFailed ? retryStartup : undefined}
      availability={mcpPage ? { mcpSettings: mcpAvailability } : undefined}
      revealPage={revealPage}
      links={links}
      features={features}
      navigation={config?.interface?.navigation}
      onPanelOpen={onPanelOpen}
    >
      {children}
    </FeaturePresentationProvider>
  );
}
