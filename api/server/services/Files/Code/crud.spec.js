const http = require('http');
const https = require('https');
const { Readable } = require('stream');

const mockAxios = jest.fn();
mockAxios.post = jest.fn();

jest.mock('@librechat/agents', () => ({
  getCodeBaseURL: jest.fn(() => 'https://code-api.example.com'),
}));

/* Inline the identity helpers' validation rules instead of pulling
 * them through `@librechat/api`'s root barrel (which has init-time
 * provider-config side effects that don't matter here) or its leaf
 * module (the package's `exports` field only surfaces the root).
 * The real implementation lives in `packages/api/src/files/code/identity.ts`
 * and has its own dedicated `identity.spec.ts` covering the validation
 * matrix; this stub just mirrors enough behavior for the surrounding
 * crud tests to exercise the upload/download flow. */
const VALID_KINDS = new Set(['skill', 'agent', 'user']);
const validateIdentity = ({ kind, id, version }, label) => {
  if (!kind || !VALID_KINDS.has(kind)) throw new Error(`${label}: invalid kind "${kind}"`);
  if (!id) throw new Error(`${label}: missing id for kind "${kind}"`);
  if (kind === 'skill' && version == null) {
    throw new Error(`${label}: kind "skill" requires a numeric version`);
  }
  if (kind !== 'skill' && version != null) {
    throw new Error(`${label}: version is only valid for kind "skill"`);
  }
};

jest.mock('@librechat/api', () => {
  const http = require('http');
  const https = require('https');
  return {
    appendCodeEnvFile: jest.fn((form, stream, filename) => {
      form.append('file', stream, { filename });
    }),
    appendCodeEnvFileIdentity: jest.fn((form, identity) => {
      validateIdentity(identity, 'appendCodeEnvFileIdentity');
      form.append('kind', identity.kind);
      form.append('id', identity.id);
      if (identity.version != null) form.append('version', String(identity.version));
    }),
    wrapCodeApiUploadError: jest.fn((error, message) => {
      const wrapped = new Error(`${message} ${error.message}`, { cause: error });
      if (error?.isAxiosError === true) {
        wrapped.isAxiosError = true;
        wrapped.response = error.response;
      }
      return wrapped;
    }),
    buildCodeEnvDownloadQuery: jest.fn((identity) => {
      validateIdentity(identity, 'buildCodeEnvDownloadQuery');
      const params = new URLSearchParams({ kind: identity.kind, id: identity.id });
      if (identity.version != null) params.set('version', String(identity.version));
      return `?${params.toString()}`;
    }),
    logAxiosError: jest.fn(({ message }) => message),
    getCodeApiAuthHeaders: jest.fn(async () => ({})),
    getCodeExecutionBaseUrl: jest.fn((profile) =>
      profile === 'stateful' ? 'https://code-stateful.example.com' : 'https://code-api.example.com',
    ),
    codeExecutionHeaders: jest.fn(({ executionProfile, bridgeWorkerId }) => ({
      'X-CodeAPI-Expected-Profile': executionProfile,
      ...(bridgeWorkerId ? { 'X-LibreChat-Code-Worker-ID': bridgeWorkerId } : {}),
    })),
    CODE_API_EXPECTED_PROFILE_HEADER: 'X-CodeAPI-Expected-Profile',
    createAxiosInstance: jest.fn(() => mockAxios),
    codeServerHttpAgent: new http.Agent({ keepAlive: false }),
    codeServerHttpsAgent: new https.Agent({ keepAlive: false }),
  };
});

const {
  codeServerHttpAgent,
  codeServerHttpsAgent,
  getCodeApiAuthHeaders,
  getCodeExecutionBaseUrl,
} = require('@librechat/api');
const {
  deleteCodeEnvFile,
  getCodeOutputDownloadStream,
  uploadCodeEnvFile,
  batchUploadCodeEnvFiles,
} = require('./crud');

describe('Code CRUD', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getCodeApiAuthHeaders.mockResolvedValue({});
  });

  describe('getCodeOutputDownloadStream', () => {
    /* Code-output downloads always carry `kind: 'user'` + `id: <userId>`
     * — codeapi's `sessionAuth` rejects without them post-Phase C. The
     * fixture mirrors what `processCodeOutput` and the `/code/download`
     * route pass in production. */
    const userIdentity = { kind: 'user', id: 'user-123' };

    it('should pass dedicated keepAlive:false agents to axios', async () => {
      const mockResponse = { data: Readable.from(['chunk']) };
      mockAxios.mockResolvedValue(mockResponse);

      await getCodeOutputDownloadStream('session-1/file-1', userIdentity);

      const callConfig = mockAxios.mock.calls[0][0];
      expect(callConfig.httpAgent).toBe(codeServerHttpAgent);
      expect(callConfig.httpsAgent).toBe(codeServerHttpsAgent);
      expect(callConfig.httpAgent).toBeInstanceOf(http.Agent);
      expect(callConfig.httpsAgent).toBeInstanceOf(https.Agent);
      expect(callConfig.httpAgent.keepAlive).toBe(false);
      expect(callConfig.httpsAgent.keepAlive).toBe(false);
    });

    it('should request stream response from the correct URL', async () => {
      mockAxios.mockResolvedValue({ data: Readable.from(['chunk']) });

      await getCodeOutputDownloadStream('session-1/file-1', userIdentity);

      const callConfig = mockAxios.mock.calls[0][0];
      /* URL carries `?kind=user&id=<userId>` so codeapi's `sessionAuth`
       * can reconstruct the matching `<tenant>:user:<userId>` sessionKey
       * (Phase C / option α). */
      expect(callConfig.url).toBe(
        'https://code-api.example.com/download/session-1/file-1?kind=user&id=user-123',
      );
      expect(callConfig.responseType).toBe('stream');
      expect(callConfig.timeout).toBe(15000);
    });

    it('uses the trusted stateful route and fail-closed profile header', async () => {
      mockAxios.mockResolvedValue({ data: Readable.from(['chunk']) });

      await getCodeOutputDownloadStream('session-1/file-1', userIdentity, undefined, {
        baseUrl: 'https://code-stateful.example.com',
        executionProfile: 'stateful',
        bridgeWorkerId: 'personal-worker-1',
      });

      expect(mockAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://code-stateful.example.com/download/session-1/file-1?kind=user&id=user-123',
          headers: expect.objectContaining({
            'X-CodeAPI-Expected-Profile': 'stateful',
            'X-LibreChat-Code-Worker-ID': 'personal-worker-1',
          }),
        }),
      );
    });

    it('forwards Code API auth headers when a request is provided', async () => {
      const req = { user: { id: 'user-123' } };
      getCodeApiAuthHeaders.mockResolvedValue({ Authorization: 'Bearer codeapi-token' });
      mockAxios.mockResolvedValue({ data: Readable.from(['chunk']) });

      await getCodeOutputDownloadStream('session-1/file-1', userIdentity, req);

      const callConfig = mockAxios.mock.calls[0][0];
      expect(getCodeApiAuthHeaders).toHaveBeenCalledWith(req, undefined);
      expect(callConfig.headers.Authorization).toBe('Bearer codeapi-token');
    });

    it('forwards skill identity (kind/id/version) when re-downloading a primed skill file', async () => {
      mockAxios.mockResolvedValue({ data: Readable.from(['chunk']) });

      await getCodeOutputDownloadStream('session-2/file-x', {
        kind: 'skill',
        id: 'skill-abc',
        version: 7,
      });

      const callConfig = mockAxios.mock.calls[0][0];
      expect(callConfig.url).toBe(
        'https://code-api.example.com/download/session-2/file-x?kind=skill&id=skill-abc&version=7',
      );
    });

    it('rejects skill identity without a version (mirrors codeapi validator)', async () => {
      await expect(
        getCodeOutputDownloadStream('s/f', { kind: 'skill', id: 'skill-abc' }),
      ).rejects.toThrow(/skill.*version/);
      expect(mockAxios).not.toHaveBeenCalled();
    });

    it('rejects unknown kind without dispatching to codeapi', async () => {
      await expect(getCodeOutputDownloadStream('s/f', { kind: 'system', id: 'x' })).rejects.toThrow(
        /invalid kind/,
      );
      expect(mockAxios).not.toHaveBeenCalled();
    });

    it('should throw on network error', async () => {
      mockAxios.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(getCodeOutputDownloadStream('s/f', userIdentity)).rejects.toThrow();
    });
  });

  describe('deleteCodeEnvFile', () => {
    const req = { user: { id: 'user-123' } };
    const file = {
      metadata: {
        codeEnvRef: {
          kind: 'agent',
          id: 'agent-abc',
          storage_session_id: 'session-1',
          file_id: 'file-1',
        },
      },
    };

    it('deletes the code environment object with resource identity and auth headers', async () => {
      getCodeApiAuthHeaders.mockResolvedValue({ Authorization: 'Bearer codeapi-token' });
      mockAxios.mockResolvedValue({ status: 204 });

      await deleteCodeEnvFile(req, file);

      expect(getCodeApiAuthHeaders).toHaveBeenCalledWith(req, undefined);
      expect(mockAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'delete',
          url: 'https://code-api.example.com/files/session-1/file-1?kind=agent&id=agent-abc',
          headers: expect.objectContaining({
            Authorization: 'Bearer codeapi-token',
            'User-Agent': 'LibreChat/1.0',
          }),
          httpAgent: codeServerHttpAgent,
          httpsAgent: codeServerHttpsAgent,
          timeout: 15000,
        }),
      );
    });

    it('deletes a stateful artifact from its originating profile', async () => {
      mockAxios.mockResolvedValue({ status: 204 });
      const statefulFile = {
        metadata: {
          codeEnvRef: {
            ...file.metadata.codeEnvRef,
            executionProfile: 'stateful',
          },
        },
      };

      await deleteCodeEnvFile(req, statefulFile);

      expect(mockAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://code-stateful.example.com/files/session-1/file-1?kind=agent&id=agent-abc',
          headers: expect.objectContaining({
            'X-CodeAPI-Expected-Profile': 'stateful',
          }),
        }),
      );
    });

    it('deletes every profile-local object retained for a shared file record', async () => {
      mockAxios.mockResolvedValue({ status: 204 });
      const dualProfileFile = {
        metadata: {
          codeEnvRef: file.metadata.codeEnvRef,
          codeEnvRefs: {
            default: file.metadata.codeEnvRef,
            stateful: {
              ...file.metadata.codeEnvRef,
              storage_session_id: 'stateful-session',
              file_id: 'stateful-file',
              executionProfile: 'stateful',
            },
          },
        },
      };

      await deleteCodeEnvFile(req, dualProfileFile);

      expect(mockAxios).toHaveBeenCalledTimes(2);
      expect(mockAxios).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          url: expect.stringContaining('/files/session-1/file-1'),
          headers: expect.objectContaining({ 'X-CodeAPI-Expected-Profile': 'default' }),
        }),
      );
      expect(mockAxios).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          url: expect.stringContaining('/files/stateful-session/stateful-file'),
          headers: expect.objectContaining({ 'X-CodeAPI-Expected-Profile': 'stateful' }),
        }),
      );
    });

    it('skips remote cleanup instead of falling back when a historical route is unmapped', async () => {
      const historicalRoute = 'stateful:0123456789abcdef0123456789abcdef';
      const historicalFile = {
        metadata: {
          codeEnvRefs: {
            [historicalRoute]: {
              ...file.metadata.codeEnvRef,
              executionProfile: 'stateful',
              executionRouteKey: historicalRoute,
            },
          },
        },
      };

      await expect(deleteCodeEnvFile(req, historicalFile)).resolves.toBeUndefined();

      expect(mockAxios).not.toHaveBeenCalled();
    });

    it('skips legacy stateful cleanup after its endpoint is retired', async () => {
      getCodeExecutionBaseUrl.mockImplementationOnce(() => {
        throw new Error('LIBRECHAT_CODE_BASEURL_STATEFUL is not configured');
      });
      const legacyStatefulFile = {
        metadata: {
          codeEnvRef: {
            ...file.metadata.codeEnvRef,
            executionProfile: 'stateful',
          },
        },
      };

      await expect(deleteCodeEnvFile(req, legacyStatefulFile)).resolves.toBeUndefined();

      expect(mockAxios).not.toHaveBeenCalled();
    });

    it('never calls the file-server path that only newer codeapi mounts', async () => {
      mockAxios.mockResolvedValue({ status: 204 });

      await deleteCodeEnvFile(req, file);

      expect(mockAxios).toHaveBeenCalledTimes(1);
      expect(mockAxios).not.toHaveBeenCalledWith(
        expect.objectContaining({
          url: expect.stringContaining('/sessions/session-1/objects/file-1'),
        }),
      );
    });

    it('surfaces an unsupported delete method instead of retrying elsewhere', async () => {
      mockAxios.mockRejectedValue(
        Object.assign(new Error('method not allowed'), { response: { status: 405 } }),
      );

      await expect(deleteCodeEnvFile(req, file)).rejects.toThrow('method not allowed');
      expect(mockAxios).toHaveBeenCalledTimes(1);
    });

    it('skips files without a code environment ref', async () => {
      await deleteCodeEnvFile(req, {});

      expect(mockAxios).not.toHaveBeenCalled();
      expect(getCodeApiAuthHeaders).not.toHaveBeenCalled();
    });

    it('treats missing code environment objects as already deleted', async () => {
      mockAxios.mockRejectedValue(
        Object.assign(new Error('missing'), { response: { status: 404 } }),
      );

      await expect(deleteCodeEnvFile(req, file)).resolves.toBeUndefined();
      expect(mockAxios).toHaveBeenCalledTimes(1);
    });

    it('throws when code environment deletion fails', async () => {
      mockAxios.mockRejectedValue(
        Object.assign(new Error('unavailable'), { response: { status: 500 } }),
      );

      await expect(deleteCodeEnvFile(req, file)).rejects.toThrow('unavailable');
    });
  });

  describe('uploadCodeEnvFile', () => {
    const baseUploadParams = {
      req: { user: { id: 'user-123' } },
      stream: Readable.from(['file-content']),
      filename: 'data.csv',
      kind: 'user',
      id: 'user-123',
    };

    it('should pass dedicated keepAlive:false agents to axios', async () => {
      mockAxios.post.mockResolvedValue({
        data: {
          message: 'success',
          storage_session_id: 'sess-1',
          files: [{ fileId: 'fid-1', filename: 'data.csv' }],
        },
      });

      await uploadCodeEnvFile(baseUploadParams);

      const callConfig = mockAxios.post.mock.calls[0][2];
      expect(callConfig.httpAgent).toBe(codeServerHttpAgent);
      expect(callConfig.httpsAgent).toBe(codeServerHttpsAgent);
      expect(callConfig.httpAgent).toBeInstanceOf(http.Agent);
      expect(callConfig.httpsAgent).toBeInstanceOf(https.Agent);
      expect(callConfig.httpAgent.keepAlive).toBe(false);
      expect(callConfig.httpsAgent.keepAlive).toBe(false);
    });

    it('should set a timeout on upload requests', async () => {
      mockAxios.post.mockResolvedValue({
        data: {
          message: 'success',
          storage_session_id: 'sess-1',
          files: [{ fileId: 'fid-1', filename: 'data.csv' }],
        },
      });

      await uploadCodeEnvFile(baseUploadParams);

      const callConfig = mockAxios.post.mock.calls[0][2];
      expect(callConfig.timeout).toBe(120000);
    });

    it('should return { storage_session_id, file_id } on success', async () => {
      mockAxios.post.mockResolvedValue({
        data: {
          message: 'success',
          storage_session_id: 'sess-1',
          files: [{ fileId: 'fid-1', filename: 'data.csv' }],
        },
      });

      const result = await uploadCodeEnvFile(baseUploadParams);
      expect(result).toEqual({
        storage_session_id: 'sess-1',
        file_id: 'fid-1',
        filename: 'data.csv',
      });
    });

    it('forwards Code API auth headers on upload requests', async () => {
      getCodeApiAuthHeaders.mockResolvedValue({ Authorization: 'Bearer codeapi-token' });
      mockAxios.post.mockResolvedValue({
        data: {
          message: 'success',
          storage_session_id: 'sess-1',
          files: [{ fileId: 'fid-1', filename: 'data.csv' }],
        },
      });

      await uploadCodeEnvFile(baseUploadParams);

      const callConfig = mockAxios.post.mock.calls[0][2];
      expect(getCodeApiAuthHeaders).toHaveBeenCalledWith(baseUploadParams.req, undefined);
      expect(callConfig.headers.Authorization).toBe('Bearer codeapi-token');
    });

    it('routes uploads through the trusted stateful endpoint and profile header', async () => {
      mockAxios.post.mockResolvedValue({
        data: {
          message: 'success',
          storage_session_id: 'sess-1',
          files: [{ fileId: 'fid-1', filename: 'data.csv' }],
        },
      });

      await uploadCodeEnvFile({
        ...baseUploadParams,
        codeApiBaseUrl: 'https://stateful-code.example.com',
        executionProfile: 'stateful',
        bridgeWorkerId: 'personal-worker-1',
      });

      const [url, , callConfig] = mockAxios.post.mock.calls[0];
      expect(url).toBe('https://stateful-code.example.com/upload');
      expect(callConfig.headers['X-CodeAPI-Expected-Profile']).toBe('stateful');
      expect(callConfig.headers['X-LibreChat-Code-Worker-ID']).toBe('personal-worker-1');
      expect(getCodeApiAuthHeaders).toHaveBeenCalledWith(baseUploadParams.req, 'personal-worker-1');
    });

    /* Phase C / option α (codeapi #1455): the upload wire carries the
     * resource identity codeapi uses for sessionKey derivation. Without
     * these on the form, codeapi falls back to user bucketing for every
     * upload and skill-cache invalidation never fires. Validation runs
     * client-side too so a bad caller fails fast instead of round-tripping
     * a 400. */
    describe('codeapi resource identity (kind/id/version)', () => {
      const FormData = require('form-data');
      const successResponse = {
        data: {
          message: 'success',
          storage_session_id: 'sess-1',
          files: [{ fileId: 'fid-1', filename: 'data.csv' }],
        },
      };
      let appendSpy;

      beforeEach(() => {
        /* Spying on the prototype lets us assert form fields without
         * materializing the multipart body — `form.getBuffer()` would
         * fail on the file-stream entry, but we don't care about the
         * stream here, only the identity fields that ride beside it. */
        appendSpy = jest.spyOn(FormData.prototype, 'append');
      });

      afterEach(() => {
        appendSpy.mockRestore();
      });

      const fieldsAppended = () =>
        appendSpy.mock.calls
          .filter((call) => typeof call[1] === 'string' || typeof call[1] === 'number')
          .reduce((acc, [name, value]) => ({ ...acc, [name]: value }), {});

      it('forwards kind, id, and (when skill) version on the multipart form', async () => {
        mockAxios.post.mockResolvedValue(successResponse);

        await uploadCodeEnvFile({
          ...baseUploadParams,
          kind: 'skill',
          id: 'skill-42',
          version: 7,
        });

        expect(fieldsAppended()).toEqual({ kind: 'skill', id: 'skill-42', version: '7' });
      });

      it('omits version on the form for non-skill kinds', async () => {
        mockAxios.post.mockResolvedValue(successResponse);

        await uploadCodeEnvFile({ ...baseUploadParams, kind: 'agent', id: 'agent-9' });

        const fields = fieldsAppended();
        expect(fields).toEqual({ kind: 'agent', id: 'agent-9' });
        expect(fields).not.toHaveProperty('version');
      });

      it('rejects unknown kind without dispatching to codeapi', async () => {
        await expect(
          uploadCodeEnvFile({ ...baseUploadParams, kind: 'system', id: 'x' }),
        ).rejects.toThrow(/invalid kind/);
        expect(mockAxios.post).not.toHaveBeenCalled();
      });

      it('rejects skill upload without a version (mirrors codeapi validator)', async () => {
        await expect(
          uploadCodeEnvFile({ ...baseUploadParams, kind: 'skill', id: 'skill-42' }),
        ).rejects.toThrow(/skill.*version/);
        expect(mockAxios.post).not.toHaveBeenCalled();
      });

      it('rejects version on non-skill kinds (mirrors codeapi validator)', async () => {
        await expect(
          uploadCodeEnvFile({
            ...baseUploadParams,
            kind: 'agent',
            id: 'agent-9',
            version: 3,
          }),
        ).rejects.toThrow(/version.*skill/);
        expect(mockAxios.post).not.toHaveBeenCalled();
      });
    });

    it('should throw when server returns non-success message', async () => {
      mockAxios.post.mockResolvedValue({
        data: { message: 'quota_exceeded', storage_session_id: 's', files: [] },
      });

      await expect(uploadCodeEnvFile(baseUploadParams)).rejects.toThrow('quota_exceeded');
    });

    it('should throw on network error', async () => {
      mockAxios.post.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(uploadCodeEnvFile(baseUploadParams)).rejects.toThrow();
    });

    it('preserves rate-limit metadata through the upload logging boundary', async () => {
      const rateLimit = Object.assign(new Error('Too Many Requests'), {
        isAxiosError: true,
        response: { status: 429, headers: { 'retry-after': '7' } },
      });
      mockAxios.post.mockRejectedValue(rateLimit);

      await expect(uploadCodeEnvFile(baseUploadParams)).rejects.toMatchObject({
        isAxiosError: true,
        response: { status: 429, headers: { 'retry-after': '7' } },
        cause: rateLimit,
      });
    });
  });

  describe('batchUploadCodeEnvFiles', () => {
    it('routes batch uploads through the selected bridge worker', async () => {
      const controller = new AbortController();
      const req = { user: { id: 'user-123' } };
      mockAxios.post.mockResolvedValue({
        data: {
          message: 'success',
          storage_session_id: 'sess-1',
          files: [{ status: 'success', fileId: 'fid-1', filename: 'data.csv' }],
          succeeded: 1,
          failed: 0,
        },
      });

      await batchUploadCodeEnvFiles({
        req,
        files: [{ stream: Readable.from(['file-content']), filename: 'data.csv' }],
        kind: 'user',
        id: 'user-123',
        codeApiBaseUrl: 'https://stateful-code.example.com',
        executionProfile: 'stateful',
        bridgeWorkerId: 'personal-worker-1',
        signal: controller.signal,
      });

      const [url, , callConfig] = mockAxios.post.mock.calls[0];
      expect(url).toBe('https://stateful-code.example.com/upload/batch');
      expect(getCodeApiAuthHeaders).toHaveBeenCalledWith(req, 'personal-worker-1');
      expect(callConfig.headers['X-CodeAPI-Expected-Profile']).toBe('stateful');
      expect(callConfig.headers['X-LibreChat-Code-Worker-ID']).toBe('personal-worker-1');
      expect(callConfig.signal).toBe(controller.signal);
    });
  });
});
