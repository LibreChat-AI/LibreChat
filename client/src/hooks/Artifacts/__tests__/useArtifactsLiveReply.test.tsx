import React from 'react';
import { renderHook } from '@testing-library/react';
import { Constants } from 'librechat-data-provider';
import { createStore, Provider as JotaiProvider } from 'jotai';
import { artifactsLiveReply } from '~/components/Artifacts/state';
import useArtifactsLiveReply from '../useArtifactsLiveReply';

type Pane = {
  conversationId: string | null;
  isSubmitting: boolean;
  latestMessageId: string | null;
};

const mount = (initial: Pane) => {
  const jotai = createStore();
  const view = renderHook(
    ({ conversationId, isSubmitting, latestMessageId }: Pane) =>
      useArtifactsLiveReply(conversationId, isSubmitting, latestMessageId),
    {
      initialProps: initial,
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <JotaiProvider store={jotai}>{children}</JotaiProvider>
      ),
    },
  );
  return { ...view, reply: () => jotai.get(artifactsLiveReply) };
};

describe('useArtifactsLiveReply', () => {
  it('follows the reply while it generates and keeps it once the run ends', () => {
    const pane = mount({ conversationId: 'convo', isSubmitting: true, latestMessageId: 'prompt' });
    expect(pane.reply()).toBe('prompt');

    pane.rerender({ conversationId: 'convo', isSubmitting: true, latestMessageId: 'answer' });
    expect(pane.reply()).toBe('answer');

    pane.rerender({ conversationId: 'convo', isSubmitting: false, latestMessageId: 'answer' });
    expect(pane.reply()).toBe('answer');
  });

  it('records nothing for a conversation loaded while idle', () => {
    const pane = mount({ conversationId: 'convo', isSubmitting: false, latestMessageId: 'saved' });
    expect(pane.reply()).toBeNull();
  });

  it('keeps the reply when a new chat takes its saved id', () => {
    const pane = mount({
      conversationId: String(Constants.NEW_CONVO),
      isSubmitting: true,
      latestMessageId: 'answer',
    });
    pane.rerender({
      conversationId: 'saved-convo',
      isSubmitting: false,
      latestMessageId: 'answer',
    });
    expect(pane.reply()).toBe('answer');
  });

  it('drops the reply when the pane moves to another conversation', () => {
    const pane = mount({ conversationId: 'convo', isSubmitting: true, latestMessageId: 'answer' });
    pane.rerender({ conversationId: 'convo', isSubmitting: false, latestMessageId: 'answer' });
    pane.rerender({ conversationId: 'other', isSubmitting: false, latestMessageId: 'old' });
    expect(pane.reply()).toBeNull();

    pane.rerender({ conversationId: 'convo', isSubmitting: false, latestMessageId: 'answer' });
    expect(pane.reply()).toBeNull();
  });
});
