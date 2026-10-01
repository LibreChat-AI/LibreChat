import { FileContext, FileSources } from 'librechat-data-provider';
import type { RunArtifactFile, RunArtifactScope } from '@librechat/data-schemas';
import type { RunFileProvenance } from 'librechat-data-provider';
import type {
  ProcessPublishedCodeOutputInput,
  CodeOutputDownloadFallback,
  CodeOutputPublication,
  CodeOutputStoredFile,
} from './publication';
import { createCodeOutputPersistence, createRunArtifactPublisher } from './publication';

const scope: RunArtifactScope = {
  userId: 'user-a',
  tenantId: 'tenant-a',
  conversationId: 'conversation-a',
  runId: 'run-a',
  executionId: 'child-a',
  agentId: 'agent-a',
  sourceFileId: 'sandbox-a',
};

const provenance: RunFileProvenance = {
  runId: scope.runId,
  executionId: scope.executionId,
  agentId: scope.agentId,
  sourceFileId: scope.sourceFileId,
  parentExecutionId: 'parent-a',
  publishedAt: '2026-09-11T16:00:00.000Z',
  inputFileIds: ['input-pdf'],
};

function storedFile(file_id = 'attempt-a'): CodeOutputStoredFile {
  return {
    file_id,
    user: scope.userId,
    tenantId: scope.tenantId ?? undefined,
    conversationId: scope.conversationId,
    filename: 'report.csv',
    filepath: `/uploads/${file_id}/report.csv`,
    type: 'text/csv',
    source: FileSources.local,
    bytes: 12,
    previewRevision: `preview-${file_id}`,
    metadata: {
      codeEnvRef: {
        kind: 'user',
        id: scope.userId,
        storage_session_id: 'child-sandbox',
        file_id: scope.sourceFileId,
      },
    },
  };
}

function downloadFallback(): CodeOutputDownloadFallback {
  return {
    filename: 'report.csv',
    filepath: '/api/files/code/download/child-sandbox/sandbox-a',
    expiresAt: 1_789_232_400_000,
    conversationId: scope.conversationId,
    toolCallId: 'tool-call-a',
    messageId: scope.runId,
    agentId: scope.agentId,
  };
}

function publishedFile(file = storedFile()): RunArtifactFile {
  return {
    ...file,
    file_id: 'canonical-artifact',
    conversationId: scope.conversationId,
    object: 'file',
    context: FileContext.run_artifact,
    embedded: false,
    usage: 1,
    text: file.text ?? undefined,
    status: file.status ?? undefined,
    previewError: file.previewError ?? undefined,
    previewRevision: file.previewRevision ?? undefined,
    metadata: { ...file.metadata, runFile: provenance },
  };
}

function publication(overrides: Partial<CodeOutputPublication> = {}): CodeOutputPublication {
  return {
    scope,
    provenance,
    publish: jest.fn(async () => publishedFile()),
    find: jest.fn(async () => null),
    discard: jest.fn(async () => undefined),
    ...overrides,
  };
}

describe('Code output publication gateway', () => {
  it('preserves the ordinary code-output claim, commit, and preview behavior', async () => {
    const claim = jest.fn(async (input: { file_id: string }) => ({ file_id: input.file_id }));
    const commit = jest.fn(async () => true);
    const persistence = createCodeOutputPersistence({ claim, commit });
    const input = {
      filename: 'report.csv',
      conversationId: scope.conversationId,
      file_id: 'ordinary-id',
      user: scope.userId,
    };
    expect(await persistence.claim(input)).toEqual({ file_id: 'ordinary-id' });
    expect(claim).toHaveBeenCalledWith(input);
    const file = storedFile();
    expect(await persistence.commit(file)).toBe(true);
    expect(commit).toHaveBeenCalledWith(file);
    const finalize = async () => file;
    expect(persistence.finalize(file, finalize)).toBe(finalize);
    expect(persistence.context).toBe(FileContext.execute_code);
  });

  it('uses a unique attempt ID until publication and then returns the canonical file identity', async () => {
    const boundary = publication();
    const legacyClaim = jest.fn();
    const legacyCommit = jest.fn();
    const persistence = createCodeOutputPersistence({
      publication: boundary,
      claim: legacyClaim,
      commit: legacyCommit,
    });
    expect(
      await persistence.claim({
        filename: 'report.csv',
        conversationId: scope.conversationId,
        file_id: 'attempt-a',
        user: scope.userId,
        tenantId: scope.tenantId,
      }),
    ).toEqual({ file_id: 'attempt-a' });
    const file = storedFile();
    expect(await persistence.commit(file)).toBe(true);
    expect(file.file_id).toBe('canonical-artifact');
    expect(file.previewRevision).toBe('preview-attempt-a');
    expect(legacyClaim).not.toHaveBeenCalled();
    expect(legacyCommit).not.toHaveBeenCalled();
    expect(boundary.discard).not.toHaveBeenCalled();
    const finalize = async () => file;
    expect(persistence.finalize(file, finalize)).toBe(finalize);
  });

  it('cleans the losing attempt without deleting source sandbox files or finalizing the winner', async () => {
    const boundary = publication();
    const persistence = createCodeOutputPersistence({
      publication: boundary,
      claim: jest.fn(),
      commit: jest.fn(),
    });
    const loser = storedFile('attempt-b');
    await persistence.commit(loser);
    expect(boundary.discard).toHaveBeenCalledWith(
      expect.objectContaining({
        file_id: 'attempt-b',
        filepath: '/uploads/attempt-b/report.csv',
        embedded: false,
        metadata: undefined,
      }),
    );
    expect(loser.file_id).toBe('canonical-artifact');
    expect(loser.filepath).toBe('/uploads/attempt-a/report.csv');
    expect(persistence.finalize(loser, async () => loser)).toBeUndefined();
  });

  it('recovers an acknowledged-late publication without deleting its stored bytes', async () => {
    const boundary = publication({
      publish: jest.fn(async () => {
        throw new Error('write acknowledgement lost');
      }),
      find: jest.fn(async () => publishedFile()),
    });
    const persistence = createCodeOutputPersistence({
      publication: boundary,
      claim: jest.fn(),
      commit: jest.fn(),
    });
    const file = storedFile();
    await persistence.commit(file);
    expect(file.file_id).toBe('canonical-artifact');
    expect(boundary.discard).not.toHaveBeenCalled();
  });

  it('removes an unpublished attempt after a confirmed storage metadata failure', async () => {
    const boundary = publication({
      publish: jest.fn(async () => {
        throw new Error('database unavailable');
      }),
    });
    const persistence = createCodeOutputPersistence({
      publication: boundary,
      claim: jest.fn(),
      commit: jest.fn(),
    });
    await expect(persistence.commit(storedFile())).rejects.toThrow('database unavailable');
    expect(boundary.discard).toHaveBeenCalledTimes(1);
  });

  it('keeps stored bytes when an uncertain write cannot be reconciled', async () => {
    const boundary = publication({
      publish: jest.fn(async () => {
        throw new Error('write acknowledgement lost');
      }),
      find: jest.fn(async () => {
        throw new Error('read unavailable');
      }),
    });
    const persistence = createCodeOutputPersistence({
      publication: boundary,
      claim: jest.fn(),
      commit: jest.fn(),
    });
    await expect(persistence.commit(storedFile())).rejects.toThrow('read unavailable');
    expect(boundary.discard).not.toHaveBeenCalled();
  });

  it('cleans an attempt cancelled after byte storage and before metadata commit', async () => {
    const controller = new AbortController();
    const boundary = publication({ signal: controller.signal });
    const persistence = createCodeOutputPersistence({
      publication: boundary,
      claim: jest.fn(),
      commit: jest.fn(),
    });
    controller.abort(new Error('Artifact generation expired'));
    await expect(persistence.commit(storedFile())).rejects.toThrow('generation expired');
    expect(boundary.publish).not.toHaveBeenCalled();
    expect(boundary.find).not.toHaveBeenCalled();
    expect(boundary.discard).toHaveBeenCalledWith(
      expect.objectContaining({
        file_id: 'attempt-a',
        metadata: undefined,
      }),
    );
  });

  it('rejects a different user, tenant, or conversation before publication', async () => {
    const boundary = publication();
    const persistence = createCodeOutputPersistence({
      publication: boundary,
      claim: jest.fn(),
      commit: jest.fn(),
    });
    for (const difference of [
      { user: 'other-user' },
      { tenantId: 'other-tenant' },
      { conversationId: 'other-conversation' },
    ]) {
      await expect(persistence.commit({ ...storedFile(), ...difference })).rejects.toThrow(
        'publication owner',
      );
    }
    expect(boundary.publish).not.toHaveBeenCalled();
  });
});

describe('Run artifact publisher', () => {
  const artifact = { id: scope.sourceFileId, name: 'report.csv', sessionId: 'child-sandbox' };

  function dependencies() {
    return {
      claimRunArtifactFile: jest.fn(async () => ({ file_id: 'canonical-artifact' })),
      publishRunArtifactFile: jest.fn(async () => publishedFile()),
      findRunArtifactFile: jest.fn(async () => publishedFile()),
      processCodeOutput: jest.fn(async (input: ProcessPublishedCodeOutputInput) => ({
        file: await input.publication.publish({ scope, provenance, file: publishedFile() }),
      })),
      prepare: jest.fn(async () => Buffer.from('a,b\n1,2')),
      discard: jest.fn(async () => undefined),
      finalize: jest.fn(),
    };
  }

  it('replays a durable publication without downloading or processing its source again', async () => {
    const deps = dependencies();
    const publish = createRunArtifactPublisher({
      ...deps,
      claimRunArtifactFile: async () => ({ file_id: 'canonical-artifact', file: publishedFile() }),
    });
    expect(await publish({ scope, provenance, artifact })).toEqual(publishedFile());
    expect(deps.prepare).not.toHaveBeenCalled();
    expect(deps.processCodeOutput).not.toHaveBeenCalled();
  });

  it('reuses inspected bytes and starts preview finalization after durable verification', async () => {
    const deps = dependencies();
    const publish = createRunArtifactPublisher(deps);
    expect(await publish({ scope, provenance, artifact })).toEqual(publishedFile());
    expect(deps.processCodeOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        id: artifact.id,
        name: artifact.name,
        session_id: artifact.sessionId,
        preparedBuffer: Buffer.from('a,b\n1,2'),
        publication: expect.objectContaining({ scope, provenance }),
      }),
    );
    expect(deps.finalize).toHaveBeenCalledTimes(1);
    expect(deps.findRunArtifactFile).not.toHaveBeenCalled();
  });

  it('fails publication when existing output processing returns a transient download fallback', async () => {
    const deps = dependencies();
    const publish = createRunArtifactPublisher({
      ...deps,
      processCodeOutput: async () => ({
        file: downloadFallback(),
      }),
    });
    await expect(publish({ scope, provenance, artifact })).rejects.toThrow('durable storage');
    expect(deps.finalize).not.toHaveBeenCalled();
  });

  it('rejects durable-looking metadata that did not pass through publication', async () => {
    const deps = dependencies();
    const publish = createRunArtifactPublisher({
      ...deps,
      processCodeOutput: async () => ({ file: publishedFile() }),
    });
    await expect(publish({ scope, provenance, artifact })).rejects.toThrow('could not be verified');
    expect(deps.finalize).not.toHaveBeenCalled();
  });

  it('does not read or download a generation that has already been cancelled', async () => {
    const deps = dependencies();
    const controller = new AbortController();
    controller.abort(new Error('Generation superseded'));
    await expect(
      createRunArtifactPublisher(deps)({ scope, provenance, artifact, signal: controller.signal }),
    ).rejects.toThrow('superseded');
    expect(deps.claimRunArtifactFile).not.toHaveBeenCalled();
    expect(deps.prepare).not.toHaveBeenCalled();
  });

  it('does not store bytes when a generation expires during inspection', async () => {
    const deps = dependencies();
    const controller = new AbortController();
    deps.prepare.mockImplementationOnce(async () => {
      controller.abort(new Error('Generation superseded'));
      return Buffer.from('newer generation bytes');
    });
    await expect(
      createRunArtifactPublisher(deps)({ scope, provenance, artifact, signal: controller.signal }),
    ).rejects.toThrow('superseded');
    expect(deps.processCodeOutput).not.toHaveBeenCalled();
    expect(deps.publishRunArtifactFile).not.toHaveBeenCalled();
  });

  it('finishes a committed preview without returning a cancelled attachment', async () => {
    const deps = dependencies();
    const controller = new AbortController();
    deps.publishRunArtifactFile.mockImplementationOnce(async () => {
      controller.abort(new Error('Caller cancelled after commit'));
      return publishedFile();
    });
    await expect(
      createRunArtifactPublisher(deps)({ scope, provenance, artifact, signal: controller.signal }),
    ).rejects.toThrow('cancelled after commit');
    expect(deps.finalize).toHaveBeenCalledTimes(1);
    expect(deps.discard).not.toHaveBeenCalled();
  });

  it.each(['throw', 'fallback'] as const)(
    'removes stored bytes when processing fails before commit (%s)',
    async (failure) => {
      const deps = dependencies();
      const publish = createRunArtifactPublisher({
        ...deps,
        processCodeOutput: async (input) => {
          const persistence = createCodeOutputPersistence({
            publication: input.publication,
            claim: jest.fn(),
            commit: jest.fn(),
          });
          persistence.trackStored(storedFile('uncommitted'));
          if (failure === 'throw') throw new Error('Processing failed before metadata');
          return { file: downloadFallback() };
        },
      });
      await expect(publish({ scope, provenance, artifact })).rejects.toThrow();
      expect(deps.discard).toHaveBeenCalledTimes(1);
      expect(deps.discard).toHaveBeenCalledWith(
        expect.objectContaining({
          file_id: 'uncommitted',
          filepath: '/uploads/uncommitted/report.csv',
          metadata: undefined,
        }),
      );
      expect(deps.publishRunArtifactFile).not.toHaveBeenCalled();
    },
  );

  it('does not delete a committed winner if processing later fails', async () => {
    const deps = dependencies();
    const publish = createRunArtifactPublisher({
      ...deps,
      processCodeOutput: async (input) => {
        const persistence = createCodeOutputPersistence({
          publication: input.publication,
          claim: jest.fn(),
          commit: jest.fn(),
        });
        const file = storedFile();
        persistence.trackStored(file);
        await persistence.commit(file);
        throw new Error('Processor failed after commit');
      },
    });
    await expect(publish({ scope, provenance, artifact })).rejects.toThrow('after commit');
    expect(deps.discard).not.toHaveBeenCalled();
  });

  it('cleans a tracked duplicate once without deleting its winner', async () => {
    const deps = dependencies();
    const publish = createRunArtifactPublisher({
      ...deps,
      processCodeOutput: async (input) => {
        const persistence = createCodeOutputPersistence({
          publication: input.publication,
          claim: jest.fn(),
          commit: jest.fn(),
        });
        const file = storedFile('loser');
        persistence.trackStored(file);
        await persistence.commit(file);
        return { file };
      },
    });
    expect(await publish({ scope, provenance, artifact })).toEqual(publishedFile());
    expect(deps.discard).toHaveBeenCalledTimes(1);
    expect(deps.discard).toHaveBeenCalledWith(expect.objectContaining({ file_id: 'loser' }));
  });

  it('retains tracked bytes when neither a lost write acknowledgement nor its recovery can be resolved', async () => {
    const deps = dependencies();
    deps.publishRunArtifactFile.mockRejectedValue(new Error('Write acknowledgement lost'));
    deps.findRunArtifactFile.mockRejectedValue(new Error('Recovery read unavailable'));
    const publish = createRunArtifactPublisher({
      ...deps,
      processCodeOutput: async (input) => {
        const persistence = createCodeOutputPersistence({
          publication: input.publication,
          claim: jest.fn(),
          commit: jest.fn(),
        });
        const file = storedFile();
        persistence.trackStored(file);
        await persistence.commit(file);
        return { file };
      },
    });
    await expect(publish({ scope, provenance, artifact })).rejects.toThrow(
      'Recovery read unavailable',
    );
    expect(deps.discard).not.toHaveBeenCalled();
  });

  it('preserves cancellation after cleaning a processor download fallback', async () => {
    const deps = dependencies();
    const controller = new AbortController();
    const publish = createRunArtifactPublisher({
      ...deps,
      processCodeOutput: async (input) => {
        const persistence = createCodeOutputPersistence({
          publication: input.publication,
          claim: jest.fn(),
          commit: jest.fn(),
        });
        const file = storedFile();
        persistence.trackStored(file);
        controller.abort(new Error('Generation expired'));
        try {
          await persistence.commit(file);
        } catch {
          /* Matches the legacy fallback. */
        }
        return { file: downloadFallback() };
      },
    });
    await expect(
      publish({ scope, provenance, artifact, signal: controller.signal }),
    ).rejects.toThrow('Generation expired');
    expect(deps.discard).toHaveBeenCalledTimes(1);
    expect(deps.publishRunArtifactFile).not.toHaveBeenCalled();
  });
});
