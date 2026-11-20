import React from 'react';
import { getDefaultStore } from 'jotai';
import { RecoilRoot, useRecoilValue } from 'recoil';
import { Link, MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { isSubmittingFamily, resetSubmitting } from '@librechat/chat/react';
import { Constants, QueryKeys, ContentTypes } from 'librechat-data-provider';
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { TMessage, TConversation } from 'librechat-data-provider';
import { activeRunFamily } from '~/hooks/SSE/atoms';
import BrowserAudio from '../BrowserAudio';
import store from '~/store';

const conversationId = 'convo-1';
const voiceName = 'Test Voice';
const responseText = 'The capital of Germany is Berlin.';
const nextChatLabel = 'Next chat';

const spoken: string[] = [];
const speechEvents: string[] = [];
let cancelCount = 0;

class FakeSpeechSynthesisUtterance {
  public voice: SpeechSynthesisVoice | null = null;
  public onend: (() => void) | null = null;
  public onerror: ((event: { error: string }) => void) | null = null;
  constructor(public text: string) {}
}

const fakeVoice = { name: voiceName, localService: true } as SpeechSynthesisVoice;
let availableVoices = [fakeVoice];
let voicesChanged = () => {};

const speechSynthesis = {
  getVoices: () => availableVoices,
  addEventListener: (_event: string, listener: () => void) => {
    voicesChanged = listener;
  },
  speak: (utterance: FakeSpeechSynthesisUtterance) => {
    speechEvents.push('speak');
    spoken.push(utterance.text);
  },
  cancel: () => {
    speechEvents.push('cancel');
    cancelCount += 1;
  },
};

const assistantMessage = {
  messageId: 'assistant-1',
  conversationId,
  parentMessageId: Constants.NO_PARENT,
  isCreatedByUser: false,
  text: responseText,
} as TMessage;

function AudioRunProbe() {
  const audioRunId = useRecoilValue(store.audioRunFamily(0));
  return <output data-testid="played-run">{audioRunId ?? 'none'}</output>;
}

const renderBrowserAudio = ({
  activeRunId = 'run-1',
  audioRunId = null,
  isSubmitting = false,
  messages = [assistantMessage],
  initialPath = `/c/${conversationId}`,
  nextPath = '/c/other-chat',
}: {
  activeRunId?: string | null;
  audioRunId?: string | null;
  isSubmitting?: boolean;
  messages?: TMessage[];
  initialPath?: string;
  nextPath?: string;
} = {}) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData([QueryKeys.messages, conversationId], messages);

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <RecoilRoot
          initializeState={({ set }) => {
            set(store.voice, voiceName);
            set(store.conversationByIndex(0), { conversationId } as TConversation);
            getDefaultStore().set(activeRunFamily(0), activeRunId);
            set(store.audioRunFamily(0), audioRunId);
            getDefaultStore().set(isSubmittingFamily(0), isSubmitting);
          }}
        >
          <AudioRunProbe />
          <Link to={nextPath}>{nextChatLabel}</Link>
          <Routes>
            <Route path="/c/:conversationId" element={<BrowserAudio index={0} />} />
          </Routes>
        </RecoilRoot>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

/** Lets every effect settle so a missing utterance is a real absence, not a pending render */
const settle = () => waitFor(() => expect(cancelCount).toBeGreaterThanOrEqual(0));

afterEach(() => {
  resetSubmitting(getDefaultStore());
});

describe('BrowserAudio autoplay', () => {
  beforeAll(() => {
    Object.defineProperty(window, 'speechSynthesis', {
      writable: true,
      configurable: true,
      value: speechSynthesis,
    });
    Object.defineProperty(global, 'SpeechSynthesisUtterance', {
      writable: true,
      configurable: true,
      value: FakeSpeechSynthesisUtterance,
    });
  });

  beforeEach(() => {
    spoken.length = 0;
    speechEvents.length = 0;
    cancelCount = 0;
    availableVoices = [fakeVoice];
    act(() => voicesChanged());
  });

  it('speaks the finalized assistant message through speech synthesis', async () => {
    renderBrowserAudio();

    await waitFor(() => expect(spoken).toEqual([responseText]));
    expect(screen.getByTestId('played-run')).toHaveTextContent('run-1');
  });

  it('keeps an unqueued run eligible until the voices arrive', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    availableVoices = [];
    act(() => voicesChanged());
    renderBrowserAudio();
    await settle();

    expect(spoken).toEqual([]);
    expect(screen.getByTestId('played-run')).toHaveTextContent('none');

    act(() => {
      availableVoices = [fakeVoice];
      voicesChanged();
    });

    await waitFor(() => expect(spoken).toEqual([responseText]));
    expect(screen.getByTestId('played-run')).toHaveTextContent('run-1');
    warn.mockRestore();
  });

  it('speaks the answer without the reasoning that preceded it', async () => {
    renderBrowserAudio({
      messages: [
        {
          ...assistantMessage,
          text: '',
          content: [
            { type: ContentTypes.THINK, think: 'Recalling European capitals.' },
            { type: ContentTypes.TEXT, text: responseText },
          ],
        },
      ],
    });

    await waitFor(() => expect(spoken).toEqual([responseText]));
  });

  it('does not speak while the run is still submitting', async () => {
    renderBrowserAudio({ isSubmitting: true });
    await settle();

    expect(spoken).toEqual([]);
  });

  it('does not speak a run that was already played', async () => {
    renderBrowserAudio({ activeRunId: 'run-1', audioRunId: 'run-1' });
    await settle();

    expect(spoken).toEqual([]);
  });

  it('does not speak a message that is still streaming', async () => {
    const streamingMessage = { ...assistantMessage, messageId: 'user-1_' } as TMessage;
    renderBrowserAudio({ messages: [streamingMessage] });
    await settle();

    expect(spoken).toEqual([]);
  });

  /** A turn stopped mid-reasoning persists its reasoning as `text` beside the parts. */
  it('does not autoplay a stopped turn that only reasoned', async () => {
    renderBrowserAudio({
      messages: [
        {
          ...assistantMessage,
          text: 'Recalling European capitals.',
          content: [{ type: ContentTypes.THINK, think: 'Recalling European capitals.' }],
        },
      ],
    });
    await settle();

    expect(spoken).toEqual([]);
  });

  it('does not speak the user message back to them', async () => {
    const userMessage = { ...assistantMessage, isCreatedByUser: true } as TMessage;
    renderBrowserAudio({ messages: [userMessage] });
    await settle();

    expect(spoken).toEqual([]);
  });

  it('cancels the utterance when the conversation is left', async () => {
    const { unmount } = renderBrowserAudio();

    await waitFor(() => expect(spoken).toEqual([responseText]));
    unmount();

    expect(cancelCount).toBeGreaterThan(0);
  });

  it('cancels on route navigation while the adapter remains mounted', async () => {
    renderBrowserAudio();
    await waitFor(() => expect(spoken).toEqual([responseText]));
    const cancelsBeforeNavigation = cancelCount;

    fireEvent.click(screen.getByRole('link', { name: 'Next chat' }));

    expect(cancelCount).toBe(cancelsBeforeNavigation + 1);
    expect(spoken).toEqual([responseText]);
  });

  it('starts the finalized reply after the new-chat route cleans up', async () => {
    renderBrowserAudio({
      initialPath: '/c/new',
      nextPath: `/c/${conversationId}`,
      isSubmitting: true,
      activeRunId: null,
    });
    await settle();
    expect(spoken).toEqual([]);

    act(() => {
      getDefaultStore().set(activeRunFamily(0), 'run-1');
      getDefaultStore().set(isSubmittingFamily(0), false);
      fireEvent.click(screen.getByRole('link', { name: nextChatLabel }));
    });

    await waitFor(() => expect(spoken).toEqual([responseText]));
    expect(screen.getByTestId('played-run')).toHaveTextContent('run-1');
    // Route cleanup and the speech service's pre-utterance cancellation both precede speaking.
    expect(cancelCount).toBe(2);
    expect(speechEvents).toEqual(['cancel', 'cancel', 'speak']);
  });

  it('does not cancel or replay an accepted utterance when voices update', async () => {
    renderBrowserAudio();
    await waitFor(() => expect(spoken).toEqual([responseText]));
    const cancelsAfterSpeaking = cancelCount;

    act(() => voicesChanged());

    expect(cancelCount).toBe(cancelsAfterSpeaking);
    expect(spoken).toEqual([responseText]);
    expect(screen.getByTestId('played-run')).toHaveTextContent('run-1');
  });

  it('still cancels accepted speech if a later voice refresh fails', async () => {
    const { unmount } = renderBrowserAudio();
    await waitFor(() => expect(spoken).toEqual([responseText]));
    const cancelsAfterSpeaking = cancelCount;
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const getVoices = jest.spyOn(speechSynthesis, 'getVoices').mockImplementationOnce(() => {
      throw new Error('Voice service unavailable');
    });

    act(() => voicesChanged());
    expect(cancelCount).toBe(cancelsAfterSpeaking);
    unmount();

    expect(cancelCount).toBe(cancelsAfterSpeaking + 1);
    getVoices.mockRestore();
    error.mockRestore();
  });
});
