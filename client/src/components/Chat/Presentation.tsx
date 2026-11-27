import { Suspense, useCallback, useEffect, useMemo, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { EModelEndpoint } from 'librechat-data-provider';
import { useRecoilValue, useSetRecoilState, useResetRecoilState } from 'recoil';
import {
  sideChatAtom,
  sideChatDraftTakenAtom,
  SIDE_CHAT_PANE,
  sideChatBesideAtom,
  sideChatRequestAtom,
  useIsSubmitting,
  activeSubagentPanel,
  SideChatHostProvider,
  ParentSubagentsProvider,
} from '@librechat/chat/react';
import type { SideChat } from '@librechat/chat/react';
import useArtifactsRegistryLifetime from '~/hooks/Artifacts/useArtifactsRegistryLifetime';
import { MessageSurfaceContext } from '~/components/Chat/Messages/ui/surface';
import DragDropWrapper from '~/components/Chat/Input/Files/DragDropWrapper';
import UndockedArtifacts from '~/components/Artifacts/UndockedArtifacts';
import { appSideChatHost } from '~/Providers/SideChatHostContext';
import { artifactsUndocked } from '~/components/Artifacts/state';
import { EditorProvider, ArtifactsProvider } from '~/Providers';
import { SessionRailSlot } from '~/components/Chat/Session';
import { SidePanelGroup } from '~/components/SidePanel';
import AppChatSurface from '~/components/Chat/Surface';
import { useGetStartupConfig } from '~/data-provider';
import { lazyWithRecovery } from '~/lib/assets/lazy';
import { migrateStoredFileDeletions } from '~/utils';
import store from '~/store';

const Artifacts = lazyWithRecovery(() => import('~/components/Artifacts/Artifacts'));
/** The panel draws message rows, so the app's message hosts load with it. */
const SubagentThreadPanel = lazyWithRecovery(() =>
  Promise.all([
    import('@librechat/chat/components').then((module) => module.loadSubagentThreadPanel()),
    import('~/components/Chat/Messages/hosts'),
  ]).then(([panel]) => panel),
);

const SideChatPanel = lazyWithRecovery(() =>
  Promise.all([
    import('@librechat/chat/components').then((module) => module.loadSideChatPanel()),
    import('~/components/Chat/Messages/hosts'),
  ]).then(([panel]) => panel),
);

export default function Presentation({
  children,
  routePending = false,
}: {
  children: React.ReactNode;
  routePending?: boolean;
}) {
  const artifacts = useRecoilValue(store.artifactsState);
  const artifactsVisibility = useRecoilValue(store.artifactsVisibility);
  // Render-gating the panel on `currentArtifactId != null` (in addition
  // to visibility + non-empty artifacts) means the side panel only opens
  // when *something* is actively focused. Conversation navigation
  // resets `currentArtifactId` to null, so the panel stays closed when
  // a user revisits an old conversation full of artifacts. New artifacts
  // arriving via SSE auto-focus through `ToolArtifactCard`'s mount effect
  // (gated on `isSubmitting`), restoring the legacy streaming UX.
  const currentArtifactId = useRecoilValue(store.currentArtifactId);
  const conversationId = useRecoilValue(store.conversationIdByIndex(0));
  const conversationEndpoint = useRecoilValue(store.effectiveEndpointByIndex(0));
  const conversationAgentId = useRecoilValue(store.conversationAgentIdByIndex(0));
  const isSubmitting = useIsSubmitting(0);
  const isUndocked = useAtomValue(artifactsUndocked);
  const selectedSubagent = useAtomValue(activeSubagentPanel);
  const setSelectedSubagent = useSetAtom(activeSubagentPanel);
  const resetSelectedSubagent = useCallback(() => setSelectedSubagent(null), [setSelectedSubagent]);
  const sideChat = useAtomValue(sideChatAtom);
  const isSideChatSubmitting = useIsSubmitting(SIDE_CHAT_PANE);
  const setSideChat = useSetAtom(sideChatAtom);
  const takeSideChatDraft = useSetAtom(sideChatDraftTakenAtom);
  const closeSideChat = useCallback(
    () => setSideChat((current) => (current === sideChat ? null : current)),
    [setSideChat, sideChat],
  );
  const takeSideChatText = useCallback(
    (expected: SideChat) =>
      setSideChat((current) =>
        current === expected ? { conversation: current.conversation } : current,
      ),
    [setSideChat],
  );
  const previousConversationIdRef = useRef<string | null>(null);

  useArtifactsRegistryLifetime(conversationId);

  useEffect(
    () => () =>
      setSelectedSubagent((current) => (current?.host === 'conversation' ? null : current)),
    [setSelectedSubagent],
  );

  useEffect(() => {
    const previous = previousConversationIdRef.current;
    const next = conversationId ?? null;
    previousConversationIdRef.current = next;
    if (previous != null && previous !== next) {
      setSelectedSubagent((current) => (current?.durable == null ? null : current));
      /** A side chat sits beside the conversation it was opened from, and leaves with it. */
      setSideChat(null);
    }
  }, [conversationId, setSelectedSubagent, setSideChat]);

  useEffect(() => () => setSideChat(null), [setSideChat]);

  /**
   * One panel at a time: a child's activity opened after the side chat takes its place, and
   * the place of one still being fetched, which would otherwise arrive on top of it.
   */
  const withdrawSideChatRequest = useSetAtom(sideChatRequestAtom);
  useEffect(() => {
    if (selectedSubagent != null) {
      withdrawSideChatRequest(null);
      setSideChat(null);
    }
  }, [selectedSubagent, setSideChat, withdrawSideChatRequest]);

  const { data: startupConfig, isSuccess: hasStartupConfig } = useGetStartupConfig();

  useEffect(() => migrateStoredFileDeletions(), []);

  /* The deployment's answer about the undocked window, resolved once by the
   * host and handed to the pane. Until the config has actually answered the
   * capability is unknown, and offering the control then would both let a user
   * undock a pane the deployment forbids and take the Dock control away from
   * them when the answer arrived. */
  const canUndock = hasStartupConfig && startupConfig?.interface?.artifactUndocking !== false;
  const artifactsProviderValue = useMemo(() => ({ canUndock }), [canUndock]);

  /** A side chat needs this chat to sit beside, and the deployment's leave to open one. */
  const canSideChat = hasStartupConfig === true && startupConfig?.interface?.sideChat !== false;
  const setSideChatBeside = useSetAtom(sideChatBesideAtom);
  useEffect(() => {
    setSideChatBeside(canSideChat ? { conversationId: conversationId ?? null } : null);
    return () => setSideChatBeside(null);
  }, [canSideChat, conversationId, setSideChatBeside]);

  /**
   * One panel at a time, and the one asked for last has the slot: a side chat opened while an
   * artifact or a child's activity is showing takes their place, as each of them takes its.
   * Undocked, the artifact is in a window of its own and gives up nothing.
   */
  const resetCurrentArtifactId = useResetRecoilState(store.currentArtifactId);
  const setArtifactsVisible = useSetRecoilState(store.artifactsVisibility);
  const sideChatId = sideChat?.conversation.conversationId ?? null;
  /** Read when a side chat opens, not watched: docking an artifact later is that panel's ask. */
  const undocked = useRef(isUndocked);
  undocked.current = isUndocked;
  useEffect(() => {
    if (sideChatId == null) {
      return;
    }
    setSelectedSubagent(null);
    if (!undocked.current) {
      resetCurrentArtifactId();
      setArtifactsVisible(false);
    }
  }, [sideChatId, setSelectedSubagent, resetCurrentArtifactId, setArtifactsVisible]);

  const artifactsElement = useMemo(() => {
    if (
      artifactsVisibility === true &&
      currentArtifactId != null &&
      Object.keys(artifacts ?? {}).length > 0
    ) {
      return (
        <ArtifactsProvider value={artifactsProviderValue}>
          <Suspense fallback={null}>
            <Artifacts />
          </Suspense>
        </ArtifactsProvider>
      );
    }
    return null;
  }, [artifactsVisibility, artifacts, currentArtifactId, artifactsProviderValue]);

  /* The two panels are mutually exclusive only while they compete for the same
   * slot. Undocked, the artifacts pane is in its own window and the side panel
   * is free, so a child-activity panel opened there must survive. */
  useEffect(() => {
    if (!isUndocked && artifactsElement != null && selectedSubagent != null) {
      resetSelectedSubagent();
    }
  }, [artifactsElement, isUndocked, resetSelectedSubagent, selectedSubagent]);

  /**
   * An artifact that takes the slot, or another one chosen in it, is the panel asked for last:
   * the side chat gives way, and so does one still being fetched. Keyed on the artifact shown,
   * not on the panel's every render, so an artifact that is merely updating withdraws nothing.
   */
  const artifactShown = !isUndocked && artifactsElement != null;
  useEffect(() => {
    if (artifactShown) {
      withdrawSideChatRequest(null);
      setSideChat(null);
    }
  }, [artifactShown, currentArtifactId, setSideChat, withdrawSideChatRequest]);

  const subagentElement = useMemo(() => {
    if (
      selectedSubagent == null ||
      selectedSubagent.host !== 'conversation' ||
      (selectedSubagent.durable == null && selectedSubagent.parentConversationId !== conversationId)
    ) {
      return null;
    }
    return (
      <ParentSubagentsProvider conversationId={selectedSubagent.parentConversationId} enabled>
        <Suspense fallback={null}>
          <SubagentThreadPanel selection={selectedSubagent} />
        </Suspense>
      </ParentSubagentsProvider>
    );
  }, [conversationId, selectedSubagent]);

  const sideChatElement = useMemo(() => {
    if (sideChat == null) {
      return null;
    }
    const { conversationId: sideConversationId, endpoint, agent_id } = sideChat.conversation;
    return (
      <SideChatHostProvider host={appSideChatHost}>
        {/* Children the side conversation's agent dispatches are its own, not the main one's. */}
        <ParentSubagentsProvider
          conversationId={sideConversationId ?? ''}
          enabled={endpoint === EModelEndpoint.agents && agent_id != null}
          isSubmitting={isSideChatSubmitting}
        >
          <Suspense fallback={null}>
            <SideChatPanel
              key={sideConversationId}
              chat={sideChat}
              onClose={closeSideChat}
              onHandedTextTaken={takeSideChatText}
              onDraftTaken={takeSideChatDraft}
            />
          </Suspense>
        </ParentSubagentsProvider>
      </SideChatHostProvider>
    );
  }, [closeSideChat, isSideChatSubmitting, sideChat, takeSideChatDraft, takeSideChatText]);

  /* Undocked, the pane renders into its own window: the side panel gives its
   * width back to the conversation instead of holding an empty column. */
  const panelElement = (isUndocked ? null : artifactsElement) ?? subagentElement ?? sideChatElement;

  return (
    <DragDropWrapper className="bg-surface-canvas relative flex w-full grow overflow-hidden">
      <AppChatSurface>
        {/* The editor buffer belongs to the pane's session, not to the window
            it happens to be in: hoisted, an undock keeps unsaved edits. */}
        <EditorProvider>
          <ParentSubagentsProvider
            conversationId={conversationId ?? ''}
            enabled={conversationEndpoint === EModelEndpoint.agents && conversationAgentId != null}
            isSubmitting={isSubmitting}
          >
            <SidePanelGroup panel={panelElement}>
              {/* A size container: the composer caps its width against this column
                  (`cqw`), so it keeps clear of the edges when the sidebar or a side panel
                  narrows the column, which a viewport unit cannot see. */}
              <main className="@container flex h-full flex-col overflow-y-auto" role="main">
                <MessageSurfaceContext.Provider value="bg-surface-canvas">
                  {children}
                </MessageSurfaceContext.Provider>
              </main>
            </SidePanelGroup>
            {/* The session rail's own column, past the side panel: the header's control draws
                the rail here, so the list of what is running stays put while a panel opens. */}
            <SessionRailSlot />
          </ParentSubagentsProvider>
          {isUndocked && artifactsElement != null && (
            <UndockedArtifacts hidden={routePending}>{artifactsElement}</UndockedArtifacts>
          )}
        </EditorProvider>
      </AppChatSurface>
    </DragDropWrapper>
  );
}
