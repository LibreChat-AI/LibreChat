import { extractDocumentTextWithPages, extractPageText } from './pdfjs';

const mockGetDocument = jest.fn();

jest.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument: (...args: unknown[]) => mockGetDocument(...args),
}));

describe('pdfjs cancellation', () => {
  beforeEach(() => {
    mockGetDocument.mockReset();
  });

  test.each([
    [
      'page recovery',
      (signal: AbortSignal) => extractPageText(Buffer.alloc(0), [0], undefined, signal),
    ],
    [
      'whole-document extraction',
      (signal: AbortSignal) =>
        extractDocumentTextWithPages(Buffer.alloc(0), undefined, undefined, signal),
    ],
  ])('stops %s when cancellation occurs during module loading', async (_label, extract) => {
    const cancellation = new AbortController();

    const extraction = extract(cancellation.signal);
    cancellation.abort();

    await expect(extraction).rejects.toMatchObject({ code: 'PARSE_ABORTED' });
    expect(mockGetDocument).not.toHaveBeenCalled();
  });

  test('rethrows a loading-task failure when cancellation destroyed the task', async () => {
    const cancellation = new AbortController();
    const destructionError = new Error('loading task was destroyed');
    const loading = Promise.withResolvers<unknown>();
    const promiseAccessed = Promise.withResolvers<void>();

    mockGetDocument.mockImplementation(() => ({
      get promise() {
        promiseAccessed.resolve();
        return loading.promise;
      },
      destroy: jest.fn(() => {
        loading.reject(destructionError);
        return Promise.resolve();
      }),
    }));

    const extraction = extractPageText(Buffer.alloc(0), [0], undefined, cancellation.signal);
    await promiseAccessed.promise;
    cancellation.abort();

    await expect(extraction).rejects.toBe(destructionError);
  });
});
