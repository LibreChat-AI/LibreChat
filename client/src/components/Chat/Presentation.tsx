import { Suspense, useCallback, useEffect, useMemo, useRef } from 'react';
import { useRecoilValue } from 'recoil';
import { useAtomValue, useSetAtom } from 'jotai';
import { EModelEndpoint, FileSources, LocalStorageKeys } from 'librechat-data-provider';
import type { ExtendedFile } from '~/common';
import { ParentSubagentsProvider } from '~/components/Chat/Subagents/ParentSubagentsProvider';
import useArtifactsRegistryLifetime from '~/hooks/Artifacts/useArtifactsRegistryLifetime';
import { useDeleteFilesMutation, useGetStartupConfig } from '~/data-provider';
import DragDropWrapper from '~/components/Chat/Input/Files/DragDropWrapper';
import UndockedArtifacts from '~/components/Artifacts/UndockedArtifacts';
import { activeSubagentPanel } from '~/components/Chat/Subagents/state';
import { artifactsUndocked } from '~/components/Artifacts/state';
import { EditorProvider, ArtifactsProvider } from '~/Providers';
import { SidePanelGroup } from '~/components/SidePanel';
import AppChatSurface from '~/components/Chat/Surface';
import { lazyWithRecovery } from '~/lib/assets/lazy';
import { useSetFilesToDelete } from '~/hooks';
import { failedFileIdsFrom } from '~/utils';
import store from '~/store';

const Artifacts = lazyWithRecovery(() => import('~/components/Artifacts/Artifacts'));
const SubagentThreadPanel = lazyWithRecovery(
  () => import('~/components/Chat/Subagents/SubagentThreadPanel'),
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
  const isSubmitting = useRecoilValue(store.isSubmittingFamily(0));
  const isUndocked = useAtomValue(artifactsUndocked);
  const selectedSubagent = useAtomValue(activeSubagentPanel);
  const setSelectedSubagent = useSetAtom(activeSubagentPanel);
  const resetSelectedSubagent = useCallback(() => setSelectedSubagent(null), [setSelectedSubagent]);
  const previousConversationIdRef = useRef<string | null>(null);

  useArtifactsRegistryLifetime(conversationId);

  useEffect(() => {
    const previous = previousConversationIdRef.current;
    const next = conversationId ?? null;
    previousConversationIdRef.current = next;
    if (previous != null && previous !== next) resetSelectedSubagent();
  }, [conversationId, resetSelectedSubagent]);

  const setFilesToDelete = useSetFilesToDelete();

  const { data: startupConfig, isSuccess: hasStartupConfig } = useGetStartupConfig();
  const { mutateAsync } = useDeleteFilesMutation({
    onSuccess: (result) => {
      console.log('Temporary Files deleted');
      const failed = new Set(failedFileIdsFrom(result));
      if (failed.size === 0) {
        setFilesToDelete({});
        return;
      }
      try {
        const filesToDelete = localStorage.getItem(LocalStorageKeys.FILES_TO_DELETE);
        const map = JSON.parse(filesToDelete ?? '{}') as Record<string, ExtendedFile>;
        const remaining: Record<string, ExtendedFile> = {};
        for (const [key, file] of Object.entries(map)) {
          if (
            (file.file_id != null && failed.has(file.file_id)) ||
            (file.temp_file_id != null && failed.has(file.temp_file_id))
          ) {
            remaining[key] = file;
          }
        }
        setFilesToDelete(remaining);
      } catch {
        // Keep existing records if reading or parsing fails.
      }
    },
    onError: (error) => {
      console.log('Error deleting temporary files:', error);
    },
  });

  useEffect(() => {
    const filesToDelete = localStorage.getItem(LocalStorageKeys.FILES_TO_DELETE);
    const map = JSON.parse(filesToDelete ?? '{}') as Record<string, ExtendedFile>;
    const files = Object.values(map)
      .filter(
        (file) =>
          file.filepath != null && file.source && !(file.embedded ?? false) && file.temp_file_id,
      )
      .map((file) => ({
        file_id: file.file_id,
        filepath: file.filepath as string,
        source: file.source as FileSources,
        embedded: !!(file.embedded ?? false),
      }));

    if (files.length === 0) {
      return;
    }
    mutateAsync({ files });
  }, [mutateAsync]);

  /* The deployment's answer about the undocked window, resolved once by the
   * host and handed to the pane. Until the config has actually answered the
   * capability is unknown, and offering the control then would both let a user
   * undock a pane the deployment forbids and take the Dock control away from
   * them when the answer arrived. */
  const canUndock = hasStartupConfig && startupConfig?.interface?.artifactUndocking !== false;
  const artifactsProviderValue = useMemo(() => ({ canUndock }), [canUndock]);

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

  const subagentElement = useMemo(() => {
    if (
      selectedSubagent == null ||
      selectedSubagent.host !== 'conversation' ||
      selectedSubagent.parentConversationId !== conversationId
    ) {
      return null;
    }
    return (
      <Suspense fallback={null}>
        <SubagentThreadPanel selection={selectedSubagent} />
      </Suspense>
    );
  }, [conversationId, selectedSubagent]);

  /* Undocked, the pane renders into its own window: the side panel gives its
   * width back to the conversation instead of holding an empty column. */
  const panelElement = (isUndocked ? null : artifactsElement) ?? subagentElement;

  return (
    <DragDropWrapper className="bg-surface-primary-alt relative flex w-full grow overflow-hidden">
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
              <main className="flex h-full flex-col overflow-y-auto" role="main">
                {children}
              </main>
            </SidePanelGroup>
          </ParentSubagentsProvider>
          {isUndocked && artifactsElement != null && (
            <UndockedArtifacts hidden={routePending}>{artifactsElement}</UndockedArtifacts>
          )}
        </EditorProvider>
      </AppChatSurface>
    </DragDropWrapper>
  );
}
