import { useForm } from 'react-hook-form';
import { ChatProvider } from '@librechat/chat/react';
import type { NavigationPage } from 'librechat-data-provider';
import type { ComponentType, ReactNode } from 'react';
import type { ChatFormValues } from '~/common';
import MCPBuilderPanel from '~/components/SidePanel/MCPBuilder/MCPBuilderPanel';
import PromptsAccordion from '~/components/Prompts/sidebar/PromptsAccordion';
import BookmarkPanel from '~/components/SidePanel/Bookmarks/BookmarkPanel';
import SkillsAccordion from '~/components/Skills/sidebar/SkillsAccordion';
import Parameters from '~/components/SidePanel/Parameters/Panel';
import { SchedulePanel } from '~/components/SidePanel/Schedules';
import { ChatFormProvider } from '~/Providers/ChatFormContext';
import { MemoryPanel } from '~/components/SidePanel/Memories';
import { useFeaturePresentation } from './Context';
import PresentationActions from './Actions';

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
  const presentation = useFeaturePresentation();
  return (
    <Session page="prompts">
      <PromptsAccordion visible={visible} isChatRoute={presentation?.page !== 'prompts'} />
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
