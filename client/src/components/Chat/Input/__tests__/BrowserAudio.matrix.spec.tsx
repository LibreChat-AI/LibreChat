import React, { useLayoutEffect } from 'react';
import { flushSync } from 'react-dom';
import { getDefaultStore } from 'jotai';
import { RecoilRoot, useRecoilValue } from 'recoil';
import { Constants, QueryKeys } from 'librechat-data-provider';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Link, RouterProvider, useParams, createMemoryRouter } from 'react-router-dom';
import { isSubmittingFamily, resetSubmitting, useIsSubmitting } from '@librechat/chat/react';
import type { TMessage, TConversation } from 'librechat-data-provider';
import { activeRunFamily } from '~/hooks/SSE/atoms';
import BrowserAudio from '../BrowserAudio';
import store from '~/store';

const savedId = 'matrix-chat';
const runId = 'matrix-run';
const voiceName = 'Matrix Voice';
const adoptLabel = 'Adopt saved route';
const exitLabel = 'Different conversation';
const message = {
  messageId: 'matrix-reply',
  conversationId: savedId,
  parentMessageId: Constants.NO_PARENT,
  isCreatedByUser: false,
  text: 'A finalized matrix answer.',
} as TMessage;

class Utterance extends EventTarget {
  voice: SpeechSynthesisVoice | null = null;
  onend: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  constructor(public text: string) {
    super();
    this.addEventListener('end', (event) => this.onend?.(event));
    this.addEventListener('error', (event) => this.onerror?.(event));
  }
}

let active: Utterance | null = null;
let committedRoute = '';
let acknowledged: string | null = null;
let voicesAvailable = true;
let voicesChanged = () => {};
const events: string[] = [];

beforeAll(() => {
  Object.defineProperty(window, 'speechSynthesis', {
    configurable: true,
    value: {
      getVoices: () => (voicesAvailable ? [{ name: voiceName, localService: true }] : []),
      addEventListener: (_event: string, listener: () => void) => {
        voicesChanged = listener;
      },
      speak: (utterance: Utterance) => {
        active = utterance;
        events.push(`speak:${committedRoute}`);
      },
      cancel: () => {
        const previous = active;
        active = null;
        events.push(`cancel:${committedRoute}`);
        if (previous) {
          const event = new Event('error');
          Object.defineProperty(event, 'error', { value: 'canceled' });
          queueMicrotask(() => previous.dispatchEvent(event));
        }
      },
    },
  });
  Object.defineProperty(window, 'SpeechSynthesisUtterance', {
    configurable: true,
    value: Utterance,
  });
});

beforeEach(() => {
  active = null;
  committedRoute = '';
  acknowledged = null;
  events.length = 0;
  voicesAvailable = true;
  act(() => voicesChanged());
});

afterEach(() => resetSubmitting(getDefaultStore()));

function Probe({ index }: { index: number }) {
  const { conversationId = '' } = useParams();
  const audioRun = useRecoilValue(store.audioRunFamily(index));
  const submitting = useIsSubmitting(index);
  useLayoutEffect(() => {
    committedRoute = conversationId;
    acknowledged = audioRun;
    events.push(`commit:${conversationId}:submitting=${submitting}:ack=${audioRun ?? 'none'}`);
  }, [conversationId, audioRun, submitting]);
  return <output data-testid="matrix-route">{conversationId}</output>;
}

function setup(index = 0) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData([QueryKeys.messages, 'new'], [message]);
  queryClient.setQueryData([QueryKeys.messages, savedId], [message]);
  const router = createMemoryRouter(
    [
      {
        path: '/c/:conversationId',
        element: (
          <>
            <Link to={`/c/${savedId}`}>{adoptLabel}</Link>
            <Link to="/c/other-chat">{exitLabel}</Link>
            <Probe index={index} />
            <BrowserAudio index={index} />
          </>
        ),
      },
    ],
    { initialEntries: ['/c/new'] },
  );
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RecoilRoot
        initializeState={({ set }) => {
          set(store.voice, voiceName);
          set(store.conversationByIndex(index), { conversationId: savedId } as TConversation);
          set(store.audioRunFamily(index), null);
          getDefaultStore().set(activeRunFamily(index), runId);
          getDefaultStore().set(isSubmittingFamily(index), true);
        }}
      >
        <RouterProvider router={router} />
      </RecoilRoot>
    </QueryClientProvider>,
  );
  return { ...view, router };
}

const finalize = (index = 0) => getDefaultStore().set(isSubmittingFamily(index), false);
const adopt = () => fireEvent.click(screen.getByRole('link', { name: adoptLabel }));
const spoken = () => events.filter((event) => event.startsWith('speak:'));

it.each([0, 1])(
  'retains speech with a combined eligibility/route commit in pane %i',
  async (index) => {
    const { router } = setup(index);
    await act(async () => {
      flushSync(() => {
        finalize(index);
        void router.navigate(`/c/${savedId}`, { flushSync: true });
      });
    });
    expect(committedRoute).toBe(savedId);
    expect(active?.text).toBe(message.text);
    expect(acknowledged).toBe(runId);
    expect(spoken()).toEqual([`speak:${savedId}`]);
    expect(events.some((event) => event.startsWith('commit:new:submitting=false'))).toBe(false);
  },
);

it('defers primary-pane speech and acknowledgement until saved-route adoption', async () => {
  setup();
  await act(async () => finalize());
  expect(committedRoute).toBe('new');
  expect(active).toBeNull();
  expect(acknowledged).toBeNull();
  expect(spoken()).toEqual([]);

  await act(async () => adopt());
  expect(committedRoute).toBe(savedId);
  expect(active?.text).toBe(message.text);
  expect(acknowledged).toBe(runId);
  expect(spoken()).toEqual([`speak:${savedId}`]);
  expect(events.filter((event) => !event.startsWith('commit:'))).toEqual([
    `cancel:${savedId}`,
    `cancel:${savedId}`,
    `speak:${savedId}`,
  ]);
  expect(events.at(-1)).toBe(`commit:${savedId}:submitting=false:ack=${runId}`);
});

it('allows an additional pane to speak its own conversation before primary-route adoption', async () => {
  setup(1);
  await act(async () => finalize(1));
  expect(committedRoute).toBe('new');
  expect(active?.text).toBe(message.text);
  expect(acknowledged).toBe(runId);
  expect(spoken()).toEqual(['speak:new']);
});

it.each(['before-adoption', 'after-adoption'])(
  'retries delayed voices %s without premature acknowledgement or replay',
  async (arrival) => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    voicesAvailable = false;
    act(() => voicesChanged());
    setup();
    await act(async () => finalize());
    const loadVoices = () => {
      voicesAvailable = true;
      voicesChanged();
    };
    if (arrival === 'before-adoption') {
      await act(async () => loadVoices());
      expect(active).toBeNull();
      expect(acknowledged).toBeNull();
      await act(async () => adopt());
    } else {
      await act(async () => adopt());
      expect(active).toBeNull();
      expect(acknowledged).toBeNull();
      await act(async () => loadVoices());
    }
    expect(active?.text).toBe(message.text);
    expect(acknowledged).toBe(runId);
    expect(spoken()).toEqual([`speak:${savedId}`]);
    await act(async () => voicesChanged());
    expect(active?.text).toBe(message.text);
    expect(spoken()).toHaveLength(1);
    warn.mockRestore();
  },
);

it.each([0, 1])('cancels accepted speech on a different conversation in pane %i', async (index) => {
  setup(index);
  await act(async () => adopt());
  await act(async () => finalize(index));
  expect(active?.text).toBe(message.text);
  await act(async () => fireEvent.click(screen.getByRole('link', { name: exitLabel })));
  expect(committedRoute).toBe('other-chat');
  expect(active).toBeNull();
  expect(acknowledged).toBe(runId);
  expect(spoken()).toHaveLength(1);
});

it.each([0, 1])('cancels accepted speech on unmount in pane %i', async (index) => {
  const view = setup(index);
  await act(async () => adopt());
  await act(async () => finalize(index));
  expect(active?.text).toBe(message.text);
  await act(async () => view.unmount());
  expect(active).toBeNull();
  expect(acknowledged).toBe(runId);
  expect(spoken()).toHaveLength(1);
});
