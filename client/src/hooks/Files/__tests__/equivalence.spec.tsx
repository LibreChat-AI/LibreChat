import React from 'react';
import { RecoilRoot } from 'recoil';
import { useForm } from 'react-hook-form';
import { ToastContext } from '@librechat/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Constants,
  FileSources,
  FileContext,
  EModelEndpoint,
  mergeFileConfig,
} from 'librechat-data-provider';
import type {
  FileConfig,
  TFileUpload,
  TConversation,
  UploadMutationOptions,
} from 'librechat-data-provider';
import type { SharePointFile } from '~/data-provider/Files/sharepoint';
import type { AttachEntry } from '~/hooks/Input/useAttachItems';
import type { ChatFormValues, ExtendedFile } from '~/common';
import type { ChatContract } from '~/hooks/Chat/contract';
import { UploadModalProvider, useUploadModalContext } from '~/Providers/UploadModalContext';
import useAttachExisting from '~/hooks/Files/useAttachExisting';
import { DragDropProvider } from '~/Providers/DragDropContext';
import { ChatFormProvider } from '~/Providers/ChatFormContext';
import useAttachTarget from '~/hooks/Input/useAttachTarget';
import useAttachItems from '~/hooks/Input/useAttachItems';
import { ChatContext } from '~/Providers/ChatContext';
import useTextarea from '~/hooks/Input/useTextarea';
import useDragHelpers from '../useDragHelpers';
import { isUnifiedUploadMode } from '~/utils';

/**
 * Every way a file reaches the composer in unified mode has to arrive at the server as the same
 * request: no destination, marked as a message file, so the server decides how it is read. The
 * hooks run for real down to the upload mutation; only the network, the browser's drag source and
 * the hooks that have nothing to do with uploads are replaced.
 */

type RawFileConfig = Parameters<typeof mergeFileConfig>[0];
type ChatFiles = Pick<
  ChatContract,
  'index' | 'conversation' | 'isSubmitting' | 'files' | 'setFiles' | 'setFilesLoading'
>;
type Upload = { body: FormData; options: UploadMutationOptions };
type TestChat = { chat: ChatFiles; staged: () => Map<string, ExtendedFile> };
type Attached = { body: FormData; staged: ExtendedFile | undefined; chat: TestChat };

const mockShowToast = jest.fn();
let mockUploads: Upload[] = [];
let mockFileConfig: RawFileConfig;
let mockDrop: ((item: { files: File[] }) => void) | undefined;

jest.mock('~/data-provider', () => ({
  useGetFileConfig: ({ select }: { select?: (data: RawFileConfig) => FileConfig } = {}) => ({
    data: select != null ? select(mockFileConfig) : mockFileConfig,
    isSuccess: true,
    isError: false,
    isPaused: false,
  }),
  useGetEndpointsQuery: () => ({ data: undefined }),
  useGetAgentByIdQuery: () => ({ data: undefined }),
  useGetStartupConfig: () => ({ data: { sharePointFilePickerEnabled: true } }),
  useGraphTokenQuery: () => ({ data: { access_token: 'graph-token' } }),
  useInteractionHealthCheck: () => async () => true,
  useUploadFileMutation: (options: UploadMutationOptions) => ({
    mutate: (body: FormData) => {
      mockUploads.push({ body, options });
    },
  }),
}));

/** The Graph download is an external API; the bytes it returns are what matter here. */
jest.mock('~/data-provider/Files', () => ({
  useSharePointBatchDownload: () => ({
    mutateAsync: async ({ files }: { files: SharePointFile[] }) =>
      files.map((file) => new File(['%PDF-'], file.name, { type: 'application/pdf' })),
  }),
}));

/** jsdom cannot originate a native file drag, so the drop target's handler is taken directly. */
jest.mock('react-dnd', () => ({
  useDrop: (spec: () => { drop: (item: { files: File[] }) => void }) => {
    mockDrop = spec().drop;
    return [{ canDrop: false, isOver: false }, () => undefined];
  },
}));

/* Barrels narrowed to the real modules these hooks use, so loading them does not pull in the
 * whole application. */
jest.mock('~/Providers', () => ({
  ...jest.requireActual<typeof import('~/Providers/AgentsMapContext')>(
    '~/Providers/AgentsMapContext',
  ),
  ...jest.requireActual<typeof import('~/Providers/ChatFormContext')>(
    '~/Providers/ChatFormContext',
  ),
  ...jest.requireActual<typeof import('~/Providers/DragDropContext')>(
    '~/Providers/DragDropContext',
  ),
  ...jest.requireActual<typeof import('~/Providers/UploadModalContext')>(
    '~/Providers/UploadModalContext',
  ),
}));

jest.mock('~/hooks/Agents', () => ({
  useAgentCapabilities: jest.requireActual<typeof import('~/hooks/Agents/useAgentCapabilities')>(
    '~/hooks/Agents/useAgentCapabilities',
  ).default,
  useGetAgentsConfig: jest.requireActual<typeof import('~/hooks/Agents/useGetAgentsConfig')>(
    '~/hooks/Agents/useGetAgentsConfig',
  ).default,
}));

jest.mock('~/hooks', () => ({
  useLocalize:
    jest.requireActual<typeof import('~/hooks/useLocalize')>('~/hooks/useLocalize').default,
  useAgentCapabilities: jest.requireActual<typeof import('~/hooks/Agents/useAgentCapabilities')>(
    '~/hooks/Agents/useAgentCapabilities',
  ).default,
  useGetAgentsConfig: jest.requireActual<typeof import('~/hooks/Agents/useGetAgentsConfig')>(
    '~/hooks/Agents/useGetAgentsConfig',
  ).default,
  useAgentToolPermissions: jest.requireActual<
    typeof import('~/hooks/Agents/useAgentToolPermissions')
  >('~/hooks/Agents/useAgentToolPermissions').default,
}));

jest.mock('~/hooks/Files', () => ({
  useFileHandlingNoChatContext: jest.requireActual<typeof import('~/hooks/Files/useFileHandling')>(
    '~/hooks/Files/useFileHandling',
  ).useFileHandlingNoChatContext,
}));

/* Composer concerns the paste path renders alongside, none of which touch an upload. */
jest.mock('~/hooks/Messages/useLatestMessage', () => ({ useLatestMessageMeta: () => undefined }));
jest.mock('~/hooks/Input/useComposerBindings', () => ({
  __esModule: true,
  default: () => ({
    shortcutsEnabled: false,
    submitOverride: undefined,
    yieldedChords: new Set<string>(),
  }),
}));
jest.mock('~/hooks/AuthContext', () => ({ useAuthContext: () => ({ user: undefined }) }));

const conversation = {
  conversationId: 'convo-1',
  endpoint: EModelEndpoint.agents,
  endpointType: EModelEndpoint.agents,
  agent_id: Constants.EPHEMERAL_AGENT_ID,
} as TConversation;

/** The fields every unified upload sends, whichever way the file arrived. */
const UNIFIED_UPLOAD = {
  endpoint: EModelEndpoint.agents,
  endpointType: EModelEndpoint.agents,
  conversationId: 'convo-1',
  message_file: 'true',
  agent_id: Constants.EPHEMERAL_AGENT_ID,
};

const report = () => new File(['%PDF-'], 'report.pdf', { type: 'application/pdf' });

/** What every entry point tells the user when the endpoint refuses the file's type. */
const REFUSED_TYPE_TOAST = {
  message: 'Unsupported file type: application/pdf',
  status: 'error',
  duration: 5000,
};

type Toast = { status?: string };
const errorToasts = (): Toast[] =>
  mockShowToast.mock.calls.flatMap(([toast]: [Toast]) => (toast.status === 'error' ? [toast] : []));

function createChat(): TestChat {
  let staged = new Map<string, ExtendedFile>();
  const chat: ChatFiles = {
    index: 0,
    conversation,
    isSubmitting: false,
    files: staged,
    setFiles: (action) => {
      staged = typeof action === 'function' ? action(staged) : action;
    },
    setFilesLoading: () => undefined,
  };
  return { chat, staged: () => staged };
}

function providers({ chat }: TestChat) {
  const queryClient = new QueryClient();
  return function Providers({ children }: { children: React.ReactNode }) {
    const form = useForm<ChatFormValues>();
    return (
      <QueryClientProvider client={queryClient}>
        <RecoilRoot>
          <ToastContext.Provider value={{ showToast: mockShowToast }}>
            <ChatContext.Provider value={chat as ChatContract}>
              <ChatFormProvider {...form}>
                <UploadModalProvider>
                  <DragDropProvider>{children}</DragDropProvider>
                </UploadModalProvider>
              </ChatFormProvider>
            </ChatContext.Provider>
          </ToastContext.Provider>
        </RecoilRoot>
      </QueryClientProvider>
    );
  };
}

/** The attach half of the composer palette, wired the way `Palette` wires it. */
function usePalette({ chat }: TestChat) {
  const target = useAttachTarget(conversation, false);
  const attach = useAttachItems({
    agentId: conversation.agent_id,
    endpoint: conversation.endpoint,
    endpointType: target.endpointType,
    endpointFileConfig: target.endpointFileConfig,
    useResponsesApi: target.useResponsesApi,
    conversationId: conversation.conversationId ?? Constants.NEW_CONVO,
    conversation,
    files: chat.files,
    setFiles: chat.setFiles,
    setFilesLoading: chat.setFilesLoading,
    isUnifiedMode: isUnifiedUploadMode(target.endpointFileConfig, target.canAttach),
  });
  const attachExisting = useAttachExisting({
    files: chat.files,
    setFiles: chat.setFiles,
    conversation,
    endpoint: conversation.endpoint,
    endpointType: target.endpointType,
    endpointFileConfig: target.endpointFileConfig,
  });
  return { attach, attachExisting };
}

/** What the server learns from an upload, less the per-upload id and the bytes. */
const uploadFields = (body: FormData): Record<string, string> =>
  Object.fromEntries(
    Array.from(body.entries()).flatMap<[string, string]>(([key, value]) =>
      key === 'file_id' || key === 'file' ? [] : [[key, String(value)]],
    ),
  );

/** The fields the send payload copies off a staged file (`useChatFunctions`). */
const messageFile = (file: ExtendedFile | undefined) => ({
  file_id: file?.file_id,
  filepath: file?.filepath,
  filename: file?.filename,
  type: file?.type,
  llmDeliveryPath: file?.llmDeliveryPath,
  height: file?.height,
  width: file?.width,
});

async function settled(test: TestChat): Promise<Attached> {
  await waitFor(() => expect(mockUploads).toHaveLength(1));
  const { body } = mockUploads[0];
  return { body, staged: test.staged().get(String(body.get('file_id'))), chat: test };
}

type Dropped = TestChat & { chooserOpen: () => boolean };

async function startDrop(file: File): Promise<Dropped> {
  const test = createChat();
  const { result } = renderHook(
    () => ({ drag: useDragHelpers(), modal: useUploadModalContext() }),
    { wrapper: providers(test) },
  );
  act(() => mockDrop?.({ files: [file] }));
  return { ...test, chooserOpen: () => result.current.modal.isVisible };
}

const pasteEvent = (files: File[]): React.ClipboardEvent<HTMLTextAreaElement> => {
  const event: Pick<React.ClipboardEvent<HTMLTextAreaElement>, 'preventDefault'> & {
    clipboardData: Pick<DataTransfer, 'getData'> & { files: ArrayLike<File> & Iterable<File> };
  } = { clipboardData: { files, getData: () => '' }, preventDefault: () => undefined };
  return event as React.ClipboardEvent<HTMLTextAreaElement>;
};

async function startPaste(file: File): Promise<TestChat> {
  const test = createChat();
  const { result } = renderHook(
    () =>
      useTextarea({
        textAreaRef: { current: document.createElement('textarea') },
        submitButtonRef: { current: document.createElement('button') },
        setIsScrollable: () => undefined,
        enterToSend: true,
      }),
    { wrapper: providers(test) },
  );
  act(() => result.current.handlePaste(pasteEvent([file])));
  return test;
}

/** Chooses a palette row, which has to be on offer for the pick to mean anything. */
function choose(entries: AttachEntry[], id: string) {
  const entry = entries.find((candidate) => candidate.id === id);
  expect(entry).toBeDefined();
  act(() => entry?.onSelect());
}

const changeEvent = (input: HTMLInputElement): React.ChangeEvent<HTMLInputElement> => {
  const event: Pick<React.ChangeEvent<HTMLInputElement>, 'target' | 'stopPropagation'> = {
    target: input,
    stopPropagation: () => undefined,
  };
  return event as React.ChangeEvent<HTMLInputElement>;
};

async function startPick(file: File): Promise<TestChat> {
  const test = createChat();
  const { result } = renderHook(() => usePalette(test), { wrapper: providers(test) });
  const input = document.createElement('input');
  input.click = () => undefined;
  Object.defineProperty(result.current.attach.inputRef, 'current', { value: input });
  choose(result.current.attach.entries, 'local:unified');
  Object.defineProperty(input, 'files', { value: [file] });
  act(() => result.current.attach.onFileChange(changeEvent(input)));
  return test;
}

async function startSharePoint(file: File): Promise<TestChat> {
  const test = createChat();
  const { result } = renderHook(() => usePalette(test), { wrapper: providers(test) });
  choose(result.current.attach.entries, 'sharepoint:unified');
  const picked: SharePointFile = {
    id: 'sp-1',
    name: file.name,
    size: file.size,
    webUrl: 'https://contoso.sharepoint.com/report.pdf',
    downloadUrl: 'https://graph.microsoft.com/download/sp-1',
    driveId: 'drive-1',
    itemId: 'item-1',
    sharePointItem: {},
  };
  await act(async () => {
    await result.current.attach.onSharePointFilesSelected([picked]);
  });
  return test;
}

const drop = async (file: File): Promise<Attached> => settled(await startDrop(file));
const paste = async (file: File): Promise<Attached> => settled(await startPaste(file));
const pick = async (file: File): Promise<Attached> => settled(await startPick(file));
const pickFromSharePoint = async (file: File): Promise<Attached> =>
  settled(await startSharePoint(file));

beforeAll(() => {
  global.URL.createObjectURL = jest.fn(() => 'blob:preview');
  global.URL.revokeObjectURL = jest.fn();
});

beforeEach(() => {
  mockUploads = [];
  mockDrop = undefined;
  mockFileConfig = {};
  mockShowToast.mockClear();
  localStorage.clear();
});

describe('unified upload entry points', () => {
  it.each([
    ['drag and drop', drop],
    ['a file paste', paste],
    ['the local picker', pick],
    ['the SharePoint picker', pickFromSharePoint],
  ])('uploads through %s with no destination', async (_entry, attach) => {
    const { body, staged } = await attach(report());
    expect(uploadFields(body)).toEqual(UNIFIED_UPLOAD);
    expect(body.get('file')).toHaveProperty('name', expect.stringMatching(/report\.pdf$/));
    expect(staged).toBeDefined();
    expect(staged?.tool_resource).toBeUndefined();
  });

  it.each([
    ['drag and drop', startDrop],
    ['the SharePoint picker', startSharePoint],
  ])(
    'refuses a type the endpoint does not accept through %s the same way',
    async (_entry, start) => {
      mockFileConfig = {
        endpoints: { [EModelEndpoint.agents]: { supportedMimeTypes: ['^image/png$'] } },
      };
      const test = await start(report());
      await waitFor(() => expect(errorToasts()).toEqual([REFUSED_TYPE_TOAST]));
      expect(mockUploads).toHaveLength(0);
      expect(test.staged().size).toBe(0);
    },
  );

  it.each([
    [{}, false],
    [{ legacyFileUploadUX: true }, true],
  ])(
    'offers the destination chooser on a drop only where the deployment keeps the legacy menu (%o: %s)',
    async (fileConfig, chooserOpen) => {
      mockFileConfig = fileConfig;
      const test = await startDrop(report());
      await waitFor(() =>
        expect({ chooserOpen: test.chooserOpen(), uploads: mockUploads.length }).toEqual({
          chooserOpen,
          uploads: chooserOpen ? 0 : 1,
        }),
      );
    },
  );

  it('stages a re-attached file exactly as the upload that produced it', async () => {
    const uploaded = await pick(report());
    const tempId = String(uploaded.body.get('file_id'));
    const record: TFileUpload = {
      user: 'user-1',
      file_id: 'server-file',
      temp_file_id: tempId,
      bytes: 5,
      embedded: false,
      filename: 'report.pdf',
      filepath: '/uploads/user-1/server-file__report.pdf',
      object: 'file',
      type: 'application/pdf',
      usage: 0,
      source: FileSources.local,
      context: FileContext.message_attachment,
      llmDeliveryPath: 'none',
    };
    act(() => mockUploads[0].options.onSuccess?.(record, uploaded.body));
    await waitFor(() => expect(uploaded.chat.staged().get(tempId)?.progress).toBe(1));

    const reattached = createChat();
    const { result } = renderHook(() => usePalette(reattached), {
      wrapper: providers(reattached),
    });
    act(() => result.current.attachExisting(record));

    const fromUpload = uploaded.chat.staged().get(tempId);
    const fromLibrary = reattached.staged().get(record.file_id);
    expect(fromLibrary).toBeDefined();
    expect(messageFile(fromLibrary)).toEqual(messageFile(fromUpload));
    expect(fromLibrary?.tool_resource).toBeUndefined();
    expect(fromUpload?.tool_resource).toBeUndefined();
  });
});
