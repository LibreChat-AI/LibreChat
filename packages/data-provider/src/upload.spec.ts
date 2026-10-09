import { uploadEventStream } from './upload';
import request from './request';

jest.mock('./request', () => ({
  __esModule: true,
  default: {
    authenticatedFetch: jest.fn(),
  },
}));

const authenticatedFetch = request.authenticatedFetch as jest.Mock;

const createStream = (...chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

const createFormData = () => {
  const formData = new FormData();
  formData.set('file_id', 'temporary-id');
  return formData;
};

describe('uploadEventStream', () => {
  beforeEach(() => {
    authenticatedFetch.mockReset();
  });

  it('parses SSE events split across chunks and waits for the terminal close event', async () => {
    authenticatedFetch.mockResolvedValue(
      new Response(
        createStream(
          'event:heartbeat\r\ndata:{"keepAlive":1}\r\n\r\nevent:da',
          'ta\r\ndata:{"file_id":"stored-id","temp_file_id":"temporary-id"}\r\n\r\n',
          'event:close\r\ndata:{}\r\n\r\n',
        ),
        { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } },
      ),
    );

    await expect(uploadEventStream('/api/files', createFormData())).resolves.toMatchObject({
      file_id: 'stored-id',
      temp_file_id: 'temporary-id',
    });
  });

  it('falls back to a JSON upload response for mixed-version servers', async () => {
    authenticatedFetch.mockResolvedValue(
      new Response('{"file_id":"stored-id","temp_file_id":"temporary-id"}', {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      }),
    );

    await expect(uploadEventStream('/api/files', createFormData())).resolves.toMatchObject({
      file_id: 'stored-id',
      temp_file_id: 'temporary-id',
    });
  });

  it('maps streamed failures to the existing upload error shape', async () => {
    authenticatedFetch.mockResolvedValue(
      new Response(
        createStream(
          'event:error\n',
          'data:{"message":"Unsupported file","temp_file_id":"temporary-id","code":422,"display_to_user":true}\n\n',
        ),
        { headers: { 'Content-Type': 'text/event-stream' } },
      ),
    );

    await expect(uploadEventStream('/api/files', createFormData())).rejects.toMatchObject({
      name: 'CustomAppError',
      code: 422,
      file_id: 'temporary-id',
      display_to_user: true,
      response: { data: { message: 'Unsupported file' } },
    });
  });

  it('maps pre-stream HTTP failures to the existing upload error shape', async () => {
    authenticatedFetch.mockResolvedValue(
      new Response('{"message":"File is too large"}', {
        status: 413,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(uploadEventStream('/api/files', createFormData())).rejects.toMatchObject({
      name: 'CustomAppError',
      code: 413,
      file_id: 'temporary-id',
      response: { data: { message: 'File is too large' } },
    });
  });

  it('cancels a stalled stream when heartbeats stop', async () => {
    jest.useFakeTimers();
    try {
      authenticatedFetch.mockResolvedValue(
        new Response(new ReadableStream<Uint8Array>(), {
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      );

      const result = uploadEventStream('/api/files', createFormData()).catch(
        (error: Error) => error,
      );
      await jest.advanceTimersByTimeAsync(15_000);

      await expect(result).resolves.toMatchObject({
        message: expect.stringContaining('timed out waiting for a heartbeat'),
      });
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('preserves the canceled-upload error contract when the signal aborts', async () => {
    const controller = new AbortController();
    controller.abort('User aborted upload');
    authenticatedFetch.mockRejectedValue('User aborted upload');

    await expect(
      uploadEventStream('/api/files', createFormData(), controller.signal),
    ).rejects.toMatchObject({ code: 'ERR_CANCELED' });
  });

  it('preserves the upload abort signal', async () => {
    const controller = new AbortController();
    authenticatedFetch.mockResolvedValue(
      new Response('{"file_id":"stored-id","temp_file_id":"temporary-id"}', {
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await uploadEventStream('/api/files', createFormData(), controller.signal);

    expect(authenticatedFetch).toHaveBeenCalledWith('/api/files', {
      method: 'POST',
      body: expect.any(FormData),
      headers: { Accept: 'text/event-stream' },
      signal: controller.signal,
    });
  });
});
