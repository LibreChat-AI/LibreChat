import { lazy, Suspense, useState, useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { useRecoilValue } from 'recoil';
import {
  useMediaQuery,
  ResizablePanel,
  ResizableHandleAlt,
  ResizablePanelGroup,
} from '@librechat/client';
import type { TMessage } from 'librechat-data-provider';
import type { ArtifactsContextValue } from '~/Providers';
import useArtifactsRegistryLifetime from '~/hooks/Artifacts/useArtifactsRegistryLifetime';
import UndockedArtifacts from '~/components/Artifacts/UndockedArtifacts';
import { artifactsUndocked } from '~/components/Artifacts/state';
import { ArtifactsProvider, EditorProvider } from '~/Providers';
import { useGetSharedStartupConfig } from '~/data-provider';
import { isCodeOnlyArtifact } from '~/utils/artifacts';
import { useShareContext } from '~/Providers';
import { getLatestText } from '~/utils';
import store from '~/store';

const Artifacts = lazy(() => import('~/components/Artifacts/Artifacts'));

const DEFAULT_ARTIFACT_PANEL_SIZE = 40;
const SHARE_ARTIFACT_PANEL_STORAGE_KEY = 'share:artifacts-panel-size';
const SHARE_ARTIFACT_PANEL_DEFAULT_KEY = 'share:artifacts-panel-size-default';

/**
 * Gets the initial artifact panel size from localStorage or returns default
 */
const getInitialArtifactPanelSize = () => {
  if (typeof window === 'undefined') {
    return DEFAULT_ARTIFACT_PANEL_SIZE;
  }

  const defaultSizeString = String(DEFAULT_ARTIFACT_PANEL_SIZE);
  const storedDefault = window.localStorage.getItem(SHARE_ARTIFACT_PANEL_DEFAULT_KEY);

  if (storedDefault !== defaultSizeString) {
    window.localStorage.setItem(SHARE_ARTIFACT_PANEL_DEFAULT_KEY, defaultSizeString);
    window.localStorage.removeItem(SHARE_ARTIFACT_PANEL_STORAGE_KEY);
    return DEFAULT_ARTIFACT_PANEL_SIZE;
  }

  const stored = window.localStorage.getItem(SHARE_ARTIFACT_PANEL_STORAGE_KEY);
  const parsed = Number(stored);
  return Number.isFinite(parsed) ? parsed : DEFAULT_ARTIFACT_PANEL_SIZE;
};

interface ShareArtifactsContainerProps {
  messages: TMessage[];
  conversationId: string;
  mainContent: React.ReactNode;
}

/**
 * Container component that manages artifact visibility and layout for shared conversations
 */
export function ShareArtifactsContainer({
  messages,
  conversationId,
  mainContent,
}: ShareArtifactsContainerProps) {
  const artifacts = useRecoilValue(store.artifactsState);
  const artifactsVisibility = useRecoilValue(store.artifactsVisibility);
  const currentArtifactId = useRecoilValue(store.currentArtifactId);
  const isSmallScreen = useMediaQuery('(max-width: 1023px)');
  const isUndocked = useAtomValue(artifactsUndocked);
  const [artifactPanelSize, setArtifactPanelSize] = useState(getInitialArtifactPanelSize);
  /* Leaving the shared conversation clears the registry; the pane's own
   * cleanup keeps it while the pane only changes hosts. */
  useArtifactsRegistryLifetime();

  const { shareId } = useShareContext();
  const { data: sharedStartupConfig } = useGetSharedStartupConfig(shareId, {
    enabled: typeof shareId === 'string' && shareId !== '',
  });
  /* Absent config reads as enabled, which is the default and today's pane. */
  const canUndock = sharedStartupConfig?.interface?.artifactUndocking !== false;

  const artifactsContextValue = useMemo<ArtifactsContextValue | null>(() => {
    const latestMessage =
      Array.isArray(messages) && messages.length > 0 ? messages[messages.length - 1] : null;

    if (!latestMessage) {
      return null;
    }

    const latestMessageText = getLatestText(latestMessage);

    return {
      isSubmitting: false,
      latestMessageId: latestMessage.messageId ?? null,
      latestMessageText,
      conversationId: conversationId ?? null,
      canUndock,
    };
  }, [messages, conversationId, canUndock]);

  const hasSelectedArtifact = currentArtifactId != null && artifacts?.[currentArtifactId] != null;
  const hasAutoOpenableArtifact = Object.values(artifacts ?? {}).some(
    (artifact) => artifact != null && !isCodeOnlyArtifact(artifact.type),
  );
  const shouldRenderArtifacts =
    artifactsVisibility === true &&
    artifactsContextValue != null &&
    (hasSelectedArtifact || hasAutoOpenableArtifact);

  const normalizedArtifactSize = Math.min(60, Math.max(20, artifactPanelSize));

  const handleLayoutChanged = (layout: Record<string, number | string>) => {
    const raw = layout['share-artifacts'];
    const newSize = typeof raw === 'string' ? parseFloat(raw) : raw;
    if (!Number.isFinite(newSize)) {
      return;
    }
    setArtifactPanelSize(newSize);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(SHARE_ARTIFACT_PANEL_STORAGE_KEY, newSize.toString());
    }
  };

  const paneContext = shouldRenderArtifacts ? artifactsContextValue : null;
  const pane = paneContext != null ? <ShareArtifactsPanel contextValue={paneContext} /> : null;
  const overlay = paneContext != null ? <ShareArtifactsOverlay contextValue={paneContext} /> : null;
  const showDockedPanel = pane != null && !isUndocked && !isSmallScreen;

  /* The transcript keeps one place in the tree through every state: React
   * cannot preserve it across a change of ancestry, so opening the pane,
   * undocking it or docking it again would each remount the conversation and
   * throw away the reader's scroll position. Only the pane's host changes —
   * a second resizable panel, a mobile overlay, or its own window — and the
   * provider that owns the editor buffer stays mounted above all of them. */
  return (
    <EditorProvider>
      <ResizablePanelGroup
        orientation="horizontal"
        className="h-full w-full"
        onLayoutChanged={handleLayoutChanged}
      >
        <ResizablePanel
          defaultSize={`${showDockedPanel ? 100 - normalizedArtifactSize : 100}`}
          minSize="35"
          id="share-content"
        >
          {mainContent}
        </ResizablePanel>
        {showDockedPanel && (
          <ResizableHandleAlt withHandle className="bg-border-medium text-text-primary" />
        )}
        {showDockedPanel && (
          <ResizablePanel
            defaultSize={`${normalizedArtifactSize}`}
            minSize="20"
            maxSize="60"
            id="share-artifacts"
          >
            {pane}
          </ResizablePanel>
        )}
      </ResizablePanelGroup>
      {pane != null && isUndocked && <UndockedArtifacts>{pane}</UndockedArtifacts>}
      {pane != null && !isUndocked && isSmallScreen && overlay}
    </EditorProvider>
  );
}

interface ShareArtifactsPanelProps {
  contextValue: ArtifactsContextValue;
}

/**
 * Panel that renders the artifacts UI within a resizable container
 */
function ShareArtifactsPanel({ contextValue }: ShareArtifactsPanelProps) {
  return (
    <ArtifactsProvider value={contextValue}>
      <div className="flex h-full w-full border-l border-border-light bg-surface-primary shadow-2xl">
        <Suspense fallback={null}>
          <Artifacts />
        </Suspense>
      </div>
    </ArtifactsProvider>
  );
}

/**
 * Mobile overlay that displays artifacts in a fixed position
 */
function ShareArtifactsOverlay({ contextValue }: ShareArtifactsPanelProps) {
  return (
    <div
      className="fixed inset-y-0 right-0 z-40 flex w-full max-w-full sm:max-w-[420px]"
      role="complementary"
      aria-label="Artifacts panel"
    >
      <ShareArtifactsPanel contextValue={contextValue} />
    </div>
  );
}
