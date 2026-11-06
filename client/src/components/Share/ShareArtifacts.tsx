import { Suspense, useState, useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { useRecoilValue } from 'recoil';
import { ResizablePanel, ResizableHandleAlt, ResizablePanelGroup } from '@librechat/client';
import type { TMessage } from 'librechat-data-provider';
import type { ArtifactsContextValue } from '~/Providers';
import useArtifactsRegistryLifetime from '~/hooks/Artifacts/useArtifactsRegistryLifetime';
import UndockedArtifacts from '~/components/Artifacts/UndockedArtifacts';
import { artifactsUndocked } from '~/components/Artifacts/state';
import { ArtifactsProvider, EditorProvider } from '~/Providers';
import { ARTIFACTS_SHEET_MAX_WIDTH } from '~/utils/breakpoints';
import useDocumentDirection from '~/hooks/useDocumentDirection';
import { useGetSharedStartupConfig } from '~/data-provider';
import useScaledMaxWidth from '~/hooks/useScaledMaxWidth';
import { isCodeOnlyArtifact } from '~/utils/artifacts';
import { lazyWithRecovery } from '~/lib/assets/lazy';
import { useShareContext } from '~/Providers';
import { getLatestText } from '~/utils';
import store from '~/store';

const Artifacts = lazyWithRecovery(() => import('~/components/Artifacts/Artifacts'));

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
  conversationId: string | null | undefined;
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
  const isSmallScreen = useScaledMaxWidth(ARTIFACTS_SHEET_MAX_WIDTH);
  const isUndocked = useAtomValue(artifactsUndocked);
  const [artifactPanelSize, setArtifactPanelSize] = useState(getInitialArtifactPanelSize);
  /* This is the shared conversation's identity, not the chat tab's Recoil
   * slot. It may be absent while shared data loads; the lifetime hook keeps
   * the last real identity through that loading transition. */
  useArtifactsRegistryLifetime(conversationId);

  const { shareId } = useShareContext();
  const { data: sharedStartupConfig, isSuccess: hasSharedConfig } = useGetSharedStartupConfig(
    shareId,
    {
      enabled: typeof shareId === 'string' && shareId !== '',
    },
  );
  /* An absent field reads as enabled, which is the default and today's pane,
   * but only once the config has answered: offering the control while the
   * request is still in flight would let a viewer undock a pane the
   * deployment forbids, and the answer would then strand it. */
  const canUndock = hasSharedConfig && sharedStartupConfig?.interface?.artifactUndocking !== false;

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
  const direction = useDocumentDirection();
  const reversed = direction === 'rtl';

  /* react-resizable-panels reads drag deltas physically, so under RTL the group
   * stays LTR and the panels render in reverse, each restoring the document
   * direction for its content. Keys keep both panels mounted across the swap. */
  const panels = [
    <ResizablePanel
      key="content"
      defaultSize={`${showDockedPanel ? 100 - normalizedArtifactSize : 100}`}
      minSize="35"
      id="share-content"
      {...(reversed ? { dir: direction } : {})}
    >
      {mainContent}
    </ResizablePanel>,
    /* The separator binds to its neighbours when it mounts, so it remounts with the order. */
    showDockedPanel && (
      <ResizableHandleAlt key={`handle-${direction}`} withHandle className="text-text-primary" />
    ),
    showDockedPanel && (
      <ResizablePanel
        key="artifacts"
        defaultSize={`${normalizedArtifactSize}`}
        minSize="20"
        maxSize="60"
        id="share-artifacts"
        {...(reversed ? { dir: direction } : {})}
      >
        {pane}
      </ResizablePanel>
    ),
  ];

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
        {...(reversed ? { dir: 'ltr' } : {})}
      >
        {reversed ? panels.reverse() : panels}
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
      <div className="border-border-light bg-surface-primary flex h-full w-full border-s shadow-2xl">
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
      className="fixed inset-y-0 inset-e-0 z-40 flex w-full max-w-full sm:max-w-[26.25rem]"
      role="complementary"
      aria-label="Artifacts panel"
    >
      <ShareArtifactsPanel contextValue={contextValue} />
    </div>
  );
}
