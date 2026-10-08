import { EventEmitter } from 'events';
import type { Request, Response } from 'express';
import {
  sendUploadPolicyError,
  sendUploadSuccess,
  shouldUseUploadSse,
  startUploadSseStream,
} from './sse';
import { ContentFilterInputTooLargeError, UninspectableFileError } from '~/protection/files';

describe('sse', () => {
  const createMockReq = (accept?: string): Request =>
    ({ headers: accept ? { accept } : {} }) as Request;

  const createMockRes = (): jest.Mocked<Response> => {
    const res = new EventEmitter() as unknown as jest.Mocked<Response>;
    res.writeHead = jest.fn().mockReturnValue(res);
    res.flushHeaders = jest.fn().mockReturnValue(res);
    res.write = jest.fn().mockReturnValue(true);
    res.end = jest.fn().mockReturnValue(res);
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    Object.defineProperty(res, 'writableEnded', { value: false, writable: true });
    Object.defineProperty(res, 'destroyed', { value: false, writable: true });
    return res;
  };

  const parseEvents = (res: jest.Mocked<Response>): Array<{ event: string; data: unknown }> =>
    (res.write as jest.Mock).mock.calls.map(([chunk]: [string]) => {
      const eventMatch = /event:(.*)\n/.exec(chunk);
      const dataMatch = /data:(.*)\n\n/.exec(chunk);
      return {
        event: eventMatch ? eventMatch[1] : '',
        data: dataMatch ? JSON.parse(dataMatch[1]) : undefined,
      };
    });

  describe('shouldUseUploadSse', () => {
    const originalValue = process.env.FILE_UPLOAD_SSE_ENABLED;

    afterEach(() => {
      if (originalValue === undefined) {
        delete process.env.FILE_UPLOAD_SSE_ENABLED;
        return;
      }
      process.env.FILE_UPLOAD_SSE_ENABLED = originalValue;
    });

    it('requires both the feature flag and an explicit event-stream accept value', () => {
      process.env.FILE_UPLOAD_SSE_ENABLED = 'true';

      expect(shouldUseUploadSse(createMockReq('application/json, text/event-stream'))).toBe(true);
      expect(shouldUseUploadSse(createMockReq('text/event-stream; charset=utf-8'))).toBe(true);
      expect(shouldUseUploadSse(createMockReq('application/json'))).toBe(false);
      expect(shouldUseUploadSse(createMockReq('*/*'))).toBe(false);
      expect(shouldUseUploadSse(createMockReq())).toBe(false);
    });

    it('keeps JSON responses when the server feature flag is disabled', () => {
      process.env.FILE_UPLOAD_SSE_ENABLED = 'false';

      expect(shouldUseUploadSse(createMockReq('text/event-stream'))).toBe(false);
    });
  });

  describe('startUploadSseStream', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('writes the SSE headers and flushes them immediately', () => {
      const res = createMockRes();
      const stream = startUploadSseStream(res);

      expect(res.writeHead).toHaveBeenCalledWith(
        200,
        expect.objectContaining({
          'Content-Type': 'text/event-stream',
          Connection: 'keep-alive',
        }),
      );
      expect(res.flushHeaders).toHaveBeenCalledTimes(1);
      stream.close();
    });

    it('emits a heartbeat event on every interval tick', () => {
      const res = createMockRes();
      const stream = startUploadSseStream(res);

      jest.advanceTimersByTime(3000);

      const heartbeats = parseEvents(res).filter((e) => e.event === 'heartbeat');
      expect(heartbeats).toHaveLength(3);
      expect(heartbeats.map((e) => e.data)).toEqual([
        { keepAlive: 1 },
        { keepAlive: 2 },
        { keepAlive: 3 },
      ]);
      stream.close();
    });

    it('stops the heartbeat once the response has already ended', () => {
      const res = createMockRes();
      startUploadSseStream(res);

      jest.advanceTimersByTime(1000);
      Object.defineProperty(res, 'writableEnded', { value: true });
      jest.advanceTimersByTime(2000);

      const heartbeats = parseEvents(res).filter((e) => e.event === 'heartbeat');
      expect(heartbeats).toHaveLength(1);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('clears the heartbeat interval on response disconnect and stops writes', () => {
      const res = createMockRes();
      const stream = startUploadSseStream(res);
      expect(jest.getTimerCount()).toBe(1);

      Object.defineProperty(res, 'destroyed', { value: true });
      res.emit('close');
      stream.sendData({ file_id: 'ignored' });

      expect(jest.getTimerCount()).toBe(0);
      expect(res.write).not.toHaveBeenCalled();
    });

    it('emits data and error events', () => {
      const res = createMockRes();
      const stream = startUploadSseStream(res);

      stream.sendData({ file_id: 'abc' });
      stream.sendError({ message: 'failed' });

      const events = parseEvents(res);
      expect(events.find((event) => event.event === 'data')?.data).toEqual({ file_id: 'abc' });
      expect(events.find((event) => event.event === 'error')?.data).toEqual({
        message: 'failed',
      });
      stream.close();
    });

    describe('close', () => {
      it('emits a close event, ends the response, and clears the heartbeat', () => {
        const res = createMockRes();
        const stream = startUploadSseStream(res);

        stream.close();

        const closeEvents = parseEvents(res).filter((e) => e.event === 'close');
        expect(closeEvents).toHaveLength(1);
        expect(closeEvents[0].data).toEqual(
          expect.objectContaining({ closedAt: expect.any(String) }),
        );
        expect(res.end).toHaveBeenCalledTimes(1);
        expect(jest.getTimerCount()).toBe(0);
      });

      it('does not write after the response already ended', () => {
        const res = createMockRes();
        const stream = startUploadSseStream(res);
        Object.defineProperty(res, 'writableEnded', { value: true });

        stream.close();

        expect(parseEvents(res).filter((e) => e.event === 'close')).toHaveLength(0);
        expect(res.end).not.toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(0);
      });

      it('does not emit further heartbeats after close', () => {
        const res = createMockRes();
        const stream = startUploadSseStream(res);

        stream.close();
        jest.advanceTimersByTime(5000);

        expect(parseEvents(res).filter((e) => e.event === 'heartbeat')).toHaveLength(0);
      });
    });
  });

  describe('sendUploadSuccess', () => {
    it('sends the payload over the SSE stream when a stream is active', () => {
      const res = createMockRes();
      const sseStream = {
        sendData: jest.fn(),
        sendError: jest.fn(),
        close: jest.fn(),
      };

      sendUploadSuccess(res, sseStream, 'Upload complete', { file_id: 'abc' });

      expect(sseStream.sendData).toHaveBeenCalledWith({
        message: 'Upload complete',
        file_id: 'abc',
      });
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
    });

    it('falls back to a plain JSON response when no stream is provided', () => {
      const res = createMockRes();

      sendUploadSuccess(res, null, 'Upload complete', { file_id: 'abc' });

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ message: 'Upload complete', file_id: 'abc' });
    });

    it('falls back to a plain JSON response when the stream is undefined', () => {
      const res = createMockRes();

      sendUploadSuccess(res, undefined, 'Upload complete', { file_id: 'abc' });

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ message: 'Upload complete', file_id: 'abc' });
    });
  });

  describe('sendUploadPolicyError', () => {
    it('sends structured policy errors as JSON', () => {
      const res = createMockRes();

      expect(sendUploadPolicyError(res, null, new UninspectableFileError('extracted_text'))).toBe(
        true,
      );
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'content_filter_uninspectable',
        message: 'Submitted file content could not be inspected before processing.',
        source: 'file',
        field: 'extracted_text',
      });
    });

    it('preserves the upload inspection limit status and raw-free body', () => {
      const res = createMockRes();

      expect(sendUploadPolicyError(res, null, new ContentFilterInputTooLargeError('content'))).toBe(
        true,
      );
      expect(res.status).toHaveBeenCalledWith(413);
      expect(res.json).toHaveBeenCalledWith({
        error: 'content_filter_input_too_large',
        message: 'Text file exceeds the 15 MB content inspection limit.',
        source: 'file',
        field: 'content',
      });
    });

    it('sends structured policy errors over an active SSE stream', () => {
      const res = createMockRes();
      const sseStream = {
        sendData: jest.fn(),
        sendError: jest.fn(),
        close: jest.fn(),
      };

      expect(
        sendUploadPolicyError(res, sseStream, new UninspectableFileError('extracted_text'), {
          tempFileId: 'temp-1',
          toolResource: 'context',
        }),
      ).toBe(true);
      expect(sseStream.sendError).toHaveBeenCalledWith({
        error: 'content_filter_uninspectable',
        message: 'Submitted file content could not be inspected before processing.',
        source: 'file',
        field: 'extracted_text',
        code: 400,
        temp_file_id: 'temp-1',
        tool_resource: 'context',
        display_to_user: true,
      });
      expect(res.status).not.toHaveBeenCalled();
    });

    it('leaves non-policy errors for the route-specific handler', () => {
      const res = createMockRes();

      expect(sendUploadPolicyError(res, null, new Error('provider failed'))).toBe(false);
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
    });

    it('unwraps a policy error carried as an error cause', () => {
      const res = createMockRes();
      const wrapped = new Error('wrapped extraction failure', {
        cause: new UninspectableFileError('transcript'),
      });

      expect(sendUploadPolicyError(res, null, wrapped)).toBe(true);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'content_filter_uninspectable',
          field: 'transcript',
        }),
      );
    });
  });
});
