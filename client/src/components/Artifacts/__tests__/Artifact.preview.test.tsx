import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { RecoilRoot, useRecoilValue } from 'recoil';
import { act, render } from '@testing-library/react';
import { PartsPreviewContext } from '@librechat/chat/react';
import type { ReactNode } from 'react';
import { MessageContext, ArtifactProvider } from '~/Providers';
import { artifactsState } from '~/store/artifacts';
import { Artifact } from '../Artifact';

jest.mock('../ArtifactButton', () => ({
  __esModule: true,
  default: () => null,
}));

let registered: Record<string, unknown> | null | undefined;

function Registry(): null {
  registered = useRecoilValue(artifactsState) as Record<string, unknown> | null;
  return null;
}

const message = {
  messageId: 'message-1',
  conversationId: 'conversation-1',
  partIndex: 0,
  isExpanded: false,
  isSubmitting: false,
  isLatestMessage: false,
} as unknown as React.ContextType<typeof MessageContext>;

const page = (ui: ReactNode) => (
  <RecoilRoot>
    <MemoryRouter initialEntries={['/c/conversation-1']}>
      <MessageContext.Provider value={message}>
        <ArtifactProvider>
          <Registry />
          {ui}
        </ArtifactProvider>
      </MessageContext.Provider>
    </MemoryRouter>
  </RecoilRoot>
);

const artifact = (
  <Artifact id="" lastUpdateTime={0} identifier="chart" title="Chart" type="text/html" node={null}>
    {'<p>hello</p>'}
  </Artifact>
);

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });

describe('Artifact registration', () => {
  beforeEach(() => {
    registered = undefined;
  });

  it('registers an artifact a message row draws', async () => {
    render(page(artifact));
    await settle();

    expect(Object.keys(registered ?? {})).toEqual(['chart_text/html_chart_message-1']);
  });

  it('registers nothing for a picture of a row drawn elsewhere', async () => {
    render(
      page(<PartsPreviewContext.Provider value={true}>{artifact}</PartsPreviewContext.Provider>),
    );
    await settle();

    expect(Object.keys(registered ?? {})).toEqual([]);
  });
});
