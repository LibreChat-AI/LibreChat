import type { EToolResources } from './types/tools';
import type { TFileUpload } from './types/files';
import request from './request';

const EVENT_STREAM_MEDIA_TYPE = 'text/event-stream';
const HEARTBEAT_TIMEOUT_MS = 15_000;

interface UploadErrorData {
  message?: string;
  code?: number;
  temp_file_id?: string;
  tool_resource?: EToolResources;
  display_to_user?: boolean;
}

interface ParsedEvent {
  type: string;
  data: string;
}

class FileUploadError extends Error {
  public code: number;
  public file_id: string;
  public tool_resource?: EToolResources;
  public display_to_user: boolean;
  public response: { data: { message: string } };

  constructor(
    message: string,
    fileId: string,
    toolResource?: EToolResources,
    displayToUser = false,
    code = 0,
  ) {
    super(message);
    this.name = 'CustomAppError';
    this.code = code;
    this.file_id = fileId;
    this.tool_resource = toolResource;
    this.display_to_user = displayToUser;
    this.response = { data: { message: displayToUser ? message : '' } };
  }
}

class UploadCanceledError extends Error {
  public code = 'ERR_CANCELED' as const;
}

const getFileId = (formData: FormData) => String(formData.get('file_id') ?? '');

const getToolResource = (formData: FormData) =>
  (formData.get('tool_resource') as EToolResources | null) ?? undefined;

const parseEvent = (message: string): ParsedEvent => {
  let type = 'message';
  const data: string[] = [];

  for (const line of message.split(/\r?\n/)) {
    if (line.startsWith('event:')) {
      type = line.slice('event:'.length).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      data.push(line.slice('data:'.length).trimStart());
    }
  }

  return { type, data: data.join('\n') };
};

const createHttpError = async (response: Response, formData: FormData) => {
  let message = `Server responded with status: ${response.status}`;
  try {
    const data = (await response.json()) as { message?: string };
    message = data.message || message;
  } catch {
    // Preserve the status-based fallback for non-JSON responses.
  }

  return new FileUploadError(
    message,
    getFileId(formData),
    getToolResource(formData),
    true,
    response.status,
  );
};

const createStreamError = (data: string, formData: FormData) => {
  let error: UploadErrorData;
  try {
    error = JSON.parse(data) as UploadErrorData;
  } catch {
    error = { message: data };
  }

  return new FileUploadError(
    error.message || 'File upload failed.',
    error.temp_file_id || getFileId(formData),
    error.tool_resource || getToolResource(formData),
    error.display_to_user ?? false,
    error.code ?? 0,
  );
};

const readEventStream = async (
  stream: ReadableStream<Uint8Array>,
  formData: FormData,
): Promise<TFileUpload> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: TFileUpload | null = null;
  let streamEnded = false;
  let timeoutError: Error | null = null;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;

  const resetHeartbeatTimer = () => {
    clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(() => {
      timeoutError = new Error('Upload connection timed out waiting for a heartbeat.');
      void reader.cancel(timeoutError);
    }, HEARTBEAT_TIMEOUT_MS);
  };

  resetHeartbeatTimer();

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        streamEnded = true;
        if (timeoutError) {
          throw timeoutError;
        }
        if (result) {
          return result;
        }
        throw new Error('Upload connection closed before completion.');
      }

      buffer += decoder.decode(value, { stream: true });
      const messages = buffer.split(/\r?\n\r?\n/);
      buffer = messages.pop() ?? '';

      for (const message of messages) {
        const event = parseEvent(message);
        if (event.type === 'heartbeat') {
          resetHeartbeatTimer();
          continue;
        }
        if (event.type === 'error') {
          throw createStreamError(event.data, formData);
        }
        if (event.type === 'data') {
          result = JSON.parse(event.data) as TFileUpload;
          continue;
        }
        if (event.type === 'close') {
          if (result) {
            return result;
          }
          throw new Error('Upload stream closed without a result.');
        }
      }
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new UploadCanceledError('Upload canceled.');
    }
    throw error;
  } finally {
    clearTimeout(heartbeatTimer);
    if (!streamEnded) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
};

export async function uploadEventStream(
  url: string,
  formData: FormData,
  signal?: AbortSignal | null,
): Promise<TFileUpload> {
  try {
    const response = await request.authenticatedFetch(url, {
      method: 'POST',
      body: formData,
      headers: { Accept: EVENT_STREAM_MEDIA_TYPE },
      signal: signal ?? undefined,
    });
    if (!response.ok) {
      throw await createHttpError(response, formData);
    }

    const contentType = response.headers.get('Content-Type')?.toLowerCase() ?? '';
    if (!contentType.includes(EVENT_STREAM_MEDIA_TYPE)) {
      return (await response.json()) as TFileUpload;
    }
    if (!response.body) {
      throw new Error('No upload response body received.');
    }

    return await readEventStream(response.body, formData);
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      throw new UploadCanceledError('Upload canceled.');
    }
    throw error;
  }
}
