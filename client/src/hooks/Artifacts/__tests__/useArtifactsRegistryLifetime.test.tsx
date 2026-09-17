import React, { useState } from 'react';
import { getDefaultStore } from 'jotai';
import { act, render } from '@testing-library/react';
import { RecoilRoot, useRecoilCallback } from 'recoil';
import type { TConversation } from 'librechat-data-provider';
import type { MutableSnapshot } from 'recoil';
import type { Artifact } from '~/common';
import { artifactsActiveTab, artifactsOpenedArtifactId } from '~/components/Artifacts/state';
import useArtifactsRegistryLifetime from '../useArtifactsRegistryLifetime';
import store from '~/store';

const buildArtifact = (id: string): Artifact => ({
  id,
  title: id,
  type: 'text/html',
  content: '<h1>x</h1>',
  messageId: 'msg-1',
  lastUpdateTime: 1,
});

const buildConversation = (conversationId: string | null): TConversation =>
  ({ conversationId }) as TConversation;

interface HarnessHandle {
  setConversation: (conversationId: string | null | undefined) => void;
  readArtifacts: () => Record<string, Artifact | undefined> | null;
  readCurrentId: () => string | null;
  readActiveTab: () => string;
  readOpenedArtifactId: () => string | null;
}

const Harness = ({
  handleRef,
  initialConversationId,
}: {
  handleRef: React.MutableRefObject<HarnessHandle | null>;
  initialConversationId: string | null | undefined;
}) => {
  const [conversationId, setConversationId] = useState<string | null | undefined>(
    initialConversationId,
  );
  useArtifactsRegistryLifetime(conversationId);
  const readArtifacts = useRecoilCallback(
    ({ snapshot }) =>
      () =>
        snapshot.getLoadable(store.artifactsState).getValue(),
    [],
  );
  const readCurrentId = useRecoilCallback(
    ({ snapshot }) =>
      () =>
        snapshot.getLoadable(store.currentArtifactId).getValue(),
    [],
  );

  if (handleRef.current == null) {
    handleRef.current = {
      setConversation: setConversationId,
      readArtifacts,
      readCurrentId,
      readActiveTab: () => getDefaultStore().get(artifactsActiveTab),
      readOpenedArtifactId: () => getDefaultStore().get(artifactsOpenedArtifactId),
    };
  }
  return null;
};

const renderHarness = (initial: {
  conversationId: string | null | undefined;
  artifacts: Record<string, Artifact>;
  currentId: string | null;
}) => {
  const initializeState = (snapshot: MutableSnapshot) => {
    snapshot.set(store.conversationByIndex(0), buildConversation(initial.conversationId ?? null));
    snapshot.set(store.artifactsState, initial.artifacts);
    snapshot.set(store.currentArtifactId, initial.currentId);
  };
  const handleRef: React.MutableRefObject<HarnessHandle | null> = { current: null };
  render(
    <RecoilRoot initializeState={initializeState}>
      <Harness handleRef={handleRef} initialConversationId={initial.conversationId} />
    </RecoilRoot>,
  );
  if (!handleRef.current) {
    throw new Error('Harness did not attach handle');
  }
  return handleRef.current;
};

describe('useArtifactsRegistryLifetime', () => {
  it('does not reset on first render (no previous conversation to compare against)', () => {
    const handle = renderHarness({
      conversationId: 'conv-A',
      artifacts: { 'art-1': buildArtifact('art-1') },
      currentId: 'art-1',
    });
    expect(handle.readArtifacts()).toEqual({ 'art-1': buildArtifact('art-1') });
    expect(handle.readCurrentId()).toBe('art-1');
  });

  it('preserves artifacts when the conversation id stays the same', () => {
    const handle = renderHarness({
      conversationId: 'conv-A',
      artifacts: { 'art-1': buildArtifact('art-1') },
      currentId: 'art-1',
    });
    act(() => handle.setConversation('conv-A'));
    expect(handle.readArtifacts()).toEqual({ 'art-1': buildArtifact('art-1') });
    expect(handle.readCurrentId()).toBe('art-1');
  });

  /* The leak this guard exists for: the panel was closed in one conversation,
   * a ToolArtifactCard's self-heal effect re-registered its entry while
   * `artifactsVisibility` stayed false, and the user moved on. Without the
   * wipe the next panel open — in the next chat or the next shared link —
   * would list the previous conversation's artifacts, and the pane would open
   * on the tab and artifact the reader left behind. */
  it('wipes all registry and pane session state when the passed identity changes', () => {
    const jotaiStore = getDefaultStore();
    jotaiStore.set(artifactsActiveTab, 'code');
    jotaiStore.set(artifactsOpenedArtifactId, 'leftover-from-A');
    const handle = renderHarness({
      conversationId: 'shared-A',
      artifacts: { 'leftover-from-A': buildArtifact('leftover-from-A') },
      currentId: 'leftover-from-A',
    });

    act(() => handle.setConversation('shared-B'));

    expect(handle.readArtifacts()).toBeNull();
    expect(handle.readCurrentId()).toBeNull();
    expect(handle.readActiveTab()).toBe('preview');
    expect(handle.readOpenedArtifactId()).toBeNull();
  });

  it('keeps the registry through an absent id while shared data is loading', () => {
    const handle = renderHarness({
      conversationId: undefined,
      artifacts: { 'art-1': buildArtifact('art-1') },
      currentId: 'art-1',
    });

    act(() => handle.setConversation('shared-A'));

    expect(handle.readArtifacts()).toEqual({ 'art-1': buildArtifact('art-1') });
    expect(handle.readCurrentId()).toBe('art-1');
  });

  it('treats an initial null → defined transition as a first observation, not a switch', () => {
    // Initial conversation can flicker through `null` while a fresh chat
    // is still loading. Treating that null as a "previous" id would
    // wipe the very first artifacts that arrive.
    const handle = renderHarness({
      conversationId: null,
      artifacts: {},
      currentId: null,
    });
    act(() => handle.setConversation('conv-A'));
    expect(handle.readArtifacts()).toEqual({});
  });

  /* The pane's own cleanup keeps the registry while it only changes hosts, so
   * the host leaving the route is what has to clear it — otherwise the next
   * route (a shared conversation, say) opens showing this chat's artifact. */
  it('wipes the registry when the host unmounts', () => {
    const handleRef: React.MutableRefObject<HarnessHandle | null> = { current: null };
    const Host = () => {
      useArtifactsRegistryLifetime('conv-A');
      return null;
    };
    const App = ({ hostMounted }: { hostMounted: boolean }) => (
      <RecoilRoot
        initializeState={(snapshot: MutableSnapshot) => {
          snapshot.set(store.conversationByIndex(0), buildConversation('conv-A'));
          snapshot.set(store.artifactsState, { 'art-1': buildArtifact('art-1') });
          snapshot.set(store.currentArtifactId, 'art-1');
        }}
      >
        <Harness handleRef={handleRef} initialConversationId="conv-A" />
        {hostMounted && <Host />}
      </RecoilRoot>
    );

    const { rerender } = render(<App hostMounted={true} />);
    const handle = handleRef.current;
    if (!handle) {
      throw new Error('Harness did not attach handle');
    }
    expect(handle.readArtifacts()).toEqual({ 'art-1': buildArtifact('art-1') });

    rerender(<App hostMounted={false} />);

    expect(handle.readArtifacts()).toBeNull();
    expect(handle.readCurrentId()).toBeNull();
  });
});
