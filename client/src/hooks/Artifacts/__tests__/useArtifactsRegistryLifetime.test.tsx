import React from 'react';
import { act, render } from '@testing-library/react';
import { RecoilRoot, useRecoilCallback, useSetRecoilState } from 'recoil';
import type { TConversation } from 'librechat-data-provider';
import type { MutableSnapshot } from 'recoil';
import type { Artifact } from '~/common';
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
  setConversation: (conversationId: string | null) => void;
  readArtifacts: () => Record<string, Artifact | undefined> | null;
  readCurrentId: () => string | null;
}

const Harness = ({ handleRef }: { handleRef: React.MutableRefObject<HarnessHandle | null> }) => {
  useArtifactsRegistryLifetime();
  const setConvo = useSetRecoilState(store.conversationByIndex(0));
  // useRecoilCallback's snapshot is read fresh at call time, so the test
  // sees the latest committed atom values rather than a stale render-time
  // closure.
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
      setConversation: (conversationId) => setConvo(buildConversation(conversationId)),
      readArtifacts,
      readCurrentId,
    };
  }
  return null;
};

const renderHarness = (initial: {
  conversationId: string | null;
  artifacts: Record<string, Artifact>;
  currentId: string | null;
}) => {
  const initializeState = (snapshot: MutableSnapshot) => {
    snapshot.set(store.conversationByIndex(0), buildConversation(initial.conversationId));
    snapshot.set(store.artifactsState, initial.artifacts);
    snapshot.set(store.currentArtifactId, initial.currentId);
  };
  const handleRef: React.MutableRefObject<HarnessHandle | null> = { current: null };
  render(
    <RecoilRoot initializeState={initializeState}>
      <Harness handleRef={handleRef} />
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

  it('wipes artifactsState and currentArtifactId when the conversation id changes', () => {
    // Reproduces the codex-flagged leak: panel was closed in conv-A, the
    // ToolArtifactCard's self-heal effect re-registered while
    // artifactsVisibility stayed false, and then the user switched to
    // conv-B. Without this hook the next panel open in conv-B would show
    // conv-A's artifacts in the version list.
    const handle = renderHarness({
      conversationId: 'conv-A',
      artifacts: { 'leftover-from-A': buildArtifact('leftover-from-A') },
      currentId: 'leftover-from-A',
    });
    act(() => handle.setConversation('conv-B'));
    expect(handle.readArtifacts()).toBeNull();
    expect(handle.readCurrentId()).toBeNull();
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
      useArtifactsRegistryLifetime();
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
        <Harness handleRef={handleRef} />
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
