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
  runId?: string | null;
};

const NEW = String(Constants.NEW_CONVO);

const mount = (initial: Pane) => {
  const jotai = createStore();
  const view = renderHook(
    ({ conversationId, isSubmitting, latestMessageId, runId = null }: Pane) =>
      useArtifactsLiveReply(conversationId, isSubmitting, latestMessageId, runId),
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

  it("follows a new chat's reply once `created` confirms the id it moved to", () => {
    const pane = mount({ conversationId: NEW, isSubmitting: true, latestMessageId: 'prompt_' });
    /* The start response re-keys the turn under its saved id before `created` arrives. */
    pane.rerender({ conversationId: 'saved', isSubmitting: true, latestMessageId: 'answer' });
    expect(pane.reply()).toEqual({ run: 1, messageId: 'prompt_' });

    pane.rerender({
      conversationId: 'saved',
      isSubmitting: true,
      latestMessageId: 'answer',
      runId: 'run-1',
    });
    expect(pane.reply()).toEqual({ run: 1, messageId: 'answer' });
  });

  it("follows a new chat's reply saved after `created` renewed the pane's run", () => {
    const pane = mount({ conversationId: NEW, isSubmitting: true, latestMessageId: 'prompt_' });
    pane.rerender({
      conversationId: NEW,
      isSubmitting: true,
      latestMessageId: 'placeholder_',
      runId: 'run-1',
    });
    pane.rerender({
      conversationId: 'saved',
      isSubmitting: true,
      latestMessageId: 'answer',
      runId: 'run-1',
    });
    expect(pane.reply()).toEqual({ run: 1, messageId: 'answer' });
  });

  it("keeps a new chat's reply that was already the tail when its run saved it", () => {
    const pane = mount({ conversationId: NEW, isSubmitting: true, latestMessageId: 'answer' });
    pane.rerender({ conversationId: 'saved', isSubmitting: true, latestMessageId: 'answer' });
    expect(pane.reply()).toEqual({ run: 1, messageId: 'answer' });

    pane.rerender({
      conversationId: 'saved',
      isSubmitting: false,
      latestMessageId: 'answer',
      runId: 'run-1',
    });
    expect(pane.reply()).toEqual({ run: 1, messageId: 'answer' });
  });

  it("records a new chat's reply that arrives whole with the render that saves it", () => {
    const pane = mount({ conversationId: NEW, isSubmitting: true, latestMessageId: 'prompt_' });
    pane.rerender({
      conversationId: 'saved',
      isSubmitting: false,
      latestMessageId: 'answer',
      runId: 'run-1',
    });
    expect(pane.reply()).toEqual({ run: 1, messageId: 'answer' });
  });

  it('writes nothing for a conversation the pane moves to from a generating new chat', () => {
    const pane = mount({ conversationId: NEW, isSubmitting: true, latestMessageId: 'prompt_' });
    pane.rerender({ conversationId: 'other', isSubmitting: true, latestMessageId: 'other-tail' });
    expect(pane.reply()).toEqual({ run: 1, messageId: 'prompt_' });

    /* The stream cleanup ends the submission before any `created`: the pane left the run. */
    pane.rerender({ conversationId: 'other', isSubmitting: false, latestMessageId: 'other-tail' });
    expect(pane.reply()).toEqual({ run: 1, messageId: null });

    pane.rerender({ conversationId: 'other', isSubmitting: true, latestMessageId: 'other-next' });
    expect(pane.reply()).toEqual({ run: 2, messageId: 'other-next' });
  });

  it('writes nothing for the conversation the pane moves to while a run streams', () => {
    const pane = mount({ conversationId: 'a', isSubmitting: true, latestMessageId: 'a-reply' });
    pane.rerender({ conversationId: 'b', isSubmitting: true, latestMessageId: 'b-tail' });
    expect(pane.reply()).toEqual({ run: 1, messageId: null });

    /* Leaving the run behind stops following it, which is not the run ending. */
    pane.rerender({ conversationId: 'b', isSubmitting: false, latestMessageId: 'b-tail' });
    expect(pane.reply()).toEqual({ run: 1, messageId: null });

    pane.rerender({ conversationId: 'a', isSubmitting: true, latestMessageId: 'a-reply' });
    expect(pane.reply()).toEqual({ run: 2, messageId: 'a-reply' });
  });

  it('drops the reply when the chat it was recorded for is left', () => {
    const pane = mount({ conversationId: 'a', isSubmitting: true, latestMessageId: 'a-reply' });
    pane.unmount();
    expect(pane.reply()).toEqual({ run: 1, messageId: null });
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
