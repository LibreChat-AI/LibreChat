import { useCallback } from 'react';
import { useSetAtom } from 'jotai';
import { useForm } from 'react-hook-form';
import { ChatProvider } from '@librechat/chat/react';
import type { ReactNode } from 'react';
import type { ChatFormValues } from '~/common';
import { AgentEditor } from '~/components/SidePanel/Agents/AgentPanelSwitch';
import { useGetStartupConfig, useGetEndpointsQuery } from '~/data-provider';
import useUnifiedSidebarLinks from '~/hooks/Nav/useUnifiedSidebarLinks';
import { activePanelAtom } from '~/Providers/ActivePanelContext';
import { ChatFormProvider } from '~/Providers/ChatFormContext';
import useSidebarToggle from '~/hooks/Nav/useSidebarToggle';
import { FeaturePresentationProvider } from './Context';
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

const features = { agentBuilder: AgentSession };

export default function PresentationHost({ children }: { children: ReactNode }) {
  const links = useUnifiedSidebarLinks();
  const { data: config, isSuccess: configReady } = useGetStartupConfig();
  const { isSuccess: endpointsReady } = useGetEndpointsQuery();
  const { user, roles } = useAuthContext();
  const rolesReady = roles?.USER != null && (!user?.role || roles?.[user.role] != null);
  const setActive = useSetAtom(activePanelAtom);
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
      links={links}
      features={features}
      navigation={config?.interface?.navigation}
      onPanelOpen={onPanelOpen}
    >
      {children}
    </FeaturePresentationProvider>
  );
}
