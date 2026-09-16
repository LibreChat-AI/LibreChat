import React, { useState } from 'react';
import { RecoilRoot } from 'recoil';
import { getDefaultStore } from 'jotai';
import type { MutableSnapshot } from 'recoil';
import type { Artifact } from '~/common';
import { artifactsActiveTab, artifactsOpenedArtifactId } from '../state';
import { act, fireEvent, render, screen } from 'test/layout-test-utils';
import { ArtifactsProvider, EditorProvider } from '~/Providers';
import Artifacts from '../Artifacts';
import store from '~/store';

/**
 * The pane changes hosts — side panel, mobile sheet, undocked window — by
 * unmounting one instance and mounting another. Everything the user can see
 * about "where they were" therefore has to live outside the instance, and the
 * tab is the part they notice: arriving back on Preview reads as the code they
 * were editing having been thrown away.
 *
 * The other half of the rule — opening a *different* artifact does return to
 * the preview — is covered in `../Artifacts.test.tsx`, which mocks
 * `useArtifacts` and so can drive artifact changes without a live preview.
 */

const htmlArtifact: Artifact = {
  id: 'artifact-1',
  type: 'text/html',
  title: 'Preview',
  content: '<p>one</p>',
  lastUpdateTime: 0,
};

const MOVE_PANE = 'Move pane to another host';

const initializeArtifacts = ({ set }: MutableSnapshot) => {
  set(store.artifactsState, { [htmlArtifact.id]: htmlArtifact });
  set(store.currentArtifactId, htmlArtifact.id);
  set(store.queriesEnabled, false);
};

/**
 * Stands in for the two hosts. Changing the key unmounts the pane and mounts a
 * fresh instance in the same commit, which is what moving it between the side
 * panel and the undocked window does; the surrounding state stays put.
 */
function Hosts() {
  const [host, setHost] = useState('panel');

  return (
    <RecoilRoot initializeState={initializeArtifacts}>
      <EditorProvider>
        <ArtifactsProvider
          value={{
            isSubmitting: false,
            latestMessageId: null,
            latestMessageText: '',
            conversationId: 'conversation-1',
          }}
        >
          <button
            type="button"
            onClick={() => setHost((current) => (current === 'panel' ? 'window' : 'panel'))}
          >
            {MOVE_PANE}
          </button>
          <Artifacts key={host} />
        </ArtifactsProvider>
      </EditorProvider>
    </RecoilRoot>
  );
}

const codeTab = () => screen.getByRole('radio', { name: 'Code' });
/** Present on both tabs, unlike Refresh, which is a preview-only control. */
const paneReady = () => screen.findByRole('button', { name: 'Copy' });

describe('the artifacts pane tab across a host change', () => {
  beforeEach(() => {
    /* Desktop: the mobile sheet renders no tab control at all. */
    window.matchMedia = jest.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: jest.fn(),
      removeListener: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      dispatchEvent: jest.fn(),
    }));
    /* Pane state lives in a module-global store, so one test's tab would
     * otherwise be the next test's starting point. */
    getDefaultStore().set(artifactsActiveTab, 'preview');
    getDefaultStore().set(artifactsOpenedArtifactId, null);
  });

  it('keeps the tab the user chose when the pane moves host', async () => {
    render(<Hosts />);
    await paneReady();

    await act(async () => {
      fireEvent.click(codeTab());
    });
    expect(codeTab()).toHaveAttribute('aria-checked', 'true');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: MOVE_PANE }));
    });
    await paneReady();

    /* The new instance sees the artifact already on screen. Reading that as a
     * freshly opened artifact is what used to send the user back to Preview. */
    expect(codeTab()).toHaveAttribute('aria-checked', 'true');
  });
});
