import { Provider } from 'jotai';
import download from 'downloadjs';
import { toCanvas } from 'html-to-image';
import { QueryKeys } from 'librechat-data-provider';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import type { TMessage, TConversation } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import { completeProgressiveRowMounts } from '~/hooks/Messages/useProgressiveRowMount';
import { ScreenshotProvider, useScreenshot } from '~/hooks/ScreenshotContext';
import useExportConversation from '../useExportConversation';

const mockShowToast = jest.fn();
jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useToastContext: () => ({ showToast: mockShowToast }),
}));
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('downloadjs', () => jest.fn());
jest.mock('html-to-image', () => ({ toCanvas: jest.fn() }));
jest.mock('~/hooks/Messages/useProgressiveRowMount', () => ({
  completeProgressiveRowMounts: jest.fn(),
}));

const sourceId = '11111111-1111-4111-8111-111111111111';
const destinationId = '22222222-2222-4222-8222-222222222222';
const clean = {
  conversationId: sourceId,
  messageId: 'safe',
  text: 'Safe text',
  isCreatedByUser: true,
  createdAt: '2026-10-02T11:00:00',
} as TMessage;

function Target() {
  const { conversationId } = useParams();
  const { screenshotTargetRef } = useScreenshot();
  return (
    <div key={conversationId} ref={screenshotTargetRef} data-conversation-id={conversationId} />
  );
}
function setup() {
  const client = new QueryClient();
  client.setQueryData([QueryKeys.messages, sourceId], [clean]);
  client.setQueryData(
    [QueryKeys.messages, destinationId],
    [{ ...clean, conversationId: destinationId, privacyRevision: 'protected' }],
  );
  const hook = renderHook(
    () => {
      const { conversationId } = useParams();
      const navigate = useNavigate();
      const { exportConversation } = useExportConversation({
        conversation: { conversationId } as TConversation,
        filename: 'screenshot',
        type: 'screenshot',
        includeOptions: false,
        exportBranches: false,
        recursive: false,
      });
      return { navigate, exportConversation };
    },
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <MemoryRouter initialEntries={[`/c/${sourceId}`]}>
          <QueryClientProvider client={client}>
            <Provider>
              <ScreenshotProvider>
                <Routes>
                  <Route
                    path="/c/:conversationId"
                    element={
                      <>
                        <Target />
                        {children}
                      </>
                    }
                  />
                </Routes>
              </ScreenshotProvider>
            </Provider>
          </QueryClientProvider>
        </MemoryRouter>
      ),
    },
  );
  const target = document.querySelector<HTMLDivElement>('[data-conversation-id]')!;
  Object.defineProperties(target, {
    scrollWidth: { value: 100 },
    scrollHeight: { value: 100 },
  });
  return { ...hook, client, target };
}
function canvas() {
  const element = document.createElement('canvas');
  jest.spyOn(element, 'toBlob').mockImplementation((callback) => {
    callback(new Blob(['image'], { type: 'image/png' }));
  });
  return element;
}
beforeEach(() => {
  jest.mocked(completeProgressiveRowMounts).mockResolvedValue(undefined);
  jest.mocked(toCanvas).mockResolvedValue(canvas());
});

it('downloads an unchanged unprotected capture', async () => {
  const { result, target } = setup();
  await act(async () => {
    await result.current.exportConversation();
  });
  expect(toCanvas).toHaveBeenCalledWith(target, expect.anything());
  expect(download).toHaveBeenCalledTimes(1);
});

it('rejects navigation to a protected transcript during progressive mounting', async () => {
  let finish!: () => void;
  jest.mocked(completeProgressiveRowMounts).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const { result, target } = setup();
  const exporting = result.current.exportConversation();
  act(() => result.current.navigate(`/c/${destinationId}`));
  const destination = document.querySelector<HTMLDivElement>('[data-conversation-id]')!;
  Object.defineProperties(destination, {
    scrollWidth: { value: 100 },
    scrollHeight: { value: 100 },
  });
  expect(target.isConnected).toBe(false);
  await act(async () => {
    finish();
    await exporting;
  });
  expect(toCanvas).not.toHaveBeenCalled();
  expect(download).not.toHaveBeenCalled();
  expect(mockShowToast).toHaveBeenCalled();
});

it('discards a capture when the target changes during image cloning', async () => {
  let finish!: (result: HTMLCanvasElement) => void;
  jest.mocked(toCanvas).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const { result } = setup();
  const exporting = result.current.exportConversation();
  await act(async () => {
    await Promise.resolve();
  });
  expect(toCanvas).toHaveBeenCalledTimes(1);
  act(() => result.current.navigate(`/c/${destinationId}`));
  await act(async () => {
    finish(canvas());
    await exporting;
  });
  expect(download).not.toHaveBeenCalled();
});

it('checks newly protected text after progressive mounting and before cloning', async () => {
  let finish!: () => void;
  jest.mocked(completeProgressiveRowMounts).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const { result, client } = setup();
  const exporting = result.current.exportConversation();
  act(() =>
    client.setQueryData(
      [QueryKeys.messages, sourceId],
      [{ ...clean, privacyRevision: 'protected' }],
    ),
  );
  await act(async () => {
    finish();
    await exporting;
  });
  expect(toCanvas).not.toHaveBeenCalled();
  expect(download).not.toHaveBeenCalled();
  expect(mockShowToast).toHaveBeenCalledWith(
    expect.objectContaining({
      message: 'com_nav_export_screenshot_private_text',
    }),
  );
});

it('refuses a target whose rendered conversation differs from the export scope', async () => {
  const { result, target } = setup();
  target.dataset.conversationId = destinationId;
  await act(async () => {
    await result.current.exportConversation();
  });
  expect(toCanvas).not.toHaveBeenCalled();
  expect(download).not.toHaveBeenCalled();
});

it('refuses a reused DOM node when its transcript identity changes during mounting', async () => {
  let finish!: () => void;
  jest.mocked(completeProgressiveRowMounts).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const { result, target } = setup();
  const exporting = result.current.exportConversation();
  target.dataset.conversationId = destinationId;
  await act(async () => {
    finish();
    await exporting;
  });
  expect(toCanvas).not.toHaveBeenCalled();
  expect(download).not.toHaveBeenCalled();
});

it('does not revive a cancelled capture after navigating away and back', async () => {
  let finish!: (result: HTMLCanvasElement) => void;
  jest.mocked(toCanvas).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const { result, target } = setup();
  const exporting = result.current.exportConversation();
  await act(async () => {
    await Promise.resolve();
  });
  act(() => result.current.navigate(`/c/${destinationId}`));
  act(() => result.current.navigate(`/c/${sourceId}`));
  expect(document.querySelector('[data-conversation-id]')).not.toBe(target);
  await act(async () => {
    finish(canvas());
    await exporting;
  });
  expect(download).not.toHaveBeenCalled();
});
