import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { FileSources, QueryKeys } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TFile } from 'librechat-data-provider';
import { collectForeignAttachmentClaims, isPasteSubmitted, retainFileDeletion } from '~/utils';
import useDiscardPastedFiles from '../useDiscardPastedFiles';
import { cancelUploads } from '../useFileHandling';

jest.mock('../useFileHandling', () => ({ cancelUploads: jest.fn() }));
jest.mock('~/utils', () => ({
  collectForeignAttachmentClaims: jest.fn(() => new Set<string>()),
  getComposerDraftId: jest.fn((_index, id) => id),
  isPasteSubmitted: jest.fn(() => false),
  retainFileDeletion: jest.fn(),
}));

const file: TFile = {
  file_id: 'stored-paste',
  temp_file_id: 'temporary-paste',
  filename: 'pasted-text.txt',
  filepath: '/uploads/paste.txt',
  type: 'text/plain',
  bytes: 5,
  source: FileSources.local,
  user: 'user',
  embedded: false,
  object: 'file',
  usage: 0,
};

function setup() {
  const client = new QueryClient();
  client.setQueryData([QueryKeys.files], [file]);
  return renderHook(() => useDiscardPastedFiles(0, 'conversation'), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

describe('superseded pasted files', () => {
  beforeEach(() => jest.clearAllMocks());

  it('cancels pending work and retains deletion by server identity', () => {
    const { result } = setup();
    act(() => result.current(['temporary-paste']));
    expect(cancelUploads).toHaveBeenCalledWith(['temporary-paste']);
    expect(retainFileDeletion).toHaveBeenCalledWith({
      file_id: file.file_id,
      filepath: file.filepath,
      source: FileSources.local,
      embedded: false,
    });
  });

  it('never deletes a paste another draft or tab owns', () => {
    jest.mocked(collectForeignAttachmentClaims).mockReturnValueOnce(new Set(['temporary-paste']));
    const { result } = setup();
    act(() => result.current(['stored-paste']));
    expect(retainFileDeletion).not.toHaveBeenCalled();
  });

  it('never deletes a previously submitted paste', () => {
    jest.mocked(isPasteSubmitted).mockReturnValueOnce(true);
    const { result } = setup();
    act(() => result.current(['stored-paste']));
    expect(retainFileDeletion).not.toHaveBeenCalled();
  });

  it('leaves unrelated uploads alone', () => {
    const { result } = setup();
    act(() => result.current(['different-upload']));
    expect(retainFileDeletion).not.toHaveBeenCalled();
  });
});
