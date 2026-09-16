import React, { Profiler, useMemo, useState } from 'react';
import '@testing-library/jest-dom';
import { DndProvider } from 'react-dnd';
import { useForm } from 'react-hook-form';
import { RecoilRoot, useRecoilState } from 'recoil';
import userEvent from '@testing-library/user-event';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { BrowserRouter as Router } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { QueryKeys, FileSources, EModelEndpoint } from 'librechat-data-provider';
import { render, screen, within, waitFor, fireEvent } from '@testing-library/react';
import type { TFile, TFileUpload, TConversation } from 'librechat-data-provider';
import type { ChatFormValues } from '~/common';
import ChatForm, { toRestoredComposerFile } from '../ChatForm';
import { ChatContext, ChatFormProvider } from '~/Providers';
import { AuthContextProvider } from '~/hooks/AuthContext';
import store from '~/store';

const mockUpload = jest.fn();

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      uploadImage: (...args: unknown[]) => mockUpload(...args),
      uploadFile: (...args: unknown[]) => mockUpload(...args),
    },
  };
});

const conversation = {
  conversationId: 'new',
  endpoint: EModelEndpoint.openAI,
  model: 'gpt-4o',
  title: 'New Chat',
} as TConversation;

const uploadResponse = {
  message: 'File uploaded',
  file_id: 'server-file-id',
  temp_file_id: 'temp-file-id',
  filename: 'cat.png',
  filepath: '/images/cat.png',
  type: 'image/png',
  bytes: 2048,
  height: 100,
  width: 100,
  source: FileSources.local,
  embedded: false,
} as unknown as TFileUpload;

/** jsdom never decodes images; `decodes` mirrors a browser that can or cannot. */
let decodes = true;

class StubImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  width = 100;
  height = 100;
  set src(_value: string) {
    setTimeout(() => (decodes ? this.onload?.() : this.onerror?.()), 0);
  }
}

let commits = 0;

function Harness() {
  const [files, setFiles] = useRecoilState(store.filesByIndex(0));
  const [isSubmitting] = useRecoilState(store.isSubmittingFamily(0));
  const [, setFilesLoading] = useState(false);
  const methods = useForm<ChatFormValues>({ defaultValues: { text: '' } });

  const chatHelpers = useMemo(
    () =>
      ({
        index: 0,
        conversation,
        setConversation: () => undefined,
        files,
        setFiles,
        isSubmitting,
        setIsSubmitting: () => undefined,
        filesLoading: false,
        setFilesLoading,
        newConversation: () => undefined,
        handleStopGenerating: () => undefined,
        stopGenerating: () => undefined,
        getMessages: () => undefined,
        setMessages: () => undefined,
        ask: () => undefined,
        regenerate: () => undefined,
        setSiblingIdx: () => undefined,
        showPopover: false,
        setShowPopover: () => undefined,
        abortScroll: false,
        setAbortScroll: () => undefined,
        preset: null,
        setPreset: () => undefined,
        optionSettings: {},
        setOptionSettings: () => undefined,
        handleRegenerate: () => undefined,
        handleContinue: () => undefined,
      }) as unknown as React.ContextType<typeof ChatContext>,
    [files, setFiles, isSubmitting],
  );

  return (
    <ChatFormProvider {...methods}>
      <ChatContext.Provider value={chatHelpers}>
        <Profiler id="composer" onRender={() => (commits += 1)}>
          <ChatForm
            index={0}
            isLandingPage={false}
            footerBelow={false}
            centerFormOnLanding={false}
          />
        </Profiler>
      </ChatContext.Provider>
    </ChatFormProvider>
  );
}

function renderComposer({
  submitting = false,
  quotes = [],
  speechSettingsInitialized = false,
}: { submitting?: boolean; quotes?: string[]; speechSettingsInitialized?: boolean } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  /* These interaction tests exercise the destination menu. Unified-mode control
   * behavior has its own focused coverage, so opt this harness into the legacy menu
   * instead of depending on the product default. */
  queryClient.setQueryData([QueryKeys.fileConfig], {
    endpoints: { default: { legacyFileUploadUX: true } },
  });
  queryClient.setQueryData<TFile[]>([QueryKeys.files], []);
  queryClient.setQueryData([QueryKeys.endpoints], { [EModelEndpoint.openAI]: { order: 0 } });

  return render(
    <QueryClientProvider client={queryClient}>
      <RecoilRoot
        initializeState={({ set }) => {
          set(store.isSubmittingFamily(0), submitting);
          set(store.speechSettingsInitialized, speechSettingsInitialized);
          set(store.pendingQuotesByConvoId(conversation.conversationId ?? ''), quotes);
        }}
      >
        <Router>
          <AuthContextProvider authConfig={{ loginRedirect: '', test: true }}>
            <DndProvider backend={HTML5Backend}>
              <Harness />
            </DndProvider>
          </AuthContextProvider>
        </Router>
      </RecoilRoot>
    </QueryClientProvider>,
  );
}

const sendButton = () => screen.getByTestId('send-button');
const attach = (container: HTMLElement, file: File) =>
  userEvent.upload(container.querySelector('input[type="file"]') as HTMLInputElement, file);
const image = () => new File(['image-bytes'], 'cat.png', { type: 'image/png' });

describe('ChatForm attachments', () => {
  beforeEach(() => {
    localStorage.clear();
    decodes = true;
    commits = 0;
    global.URL.createObjectURL = jest.fn(() => 'blob:preview');
    global.URL.revokeObjectURL = jest.fn();
    (global as unknown as { Image: unknown }).Image = StubImage;
    mockUpload.mockReset();
    /** The server echoes the id the client sent back as `temp_file_id`. */
    mockUpload.mockImplementation((body: FormData) =>
      Promise.resolve({ ...uploadResponse, temp_file_id: body.get('file_id') as string }),
    );
  });

  test('preserves extracted-text delivery when restoring a queued attachment', () => {
    expect(
      toRestoredComposerFile({
        file_id: 'stored-doc',
        filename: 'report.docx',
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        llmDeliveryPath: 'text',
      }),
    ).toMatchObject({
      file_id: 'stored-doc',
      filename: 'report.docx',
      progress: 1,
      attached: true,
      llmDeliveryPath: 'text',
    });
  });

  test('keeps the mic disabled until speech settings hydrate', async () => {
    const pending = renderComposer({ speechSettingsInitialized: false });
    const micName = 'Use microphone';

    expect(await screen.findByRole('button', { name: micName })).toBeDisabled();

    pending.unmount();
    renderComposer({ speechSettingsInitialized: true });

    expect(await screen.findByRole('button', { name: micName })).toBeEnabled();
  }, 20000);

  test('re-enables send once an attachment finishes uploading', async () => {
    const { container } = renderComposer();

    const textarea = await screen.findByTestId('text-input');
    await userEvent.type(textarea, 'hi');
    expect(sendButton()).toBeEnabled();

    await attach(container, image());
    await waitFor(() => expect(mockUpload).toHaveBeenCalled());

    await waitFor(() => expect(sendButton()).toBeEnabled());
    expect(textarea).toHaveValue('hi');
  }, 20000);

  test('does not steal focus when clicking the nested attachment icon', async () => {
    renderComposer();
    const textarea = await screen.findByTestId('text-input');
    const trigger = screen.getByRole('button', { name: 'Attach File Options' });
    expect(trigger).toBeEnabled();
    const icon = trigger.querySelector('svg');
    expect(icon).not.toBeNull();
    const focus = jest.spyOn(textarea, 'focus');

    await userEvent.click(icon as SVGElement);

    expect(focus).not.toHaveBeenCalled();
    expect(await screen.findByRole('menu', { name: 'Attach File Options' })).toBeInTheDocument();
  }, 20000);

  test('closes an open menu when the textarea is clicked', async () => {
    renderComposer();
    const textarea = await screen.findByTestId('text-input');
    await userEvent.click(screen.getByRole('button', { name: 'Attach File Options' }));
    expect(await screen.findByRole('menu', { name: 'Attach File Options' })).toBeInTheDocument();

    await userEvent.click(textarea);

    await waitFor(() =>
      expect(screen.queryByRole('menu', { name: 'Attach File Options' })).not.toBeInTheDocument(),
    );
    expect(textarea).toHaveFocus();
  }, 20000);

  test('still returns focus to the textarea after a plain control click', async () => {
    renderComposer();
    const textarea = await screen.findByTestId('text-input');
    await userEvent.type(textarea, 'hi');
    expect(sendButton()).toBeEnabled();

    await userEvent.click(sendButton());

    expect(textarea).toHaveFocus();
  }, 20000);

  test('returns focus to the textarea after a during-run hovercard action', async () => {
    renderComposer({ submitting: true });
    const textarea = await screen.findByTestId('text-input');
    await userEvent.type(textarea, 'later');
    /** Ariakit shows a hovercard only after the pointer has travelled, and a
     *  keydown resets that, so the hover needs real screen-coordinate movement. */
    const anchor = await screen.findByTestId('during-run-send-button');
    fireEvent.mouseMove(anchor, { screenX: 10, screenY: 10 });
    fireEvent.mouseMove(anchor, { screenX: 20, screenY: 20 });
    const hovercard = await screen.findByRole('dialog');
    const queue = within(hovercard).getByRole('button', { name: /^Queue\b/ });
    expect(queue).toBeEnabled();

    await userEvent.click(queue);

    await waitFor(() => expect(textarea).toHaveValue(''));
    expect(textarea).toHaveFocus();
  }, 20000);

  test('returns focus to the textarea after the primary during-run submit', async () => {
    renderComposer({ submitting: true });
    const textarea = await screen.findByTestId('text-input');
    await userEvent.type(textarea, 'later');

    await userEvent.click(await screen.findByTestId('during-run-send-button'));

    await waitFor(() => expect(textarea).toHaveValue(''));
    expect(textarea).toHaveFocus();
  }, 20000);

  test('returns focus to the textarea when removing a quote collapses the popup', async () => {
    renderComposer({ quotes: ['alpha', 'beta'] });
    const textarea = await screen.findByTestId('text-input');
    // Hover opens this disclosure too; test the click path without a synthetic hover toggle.
    await userEvent.click(screen.getByRole('button', { name: '2 selections' }), {
      skipHover: true,
    });
    const popup = await screen.findByRole('dialog');

    await userEvent.click(within(popup).getAllByRole('button', { name: 'Remove quote' })[0]);

    await waitFor(() => expect(screen.queryByTestId('quote-selections-popup')).toBeNull());
    expect(screen.getByText('beta')).toBeInTheDocument();
    expect(textarea).toHaveFocus();
  }, 20000);

  test('keeps focus inside the popup when removing a quote leaves several', async () => {
    renderComposer({ quotes: ['alpha', 'beta', 'gamma'] });
    await screen.findByTestId('text-input');
    // Hover opens this disclosure too; test the click path without a synthetic hover toggle.
    await userEvent.click(screen.getByRole('button', { name: '3 selections' }), {
      skipHover: true,
    });
    const popup = await screen.findByRole('dialog');

    await userEvent.click(within(popup).getAllByRole('button', { name: 'Remove quote' })[0]);

    await waitFor(() => expect(within(popup).getAllByRole('button')).toHaveLength(2));
    expect(within(popup).getAllByRole('button', { name: 'Remove quote' })[0]).toHaveFocus();
  }, 20000);

  test('does not raise the keyboard when a quote removal collapses the popup on touch', async () => {
    const matchMedia = window.matchMedia;
    window.matchMedia = jest
      .fn()
      .mockReturnValue({ matches: true }) as unknown as typeof matchMedia;
    try {
      renderComposer({ quotes: ['alpha', 'beta'] });
      const textarea = await screen.findByTestId('text-input');
      // Hover opens this disclosure too; test the click path without a synthetic hover toggle.
      await userEvent.click(screen.getByRole('button', { name: '2 selections' }), {
        skipHover: true,
      });
      const popup = await screen.findByRole('dialog');

      await userEvent.click(within(popup).getAllByRole('button', { name: 'Remove quote' })[0]);

      await waitFor(() => expect(screen.queryByTestId('quote-selections-popup')).toBeNull());
      expect(textarea).not.toHaveFocus();
    } finally {
      window.matchMedia = matchMedia;
    }
  }, 20000);

  test('focuses the textarea when clicking empty composer space', async () => {
    renderComposer();
    const textarea = await screen.findByTestId('text-input');
    const surface = screen.getByTestId('composer-surface');
    const focus = jest.spyOn(textarea, 'focus');

    fireEvent.click(surface);

    expect(focus).toHaveBeenCalledTimes(1);
    expect(textarea).toHaveFocus();
  }, 20000);

  test('enables send for an attachment with no composer text', async () => {
    const { container } = renderComposer();
    await screen.findByTestId('text-input');
    expect(sendButton()).toBeDisabled();

    await attach(container, image());
    await waitFor(() => expect(mockUpload).toHaveBeenCalled());

    await waitFor(() => expect(sendButton()).toBeEnabled());
  }, 20000);

  /**
   * The upload only starts once the browser has decoded the image. A decode it
   * refuses used to leave the attachment below `progress: 1`, which reads as
   * "still uploading" and disabled the send button for the rest of the session.
   */
  test('drops an image the browser cannot decode instead of disabling send', async () => {
    decodes = false;
    const { container } = renderComposer();

    const textarea = await screen.findByTestId('text-input');
    await userEvent.type(textarea, 'hi');

    await attach(container, image());
    await waitFor(() => expect(screen.queryByLabelText('Remove file')).not.toBeInTheDocument());

    expect(mockUpload).not.toHaveBeenCalled();
    expect(sendButton()).toBeEnabled();
    expect(textarea).toHaveValue('hi');
  }, 20000);

  /**
   * The composer is the app's busiest surface: every keystroke already re-renders
   * it for the row count and the send button's enabled state, so anything that
   * multiplies that work per character is a regression worth failing on. The
   * measured cost is ~2.5 commits per character (react-scan reports one ChatForm
   * render per keystroke in a real browser); the bound leaves headroom for jsdom
   * scheduling without tolerating a doubling.
   */
  test('keeps typing render-bounded', async () => {
    renderComposer();
    const textarea = await screen.findByTestId('text-input');
    await waitFor(() => expect(sendButton()).toBeInTheDocument());

    commits = 0;
    await userEvent.type(textarea, 'hello there');

    expect(commits).toBeLessThanOrEqual('hello there'.length * 3);
  }, 20000);
});
