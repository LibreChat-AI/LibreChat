import { executeFileSearchQuery } from './search';

const hit = (source: string): [{ page_content: string; metadata: { source: string } }, number] => [
  { page_content: `content of ${source}`, metadata: { source } },
  0.1,
];

function setup() {
  const httpClient = {
    post: jest.fn(
      (_url: string, body: { file_id: string }, _config?: { headers?: Record<string, string> }) =>
        Promise.resolve({ data: [hit(body.file_id)] }),
    ),
  };
  const generateShortLivedToken = jest.fn((userId: string) => `token-for-${userId}`);
  const run = (files: Parameters<typeof executeFileSearchQuery>[0]['files']) =>
    executeFileSearchQuery({
      query: 'policy',
      userId: 'member',
      files,
      fileCitations: false,
      ragApiUrl: 'http://rag',
      httpClient: httpClient as never,
      generateShortLivedToken,
      logAxiosError: jest.fn() as never,
      selectFileCitationSources: jest.fn(() => []) as never,
      logger: { debug: jest.fn() },
    });
  return { httpClient, generateShortLivedToken, run };
}

const authorizationFor = (httpClient: ReturnType<typeof setup>['httpClient'], fileId: string) =>
  httpClient.post.mock.calls.find(([, body]) => body.file_id === fileId)?.[2]?.headers
    ?.Authorization;

describe('executeFileSearchQuery search owner', () => {
  it("queries the requester's own files with the requester's token", async () => {
    const { httpClient, run } = setup();
    await run([{ file_id: 'mine' }]);
    expect(authorizationFor(httpClient, 'mine')).toBe('Bearer token-for-member');
  });

  it("queries a shared project's files as their owner, and only those", async () => {
    const { httpClient, generateShortLivedToken, run } = setup();
    await run([
      { file_id: 'mine' },
      { file_id: 'owners-a', searchOwnerId: 'owner' },
      { file_id: 'owners-b', searchOwnerId: 'owner' },
    ]);
    expect(authorizationFor(httpClient, 'mine')).toBe('Bearer token-for-member');
    expect(authorizationFor(httpClient, 'owners-a')).toBe('Bearer token-for-owner');
    expect(authorizationFor(httpClient, 'owners-b')).toBe('Bearer token-for-owner');
    expect(generateShortLivedToken.mock.calls.map(([id]) => id).sort()).toEqual([
      'member',
      'owner',
    ]);
  });
});
