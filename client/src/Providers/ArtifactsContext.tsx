import React, { createContext, useContext, useMemo } from 'react';
import { useRecoilValue } from 'recoil';
import { Constants } from 'librechat-data-provider';
import { useLatestMessage } from '~/hooks/Messages/useLatestMessage';
import { getLatestText } from '~/utils';
import store from '~/store';

export interface ArtifactsContextValue {
  isSubmitting: boolean;
  latestMessageId: string | null;
  latestMessageText: string;
  latestMessageError: boolean;
  conversationId: string | null;
  /** Whether this host offers opening the pane in its own window. The pane
   *  consumes the deployment's `interface.artifactUndocking` rather than
   *  reading config itself: the host already knows, and only the host knows
   *  whether a window it would have to render is available at all. */
  canUndock: boolean;
}

const ArtifactsContext = createContext<ArtifactsContextValue | undefined>(undefined);

interface ArtifactsProviderProps {
  children: React.ReactNode;
  /* The capability has no safe default, so the host has to answer it: a
   * provider that guessed would either offer a window the deployment forbids
   * or hide a control it allows. Everything else here has a chat-shaped
   * fallback the host can leave alone. */
  value: Partial<Omit<ArtifactsContextValue, 'canUndock'>> &
    Pick<ArtifactsContextValue, 'canUndock'>;
}

export function ArtifactsProvider({ children, value }: ArtifactsProviderProps) {
  const isSubmitting = useRecoilValue(store.isSubmittingFamily(0));
  const latestMessage = useLatestMessage(0);
  const conversationId = useRecoilValue(store.conversationIdByIndex(0));

  const chatLatestMessageText = useMemo(() => {
    return getLatestText(latestMessage);
  }, [latestMessage]);

  /**
   * A tool-call-limit pause also sets `unfinished: true` even though nothing
   * failed or was cancelled — its distinct `finish_reason` is what excludes
   * it here, so a paused-but-valid generation still registers its artifacts.
   */
  const latestMessageError =
    latestMessage?.error === true ||
    (latestMessage?.unfinished === true &&
      latestMessage.finish_reason !== Constants.TOOL_CALL_LIMIT_FINISH_REASON);

  const defaultContextValue = useMemo<Omit<ArtifactsContextValue, 'canUndock'>>(
    () => ({
      isSubmitting,
      conversationId: conversationId ?? null,
      latestMessageText: chatLatestMessageText,
      latestMessageId: latestMessage?.messageId ?? null,
      latestMessageError,
    }),
    [
      isSubmitting,
      chatLatestMessageText,
      latestMessage?.messageId,
      latestMessageError,
      conversationId,
    ],
  );

  const contextValue = useMemo<ArtifactsContextValue>(
    () => ({ ...defaultContextValue, ...value }),
    [defaultContextValue, value],
  );

  return <ArtifactsContext.Provider value={contextValue}>{children}</ArtifactsContext.Provider>;
}

export function useArtifactsContext() {
  const context = useContext(ArtifactsContext);
  if (!context) {
    throw new Error('useArtifactsContext must be used within ArtifactsProvider');
  }
  return context;
}
