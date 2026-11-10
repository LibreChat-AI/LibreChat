import React, { useMemo, useState } from 'react';
import { getDefaultStore, useAtom } from 'jotai';
import { filesFamily, isSubmittingFamily } from '@librechat/chat/react';
import '@testing-library/jest-dom';
import { RecoilRoot } from 'recoil';
import { DndProvider } from 'react-dnd';
import { useForm } from 'react-hook-form';
import userEvent from '@testing-library/user-event';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { render, screen } from '@testing-library/react';
import { BrowserRouter as Router } from 'react-router-dom';
import { QueryKeys, EModelEndpoint } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TFile, TConversation } from 'librechat-data-provider';
import type { TOptions } from 'i18next';
import type { TranslationKeys } from '~/hooks/useLocalize';
import type BarComponent from '../Composer/Bar';
import type { ChatFormValues } from '~/common';
import { ChatContext, ChatFormProvider } from '~/Providers';
import { TargetContext } from '~/Providers/TargetContext';
import { AuthContextProvider } from '~/hooks/AuthContext';
import { SteerHostTestProvider } from 'test/steerHost';
import ChatForm from '../ChatForm';

type BarProps = React.ComponentProps<typeof BarComponent>;

/* Production keeps `t` stable between language changes; the global test double returns a new one
   on every render, which makes `localize`, and every hook memoized on it, look unstable. */
jest.mock('react-i18next', () => {
  const actual = jest.requireActual<typeof import('react-i18next')>('react-i18next');
  const t = (key: TranslationKeys, options?: TOptions) =>
    jest.requireActual<typeof import('~/locales/i18n')>('~/locales/i18n').default.t(key, options);
  return {
    ...actual,
    useTranslation: () => ({
      t,
      i18n: {
        ...jest.requireActual<typeof import('~/locales/i18n')>('~/locales/i18n').default,
        changeLanguage: jest.fn(),
      },
    }),
  };
});

/** Props of every render of the bar, in order. Written by the probe below. */
const mockBarRenders: BarProps[] = [];

/**
 * The probe wraps the real bar in `memo`, the way the bar's own default export is, so it renders
 * exactly when `memo(Bar)` would: when a prop changes identity. A stand-in without `memo` would
 * render on every parent render and could never tell a stable prop from an unstable one.
 */
jest.mock('../Composer/Bar', () => {
  const { memo } = jest.requireActual('react');
  const Bar = jest.requireActual('../Composer/Bar').default;
  const BarProbe = memo(function BarProbe(props: BarProps) {
    mockBarRenders.push(props);
    return <Bar {...props} />;
  });
  return { __esModule: true, default: BarProbe };
});

const mockBarBody = { runs: 0 };

/**
 * The bar calls this hook once per render and nothing else does, so the count is how many times
 * the real bar body ran, whatever caused it: a prop, its own state, or a context it reads. The
 * probe above only sees props.
 */
jest.mock('~/hooks/Input/usePaletteEntries', () => {
  const actual = jest.requireActual('~/hooks/Input/usePaletteEntries');
  return {
    __esModule: true,
    ...actual,
    default: (...args: unknown[]) => {
      mockBarBody.runs += 1;
      return actual.default(...args);
    },
  };
});

function Harness({ conversationId }: { conversationId: string }) {
  const [files, setFiles] = useAtom(filesFamily(0));
  const [isSubmitting] = useAtom(isSubmittingFamily(0));
  const [, setFilesLoading] = useState(false);
  const methods = useForm<ChatFormValues>({ defaultValues: { text: '' } });
  const conversation = useMemo(
    () =>
      ({
        conversationId,
        endpoint: EModelEndpoint.openAI,
        model: 'gpt-4o',
        title: 'New Chat',
      }) as TConversation,
    [conversationId],
  );

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
        abortScroll: false,
        setAbortScroll: () => undefined,
        preset: null,
        setPreset: () => undefined,
        optionSettings: {},
        setOptionSettings: () => undefined,
        handleRegenerate: () => undefined,
        handleContinue: () => undefined,
      }) as unknown as React.ContextType<typeof ChatContext>,
    [conversation, files, setFiles, isSubmitting],
  );

  return (
    <ChatFormProvider {...methods}>
      <ChatContext.Provider value={chatHelpers}>
        <TargetContext.Provider
          value={{ ready: true, pending: false, failed: false, retry: () => {} }}
        >
          <ChatForm
            index={0}
            isLandingPage={false}
            footerBelow={false}
            centerFormOnLanding={false}
          />
        </TargetContext.Provider>
      </ChatContext.Provider>
    </ChatFormProvider>
  );
}

function renderComposer({
  conversationId = 'new',
  submitting = false,
}: { conversationId?: string; submitting?: boolean } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClient.setQueryData<TFile[]>([QueryKeys.files], []);
  queryClient.setQueryData([QueryKeys.endpoints], { [EModelEndpoint.openAI]: { order: 0 } });
  getDefaultStore().set(isSubmittingFamily(0), submitting);

  return render(
    <QueryClientProvider client={queryClient}>
      <RecoilRoot>
        <SteerHostTestProvider>
          <Router>
            <AuthContextProvider authConfig={{ loginRedirect: '', test: true }}>
              <DndProvider backend={HTML5Backend}>
                <main>
                  <Harness conversationId={conversationId} />
                </main>
              </DndProvider>
            </AuthContextProvider>
          </Router>
        </SteerHostTestProvider>
      </RecoilRoot>
    </QueryClientProvider>,
  );
}

/** Names of the props whose identity differs between two renders of the bar. */
function changedProps(previous: BarProps, next: BarProps): string[] {
  const keys = Object.keys(next) as Array<keyof BarProps>;
  return keys.filter((key) => !Object.is(previous[key], next[key]));
}

/** For each render of the bar after the first `count`, the props that changed to cause it. */
function rendersAfter(count: number): string[][] {
  return mockBarRenders
    .slice(count)
    .map((props, offset) => changedProps(mockBarRenders[count + offset - 1], props));
}

beforeEach(() => {
  localStorage.clear();
  mockBarRenders.length = 0;
  mockBarBody.runs = 0;
});

afterEach(() => {
  getDefaultStore().set(filesFamily(0), new Map());
  getDefaultStore().set(isSubmittingFamily(0), false);
});

describe('ChatForm action bar', () => {
  test.each([
    { name: 'a new chat', conversationId: 'new', submitting: false },
    { name: 'a saved chat', conversationId: 'saved-chat', submitting: false },
    { name: 'a saved chat with a run in flight', conversationId: 'saved-chat', submitting: true },
  ])(
    'does not re-render while the draft is typed in $name',
    async (scenario) => {
      renderComposer(scenario);
      const textarea = await screen.findByTestId('text-input');
      await userEvent.click(textarea);
      const rendersBefore = mockBarRenders.length;
      const runsBefore = mockBarBody.runs;
      /* A probe or spy that never fires would pass for the wrong reason. */
      expect(rendersBefore).toBeGreaterThan(0);
      expect(runsBefore).toBeGreaterThan(0);

      await userEvent.keyboard('hello');

      expect(textarea).toHaveValue('hello');
      expect(rendersAfter(rendersBefore)).toEqual([]);
      expect(mockBarBody.runs).toBe(runsBefore);
    },
    20000,
  );

  test('send follows the draft', async () => {
    renderComposer();
    const textarea = await screen.findByTestId('text-input');
    expect(await screen.findByTestId('send-button')).toBeDisabled();

    await userEvent.type(textarea, 'hi');
    expect(screen.getByTestId('send-button')).toBeEnabled();

    await userEvent.clear(textarea);
    expect(screen.getByTestId('send-button')).toBeDisabled();

    await userEvent.type(textarea, '   ');
    expect(screen.getByTestId('send-button')).toBeDisabled();
  }, 20000);

  test('the during-run send follows the draft while a run is in flight', async () => {
    renderComposer({ conversationId: 'saved-chat', submitting: true });
    const textarea = await screen.findByTestId('text-input');
    expect(screen.queryByTestId('during-run-send-button')).not.toBeInTheDocument();

    await userEvent.type(textarea, 'later');
    expect(await screen.findByTestId('during-run-send-button')).toBeEnabled();

    await userEvent.clear(textarea);
    expect(screen.queryByTestId('during-run-send-button')).not.toBeInTheDocument();
  }, 20000);
});
