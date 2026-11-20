import {
  createOwnedBlobFileDeleter,
  extractAzureBlobPath,
  extractFirebaseBlobPath,
} from './ownedBlobDelete';

describe.each([
  {
    source: 'Azure',
    filepath: 'https://example.blob.core.windows.net/files/uploads/author-1/file.txt',
    extractPath: (url: string) => extractAzureBlobPath(url, 'files'),
  },
  {
    source: 'Firebase',
    filepath: 'https://firebasestorage.googleapis.com/v0/b/bucket/o/uploads%2Fauthor-1%2Ffile.txt',
    extractPath: extractFirebaseBlobPath,
  },
])('$source owner-aware deletion', ({ filepath, extractPath }) => {
  const deleteBlob = jest.fn().mockResolvedValue(undefined);
  const deleteRagFile = jest.fn().mockResolvedValue(undefined);
  const remove = createOwnedBlobFileDeleter({
    extractPath,
    deleteBlob,
    deleteRagFile,
    isMissing: (error) => (error as { code?: string }).code === 'missing',
  });
  const req = { user: { id: 'author-1' } };

  beforeEach(() => {
    deleteBlob.mockReset().mockResolvedValue(undefined);
    deleteRagFile.mockClear();
  });

  it('deletes a file under the request owner', async () => {
    const file = { filepath, user: 'author-1' };
    await remove(req, file);
    expect(deleteBlob).toHaveBeenCalledWith('uploads/author-1/file.txt');
    expect(deleteRagFile).toHaveBeenCalledWith({ userId: 'author-1', file });
  });

  it('retains the blob when vector cleanup returns false', async () => {
    deleteRagFile.mockResolvedValueOnce(false);
    await expect(remove(req, { filepath })).rejects.toThrow('Vector deletion was not confirmed');
    expect(deleteBlob).not.toHaveBeenCalled();
  });

  it('rejects an owner mismatch before deleting either blob or RAG data', async () => {
    await expect(
      remove({ user: { id: 'author-2' } }, { filepath, user: 'author-1' }),
    ).rejects.toThrow('Invalid file path');
    expect(deleteBlob).not.toHaveBeenCalled();
    expect(deleteRagFile).not.toHaveBeenCalled();
  });

  it('does not let descriptor ownership change the request owner', async () => {
    const file = { filepath, user: 'descriptor-owner' };
    await remove(req, file);
    expect(deleteBlob).toHaveBeenCalledWith('uploads/author-1/file.txt');
    expect(deleteRagFile).toHaveBeenCalledWith({ userId: 'author-1', file });
  });

  it('rejects an empty request owner without invoking either provider', async () => {
    await expect(remove({ user: { id: '' } }, { filepath, user: 'author-1' })).rejects.toThrow(
      'Invalid file path',
    );
    expect(deleteBlob).not.toHaveBeenCalled();
    expect(deleteRagFile).not.toHaveBeenCalled();
  });

  it('attempts vector cleanup before deleting remote storage', async () => {
    deleteBlob.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(remove(req, { filepath, user: 'author-1' })).rejects.toThrow(
      'storage unavailable',
    );
    expect(deleteRagFile).toHaveBeenCalled();
  });

  it('treats an already missing blob as deleted and still cleans up RAG data', async () => {
    deleteBlob.mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'missing' }));
    await remove(req, { filepath, user: 'author-1' });
    expect(deleteRagFile).toHaveBeenCalledWith({ userId: 'author-1', file: expect.any(Object) });
  });
});
