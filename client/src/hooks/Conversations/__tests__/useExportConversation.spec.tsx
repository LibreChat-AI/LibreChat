import { Provider } from 'jotai';
import download from 'downloadjs';
import exportFromJSON from 'export-from-json';
import { act, renderHook } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Constants, QueryKeys } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TConversation, TMessage } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import useExportConversation from '../useExportConversation';

const mockGetMessages = jest.fn();
const mockShowToast = jest.fn();
const mockCaptureScreenshot = jest.fn();
const mockScreenshotRef = { current: document.createElement('div') };

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getMessagesByConvoId: (...args: unknown[]) => mockGetMessages(...args),
    },
  };
});
jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useToastContext: () => ({ showToast: mockShowToast }),
}));
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('~/hooks/ScreenshotContext', () => ({
  useScreenshot: () => ({
    captureScreenshot: mockCaptureScreenshot,
    screenshotTargetRef: mockScreenshotRef,
  }),
  ScreenshotLimitError: class ScreenshotLimitError extends Error {},
  ScreenshotTargetError: class ScreenshotTargetError extends Error {},
}));
jest.mock('downloadjs', () => jest.fn());
jest.mock('export-from-json', () =>
  Object.assign(jest.fn(), { types: { csv: 'csv', txt: 'txt' } }),
);

const conversationId = '11111111-1111-4111-8111-111111111111';
const conversation = { conversationId, title: 'Protected chat' } as TConversation;
const submitted = {
  conversationId,
  messageId: 'user-1',
  parentMessageId: Constants.NO_PARENT,
  isCreatedByUser: true,
  clientTimestamp: '2026-09-28T15:00:00',
  text: 'Email alice@example.com',
} as TMessage;
const canonical = {
  ...submitted,
  text: 'Email [EMAIL_1_revision]',
  privacyRevision: 'revision',
} as TMessage;

function setup(type: string, pending: TMessage[] = [submitted]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData([QueryKeys.messages, conversationId], pending);
  const hook = renderHook(
    () =>
      useExportConversation({
        conversation,
        filename: 'protected',
        type,
        includeOptions: false,
        exportBranches: false,
        recursive: false,
      }),
    {
      wrapper: function Wrapper({ children }: { children: ReactNode }) {
        return (
          <MemoryRouter initialEntries={[`/c/${conversationId}`]}>
            <QueryClientProvider client={queryClient}>
              <Provider>
                <Routes>
                  <Route path="/c/:conversationId" element={children} />
                </Routes>
              </Provider>
            </QueryClientProvider>
          </MemoryRouter>
        );
      },
    },
  );
  return { ...hook, queryClient };
}

async function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockScreenshotRef.current.dataset.conversationId = conversationId;
  document.body.append(mockScreenshotRef.current);
});

it('exports acknowledged canonical text rather than a pending private cache value', async () => {
  mockGetMessages.mockResolvedValueOnce([canonical]);
  const { result } = setup('json');
  await act(async () => {
    await result.current.exportConversation();
  });
  expect(mockGetMessages).toHaveBeenCalledWith(conversationId);
  const saved = (download as jest.Mock).mock.calls[0]?.[0] as Blob;
  expect(saved).toBeInstanceOf(Blob);
  const fileText = await readBlob(saved);
  expect(fileText).toContain(canonical.text);
  expect(fileText).not.toContain('alice@example.com');
  expect(mockShowToast).not.toHaveBeenCalled();
});

it.each(['csv', 'markdown', 'text'])(
  'uses the canonical server response for %s exports',
  async (type) => {
    mockGetMessages.mockResolvedValueOnce([canonical]);
    const { result } = setup(type);
    await act(async () => {
      await result.current.exportConversation();
    });
    expect(mockGetMessages).toHaveBeenCalledWith(conversationId);
    expect(exportFromJSON).toHaveBeenCalledTimes(1);
    const payload = JSON.stringify(jest.mocked(exportFromJSON).mock.calls[0][0]);
    expect(payload).toContain(canonical.text);
    expect(payload).not.toContain('alice@example.com');
  },
);

it('does not fall back to the unfiltered cache when the canonical read fails', async () => {
  mockGetMessages.mockRejectedValueOnce(new Error('Temporary outage'));
  const { result } = setup('json');
  await act(async () => {
    await result.current.exportConversation();
  });
  expect(download).not.toHaveBeenCalled();
  expect(mockShowToast).toHaveBeenCalledWith(
    expect.objectContaining({ message: 'com_nav_export_unavailable' }),
  );
});

it('does not download a screenshot when a protected row arrives during capture', async () => {
  const clean = { ...canonical, privacyRevision: undefined, createdAt: '2026-09-28T15:00:01' };
  let finish!: (result: Blob) => void;
  mockCaptureScreenshot.mockReturnValueOnce(
    new Promise<Blob>((resolve) => {
      finish = resolve;
    }),
  );
  const { result, queryClient } = setup('screenshot', [clean]);
  const exportAction = result.current.exportConversation();
  expect(mockCaptureScreenshot).toHaveBeenCalledTimes(1);
  act(() => queryClient.setQueryData([QueryKeys.messages, conversationId], [canonical]));
  finish(new Blob(['captured original'], { type: 'image/png' }));
  await act(async () => {
    await exportAction;
  });
  expect(download).not.toHaveBeenCalled();
  expect(mockShowToast).toHaveBeenCalledWith(
    expect.objectContaining({ message: 'com_nav_export_screenshot_private_text' }),
  );
});

it.each([
  { kind: 'unsent', message: submitted },
  { kind: 'protected', message: canonical },
])('does not screenshot $kind text', async ({ message }) => {
  const { result } = setup('screenshot', [message]);
  await act(async () => {
    await result.current.exportConversation();
  });
  expect(mockCaptureScreenshot).not.toHaveBeenCalled();
  expect(download).not.toHaveBeenCalled();
  expect(mockShowToast).toHaveBeenCalledWith(
    expect.objectContaining({ message: 'com_nav_export_screenshot_private_text' }),
  );
});
