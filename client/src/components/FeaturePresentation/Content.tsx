import { useForm } from 'react-hook-form';
import { useLocation } from 'react-router-dom';
import { ChatProvider } from '@librechat/chat/react';
import type { NavigationPage } from 'librechat-data-provider';
import type { ComponentType, ReactNode } from 'react';
import type { ChatFormValues } from '~/common';
import PromptsAccordion from '~/components/Prompts/sidebar/PromptsAccordion';
import SkillsAccordion from '~/components/Skills/sidebar/SkillsAccordion';
import { ChatFormProvider } from '~/Providers/ChatFormContext';
import { lazyWithRecovery } from '~/lib/assets/lazy';
import PresentationActions from './Actions';

const MCPBuilderPanel = lazyWithRecovery(
  () => import('~/components/SidePanel/MCPBuilder/MCPBuilderPanel'),
);
const BookmarkPanel = lazyWithRecovery(
  () => import('~/components/SidePanel/Bookmarks/BookmarkPanel'),
);
const Parameters = lazyWithRecovery(() => import('~/components/SidePanel/Parameters/Panel'));
const SchedulePanel = lazyWithRecovery(
  () => import('~/components/SidePanel/Schedules/SchedulePanel'),
);
const MemoryPanel = lazyWithRecovery(() => import('~/components/SidePanel/Memories/MemoryPanel'));

function Session({ children, page }: { children: ReactNode; page: NavigationPage }) {
  const methods = useForm<ChatFormValues>({ defaultValues: { text: '' } });
  return (
    <ChatFormProvider {...methods}>
      <ChatProvider index={0}>
        <PresentationActions page={page} />
        {children}
      </ChatProvider>
    </ChatFormProvider>
  );
}

function Skills({ visible }: { visible: boolean }) {
  return (
    <Session page="skills">
      <SkillsAccordion visible={visible} />
    </Session>
  );
}

function Prompts({ visible }: { visible: boolean }) {
  const { pathname } = useLocation();
  return (
    <Session page="prompts">
      <PromptsAccordion visible={visible} isChatRoute={pathname.startsWith('/c/')} />
    </Session>
  );
}

function Schedules() {
  return (
    <Session page="schedules">
      <SchedulePanel />
    </Session>
  );
}

function Memories() {
  return (
    <Session page="memories">
      <MemoryPanel />
    </Session>
  );
}

function Bookmarks() {
  return (
    <Session page="bookmarks">
      <BookmarkPanel />
    </Session>
  );
}

function ModelParameters() {
  return (
    <Session page="parameters">
      <Parameters />
    </Session>
  );
}

function MCPSettings({ visible }: { visible: boolean }) {
  return (
    <Session page="mcpSettings">
      <MCPBuilderPanel visible={visible} />
    </Session>
  );
}

export const featureContent: Record<
  Exclude<NavigationPage, 'agentBuilder'>,
  ComponentType<{ visible: boolean }>
> = {
  skills: Skills,
  prompts: Prompts,
  schedules: Schedules,
  memories: Memories,
  bookmarks: Bookmarks,
  parameters: ModelParameters,
  mcpSettings: MCPSettings,
};
