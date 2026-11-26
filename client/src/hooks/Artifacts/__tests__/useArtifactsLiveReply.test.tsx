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
  it('numbers each run and follows its reply through it', () => {
    const pane = mount({ conversationId: 'convo', isSubmitting: true, latestMessageId: 'prompt' });
    expect(pane.reply()).toEqual({ run: 1, messageId: 'prompt' });

    pane.rerender({ conversationId: 'convo', isSubmitting: true, latestMessageId: 'answer' });
    expect(pane.reply()).toEqual({ run: 1, messageId: 'answer' });

    pane.rerender({ conversationId: 'convo', isSubmitting: false, latestMessageId: 'answer' });
    expect(pane.reply()).toEqual({ run: 1, messageId: 'answer' });

    pane.rerender({ conversationId: 'convo', isSubmitting: true, latestMessageId: 'next' });
    expect(pane.reply()).toEqual({ run: 2, messageId: 'next' });
  });

  it('records a reply that becomes the tail in the render that ends the run', () => {
    const pane = mount({ conversationId: 'convo', isSubmitting: true, latestMessageId: 'prompt' });
    pane.rerender({ conversationId: 'convo', isSubmitting: false, latestMessageId: 'answer' });
    expect(pane.reply()).toEqual({ run: 1, messageId: 'answer' });

    pane.rerender({ conversationId: 'convo', isSubmitting: false, latestMessageId: 'later' });
    expect(pane.reply()).toEqual({ run: 1, messageId: 'answer' });
  });

  it('records nothing for a conversation loaded while idle', () => {
    const pane = mount({ conversationId: 'convo', isSubmitting: false, latestMessageId: 'saved' });
    expect(pane.reply()).toEqual({ run: 0, messageId: null });
  });

  it('keeps the reply when a new chat takes its saved id', () => {
    const pane = mount({
      conversationId: String(Constants.NEW_CONVO),
      isSubmitting: true,
      latestMessageId: 'answer',
    });
    pane.rerender({ conversationId: 'saved-convo', isSubmitting: true, latestMessageId: 'answer' });
    expect(pane.reply()).toEqual({ run: 1, messageId: 'answer' });
  });

  it('drops the reply when the pane moves to another conversation', () => {
    const pane = mount({ conversationId: 'convo', isSubmitting: true, latestMessageId: 'answer' });
    pane.rerender({ conversationId: 'convo', isSubmitting: false, latestMessageId: 'answer' });
    pane.rerender({ conversationId: 'other', isSubmitting: false, latestMessageId: 'old' });
    expect(pane.reply()).toEqual({ run: 1, messageId: null });

    pane.rerender({ conversationId: 'convo', isSubmitting: false, latestMessageId: 'answer' });
    expect(pane.reply()).toEqual({ run: 1, messageId: null });
  });
});
