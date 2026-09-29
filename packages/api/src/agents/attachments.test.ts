import { logger } from '@librechat/data-schemas';
import { EModelEndpoint, FileContext, FileSources } from 'librechat-data-provider';
import type { IMongoFile } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types';

jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn() },
}));

import {
  AgentAttachmentLimitError,
  AgentAttachmentPolicyError,
  assertAgentAttachmentLimits,
  createAgentMemoryCallback,
  collectAgentAttachmentStats,
  collectFileIds,
  buildAgentScopedContext,
  getAgentContextAttachments,
  buildAgentContextAttachmentsByAgentId,
  isModelBoundAttachmentFile,
  isToolOwnedAttachment,
} from './attachments';
import { applyTurnDelivery, resolveTurnDeliveryRouting } from './files/delivery';

const makeTextFile = (file_id: string, filename: string, text: string): IMongoFile =>
  ({
    file_id,
    filename,
    text,
    bytes: 0,
    source: FileSources.text,
  }) as IMongoFile;

describe('agent attachment helpers', () => {
  it('excludes tool-only files while retaining extracted text files', () => {
    expect(isModelBoundAttachmentFile({ file_id: 'rag', embedded: true } as IMongoFile)).toBe(
      false,
    );
    expect(
      isModelBoundAttachmentFile({
        file_id: 'code',
        metadata: { codeEnvRef: { file_id: 'code-file', storage_session_id: 'session' } },
      } as IMongoFile),
    ).toBe(false);
    expect(
      isModelBoundAttachmentFile({
        file_id: 'text',
        source: FileSources.text,
        embedded: true,
        text: 'injected context',
      } as IMongoFile),
    ).toBe(true);
    expect(
      isModelBoundAttachmentFile({
        file_id: 'text-with-code-ref',
        llmDeliveryPath: 'text',
        text: 'context survives provisioning',
        metadata: { codeEnvRef: { file_id: 'code-file', storage_session_id: 'session' } },
      } as IMongoFile),
    ).toBe(true);
    expect(
      isModelBoundAttachmentFile({
        file_id: 'empty-text',
        source: FileSources.text,
        text: '',
      } as IMongoFile),
    ).toBe(false);
    expect(
      isModelBoundAttachmentFile({
        file_id: 'lazy-code-file',
        llmDeliveryPath: 'none',
        bytes: 200 * 1024 * 1024,
      } as IMongoFile),
    ).toBe(false);
    expect(
      isModelBoundAttachmentFile({
        file_id: 'provider-with-code-ref',
        llmDeliveryPath: 'provider',
        metadata: { codeEnvRef: { file_id: 'code-file', storage_session_id: 'session' } },
      } as IMongoFile),
    ).toBe(true);
  });

  it('summarizes unique attachment bytes and extracted text', () => {
    const stats = collectAgentAttachmentStats([
      { file_id: 'file-1', bytes: 12, type: 'text/plain', text: 'hello' },
      { file_id: 'file-1', bytes: 12, type: 'text/plain', text: 'hello' },
      { file_id: 'file-2', bytes: 8, type: 'application/pdf', text: 'world!' },
    ]);

    expect(stats).toMatchObject({
      attachmentCount: 2,
      totalKnownBytes: 20,
      extractedTextChars: 11,
    });
    expect(stats.files).toEqual([
      { fileId: 'file-1', mimeType: 'text/plain', bytes: 12, extractedTextChars: 5 },
      { fileId: 'file-2', mimeType: 'application/pdf', bytes: 8, extractedTextChars: 6 },
    ]);
  });

  it('counts bytes once per repeated model injection when requested', () => {
    const repeated = {
      file_id: 'replayed-pdf',
      bytes: 70 * 1024 * 1024,
      type: 'application/pdf',
    };

    expect(() =>
      assertAgentAttachmentLimits({
        attachments: [repeated, repeated],
        fileConfig: { fileContextSizeLimit: 128 },
        countRepeatedExtractedText: true,
      }),
    ).toThrow(
      expect.objectContaining({
        limitType: 'bytes',
        observed: 140 * 1024 * 1024,
      }),
    );
  });

  it.each([
    {
      name: 'attachment count',
      files: [
        { file_id: 'file-1', bytes: 1 },
        { file_id: 'file-2', bytes: 1 },
      ],
      fileConfig: { endpoints: { agents: { fileLimit: 1 } } },
      limitType: 'count',
    },
    {
      name: 'aggregate bytes',
      files: [{ file_id: 'file-1', bytes: 2 * 1024 * 1024 }],
      fileConfig: { endpoints: { agents: { totalSizeLimit: 1 } } },
      limitType: 'bytes',
    },
    {
      name: 'aggregate extracted text',
      files: [{ file_id: 'file-1', bytes: 1, text: 'too long' }],
      fileConfig: { fileContextCharLimit: 4 },
      limitType: 'extracted_text',
    },
  ])('rejects turns over the configured $name limit', ({ files, fileConfig, limitType }) => {
    const req = { config: { fileConfig } };

    expect(() => assertAgentAttachmentLimits({ attachments: files, req })).toThrow(
      expect.objectContaining<Partial<AgentAttachmentLimitError>>({
        code: 'AGENT_ATTACHMENT_LIMIT_EXCEEDED',
        limitType: limitType as AgentAttachmentLimitError['limitType'],
      }),
    );
  });

  it('applies the context-size default to a provider-backed agent', () => {
    expect(() =>
      assertAgentAttachmentLimits({
        attachments: [{ file_id: 'large', bytes: 200 * 1024 * 1024 }],
        req: { config: {} },
        endpoint: EModelEndpoint.openAI,
      }),
    ).toThrow(expect.objectContaining({ limitType: 'bytes' }));
  });

  it('falls back to the agents file limit for a provider-backed agent', () => {
    expect(() =>
      assertAgentAttachmentLimits({
        attachments: [{ file_id: 'one' }, { file_id: 'two' }],
        req: { config: { fileConfig: { endpoints: { agents: { fileLimit: 1 } } } } },
        endpoint: EModelEndpoint.openAI,
      }),
    ).toThrow(expect.objectContaining({ limitType: 'count', observed: 2, limit: 1 }));
  });

  it('falls back to the agents file limit for a partial provider config', () => {
    expect(() =>
      assertAgentAttachmentLimits({
        attachments: [{ file_id: 'one' }, { file_id: 'two' }],
        req: {
          config: {
            fileConfig: {
              endpoints: {
                agents: { fileLimit: 1 },
                openAI: { supportedMimeTypes: ['^text/plain$'] },
              },
            },
          },
        },
        endpoint: EModelEndpoint.openAI,
      }),
    ).toThrow(expect.objectContaining({ limitType: 'count', observed: 2, limit: 1 }));
  });

  it('prefers an explicit backing-provider file limit over the agents fallback', () => {
    expect(() =>
      assertAgentAttachmentLimits({
        attachments: [{ file_id: 'one' }, { file_id: 'two' }],
        req: {
          config: {
            fileConfig: {
              endpoints: { agents: { fileLimit: 1 }, openAI: { fileLimit: 2 } },
            },
          },
        },
        endpoint: EModelEndpoint.openAI,
      }),
    ).not.toThrow();
  });

  it('prefers the generic custom file limit over the agents fallback', () => {
    expect(() =>
      assertAgentAttachmentLimits({
        attachments: [{ file_id: 'one' }, { file_id: 'two' }],
        req: {
          config: {
            fileConfig: {
              endpoints: { agents: { fileLimit: 10 }, custom: { fileLimit: 1 } },
            },
          },
        },
        endpoint: 'Moonshot',
      }),
    ).toThrow(expect.objectContaining({ limitType: 'count', observed: 2, limit: 1 }));
  });

  it('does not borrow a generic custom file limit through a selected named config', () => {
    expect(() =>
      assertAgentAttachmentLimits({
        attachments: [{ file_id: 'one' }, { file_id: 'two' }],
        req: {
          config: {
            fileConfig: {
              endpoints: {
                Moonshot: { supportedMimeTypes: ['^text/plain$'] },
                custom: { fileLimit: 10 },
                default: { fileLimit: 1 },
              },
            },
          },
        },
        endpoint: 'Moonshot',
      }),
    ).toThrow(expect.objectContaining({ limitType: 'count', observed: 2, limit: 1 }));
  });

  it('prefers an exact custom endpoint key over a colliding normalized key', () => {
    expect(() =>
      assertAgentAttachmentLimits({
        attachments: [{ file_id: 'one' }, { file_id: 'two' }],
        req: {
          config: {
            fileConfig: {
              endpoints: {
                'foo-bar': { fileLimit: 1 },
                foobar: { fileLimit: 2 },
              },
            },
          },
        },
        endpoint: 'foobar',
      }),
    ).not.toThrow();
  });

  it('preserves an explicit backing-endpoint aggregate override', () => {
    expect(() =>
      assertAgentAttachmentLimits({
        attachments: [{ file_id: 'large', bytes: 200 * 1024 * 1024 }],
        req: {
          config: { fileConfig: { endpoints: { openAI: { totalSizeLimit: 256 } } } },
        },
        endpoint: EModelEndpoint.openAI,
      }),
    ).not.toThrow();
  });

  it('falls back to the agents aggregate limit for a provider-backed agent', () => {
    expect(() =>
      assertAgentAttachmentLimits({
        attachments: [{ file_id: 'large', bytes: 21 * 1024 * 1024 }],
        req: {
          config: { fileConfig: { endpoints: { agents: { totalSizeLimit: 20 } } } },
        },
        endpoint: EModelEndpoint.openAI,
      }),
    ).toThrow(expect.objectContaining({ limitType: 'bytes', limit: 20 * 1024 * 1024 }));
  });

  it('honors the generic custom-endpoint aggregate fallback', () => {
    expect(() =>
      assertAgentAttachmentLimits({
        attachments: [{ file_id: 'custom-file', bytes: 2 * 1024 * 1024 }],
        req: {
          config: { fileConfig: { endpoints: { custom: { totalSizeLimit: 1 } } } },
        },
        endpoint: 'Named Compatible Provider',
      }),
    ).toThrow(expect.objectContaining({ limitType: 'bytes', limit: 1024 * 1024 }));
  });

  it('does not borrow an agents aggregate limit through a selected partial custom config', () => {
    expect(() =>
      assertAgentAttachmentLimits({
        attachments: [{ file_id: 'custom-file', bytes: 200 * 1024 * 1024 }],
        req: {
          config: {
            fileConfig: {
              endpoints: {
                agents: { totalSizeLimit: 256 },
                custom: { fileLimit: 5 },
              },
            },
          },
        },
        endpoint: 'Named Compatible Provider',
      }),
    ).toThrow(expect.objectContaining({ limitType: 'bytes', limit: 128 * 1024 * 1024 }));
  });

  it('honors the explicitly configured default aggregate fallback', () => {
    expect(() =>
      assertAgentAttachmentLimits({
        attachments: [{ file_id: 'default-file', bytes: 2 * 1024 * 1024 }],
        req: {
          config: { fileConfig: { endpoints: { default: { totalSizeLimit: 1 } } } },
        },
        endpoint: EModelEndpoint.openAI,
      }),
    ).toThrow(expect.objectContaining({ limitType: 'bytes', limit: 1024 * 1024 }));
  });

  it('logs memory snapshots around model execution when attachments are present', () => {
    const loggerInfo = logger.info as jest.Mock;
    loggerInfo.mockClear();
    const callback = createAgentMemoryCallback({
      conversationId: 'conversation-1',
      messageId: 'message-1',
      attachments: [makeTextFile('file-1', 'file.txt', 'context')],
    });

    callback.handleChatModelStart(undefined, [], 'run-1');
    callback.handleLLMEnd({}, 'run-1');

    expect(loggerInfo.mock.calls.map(([, fields]) => fields.phase)).toEqual([
      'before_model',
      'after_model',
    ]);
    expect(loggerInfo).toHaveBeenLastCalledWith(
      '[AgentAttachmentMemory] snapshot',
      expect.objectContaining({
        modelRunId: 'run-1',
        attachmentCount: 1,
        extractedTextChars: 7,
        rss: expect.any(Number),
        heapUsed: expect.any(Number),
        external: expect.any(Number),
        arrayBuffers: expect.any(Number),
      }),
    );
  });

  it('does not log attachment snapshots for runs without attachments', () => {
    const loggerInfo = logger.info as jest.Mock;
    loggerInfo.mockClear();
    const callback = createAgentMemoryCallback({ attachments: [] });

    callback.handleChatModelStart(undefined, [], 'run-1');
    callback.handleLLMEnd({}, 'run-1');

    expect(loggerInfo).not.toHaveBeenCalled();
  });

  it('counts repeated binary bytes in memory snapshots', () => {
    const loggerInfo = logger.info as jest.Mock;
    loggerInfo.mockClear();
    const repeated = {
      file_id: 'replayed-pdf',
      bytes: 70 * 1024 * 1024,
      type: 'application/pdf',
    } as IMongoFile;
    const callback = createAgentMemoryCallback({
      attachments: [repeated, repeated],
      countRepeatedExtractedText: true,
    });

    callback.handleChatModelStart(undefined, [], 'run-replay');

    expect(loggerInfo).toHaveBeenCalledWith(
      '[AgentAttachmentMemory] snapshot',
      expect.objectContaining({ totalKnownBytes: 140 * 1024 * 1024 }),
    );
  });

  it('collects file ids from attachment-like files', () => {
    const fileIds = collectFileIds([
      { file_id: 'file-1' },
      null,
      { file_id: '' },
      { file_id: 'file-2' },
      { file_id: 'file-1' },
    ]);

    expect(Array.from(fileIds)).toEqual(['file-1', 'file-2']);
  });

  it('builds an agent context attachment map from initialized configs', () => {
    const file = makeTextFile('context-file', 'context.txt', 'context');
    const attachmentsByAgentId = buildAgentContextAttachmentsByAgentId([
      { id: 'agent-a', agentContextAttachments: [file] },
      { id: 'agent-b', agentContextAttachments: [] },
      { id: null, agentContextAttachments: [file] },
      undefined,
    ]);

    expect(attachmentsByAgentId.size).toBe(1);
    expect(attachmentsByAgentId.get('agent-a')).toEqual([file]);
  });

  it('collects attachments from nested graph members', () => {
    const memberFile = makeTextFile('member-file', 'member.txt', 'member context');
    const attachmentsByAgentId = buildAgentContextAttachmentsByAgentId([
      {
        id: 'parent',
        subagentGraphConfigs: [
          {
            memberConfigs: [{ id: 'graph-member', agentContextAttachments: [memberFile] }],
          },
        ],
      },
    ]);

    expect(attachmentsByAgentId.get('graph-member')).toEqual([memberFile]);
  });

  it('filters shared request files out of scoped context attachments', () => {
    const shared = makeTextFile('shared-file', 'shared.txt', 'shared');
    const scoped = makeTextFile('scoped-file', 'scoped.txt', 'scoped');

    const attachments = getAgentContextAttachments({
      agentId: 'agent-a',
      attachmentsByAgentId: new Map([['agent-a', [shared, scoped]]]),
      excludeFileIds: new Set(['shared-file']),
    });

    expect(attachments).toEqual([scoped]);
  });

  it('builds scoped context only from non-shared context documents', async () => {
    const shared = makeTextFile('shared-file', 'shared.txt', 'Shared duplicate context');
    const scoped = makeTextFile('scoped-file', 'scoped.txt', 'Scoped private context');
    const req = {
      body: { fileTokenLimit: 1000 },
      config: {},
    } as unknown as ServerRequest;

    const scopedContext = await buildAgentScopedContext({
      agentIds: ['agent-a', 'agent-b'],
      attachmentsByAgentId: new Map([
        ['agent-a', [shared, scoped]],
        ['agent-b', [shared]],
      ]),
      sharedRunAttachmentIds: new Set(['shared-file']),
      req,
      tokenCountFn: (text) => text.length,
    });

    expect(scopedContext.get('agent-a')).toContain('Scoped private context');
    expect(scopedContext.get('agent-a')).not.toContain('Shared duplicate context');
    expect(scopedContext.has('agent-b')).toBe(false);
  });

  it('counts repeated extracted context once per agent injection', async () => {
    const repeatedContext = makeTextFile('shared-context', 'shared.txt', 'x'.repeat(600_000));
    const req = {
      body: { fileTokenLimit: 1_000_000 },
      config: { fileConfig: { fileContextCharLimit: 1_000_000 } },
    } as ServerRequest;

    await expect(
      buildAgentScopedContext({
        agentIds: ['agent-a', 'agent-b'],
        attachmentsByAgentId: new Map([
          ['agent-a', [repeatedContext]],
          ['agent-b', [repeatedContext]],
        ]),
        req,
      }),
    ).rejects.toMatchObject({
      code: 'AGENT_ATTACHMENT_LIMIT_EXCEEDED',
      limitType: 'extracted_text',
      observed: 1_200_000,
    });
  });

  it('applies each agent backing endpoint limit before scoped extraction', async () => {
    const oversized = {
      ...makeTextFile('moonshot-file', 'moonshot.txt', 'context'),
      bytes: 2 * 1024 * 1024,
    };
    const req = {
      body: { fileTokenLimit: 1000 },
      config: {
        fileConfig: { endpoints: { Moonshot: { fileLimit: 10, totalSizeLimit: 1 } } },
      },
    } as unknown as ServerRequest;

    await expect(
      buildAgentScopedContext({
        agentIds: ['primary', 'secondary'],
        attachmentsByAgentId: new Map([['secondary', [oversized]]]),
        endpointsByAgentId: new Map([
          ['primary', { endpoint: 'openAI' }],
          ['secondary', { endpoint: 'Moonshot' }],
        ]),
        req,
      }),
    ).rejects.toMatchObject({
      code: 'AGENT_ATTACHMENT_LIMIT_EXCEEDED',
      limitType: 'bytes',
    });
  });

  it('applies each agent backing endpoint limit to shared attachments', async () => {
    const sharedAttachments = [
      makeTextFile('shared-1', 'shared-1.txt', 'one'),
      makeTextFile('shared-2', 'shared-2.txt', 'two'),
    ];
    const req = {
      body: { fileTokenLimit: 1000 },
      config: {
        fileConfig: {
          endpoints: { openAI: { fileLimit: 10 }, Moonshot: { fileLimit: 1 } },
        },
      },
    } as unknown as ServerRequest;

    await expect(
      buildAgentScopedContext({
        agentIds: ['primary', 'secondary'],
        attachmentsByAgentId: new Map(),
        sharedAttachments,
        sharedRunAttachmentIds: new Set(sharedAttachments.map(({ file_id }) => file_id)),
        endpointsByAgentId: new Map([
          ['primary', { endpoint: 'openAI' }],
          ['secondary', { endpoint: 'Moonshot' }],
        ]),
        req,
      }),
    ).rejects.toMatchObject({
      code: 'AGENT_ATTACHMENT_LIMIT_EXCEEDED',
      limitType: 'count',
      observed: 2,
      limit: 1,
    });
  });

  it('rejects shared attachments incompatible with a receiving agent', async () => {
    const sharedAttachment = {
      ...makeTextFile('shared-pdf', 'shared.pdf', ''),
      source: FileSources.local,
      type: 'application/pdf',
      bytes: 1,
    };
    const req = {
      body: { fileTokenLimit: 1000 },
      config: {
        fileConfig: {
          endpoints: { Moonshot: { fileLimit: 10, supportedMimeTypes: ['^text/plain$'] } },
        },
      },
    } as unknown as ServerRequest;

    await expect(
      buildAgentScopedContext({
        agentIds: ['secondary'],
        attachmentsByAgentId: new Map(),
        sharedAttachments: [sharedAttachment],
        endpointsByAgentId: new Map([['secondary', { endpoint: 'Moonshot' }]]),
        req,
      }),
    ).rejects.toBeInstanceOf(AgentAttachmentPolicyError);
  });

  it('does not apply the primary file count limit across disjoint private scopes', async () => {
    const req = {
      body: { fileTokenLimit: 1000 },
      config: {
        fileConfig: {
          endpoints: { openAI: { fileLimit: 1 }, Moonshot: { fileLimit: 10 } },
        },
      },
    } as unknown as ServerRequest;

    await expect(
      buildAgentScopedContext({
        agentIds: ['primary', 'secondary'],
        attachmentsByAgentId: new Map([
          [
            'secondary',
            [
              makeTextFile('secondary-1', 'secondary-1.txt', 'one'),
              makeTextFile('secondary-2', 'secondary-2.txt', 'two'),
            ],
          ],
        ]),
        endpointsByAgentId: new Map([
          ['primary', { endpoint: 'openAI' }],
          ['secondary', { endpoint: 'Moonshot' }],
        ]),
        req,
      }),
    ).resolves.toEqual(new Map([['secondary', expect.stringContaining('secondary-1.txt')]]));
  });

  it('uses the global byte cap across disjoint private scopes', async () => {
    const secondaryContext = {
      ...makeTextFile('secondary-large', 'secondary-large.txt', 'context'),
      bytes: 2 * 1024 * 1024,
    };
    const req = {
      body: { fileTokenLimit: 1000 },
      config: {
        fileConfig: {
          endpoints: {
            openAI: { fileLimit: 10, totalSizeLimit: 1 },
            Moonshot: { fileLimit: 10, totalSizeLimit: 10 },
          },
        },
      },
    } as unknown as ServerRequest;

    await expect(
      buildAgentScopedContext({
        agentIds: ['primary', 'secondary'],
        attachmentsByAgentId: new Map([['secondary', [secondaryContext]]]),
        endpointsByAgentId: new Map([
          ['primary', { endpoint: 'openAI' }],
          ['secondary', { endpoint: 'Moonshot' }],
        ]),
        endpoint: 'openAI',
        req,
      }),
    ).resolves.toEqual(new Map([['secondary', expect.stringContaining('secondary-large.txt')]]));
  });

  it('filters endpoint-incompatible scoped resources before admission', async () => {
    const unsupported = Array.from({ length: 11 }, (_, index) => ({
      ...makeTextFile(`binary-${index}`, `binary-${index}.bin`, ''),
      source: FileSources.local,
      type: 'application/octet-stream',
      bytes: 1,
    }));
    const req = {
      body: { fileTokenLimit: 1000 },
      config: {
        fileConfig: {
          endpoints: { Moonshot: { fileLimit: 10, supportedMimeTypes: ['^text/plain$'] } },
        },
      },
    } as unknown as ServerRequest;

    await expect(
      buildAgentScopedContext({
        agentIds: ['secondary'],
        attachmentsByAgentId: new Map([['secondary', unsupported]]),
        endpointsByAgentId: new Map([
          ['secondary', { endpoint: 'Moonshot', endpointType: EModelEndpoint.custom }],
        ]),
        req,
      }),
    ).resolves.toEqual(new Map());
  });
});

describe('files that belong to a tool', () => {
  const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const sandboxRef = {
    kind: 'user',
    id: 'user-1',
    file_id: 'sandbox-file',
    storage_session_id: 's1',
  };

  it('keeps a code output tool-owned after priming clears its expired sandbox references', () => {
    const output = {
      file_id: 'rows-json',
      type: 'application/json',
      context: FileContext.execute_code,
      text: '{"rows":[]}',
      metadata: {},
    } as unknown as IMongoFile;

    expect(isToolOwnedAttachment(output)).toBe(true);
    expect(isModelBoundAttachmentFile(output)).toBe(false);
  });

  it('still treats a route-less user upload without tool references as prompt content', () => {
    const upload = {
      file_id: 'legacy-upload',
      type: 'application/pdf',
      context: FileContext.message_attachment,
      metadata: {},
    } as unknown as IMongoFile;

    expect(isToolOwnedAttachment(upload)).toBe(false);
    expect(isModelBoundAttachmentFile(upload)).toBe(true);
  });

  it('admits a Run Code thread shaped like the one the history limit locked', () => {
    /* Spreadsheets routed to tools with text stored for the fallback, one screenshot, and the
     * code outputs of an earlier run whose expired sandbox references priming cleared. Counted
     * as prompt attachments, the outputs and the spreadsheets' fallback text filled the per-turn
     * count past its default of ten, so every later turn was refused. */
    const config = {
      fileConfig: {
        textFallbackWithoutTools: true,
        endpoints: {
          default: { defaultLLMDeliveryPath: { overrides: { [XLSX]: 'none' as const } } },
        },
      },
    };
    const routing = resolveTurnDeliveryRouting({
      agent: { provider: EModelEndpoint.bedrock, endpoint: EModelEndpoint.bedrock },
      config,
    });
    const consumers = { executeCode: true, fileSearch: false };
    const sheet = (file_id: string, extra: object = {}) =>
      ({
        file_id,
        type: XLSX,
        bytes: 200_000,
        source: FileSources.local,
        context: FileContext.message_attachment,
        llmDeliveryPath: 'none',
        text: 'x'.repeat(110_000),
        metadata: { destinationChosen: false },
        ...extra,
      }) as unknown as IMongoFile;
    const olderSheets = ['q3-actuals', 'q3-budget', 'q3-map'].map((id) =>
      sheet(id, {
        llmDeliveryPath: 'text',
        metadata: { destinationChosen: false, codeEnvRef: sandboxRef },
      }),
    );
    const newSheets = ['s1', 's2', 's3', 's4', 's5', 's6'].map((id) => sheet(id));
    const screenshot = {
      file_id: 'screenshot',
      type: 'image/png',
      bytes: 380_971,
      source: FileSources.local,
      context: FileContext.message_attachment,
      llmDeliveryPath: 'provider',
      metadata: { destinationChosen: false },
    } as unknown as IMongoFile;
    const outputs = Array.from(
      { length: 8 },
      (_, index) =>
        ({
          file_id: `output-${index}`,
          type: 'application/json',
          bytes: 20_000,
          source: FileSources.local,
          context: FileContext.execute_code,
          text: 'y'.repeat(20_000),
          metadata: {},
        }) as unknown as IMongoFile,
    );

    const admitted = applyTurnDelivery([...olderSheets, screenshot, ...newSheets, ...outputs], {
      routing,
      consumers,
    }).filter(isModelBoundAttachmentFile);

    expect(admitted.map((file) => file.file_id)).toEqual(['screenshot']);
    expect(() =>
      assertAgentAttachmentLimits({
        attachments: admitted,
        fileConfig: config.fileConfig,
        endpoint: EModelEndpoint.bedrock,
        countRepeatedExtractedText: true,
      }),
    ).not.toThrow();
  });
});
