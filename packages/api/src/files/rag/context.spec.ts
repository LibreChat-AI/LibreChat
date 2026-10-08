import { createRagContextHandlers } from './context';

const req = { user: { id: 'user-1' } };
const files = ['a.pdf', 'b.pdf', 'c.pdf'].map((filename, index) => ({
  file_id: `file-${index}`,
  filename,
  type: 'application/pdf',
  embedded: true,
}));

function setup(userMessageContent?: string, fullContextSetting?: string, ragApiUrl = 'http://rag') {
  const httpClient = {
    get: jest.fn().mockResolvedValue({ data: 'whole document' }),
    post: jest.fn().mockResolvedValue({ data: [[{ page_content: 'Relevant excerpt' }, 0.1]] }),
  };
  const generateShortLivedToken = jest.fn(() => 'signed-token');
  const isEnabled = jest.fn((setting?: string | boolean | null) => setting === 'true');
  const logAxiosError = jest.fn(() => 'logged');
  const handlers = createRagContextHandlers({
    req,
    userMessageContent,
    ragApiUrl,
    fullContextSetting,
    httpClient,
    generateShortLivedToken,
    isEnabled,
    logAxiosError,
  });
  return { handlers, httpClient, generateShortLivedToken, isEnabled, logAxiosError };
}

describe('legacy RAG context', () => {
  it.each(['', ' ', '\t\n ', undefined])(
    'skips searches for a blank message (%j), even across several files',
    async (text) => {
      const { handlers, httpClient } = setup(text);
      for (const file of files) {
        await handlers?.processFile(file);
      }
      expect(await handlers?.createContext()).toBe('');
      expect(httpClient.post).not.toHaveBeenCalled();
      expect(httpClient.get).not.toHaveBeenCalled();
    },
  );

  it('retains the original query and formats valid search results', async () => {
    const { handlers, httpClient } = setup('  what is the deadline?  ');
    await handlers?.processFile(files[0]);
    await handlers?.processFile(files[0]);
    expect(await handlers?.createContext()).toContain('Relevant excerpt');
    expect(httpClient.post).toHaveBeenCalledTimes(1);
    expect(httpClient.post).toHaveBeenCalledWith(
      'http://rag/query',
      { file_id: 'file-0', query: '  what is the deadline?  ', k: 4 },
      { headers: { Authorization: 'Bearer signed-token', 'Content-Type': 'application/json' } },
    );
  });

  it('continues to fetch the full document for a blank message in full-context mode', async () => {
    const { handlers, httpClient } = setup('', 'true');
    await handlers?.processFile(files[0]);
    expect(await handlers?.createContext()).toContain('whole document');
    expect(httpClient.post).not.toHaveBeenCalled();
    expect(httpClient.get).toHaveBeenCalledWith('http://rag/documents/file-0/context', {
      headers: { Authorization: 'Bearer signed-token' },
    });
  });

  it('does nothing when RAG is disabled, without looking at the request', () => {
    const { handlers, generateShortLivedToken, isEnabled } = setup('', 'true', '');
    expect(handlers).toBeUndefined();
    expect(generateShortLivedToken).not.toHaveBeenCalled();
    expect(isEnabled).not.toHaveBeenCalled();
  });

  it('preserves failed-request behavior for a nonblank query', async () => {
    const { handlers, httpClient, logAxiosError } = setup('question');
    const failure = new Error('backend unavailable');
    httpClient.post.mockRejectedValueOnce(failure);
    await handlers?.processFile(files[0]);
    await expect(handlers?.createContext()).rejects.toBe(failure);
    expect(logAxiosError).toHaveBeenCalledWith({
      message: 'Error creating context',
      error: failure,
    });
  });
});
