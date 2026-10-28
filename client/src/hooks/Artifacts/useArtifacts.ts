import { useMemo, useEffect, useRef } from 'react';
import { useAtom, useSetAtom } from 'jotai';
import { Constants } from 'librechat-data-provider';
import { useRecoilCallback, useRecoilState, useRecoilValue, useResetRecoilState } from 'recoil';
import {
  artifactsActiveTab,
  artifactsOpenedArtifactId,
  artifactsPaneFocusRequest,
} from '~/components/Artifacts/state';
import { useCodeState } from '~/Providers/EditorContext';
import { isCodeOnlyArtifact } from '~/utils/artifacts';
import { useArtifactsContext } from '~/Providers';
import { logger } from '~/utils';
import store from '~/store';

type ArtifactFence = {
  marker: string;
  length: number;
  contentStart: number;
};

const getLineEnd = (text: string, start: number): number => {
  const index = text.indexOf('\n', start);
  return index === -1 ? text.length : index;
};

const getNextLineStart = (text: string, lineEnd: number): number =>
  lineEnd >= text.length ? text.length : lineEnd + 1;

const getFirstContentLineStart = (text: string, start: number): number => {
  let currentIndex = start;

  while (currentIndex < text.length) {
    const lineEnd = getLineEnd(text, currentIndex);
    const line = text.slice(currentIndex, lineEnd);
    if (line.trim().length > 0) {
      return currentIndex;
    }
    currentIndex = getNextLineStart(text, lineEnd);
  }

  return text.length;
};

const getArtifactFence = (text: string, lineStart: number): ArtifactFence | null => {
  const lineEnd = getLineEnd(text, lineStart);
  const line = text.slice(lineStart, lineEnd);
  const match = line.trimStart().match(/^(`{3,}|~{3,})/);

  if (!match) {
    return null;
  }

  return {
    marker: match[1][0],
    length: match[1].length,
    contentStart: getNextLineStart(text, lineEnd),
  };
};

const isClosingArtifactFence = (line: string, openingFence: ArtifactFence): boolean => {
  const trimmed = line.trim();
  if (trimmed.length < openingFence.length) {
    return false;
  }
  for (const char of trimmed) {
    if (char !== openingFence.marker) {
      return false;
    }
  }
  return true;
};

const isArtifactCloseLine = (line: string): boolean => {
  const trimmed = line.trimStart();
  return trimmed.startsWith(':::') && !trimmed.startsWith(':::artifact');
};

const hasArtifactCloseAfter = (text: string, start: number): boolean => {
  const closeStart = getFirstContentLineStart(text, start);
  if (closeStart >= text.length) {
    return false;
  }

  const closeLineEnd = getLineEnd(text, closeStart);
  return isArtifactCloseLine(text.slice(closeStart, closeLineEnd));
};

const hasUnfencedArtifactClose = (text: string, start: number): boolean => {
  let currentIndex = start;
  let codeFence: ArtifactFence | null = null;

  while (currentIndex < text.length) {
    const lineEnd = getLineEnd(text, currentIndex);
    const line = text.slice(currentIndex, lineEnd);
    const fence = getArtifactFence(text, currentIndex);

    if (isArtifactCloseLine(line) && !codeFence) {
      return true;
    }

    if (fence && !codeFence) {
      codeFence = fence;
    } else if (codeFence && isClosingArtifactFence(line, codeFence)) {
      codeFence = null;
    }

    currentIndex = getNextLineStart(text, lineEnd);
  }

  return false;
};

const hasEnclosedArtifact = (messageText: string): boolean => {
  if (!messageText.includes(':::artifact')) {
    return false;
  }
  const text = messageText.trim();
  const artifactPattern = /:::artifact(?:\{[^}]*\})?/g;
  let artifactMatch = artifactPattern.exec(text);

  while (artifactMatch) {
    const openingLineEnd = getLineEnd(text, artifactMatch.index);
    const contentStart = getFirstContentLineStart(text, getNextLineStart(text, openingLineEnd));
    const openingFence = getArtifactFence(text, contentStart);

    if (!openingFence) {
      if (hasUnfencedArtifactClose(text, contentStart)) {
        return true;
      }
      artifactMatch = artifactPattern.exec(text);
      continue;
    }

    let currentIndex = openingFence.contentStart;
    while (currentIndex < text.length) {
      const lineEnd = getLineEnd(text, currentIndex);
      const line = text.slice(currentIndex, lineEnd);

      if (isClosingArtifactFence(line, openingFence)) {
        if (hasArtifactCloseAfter(text, getNextLineStart(text, lineEnd))) {
          return true;
        }
        break;
      }

      currentIndex = getNextLineStart(text, lineEnd);
    }

    artifactMatch = artifactPattern.exec(text);
  }

  return false;
};

export default function useArtifacts() {
  /* Pane state, not instance state: the pane is remounted when it changes
   * hosts, and the tab the user was on has to come with it. */
  const [activeTab, setActiveTab] = useAtom(artifactsActiveTab);
  const setPaneFocusRequest = useSetAtom(artifactsPaneFocusRequest);
  const setOpenedArtifactId = useSetAtom(artifactsOpenedArtifactId);
  const { endCodeSession } = useCodeState();
  const { isSubmitting, latestMessageId, latestMessageText, conversationId } =
    useArtifactsContext();

  const artifacts = useRecoilValue(store.artifactsState);
  const resetArtifacts = useResetRecoilState(store.artifactsState);
  const resetCurrentArtifactId = useResetRecoilState(store.currentArtifactId);
  const [currentArtifactId, setCurrentArtifactId] = useRecoilState(store.currentArtifactId);

  const { orderedArtifactIds, latestAutoOpenArtifactId } = useMemo(() => {
    const ids = Object.keys(artifacts ?? {}).sort(
      (a, b) => (artifacts?.[a]?.lastUpdateTime ?? 0) - (artifacts?.[b]?.lastUpdateTime ?? 0),
    );
    for (let i = ids.length - 1; i >= 0; i--) {
      const id = ids[i];
      if (!isCodeOnlyArtifact(artifacts?.[id]?.type)) {
        return { orderedArtifactIds: ids, latestAutoOpenArtifactId: id };
      }
    }
    return { orderedArtifactIds: ids, latestAutoOpenArtifactId: null };
  }, [artifacts]);

  const prevIsSubmittingRef = useRef<boolean>(false);
  const lastContentRef = useRef<string | null>(null);
  const hasEnclosedArtifactRef = useRef<boolean>(false);
  const hasAutoSwitchedToCodeRef = useRef<boolean>(false);
  const lastRunMessageIdRef = useRef<string | null>(null);
  const prevConversationIdRef = useRef<string | null>(null);

  /**
   * Whether the pane is closing for good rather than moving. The pane changes
   * hosts — side panel, mobile sheet, undocked window — by unmounting one
   * instance and mounting another, and clearing the registry on that unmount
   * would close the pane the user was moving. Closing clears visibility and
   * the focused id first, so a fresh snapshot distinguishes the two; the
   * component's own render props cannot, because the parent stops rendering
   * it before it sees the new values.
   */
  const isPaneClosed = useRecoilCallback(
    ({ snapshot }) =>
      () =>
        snapshot.getLoadable(store.artifactsVisibility).valueMaybe() !== true ||
        snapshot.getLoadable(store.currentArtifactId).valueMaybe() == null,
    [],
  );

  useEffect(() => {
    const resetState = () => {
      resetArtifacts();
      resetCurrentArtifactId();
      /* The tab and the editor buffer outlive a host move but not the session:
       * the next artifact opens on the default view, with its own text, as it
       * did when both lived in the pane instance. Ending the code session also
       * tells a save still in flight that its callbacks have nothing to
       * restore here. */
      setActiveTab('preview');
      setOpenedArtifactId(null);
      endCodeSession();
      setPaneFocusRequest(false);
      prevConversationIdRef.current = conversationId;
      lastRunMessageIdRef.current = null;
      lastContentRef.current = null;
      hasEnclosedArtifactRef.current = false;
      hasAutoSwitchedToCodeRef.current = false;
    };
    if (conversationId !== prevConversationIdRef.current && prevConversationIdRef.current != null) {
      resetState();
    } else if (conversationId === Constants.NEW_CONVO) {
      resetState();
    }
    prevConversationIdRef.current = conversationId;
    /** Resets artifacts when the pane closes */
    return () => {
      if (!isPaneClosed()) {
        return;
      }
      logger.log('artifacts_visibility', 'Unmounting artifacts');
      resetState();
    };
  }, [
    conversationId,
    isPaneClosed,
    resetArtifacts,
    resetCurrentArtifactId,
    setActiveTab,
    endCodeSession,
    setPaneFocusRequest,
    setOpenedArtifactId,
  ]);

  /**
   * Read currentArtifactId in effects without subscribing as a dependency.
   * Adding it to effect deps fires auto-select on every reset, breaking toggle-close.
   */
  const currentArtifactIdRef = useRef(currentArtifactId);
  currentArtifactIdRef.current = currentArtifactId;

  useEffect(() => {
    if (orderedArtifactIds.length === 0) return;
    const currentId = currentArtifactIdRef.current;
    if (currentId != null && orderedArtifactIds.includes(currentId)) return;
    if (latestAutoOpenArtifactId == null) {
      if (currentId != null) {
        resetCurrentArtifactId();
      }
      return;
    }
    setCurrentArtifactId(latestAutoOpenArtifactId);
  }, [latestAutoOpenArtifactId, orderedArtifactIds, resetCurrentArtifactId, setCurrentArtifactId]);

  /**
   * Manage artifact selection and code tab switching for non-enclosed artifacts
   * Runs when artifact content changes
   */
  useEffect(() => {
    // Check if we just finished submitting (transition from true to false)
    const justFinishedSubmitting = prevIsSubmittingRef.current && !isSubmitting;
    prevIsSubmittingRef.current = isSubmitting;

    // Only process during submission OR when just finished
    if (!isSubmitting && !justFinishedSubmitting) {
      return;
    }
    if (orderedArtifactIds.length === 0) {
      return;
    }
    if (latestMessageId == null) {
      return;
    }
    const latestArtifactId = orderedArtifactIds[orderedArtifactIds.length - 1];
    const latestArtifact = artifacts?.[latestArtifactId];
    if (latestArtifact?.messageId !== latestMessageId) {
      return;
    }
    if (latestArtifact.content === lastContentRef.current && !justFinishedSubmitting) {
      return;
    }
    lastContentRef.current = latestArtifact?.content ?? null;
    if (isCodeOnlyArtifact(latestArtifact?.type)) {
      return;
    }

    setCurrentArtifactId(latestArtifactId);

    // Only switch to code tab if we haven't detected an enclosed artifact yet
    if (!hasEnclosedArtifactRef.current && !hasAutoSwitchedToCodeRef.current) {
      const artifactStartContent = latestArtifact?.content?.slice(0, 50) ?? '';
      if (artifactStartContent.length > 0 && latestMessageText.includes(artifactStartContent)) {
        setActiveTab('code');
        hasAutoSwitchedToCodeRef.current = true;
      }
    }
  }, [
    artifacts,
    isSubmitting,
    latestMessageId,
    latestMessageText,
    orderedArtifactIds,
    setActiveTab,
    setCurrentArtifactId,
  ]);

  /**
   * Watch for enclosed artifact pattern during message generation
   * Optimized: Exits early if already detected, only checks during streaming
   */
  useEffect(() => {
    if (!isSubmitting || hasEnclosedArtifactRef.current) {
      return;
    }

    if (hasEnclosedArtifact(latestMessageText)) {
      logger.log('artifacts', 'Enclosed artifact detected during generation, switching to preview');
      setActiveTab('preview');
      hasEnclosedArtifactRef.current = true;
      hasAutoSwitchedToCodeRef.current = false;
    }
  }, [isSubmitting, latestMessageText, setActiveTab]);

  useEffect(() => {
    if (latestMessageId !== lastRunMessageIdRef.current) {
      lastRunMessageIdRef.current = latestMessageId;
      hasEnclosedArtifactRef.current = false;
      hasAutoSwitchedToCodeRef.current = false;
    }
  }, [latestMessageId]);

  const currentArtifact = currentArtifactId != null ? artifacts?.[currentArtifactId] : null;

  const currentIndex = orderedArtifactIds.indexOf(currentArtifactId ?? '');

  return {
    activeTab,
    setActiveTab,
    currentIndex,
    currentArtifact,
    orderedArtifactIds,
    setCurrentArtifactId,
  };
}
