import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  replyPrompt,
  replyText,
  thinkPrompt,
  messagesView,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
} from '../helpers';
import { deleteConversations, deleteMessagesByConversation } from '../db';

type SpeechEvent = { type: 'cancel' | 'speak' | 'end' | 'voices' | 'unavailable'; path: string };
type SpeechBoundary = {
  events: SpeechEvent[];
  spoken: string[];
  activeText: string | null;
  setVoices: (ready: boolean, fail?: boolean) => void;
  finish: () => void;
};

declare global {
  interface Window {
    browserAudio: SpeechBoundary;
  }
}

const createdConversationIds: string[] = [];

test.describe.configure({ timeout: 120_000 });

test.afterAll(async () => {
  await deleteMessagesByConversation(createdConversationIds);
  await deleteConversations(createdConversationIds);
});

/** Replace the Web Speech boundary; native utterances reject service-fake voice objects. */
async function openChat(page: Page, voicesReady = true) {
  await page.addInitScript((ready) => {
    for (const [key, value] of Object.entries({
      engineSTT: 'browser',
      engineTTS: 'browser',
      textToSpeech: true,
      automaticPlayback: true,
      voice: 'E2E local voice',
      cloudBrowserVoices: false,
    })) {
      localStorage.setItem(key, JSON.stringify(value));
    }

    const target = new EventTarget();
    const voice: SpeechSynthesisVoice = {
      name: 'E2E local voice',
      voiceURI: 'e2e-local',
      lang: 'en-US',
      localService: true,
      default: true,
    };
    let available = ready;
    let fail = false;
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
    Object.defineProperty(window, 'SpeechSynthesisUtterance', {
      configurable: true,
      value: Utterance,
    });
    let current: Utterance | null = null;
    const record = (type: SpeechEvent['type']) => {
      window.browserAudio.events.push({ type, path: location.pathname });
    };
    window.browserAudio = {
      events: [],
      spoken: [],
      activeText: null,
      setVoices: (nextReady, nextFail = false) => {
        available = nextReady;
        fail = nextFail;
        record('voices');
        target.dispatchEvent(new Event('voiceschanged'));
      },
      finish: () => {
        const utterance = current;
        current = null;
        window.browserAudio.activeText = null;
        record('end');
        utterance?.dispatchEvent(new Event('end'));
      },
    };
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        getVoices: () => {
          if (fail) {
            record('unavailable');
            throw new Error('E2E voice service unavailable');
          }
          return available ? [voice] : [];
        },
        addEventListener: target.addEventListener.bind(target),
        removeEventListener: target.removeEventListener.bind(target),
        speak: (utterance: Utterance) => {
          current = utterance;
          window.browserAudio.activeText = utterance.text;
          window.browserAudio.spoken.push(utterance.text);
          record('speak');
        },
        cancel: () => {
          const utterance = current;
          current = null;
          window.browserAudio.activeText = null;
          record('cancel');
          if (utterance) {
            const event = new Event('error');
            Object.defineProperty(event, 'error', { value: 'canceled' });
            queueMicrotask(() => utterance.dispatchEvent(event));
          }
        },
      },
    });
  }, voicesReady);
  await page.goto(NEW_CHAT_PATH);
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
}

async function reply(page: Page, reasoning = false) {
  const label = `browser-audio-${randomUUID().slice(0, 8)}`;
  const response = await sendMessageAndWaitForCompletion(
    page,
    reasoning ? thinkPrompt(label) : replyPrompt(label),
  );
  const { conversationId } = (await response.json()) as { conversationId: string };
  createdConversationIds.push(conversationId);
  await expect(messagesView(page).getByText(replyText(label), { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0);
  return replyText(label);
}

/** Let the voiceschanged subscription and its passive playback effect reach a browser paint. */
async function refreshVoices(page: Page, fail = false) {
  await page.evaluate(async (unavailable) => {
    window.browserAudio.setVoices(true, unavailable);
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  }, fail);
}

const speech = (page: Page) =>
  page.evaluate(() => ({
    events: window.browserAudio.events,
    spoken: window.browserAudio.spoken,
    activeText: window.browserAudio.activeText,
  }));

async function newChat(page: Page) {
  await page
    .getByRole('link', { name: 'New chat', exact: true })
    .or(page.getByRole('button', { name: 'New chat', exact: true }))
    .filter({ visible: true })
    .first()
    .click();
  await expect(page).toHaveURL(/\/c\/new$/);
}

test.describe('browser speech autoplay', () => {
  test('speaks only the answer after new-chat cleanup and acknowledges the run without replay @scenario:browser-audio-finalized-answer', async ({
    page,
  }) => {
    await openChat(page);
    const answer = await reply(page, true);
    await expect.poll(async () => (await speech(page)).spoken).toEqual([answer]);
    const queued = await speech(page);
    expect(queued.activeText).toBe(answer);
    expect(queued.events.map((event) => event.type)).toEqual(['cancel', 'cancel', 'speak']);
    expect(queued.events.every((event) => event.path === new URL(page.url()).pathname)).toBe(true);

    await page.evaluate(() => window.browserAudio.finish());
    await refreshVoices(page);
    expect((await speech(page)).spoken).toEqual([answer]);
    expect((await speech(page)).activeText).toBeNull();

    const nextAnswer = await reply(page);
    await expect.poll(async () => (await speech(page)).spoken).toEqual([answer, nextAnswer]);
  });

  test('leaves a refused run eligible until voices become available @scenario:browser-audio-late-voices', async ({
    page,
  }) => {
    await openChat(page, false);
    const answer = await reply(page);
    expect((await speech(page)).spoken).toEqual([]);

    await refreshVoices(page);
    await expect.poll(async () => (await speech(page)).spoken).toEqual([answer]);
    await refreshVoices(page);
    expect((await speech(page)).spoken).toEqual([answer]);
    expect((await speech(page)).activeText).toBe(answer);
  });

  test('cancels active speech on route navigation and when the chat unmounts @scenario:browser-audio-route-cancellation', async ({
    page,
  }) => {
    await openChat(page);
    const answer = await reply(page);
    await expect.poll(async () => (await speech(page)).activeText).toBe(answer);
    await newChat(page);
    await expect.poll(async () => (await speech(page)).activeText).toBeNull();
    expect((await speech(page)).events.at(-1)).toEqual({ type: 'cancel', path: NEW_CHAT_PATH });

    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    const nextAnswer = await reply(page);
    await expect.poll(async () => (await speech(page)).activeText).toBe(nextAnswer);
    await page.evaluate(() => {
      history.pushState(history.state, '', '/search');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.getByRole('textbox', { name: 'Message input' })).toHaveCount(0);
    await expect.poll(async () => (await speech(page)).activeText).toBeNull();
    expect((await speech(page)).events.at(-1)).toEqual({ type: 'cancel', path: '/search' });
  });

  test('retains cancellation after a later voice refresh fails @scenario:browser-audio-failed-voice-refresh', async ({
    page,
  }) => {
    await openChat(page);
    const answer = await reply(page);
    await expect.poll(async () => (await speech(page)).activeText).toBe(answer);
    await refreshVoices(page, true);
    expect((await speech(page)).events.at(-1)?.type).toBe('unavailable');
    expect((await speech(page)).activeText).toBe(answer);

    await newChat(page);
    await expect.poll(async () => (await speech(page)).activeText).toBeNull();
    expect((await speech(page)).events.at(-1)).toEqual({ type: 'cancel', path: NEW_CHAT_PATH });
    expect((await speech(page)).spoken).toEqual([answer]);
  });

  test('does not speak an empty completed answer @scenario:browser-audio-ineligible-message', async ({
    page,
  }) => {
    await openChat(page);
    const response = await sendMessageAndWaitForCompletion(
      page,
      `E2E_EMPTY_REPLY:browser-audio-${randomUUID().slice(0, 8)}`,
    );
    const { conversationId } = (await response.json()) as { conversationId: string };
    createdConversationIds.push(conversationId);
    await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0);
    await refreshVoices(page);
    expect((await speech(page)).spoken).toEqual([]);
    expect((await speech(page)).activeText).toBeNull();
  });
});
