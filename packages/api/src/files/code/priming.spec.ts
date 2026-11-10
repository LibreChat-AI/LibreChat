import { createReadStream } from 'node:fs';
import { PassThrough, Readable } from 'node:stream';
import { FileContext } from 'librechat-data-provider';
import type { CodeEnvRef, TFile } from 'librechat-data-provider';
import {
  selectCodeFiles,
  getCodeFileLocation,
  getCodeFileContextLine,
  appendCodeFileContextLine,
  CodeSourceMissingError,
  openCodeFileSource,
  setMissingCodeFilesContext,
  createCodeReuploadFailures,
} from './priming';

const file = (id: string, name: string, ref: Partial<CodeEnvRef> = {}, time = 1): TFile =>
  ({
    file_id: id,
    user: 'user',
    filename: name,
    type: 'text/csv',
    createdAt: new Date(time),
    metadata: {
      codeEnvRef: { kind: 'user', id: 'user', storage_session_id: id, file_id: id, ...ref },
    },
  }) as TFile;

const fresh = { lastModified: new Date().toISOString() };

describe('selectCodeFiles', () => {
  it.each(['default', 'stateful'] as const)(
    'reuses a fresh unnamed legacy ref with timestamp-only metadata on %s',
    async (routeKey) => {
      const legacy = {
        ...file('legacy', 'rows.csv', { executionProfile: routeKey }),
        context: FileContext.execute_code,
      };
      const getFileInfo = jest.fn(async () => fresh);
      const result = await selectCodeFiles({ files: [legacy], routeKey, getFileInfo });

      expect(result.selected).toHaveLength(1);
      expect(result.selected[0]).toMatchObject({
        ref: legacy.metadata!.codeEnvRef,
        sourceRef: legacy.metadata!.codeEnvRef,
        sandboxName: 'rows.csv',
        isActive: true,
      });
      expect(result.skippedNoRef).toBe(0);
      expect(result.skippedSuperseded).toBe(0);
      await expect(result.selected[0].getUploadTime()).resolves.toBe(fresh.lastModified);
      await expect(result.selected[0].getUploadTime()).resolves.toBe(fresh.lastModified);
      expect(getFileInfo).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps the newest snapshot at the live path across legacy records and route recovery', async () => {
    const legacy = {
      ...file('legacy', 'rows.csv', { sandboxFilename: 'rows.csv' }),
      context: FileContext.execute_code,
    };
    const snapshot = {
      ...file('snapshot', 'rows.csv', {}, 2),
      context: FileContext.execute_code_snapshot,
    };
    snapshot.metadata = { codeEnvSource: snapshot.metadata?.codeEnvRef, sourceDispatchedAt: 2 };
    const result = await selectCodeFiles({
      files: [legacy, snapshot],
      routeKey: 'stateful',
      getFileInfo: async () => fresh,
    });
    expect(result.selected.map(({ file }) => file.file_id)).toEqual(['snapshot']);
    expect(result.selected[0].sandboxName).toBe('rows.csv');
    expect(result.selected[0].ref).toBeUndefined();
    expect(result.skippedSuperseded).toBe(1);
  });

  describe.each([
    {
      label: 'converted image',
      capture: 'nested/chart.png',
      name: 'nested/chart.webp',
      canonical: 'nested/chart.webp',
      type: 'image/webp',
    },
    {
      label: 'assigned text alias',
      capture: 'report.txt',
      name: 'report-assigned.txt',
      canonical: 'report.txt',
      type: 'text/plain',
    },
  ])('$label', ({ capture, name, canonical, type }) => {
    it.each([
      ['default', false],
      ['default', true],
      ['stateful', false],
      ['stateful', true],
    ] as const)(
      'keeps literal snapshot paths ahead of legacy receipts on %s (stale=%s)',
      async (routeKey, stale) => {
        const legacy = {
          ...file('legacy', capture, {
            sandboxFilename: name,
            executionProfile: routeKey,
          }),
          type,
          context: FileContext.execute_code,
        };
        const snapshot = {
          ...file('snapshot', name, {}, 2),
          type,
          context: FileContext.execute_code_snapshot,
        };
        const result = await selectCodeFiles({
          files: [legacy, snapshot],
          routeKey,
          getFileInfo: async () => (stale ? null : fresh),
        });
        expect(result.selected).toHaveLength(2);
        expect(result.skippedSuperseded).toBe(0);
        expect(result.selected.find((entry) => entry.file.file_id === 'snapshot')).toMatchObject({
          sandboxName: name,
          isActive: false,
        });
        expect(result.selected.find((entry) => entry.file.file_id === 'legacy')).toMatchObject({
          sandboxName:
            canonical === name ? expect.stringMatching(/^nested\/chart-.+\.webp$/) : canonical,
          isActive: false,
          sourceRef: { file_id: 'legacy' },
        });
        const alias = result.selected.find((entry) => entry.file.file_id === 'legacy')!.sandboxName;
        legacy.metadata!.codeEnvRef!.sandboxFilename = alias;
        const repeated = await selectCodeFiles({
          files: [legacy, snapshot],
          routeKey,
          getFileInfo: async () => (stale ? null : fresh),
        });
        expect(repeated.selected.find((entry) => entry.file.file_id === 'legacy')).toMatchObject({
          sandboxName: alias,
          isActive: !stale && alias === canonical,
        });
        const oldBranch = await selectCodeFiles({
          files: [legacy],
          routeKey,
          getFileInfo: async () => (stale ? null : fresh),
        });
        expect(oldBranch.selected[0].sandboxName).toBe(canonical);
      },
    );
  });

  it('preserves provisioned aliases across turns and reuses legacy metadata probes', async () => {
    const getFileInfo = jest.fn(async (ref: CodeEnvRef) => ({
      ...fresh,
      originalFilename: ref.file_id === 'older' ? 'rows-alias.csv' : 'rows.csv',
    }));
    const result = await selectCodeFiles({
      files: [file('older', 'rows.csv'), file('newer', 'rows.csv', {}, 2)],
      routeKey: 'default',
      getFileInfo,
    });
    expect(result.selected.map((f) => f.sandboxName)).toEqual(['rows.csv', 'rows-alias.csv']);
    await Promise.all(result.selected.map((f) => f.getUploadTime()));
    expect(getFileInfo).toHaveBeenCalledTimes(2);
  });

  it('keeps stored aliases when expired and selects the requested deployment reference', async () => {
    const older = file('older', 'rows.csv', { sandboxFilename: 'rows-old.csv' });
    older.metadata!.codeEnvRefs = {
      stateful: {
        kind: 'user',
        id: 'user',
        storage_session_id: 'stateful',
        file_id: 'remote',
        sandboxFilename: 'rows-stateful.csv',
        executionProfile: 'stateful',
      },
    };
    const getFileInfo = jest.fn(async () => null);
    const result = await selectCodeFiles({
      files: [older, file('newer', 'rows.csv', { sandboxFilename: 'rows.csv' }, 2)],
      routeKey: 'stateful',
      getFileInfo,
    });
    expect(result.selected.map((f) => f.sandboxName)).toEqual(['rows-stateful.csv', 'rows.csv']);
    expect(getFileInfo).toHaveBeenCalledTimes(1);
    expect(await result.selected[0].getUploadTime()).toBeUndefined();
  });

  it('reserves a failed newest winner without reviving the superseded copy', async () => {
    const getFileInfo = jest.fn(async () => null);
    const result = await selectCodeFiles({
      files: [
        file('older', 'rows.csv', { sandboxFilename: 'rows.csv' }),
        file('newer', 'rows.csv', { sandboxFilename: 'rows.csv' }, 2),
      ],
      routeKey: 'default',
      getFileInfo,
    });
    expect(result.selected.map((f) => f.file.file_id)).toEqual(['newer']);
    expect(result.skippedSuperseded).toBe(1);
    await result.selected[0].getUploadTime();
    expect(getFileInfo).toHaveBeenCalledTimes(2);
  });

  it('lets an output supersede an aliased upload at its actual destination', async () => {
    const result = await selectCodeFiles({
      files: [
        file('upload', 'rows.csv', { sandboxFilename: 'rows-alias.csv' }),
        file('output', 'rows-alias.csv', {}, 2),
      ],
      routeKey: 'default',
      getFileInfo: async () => fresh,
    });
    expect(result.selected.map((f) => f.file.file_id)).toEqual(['output']);
  });

  it('keeps shared content ahead of private resources and rejects ancestor conflicts', async () => {
    const result = await selectCodeFiles({
      files: [file('shared', 'data/rows.csv'), file('private', 'data', {}, 2)],
      privateFileIds: new Set(['private']),
      routeKey: 'default',
      getFileInfo: async () => fresh,
    });
    expect(result.selected.map((f) => f.file.file_id)).toEqual(['shared']);
  });

  it('recovers distinct expired paths with a directory-prefix conflict', async () => {
    const result = await selectCodeFiles({
      files: [
        file('parent', 'reports', { sandboxFilename: 'reports' }),
        file('child', 'reports/data.csv', { sandboxFilename: 'reports/data.csv' }),
      ],
      routeKey: 'default',
      getFileInfo: async () => null,
    });
    expect(result.selected).toHaveLength(2);
    expect(new Set(result.selected.map((f) => f.sandboxName)).size).toBe(2);
  });

  it('recovers every expired legacy input under a distinct persisted destination', async () => {
    const originals = [file('older', 'rows.csv'), file('newer', 'rows.csv', {}, 2)];
    const recovered = await selectCodeFiles({
      files: originals,
      routeKey: 'default',
      getFileInfo: async () => null,
    });
    expect(recovered.selected).toHaveLength(2);
    expect(new Set(recovered.selected.map((f) => f.sandboxName)).size).toBe(2);
    const restored = recovered.selected.map(({ file: original, sandboxName, sourceRef }) => {
      if (!sourceRef.file_id || !sourceRef.storage_session_id)
        throw new Error('Expected owned legacy copy');
      const ref: CodeEnvRef = {
        ...sourceRef,
        file_id: sourceRef.file_id,
        storage_session_id: sourceRef.storage_session_id,
        sandboxFilename: sandboxName,
      };
      return { ...original, metadata: { codeEnvRef: ref } };
    });
    const next = await selectCodeFiles({
      files: restored,
      routeKey: 'default',
      getFileInfo: async () => fresh,
    });
    expect(next.selected.map((f) => f.sandboxName)).toEqual(
      recovered.selected.map((f) => f.sandboxName),
    );
  });

  it('allocates missing legacy inputs around confirmed live aliases', async () => {
    const result = await selectCodeFiles({
      files: [
        file('missing', 'rows.csv', {}, 3),
        file('live', 'rows.csv', { sandboxFilename: 'rows.csv' }),
      ],
      routeKey: 'default',
      getFileInfo: async (ref) => (ref.file_id === 'live' ? fresh : null),
    });
    expect(result.selected.find((f) => f.file.file_id === 'live')?.sandboxName).toBe('rows.csv');
    expect(result.selected.find((f) => f.file.file_id === 'missing')?.sandboxName).not.toBe(
      'rows.csv',
    );
  });

  it.each([false, true])(
    'matches recovered image bytes while retaining a live remote name (expired=%s)',
    async (expired) => {
      const image = { ...file('image', 'plot.png'), type: 'image/webp' };
      const result = await selectCodeFiles({
        files: [image],
        routeKey: 'default',
        getFileInfo: async () => ({
          originalFilename: 'plot-alias.png',
          lastModified: expired ? '2020-01-01' : fresh.lastModified,
        }),
      });
      expect(result.selected[0].sandboxName).toBe(expired ? 'plot-alias.webp' : 'plot-alias.png');
    },
  );

  it('arbitrates collisions introduced by durable image conversion before uploading', async () => {
    const result = await selectCodeFiles({
      files: [
        { ...file('image', 'plot.png', {}, 1), type: 'image/webp' },
        file('live', 'plot.webp', { sandboxFilename: 'plot.webp' }, 2),
      ],
      routeKey: 'default',
      getFileInfo: async (ref) =>
        ref.file_id === 'live'
          ? fresh
          : { originalFilename: 'plot.png', lastModified: '2020-01-01' },
    });
    expect(result.selected).toHaveLength(2);
    expect(result.selected.find((f) => f.file.file_id === 'live')?.sandboxName).toBe('plot.webp');
    expect(result.selected.find((f) => f.file.file_id === 'image')?.sandboxName).toMatch(
      /^plot-.+\.webp$/,
    );
  });

  it('keeps a missing shared input independent of each agents private files', async () => {
    const shared = file('shared', 'rows.csv');
    const privateFile = file('private', 'rows.csv', { sandboxFilename: 'rows.csv' }, 2);
    const getFileInfo = async (ref: CodeEnvRef) => (ref.file_id === 'private' ? fresh : null);
    const first = await selectCodeFiles({ files: [shared], routeKey: 'default', getFileInfo });
    const second = await selectCodeFiles({
      files: [shared, privateFile],
      privateFileIds: new Set(['private']),
      routeKey: 'default',
      getFileInfo,
    });
    expect(second.selected.find((f) => f.file.file_id === 'shared')?.sandboxName).toBe(
      first.selected[0].sandboxName,
    );
  });

  it.each([
    ['default', true],
    ['default', false],
    ['stateful', true],
    ['stateful', false],
  ] as const)(
    'reuploads a displaced private receipt rather than trusting its live bytes on %s (named %s)',
    async (routeKey, named) => {
      const shared = { ...file('shared', 'rows.csv'), context: FileContext.execute_code_snapshot };
      const privateFile = file('private', 'rows.csv', {
        kind: 'agent',
        id: 'agent-a',
        sandboxFilename: named ? 'rows.csv' : undefined,
        executionProfile: routeKey,
      });
      const result = await selectCodeFiles({
        files: [privateFile, shared],
        privateFileIds: new Set(['private']),
        routeKey,
        getFileInfo: async () => ({ ...fresh, originalFilename: 'rows.csv' }),
      });
      expect(result.selected).toHaveLength(2);
      expect(result.selected.find((entry) => entry.file.file_id === 'shared')?.sandboxName).toBe(
        'rows.csv',
      );
      expect(result.selected.find((entry) => entry.file.file_id === 'private')).toMatchObject({
        sandboxName: expect.stringMatching(/^rows-.+\.csv$/),
        isActive: false,
        sourceRef: { kind: 'agent', id: 'agent-a', file_id: 'private' },
      });
    },
  );

  it('keeps the freshness decision paired with the selected image destination', async () => {
    const now = Date.parse('2026-09-10T12:00:00Z');
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    const result = await selectCodeFiles({
      files: [{ ...file('image', 'plot.png'), type: 'image/webp' }],
      routeKey: 'default',
      getFileInfo: async () => ({
        originalFilename: 'plot.png',
        lastModified: new Date(now - 23 * 3_600_000 + 1_000).toISOString(),
      }),
    });
    clock.mockReturnValue(now + 2_000);
    expect(result.selected[0]).toMatchObject({ isActive: true, sandboxName: 'plot.png' });
    clock.mockRestore();
  });

  it('claims alternate-route names around destinations already present in the target route', async () => {
    const missing = file('missing', 'rows.csv', { sandboxFilename: 'rows.csv' }, 2);
    const live = file('live', 'rows.csv', {
      sandboxFilename: 'rows.csv',
      executionProfile: 'stateful',
    });
    const result = await selectCodeFiles({
      files: [missing, live],
      routeKey: 'stateful',
      getFileInfo: async () => fresh,
    });
    expect(result.selected).toHaveLength(2);
    expect(result.selected.find((f) => f.file.file_id === 'live')?.sandboxName).toBe('rows.csv');
    expect(result.selected.find((f) => f.file.file_id === 'missing')?.sandboxName).not.toBe(
      'rows.csv',
    );
  });

  it.each([false, true])(
    'uses the multipart fallback only during recovery (expired=%s)',
    async (expired) => {
      const result = await selectCodeFiles({
        files: [file('nested', 'my dir/file.csv')],
        routeKey: 'default',
        getFileInfo: async () => ({
          originalFilename: 'my dir/file.csv',
          lastModified: expired ? '2020-01-01' : fresh.lastModified,
        }),
      });
      expect(result.selected[0].sandboxName).toBe(expired ? 'file.csv' : 'my dir/file.csv');
    },
  );

  it('arbitrates recovery names after the multipart adapter flattens paths', async () => {
    const result = await selectCodeFiles({
      files: [
        file('older', 'my dir/file.csv'),
        file('newer', 'file.csv', { sandboxFilename: 'file.csv' }, 2),
      ],
      routeKey: 'default',
      getFileInfo: async (ref) =>
        ref.file_id === 'newer'
          ? fresh
          : { originalFilename: 'my dir/file.csv', lastModified: '2020-01-01' },
    });
    expect(result.selected).toHaveLength(2);
    expect(result.selected.find((f) => f.file.file_id === 'newer')?.sandboxName).toBe('file.csv');
    expect(result.selected.find((f) => f.file.file_id === 'older')?.sandboxName).toMatch(
      /^file-.+\.csv$/,
    );
  });

  it('collapses confirmed old-path duplicates before allocating converted recovery names', async () => {
    const result = await selectCodeFiles({
      files: [
        { ...file('older', 'plot.png'), type: 'image/webp' },
        { ...file('newer', 'plot.png', {}, 2), type: 'image/webp' },
      ],
      routeKey: 'default',
      getFileInfo: async () => ({ originalFilename: 'plot.png', lastModified: '2020-01-01' }),
    });
    expect(result.selected.map((f) => f.file.file_id)).toEqual(['newer']);
    expect(result.selected[0].sandboxName).toBe('plot.webp');
  });

  it('propagates cancellation during legacy recovery', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled');
    await expect(
      selectCodeFiles({
        files: [file('old', 'rows.csv')],
        routeKey: 'default',
        signal: controller.signal,
        getFileInfo: async () => {
          controller.abort(reason);
          return null;
        },
      }),
    ).rejects.toBe(reason);
  });
});

describe('code file context', () => {
  const upload = {
    file_id: 'upload',
    filename: 'photo.png',
    context: FileContext.message_attachment,
  };
  const workspace = {
    environmentId: 'personal-machine',
    workspaceId: 'project-a',
    operations: ['read_file' as const],
  };

  it('reserves the programmatic location for an attached environment with a selected workspace', () => {
    expect(getCodeFileLocation(undefined)).toBe('sandbox');
    expect(getCodeFileLocation({})).toBe('sandbox');
    expect(getCodeFileLocation({ environmentType: 'attached' })).toBe('sandbox');
    expect(getCodeFileLocation({ codeWorkspace: workspace })).toBe('sandbox');
    expect(getCodeFileLocation({ environmentType: 'attached', codeWorkspace: workspace })).toBe(
      'programmatic',
    );
  });

  it('keeps the sandbox mount path and header by default', () => {
    const line = getCodeFileContextLine(upload, new Set(), 'photo.png');
    expect(line).toBe('\n\t- /mnt/data/photo.png (attached by user)');
    expect(appendCodeFileContextLine('', line)).toBe(
      `- Note: The following files are available in the "execute_code" tool environment:${line}`,
    );
  });

  it('points an attached workspace at the per-run data directory instead of the sandbox mount', () => {
    const line = getCodeFileContextLine(upload, new Set(), 'photo.png', 'programmatic');
    expect(line).toBe('\n\t- $LIBRECHAT_CODE_DATA_DIR/photo.png (attached by user)');

    const context = appendCodeFileContextLine('', line, 'programmatic');
    expect(context).toContain('not in the attached workspace, so workspace tools cannot open them');
    expect(context).toContain('programmatic Bash tool, when it is available');
    expect(context).not.toContain('/mnt/data');
    expect(context).not.toContain('tool environment:');
  });

  it('appends later lines under the first header and ignores empty lines', () => {
    const first = getCodeFileContextLine(upload, new Set(['upload']), 'photo.png', 'programmatic');
    const context = appendCodeFileContextLine('', first, 'programmatic');
    expect(appendCodeFileContextLine(context, '', 'programmatic')).toBe(context);

    const second = getCodeFileContextLine(
      {
        ...upload,
        file_id: 'other',
        filename: 'data.csv',
        status: 'failed',
        previewError: 'timeout',
      },
      new Set(),
      'data.csv',
      'programmatic',
    );
    expect(appendCodeFileContextLine(context, second, 'programmatic')).toBe(`${context}${second}`);
    expect(second).toContain('(preview unavailable: timeout)');
  });

  it('omits an undisplaced generated output and names a displaced one', () => {
    const output = { file_id: 'out', filename: 'chart.png', context: FileContext.execute_code };
    expect(getCodeFileContextLine(output, new Set(), 'chart.png', 'programmatic')).toBe('');
    expect(getCodeFileContextLine(output, new Set(), 'chart-1.png', 'programmatic')).toBe(
      '\n\t- $LIBRECHAT_CODE_DATA_DIR/chart-1.png (written earlier as chart.png)',
    );
  });
});

describe('openCodeFileSource', () => {
  it.each([
    { name: 'NoSuchKey' },
    { code: 'BlobNotFound', statusCode: 404 },
    { response: { status: 404 } },
  ])('names a storage miss %#', async (error) => {
    await expect(openCodeFileSource(() => Promise.reject(error))).rejects.toBeInstanceOf(
      CodeSourceMissingError,
    );
  });

  it('names a local file that only reports ENOENT once the stream is read', async () => {
    await expect(
      openCodeFileSource(async () => createReadStream('/nonexistent/librechat-missing.csv')),
    ).rejects.toBeInstanceOf(CodeSourceMissingError);
  });

  it('keeps every byte of a stream it held for its first chunk', async () => {
    const stream = await openCodeFileSource(async () => Readable.from(['first,', 'second']));
    const chunks: string[] = [];
    for await (const chunk of stream) {
      chunks.push(String(chunk));
    }
    expect(chunks.join('')).toBe('first,second');
  });

  it('destroys a stream it was still holding when the turn is cancelled', async () => {
    const stream = new PassThrough();
    const controller = new AbortController();
    const opened = openCodeFileSource(async () => stream, controller.signal);
    controller.abort();

    await expect(opened).rejects.toMatchObject({ name: 'AbortError' });
    expect(stream.destroyed).toBe(true);
  });

  it('passes other storage failures through unchanged', async () => {
    const denied = { code: 'AccessDenied', status: 403 };
    await expect(openCodeFileSource(() => Promise.reject(denied))).rejects.toBe(denied);
    await expect(openCodeFileSource(async () => 'stream')).resolves.toBe('stream');
  });
});

describe('createCodeReuploadFailures', () => {
  const file = (file_id: string, filename: string) => ({ file_id, filename });
  const missing = new CodeSourceMissingError();

  it('names files whose source storage deleted without requiring recovery', () => {
    const failures = createCodeReuploadFailures();
    failures.add(missing, 'missing_backing_object', file('a', 'report.csv'));
    failures.add(missing, 'missing_backing_object', file('b', ''));

    expect(failures.count).toBe(2);
    expect(failures.missingCount).toBe(2);
    expect(failures.requiresRecovery(2, 0)).toBe(false);
    expect(failures.missingFilesContext()).toContain('"report.csv", "b"');
  });

  it('treats a Code API 404 as a recovery failure, not a deleted file', () => {
    const failures = createCodeReuploadFailures();
    failures.add({ response: { status: 404 } }, 'missing_backing_object', file('a', 'a.csv'));

    expect(failures.missingCount).toBe(0);
    expect(failures.requiresRecovery(1, 0)).toBe(true);
    expect(failures.recoveryCategory()).toBe('missing_backing_object');
  });

  it('requires recovery when every file failed and one failed for another reason', () => {
    const failures = createCodeReuploadFailures();
    failures.add(missing, 'missing_backing_object', file('a', 'gone.csv'));
    failures.add(new Error('denied'), 'resource_access_denied', file('b', 'denied.csv'));

    expect(failures.requiresRecovery(2, 0)).toBe(true);
    expect(failures.recoveryCategory()).toBe('resource_access_denied');
    expect(failures.requiresRecovery(3, 1)).toBe(false);
  });

  it('reports mixed categories and stays quiet with no failures', () => {
    const failures = createCodeReuploadFailures();
    expect(failures.requiresRecovery(0, 0)).toBe(false);
    expect(failures.missingFilesContext()).toBe('');
    failures.add(new Error('slow'), 'rate_limited', file('a', 'a.csv'));
    failures.add(new Error('boom'), 'reupload_failed', file('b', 'b.csv'));
    expect(failures.recoveryCategory()).toBe('mixed_reupload_failure');
  });
});

describe('setMissingCodeFilesContext', () => {
  it('adds the note under its own key and nothing when there is none', () => {
    const map: Record<string, unknown> = { execute_code: 'files' };
    setMissingCodeFilesContext(map, undefined);
    expect(map).toEqual({ execute_code: 'files' });
    setMissingCodeFilesContext(map, 'note');
    expect(Object.values(map)).toEqual(['files', 'note']);
  });
});
