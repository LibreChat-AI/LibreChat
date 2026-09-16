/* eslint jest/expect-expect: ["warn", { "assertFunctionNames": ["expect", "refused"] }] */
import { renderHook } from '@testing-library/react';
import { FileSources, EModelEndpoint, mergeFileConfig } from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';
import type { ExtendedFile } from '~/common';
import useAttachExisting from '../useAttachExisting';

/**
 * Re-attaching a file already on the server. Every branch here is a refusal,
 * and an inverted one either blocks every re-attachment or stages a file the
 * endpoint will reject at send time, when the words are already gone.
 */

const mockShowToast = jest.fn();
const mockAddFile = jest.fn();
let mockFileMap: Record<string, TFile | undefined>;
let mockConversation: { endpoint?: string | null; endpointType?: string } | null;
let mockStaged: Map<string, ExtendedFile>;
/** Raw, not merged: the hook's own `select` merges it, and merging twice
 *  scales the megabyte limits twice and puts them out of reach. */
let mockFileConfig: Parameters<typeof mergeFileConfig>[0];

jest.mock('@librechat/client', () => ({
  useToastContext: () => ({ showToast: mockShowToast }),
}));

jest.mock('~/Providers', () => ({
  useFileMapContext: () => mockFileMap,
}));

jest.mock('~/data-provider', () => ({
  useGetFileConfig: ({ select }: { select?: (data: unknown) => unknown }) => ({
    data: select != null ? select(mockFileConfig) : mockFileConfig,
  }),
}));

jest.mock('~/hooks/Files/useUpdateFiles', () => ({
  __esModule: true,
  default: () => ({ addFile: mockAddFile }),
}));

jest.mock('~/hooks/useLocalize', () => ({
  __esModule: true,
  default: () => (key: string) => key,
}));

const MB = 1024 * 1024;
/** The endpoint config is written in megabytes; it scales them itself. */

const file = (over: Partial<TFile> = {}): TFile =>
  ({
    file_id: 'f1',
    filename: 'notes.pdf',
    filepath: '/files/notes.pdf',
    type: 'application/pdf',
    bytes: MB,
    source: FileSources.local,
    ...over,
  }) as TFile;

const staged = (over: Partial<ExtendedFile> = {}): ExtendedFile =>
  ({ file_id: 'other', size: MB, progress: 1, ...over }) as ExtendedFile;

const attach = (
  target: TFile = file(),
  resolved: Partial<Parameters<typeof useAttachExisting>[0]> = {},
) => {
  const { result } = renderHook(() =>
    useAttachExisting({
      files: mockStaged,
      setFiles: jest.fn(),
      conversation: mockConversation as never,
      ...resolved,
    }),
  );
  result.current(target);
};

describe('useAttachExisting', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFileMap = { f1: file() };
    mockConversation = { endpoint: EModelEndpoint.openAI };
    mockStaged = new Map();
    mockFileConfig = {
      endpoints: {
        [EModelEndpoint.openAI]: {
          fileLimit: 3,
          fileSizeLimit: 5,
          totalSizeLimit: 10,
          supportedMimeTypes: ['application/pdf'],
        },
      },
    };
  });

  it('stages the file it was given, marked as already uploaded', () => {
    attach();
    expect(mockAddFile).toHaveBeenCalledWith(
      expect.objectContaining({
        file_id: 'f1',
        filename: 'notes.pdf',
        progress: 1,
        attached: true,
        size: MB,
      }),
    );
    expect(mockShowToast).not.toHaveBeenCalled();
  });

  /* The palette's short recent request routinely beats the unbounded file-map
     query on a cold load, so the row is clickable before `fileMap` has it. */
  it('stages a file the shared file map has not caught up with yet', () => {
    mockFileMap = {};
    attach();
    expect(mockAddFile).toHaveBeenCalledWith(
      expect.objectContaining({ file_id: 'f1', filename: 'notes.pdf', size: MB }),
    );
    expect(mockShowToast).not.toHaveBeenCalled();
  });

  /* The recent-files request refreshes signed S3 URLs independently of the
     full file-map query, so the visible row can be fresher than that cache. */
  it('prefers the freshly signed row over a stale shared file-map record', () => {
    mockFileMap = { f1: file({ filepath: 'https://s3.example/expired' }) };
    attach(file({ filepath: 'https://s3.example/refreshed' }));
    expect(mockAddFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filepath: 'https://s3.example/refreshed',
        preview: 'https://s3.example/refreshed',
      }),
    );
  });

  describe('refusals', () => {
    const refused = (message: string) => {
      expect(mockAddFile).not.toHaveBeenCalled();
      expect(mockShowToast).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining(message), status: 'error' }),
      );
    };

    it('refuses a file with nothing to identify where it is stored', () => {
      mockFileMap = {};
      attach(file({ source: undefined }));
      refused('com_ui_attach_error');
    });

    it('refuses when there is no conversation to attach to', () => {
      mockConversation = null;
      attach();
      refused('com_ui_attach_error');
    });

    it('refuses OpenAI-stored files outside the assistants endpoint', () => {
      attach(file({ source: FileSources.openai }));
      refused('com_ui_attach_error_openai');
    });

    it('refuses when the endpoint has uploads switched off', () => {
      mockFileConfig = { endpoints: { [EModelEndpoint.openAI]: { disabled: true } } };
      attach();
      refused('com_ui_attach_error_disabled');
    });

    it('refuses once the endpoint is already holding its limit', () => {
      mockStaged = new Map([
        ['a', staged({ file_id: 'a' })],
        ['b', staged({ file_id: 'b' })],
        ['c', staged({ file_id: 'c' })],
      ]);
      attach();
      refused('com_ui_attach_error_limit');
    });

    it('refuses a file bigger than the endpoint takes', () => {
      attach(file({ bytes: 6 * MB }));
      refused('com_ui_attach_error_size');
    });

    /* The upload path rejects only `size > fileSizeLimit` and the backend filter
       accepts `bytes <= fileSizeLimit`, so a file sitting exactly on the limit
       uploads fine and has to stay re-attachable from the palette. */
    it('accepts a file sitting exactly on the endpoint limit', () => {
      attach(file({ bytes: 5 * MB }));
      expect(mockAddFile).toHaveBeenCalled();
    });

    it('refuses a type the endpoint does not accept', () => {
      const zip = file({ type: 'application/zip' });
      attach(zip);
      refused('com_ui_attach_error_type');
    });

    it('refuses when it would put the staged files over the total', () => {
      mockStaged = new Map([['big', staged({ file_id: 'big', size: 9.5 * MB })]]);
      attach();
      refused('com_ui_attach_error_total_size');
    });
  });

  /* Re-attaching a file that is already staged replaces it, so its own size
     must come out of the running total before the check. */
  it('counts a file it is replacing out of the total', () => {
    mockFileConfig = {
      endpoints: {
        [EModelEndpoint.openAI]: {
          fileSizeLimit: 8,
          totalSizeLimit: 10,
          supportedMimeTypes: ['application/pdf'],
        },
      },
    };
    mockStaged = new Map([['f1', staged({ file_id: 'f1', size: 6 * MB })]]);
    attach(file({ bytes: 6 * MB }));
    expect(mockAddFile).toHaveBeenCalled();
  });

  it('warns but still attaches a non-OpenAI file on the assistants endpoint', () => {
    mockConversation = { endpoint: EModelEndpoint.assistants };
    mockFileConfig = {
      endpoints: { [EModelEndpoint.assistants]: { supportedMimeTypes: ['application/pdf'] } },
    };
    attach();
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'com_ui_attach_warn_endpoint', status: 'warning' }),
    );
    expect(mockAddFile).toHaveBeenCalled();
  });

  it('uses the resolved agent provider instead of the stale conversation endpoint', () => {
    attach(file({ source: FileSources.openai }), {
      endpoint: EModelEndpoint.assistants,
      endpointFileConfig: {
        supportedMimeTypes: [/^application\/pdf$/],
        fileSizeLimit: 5 * MB,
      },
    });

    expect(mockAddFile).toHaveBeenCalled();
    expect(mockShowToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: 'com_ui_attach_error_openai' }),
    );
  });
});
