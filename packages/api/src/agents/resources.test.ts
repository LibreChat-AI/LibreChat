import { logger } from '@librechat/data-schemas';
import {
  FileSources,
  FileContext,
  EModelEndpoint,
  EToolResources,
  AgentCapabilities,
} from 'librechat-data-provider';
import type { TAgentsEndpoint, TFile } from 'librechat-data-provider';
import type { IUser, AppConfig } from '@librechat/data-schemas';
import type { Request as ServerRequest } from 'express';
import type { TGetFiles, TFilterFilesByAgentAccess } from './resources';
import { primeResources } from './resources';

// Mock logger
jest.mock('@librechat/data-schemas', () => ({
  logger: {
    error: jest.fn(),
    info: jest.fn(),
  },
}));

describe('primeResources', () => {
  let mockReq: ServerRequest & { user?: IUser };
  let mockAppConfig: AppConfig;
  let mockGetFiles: jest.MockedFunction<TGetFiles>;
  let mockFilterFiles: jest.MockedFunction<TFilterFilesByAgentAccess>;
  let requestFileSet: Set<string>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockReq = {
      user: { id: 'user1', role: 'USER' },
    } as unknown as ServerRequest & { user?: IUser };

    mockAppConfig = {
      endpoints: {
        [EModelEndpoint.agents]: {
          capabilities: [AgentCapabilities.context],
        } as TAgentsEndpoint,
      },
    } as AppConfig;

    mockGetFiles = jest.fn();
    mockFilterFiles = jest.fn().mockImplementation(({ files }) => Promise.resolve(files));

    requestFileSet = new Set(['file1', 'file2', 'file3']);
  });

  describe('when `context` capability is enabled and tool_resources has "context" file_ids', () => {
    it('should fetch context files and include them in attachments', async () => {
      const mockOcrFiles: TFile[] = [
        {
          user: 'user1',
          file_id: 'ocr-file-1',
          filename: 'document.pdf',
          filepath: '/uploads/document.pdf',
          object: 'file',
          type: 'application/pdf',
          bytes: 1024,
          embedded: false,
          usage: 0,
        },
      ];

      mockGetFiles.mockResolvedValue(mockOcrFiles);

      const tool_resources = {
        [EToolResources.context]: {
          file_ids: ['ocr-file-1'],
        },
      };

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        filterFiles: mockFilterFiles,
        requestFileSet,
        attachments: undefined,
        tool_resources,
        agentId: 'agent_test',
      });

      expect(mockGetFiles).toHaveBeenCalledWith({ file_id: { $in: ['ocr-file-1'] } }, {}, {});
      expect(mockFilterFiles).toHaveBeenCalledWith({
        files: mockOcrFiles,
        userId: 'user1',
        role: 'USER',
        agentId: 'agent_test',
      });
      expect(result.attachments).toEqual(mockOcrFiles);
      expect(result.agentContextAttachments).toEqual(mockOcrFiles);
      expect(result.requestAttachments).toBeUndefined();
      expect(result.tool_resources).toEqual({});
    });
  });

  describe('embedding state across agents that share a file record', () => {
    const sharedContextFile = (embeddedEntities?: string[]): TFile =>
      ({
        user: 'user1',
        file_id: 'shared-context-file',
        filename: 'notes.pdf',
        filepath: '/uploads/notes.pdf',
        object: 'file' as const,
        type: 'application/pdf',
        bytes: 1024,
        usage: 0,
        embedded: true,
        source: FileSources.local,
        context: FileContext.agents,
        ...(embeddedEntities ? { metadata: { embeddedEntities } } : {}),
      }) as TFile;

    const primeFor = (agentId: string, file: TFile) => {
      mockGetFiles.mockResolvedValue([file]);
      return primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        filterFiles: mockFilterFiles,
        requestFileSet,
        attachments: undefined,
        tool_resources: { [EToolResources.context]: { file_ids: ['shared-context-file'] } },
        agentId,
        enabledToolResources: new Set([EToolResources.file_search]),
      });
    };

    it('re-embeds for an agent whose namespace was never provisioned', async () => {
      /* A duplicated agent inherits the file id but searches its own namespace, so the
       * record-wide embedded flag cannot answer for it. */
      const result = await primeFor('agent-b', sharedContextFile(['agent-a']));

      expect(result.provisionState?.vectorDBFiles.map((f) => f.file_id)).toEqual([
        'shared-context-file',
      ]);
    });

    it('does not re-embed for the agent that already provisioned it', async () => {
      const result = await primeFor('agent-a', sharedContextFile(['agent-a']));

      expect(result.provisionState).toBeUndefined();
    });
  });

  describe('when policy screening rejects a persistent context file', () => {
    it('keeps it out of provisioning and out of attachments', async () => {
      /* These files are read inside primeResources, so the caller never sees them to
       * filter. A provider or policy change since they were attached must still stop
       * their bytes reaching the Code API or RAG. */
      const rejected: TFile[] = [
        {
          user: 'user1',
          file_id: 'stale-context-file',
          filename: 'legacy.csv',
          filepath: '/uploads/legacy.csv',
          object: 'file' as const,
          type: 'text/csv',
          bytes: 1024,
          embedded: false,
          usage: 0,
          source: FileSources.local,
          metadata: { destinationChosen: false },
        },
      ];
      mockGetFiles.mockResolvedValue(rejected);

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        filterFiles: mockFilterFiles,
        requestFileSet,
        attachments: undefined,
        tool_resources: { [EToolResources.context]: { file_ids: ['stale-context-file'] } },
        agentId: 'agent_test',
        enabledToolResources: new Set([EToolResources.execute_code, EToolResources.file_search]),
        screenPersistentFiles: () => [],
      });

      expect(result.provisionState).toBeUndefined();
      expect(result.attachments).toBeUndefined();
    });

    it('still provisions a persistent context file the policy allows', async () => {
      const allowed: TFile[] = [
        {
          user: 'user1',
          file_id: 'live-context-file',
          filename: 'data.csv',
          filepath: '/uploads/data.csv',
          object: 'file' as const,
          type: 'text/csv',
          bytes: 1024,
          embedded: false,
          usage: 0,
          source: FileSources.local,
          metadata: { destinationChosen: false },
        },
      ];
      mockGetFiles.mockResolvedValue(allowed);

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        filterFiles: mockFilterFiles,
        requestFileSet,
        attachments: undefined,
        tool_resources: { [EToolResources.context]: { file_ids: ['live-context-file'] } },
        agentId: 'agent_test',
        enabledToolResources: new Set([EToolResources.execute_code, EToolResources.file_search]),
        screenPersistentFiles: (files) => files,
      });

      expect(result.provisionState?.codeEnvFiles.map((f) => f.file_id)).toEqual([
        'live-context-file',
      ]);
    });
  });

  describe('when `context` capability is disabled', () => {
    it('should not fetch context files even if tool_resources has context file_ids', async () => {
      (mockAppConfig.endpoints![EModelEndpoint.agents] as TAgentsEndpoint).capabilities = [];

      const tool_resources = {
        [EToolResources.context]: {
          file_ids: ['ocr-file-1'],
        },
      };

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        requestFileSet,
        attachments: undefined,
        tool_resources,
      });

      expect(mockGetFiles).not.toHaveBeenCalled();
      expect(result.attachments).toBeUndefined();
      expect(result.tool_resources).toEqual(tool_resources);
    });
  });

  describe('when persisted image-edit file IDs are provided', () => {
    it('should rehydrate only accessible image records for tool initialization', async () => {
      const accessibleImage: TFile = {
        user: 'user1',
        file_id: 'accessible-image',
        filename: 'accessible.png',
        filepath: '/uploads/accessible.png',
        object: 'file',
        type: 'image/png',
        bytes: 2048,
        embedded: false,
        usage: 0,
        height: 800,
        width: 600,
      };
      const inaccessibleImage: TFile = {
        ...accessibleImage,
        user: 'other-user',
        file_id: 'inaccessible-image',
        filename: 'inaccessible.png',
        filepath: '/uploads/inaccessible.png',
      };

      mockGetFiles.mockResolvedValue([accessibleImage, inaccessibleImage]);
      mockFilterFiles.mockResolvedValue([accessibleImage]);

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        filterFiles: mockFilterFiles,
        requestFileSet,
        attachments: undefined,
        tool_resources: {
          [EToolResources.image_edit]: {
            file_ids: ['accessible-image', 'inaccessible-image'],
          },
        },
        agentId: 'agent_shared',
      });

      expect(mockGetFiles).toHaveBeenCalledWith(
        { file_id: { $in: ['accessible-image', 'inaccessible-image'] } },
        {},
        {},
      );
      expect(mockFilterFiles).toHaveBeenCalledWith({
        files: [accessibleImage, inaccessibleImage],
        userId: 'user1',
        role: 'USER',
        agentId: 'agent_shared',
      });
      expect(result.tool_resources?.[EToolResources.image_edit]).toEqual({
        file_ids: ['accessible-image', 'inaccessible-image'],
        files: [accessibleImage],
      });
    });

    it('should fetch and filter context and image records in one batch', async () => {
      const contextFile: TFile = {
        user: 'agent-owner',
        file_id: 'context-file',
        filename: 'context.pdf',
        filepath: '/uploads/context.pdf',
        object: 'file',
        type: 'application/pdf',
        bytes: 1024,
        embedded: true,
        usage: 0,
      };
      const sharedImage: TFile = {
        user: 'agent-owner',
        file_id: 'shared-image',
        filename: 'shared.png',
        filepath: '/uploads/shared.png',
        object: 'file',
        type: 'image/png',
        bytes: 2048,
        embedded: false,
        usage: 0,
        height: 800,
        width: 600,
      };
      const imageFile: TFile = {
        ...sharedImage,
        file_id: 'image-file',
        filename: 'image.png',
        filepath: '/uploads/image.png',
      };

      mockGetFiles.mockResolvedValue([contextFile, sharedImage, imageFile]);
      mockFilterFiles.mockResolvedValue([contextFile, sharedImage, imageFile]);

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        filterFiles: mockFilterFiles,
        requestFileSet,
        attachments: undefined,
        tool_resources: {
          [EToolResources.context]: {
            file_ids: ['context-file', 'shared-image'],
          },
          [EToolResources.image_edit]: {
            file_ids: ['shared-image', 'image-file'],
          },
        },
        agentId: 'agent_shared',
      });

      expect(mockGetFiles).toHaveBeenCalledTimes(1);
      expect(mockGetFiles).toHaveBeenCalledWith(
        { file_id: { $in: ['context-file', 'shared-image', 'image-file'] } },
        {},
        {},
      );
      expect(mockFilterFiles).toHaveBeenCalledTimes(1);
      expect(mockFilterFiles).toHaveBeenCalledWith({
        files: [contextFile, sharedImage, imageFile],
        userId: 'user1',
        role: 'USER',
        agentId: 'agent_shared',
      });
      expect(result.attachments).toEqual([contextFile, sharedImage]);
      expect(result.tool_resources?.[EToolResources.image_edit]?.files).toEqual([
        sharedImage,
        imageFile,
      ]);
    });
  });

  describe('when attachments are provided', () => {
    it('should process files with fileIdentifier as execute_code resources', async () => {
      const mockFiles: TFile[] = [
        {
          user: 'user1',
          file_id: 'file1',
          filename: 'script.py',
          filepath: '/uploads/script.py',
          object: 'file',
          type: 'text/x-python',
          bytes: 512,
          embedded: false,
          usage: 0,
          metadata: {
            codeEnvRef: { kind: 'user', id: 'user1', storage_session_id: 'sess', file_id: 'fid' },
          },
        },
      ];

      const attachments = Promise.resolve(mockFiles);

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        requestFileSet,
        attachments,
        tool_resources: {},
      });

      expect(result.attachments).toEqual(mockFiles);
      expect(result.tool_resources?.[EToolResources.execute_code]?.files).toEqual(mockFiles);
    });

    it('should process embedded files as file_search resources', async () => {
      const mockFiles: TFile[] = [
        {
          user: 'user1',
          file_id: 'file2',
          filename: 'document.txt',
          filepath: '/uploads/document.txt',
          object: 'file',
          type: 'text/plain',
          bytes: 256,
          embedded: true,
          usage: 0,
        },
      ];

      const attachments = Promise.resolve(mockFiles);

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        requestFileSet,
        attachments,
        tool_resources: {},
      });

      expect(result.attachments).toEqual(mockFiles);
      expect(result.tool_resources?.[EToolResources.file_search]?.files).toEqual(mockFiles);
    });

    it('should process image files in requestFileSet as image_edit resources', async () => {
      const mockFiles: TFile[] = [
        {
          user: 'user1',
          file_id: 'file1',
          filename: 'image.png',
          filepath: '/uploads/image.png',
          object: 'file',
          type: 'image/png',
          bytes: 2048,
          embedded: false,
          usage: 0,
          height: 800,
          width: 600,
        },
      ];

      const attachments = Promise.resolve(mockFiles);

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        requestFileSet,
        attachments,
        tool_resources: {},
      });

      expect(result.attachments).toEqual(mockFiles);
      expect(result.tool_resources?.[EToolResources.image_edit]?.files).toEqual(mockFiles);
    });

    it('should not process image files not in requestFileSet', async () => {
      const mockFiles: TFile[] = [
        {
          user: 'user1',
          file_id: 'file-not-in-set',
          filename: 'image.png',
          filepath: '/uploads/image.png',
          object: 'file',
          type: 'image/png',
          bytes: 2048,
          embedded: false,
          usage: 0,
          height: 800,
          width: 600,
        },
      ];

      const attachments = Promise.resolve(mockFiles);

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        requestFileSet,
        attachments,
        tool_resources: {},
      });

      expect(result.attachments).toEqual(mockFiles);
      expect(result.tool_resources?.[EToolResources.image_edit]).toBeUndefined();
    });

    it('should not process image files without height and width', async () => {
      const mockFiles: TFile[] = [
        {
          user: 'user1',
          file_id: 'file1',
          filename: 'image.png',
          filepath: '/uploads/image.png',
          object: 'file',
          type: 'image/png',
          bytes: 2048,
          embedded: false,
          usage: 0,
          // Missing height and width
        },
      ];

      const attachments = Promise.resolve(mockFiles);

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        requestFileSet,
        attachments,
        tool_resources: {},
      });

      expect(result.attachments).toEqual(mockFiles);
      expect(result.tool_resources?.[EToolResources.image_edit]).toBeUndefined();
    });

    it('should filter out null files from attachments', async () => {
      const mockFiles: Array<TFile | null> = [
        {
          user: 'user1',
          file_id: 'file1',
          filename: 'valid.txt',
          filepath: '/uploads/valid.txt',
          object: 'file',
          type: 'text/plain',
          bytes: 256,
          embedded: false,
          usage: 0,
        },
        null,
        {
          user: 'user1',
          file_id: 'file2',
          filename: 'valid2.txt',
          filepath: '/uploads/valid2.txt',
          object: 'file',
          type: 'text/plain',
          bytes: 128,
          embedded: false,
          usage: 0,
        },
      ];

      const attachments = Promise.resolve(mockFiles);

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        requestFileSet,
        attachments,
        tool_resources: {},
      });

      expect(result.attachments).toHaveLength(2);
      expect(result.attachments?.[0]?.file_id).toBe('file1');
      expect(result.attachments?.[1]?.file_id).toBe('file2');
    });

    it('should discard persisted files and add trusted attachment records at runtime', async () => {
      const mockFiles: TFile[] = [
        {
          user: 'user1',
          file_id: 'file1',
          filename: 'script.py',
          filepath: '/uploads/script.py',
          object: 'file',
          type: 'text/x-python',
          bytes: 512,
          embedded: false,
          usage: 0,
          metadata: {
            codeEnvRef: { kind: 'user', id: 'user1', storage_session_id: 'sess', file_id: 'fid' },
          },
        },
      ];

      const existingToolResources = {
        [EToolResources.execute_code]: {
          file_ids: ['persisted-id'],
          files: [
            {
              user: 'attacker',
              file_id: 'forged-file',
              filename: 'forged.py',
              filepath: '/etc/passwd',
              object: 'file' as const,
              type: 'text/x-python',
              bytes: 256,
              embedded: false,
              usage: 0,
              source: FileSources.local,
            },
          ],
        },
      };

      const attachments = Promise.resolve(mockFiles);

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        requestFileSet,
        attachments,
        tool_resources: existingToolResources,
      });

      expect(result.tool_resources?.[EToolResources.execute_code]).toEqual({
        file_ids: ['persisted-id'],
        files: mockFiles,
      });
    });
  });

  describe('when both "context" files and "attachments" are provided', () => {
    it('should include both context files and attachment files', async () => {
      const mockOcrFiles: TFile[] = [
        {
          user: 'user1',
          file_id: 'ocr-file-1',
          filename: 'document.pdf',
          filepath: '/uploads/document.pdf',
          object: 'file',
          type: 'application/pdf',
          bytes: 1024,
          embedded: false,
          usage: 0,
        },
      ];

      const mockAttachmentFiles: TFile[] = [
        {
          user: 'user1',
          file_id: 'file1',
          filename: 'attachment.txt',
          filepath: '/uploads/attachment.txt',
          object: 'file',
          type: 'text/plain',
          bytes: 256,
          embedded: false,
          usage: 0,
        },
      ];

      mockGetFiles.mockResolvedValue(mockOcrFiles);
      const attachments = Promise.resolve(mockAttachmentFiles);

      const tool_resources = {
        [EToolResources.context]: {
          file_ids: ['ocr-file-1'],
        },
      };

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        requestFileSet,
        attachments,
        tool_resources,
      });

      expect(result.attachments).toHaveLength(2);
      expect(result.attachments?.[0]?.file_id).toBe('ocr-file-1');
      expect(result.attachments?.[1]?.file_id).toBe('file1');
      expect(result.agentContextAttachments).toEqual(mockOcrFiles);
      expect(result.requestAttachments).toEqual(mockAttachmentFiles);
    });

    it('should include both context (as `ocr` resource) files and attachment files', async () => {
      const mockOcrFiles: TFile[] = [
        {
          user: 'user1',
          file_id: 'ocr-file-1',
          filename: 'document.pdf',
          filepath: '/uploads/document.pdf',
          object: 'file',
          type: 'application/pdf',
          bytes: 1024,
          embedded: false,
          usage: 0,
        },
      ];

      const mockAttachmentFiles: TFile[] = [
        {
          user: 'user1',
          file_id: 'file1',
          filename: 'attachment.txt',
          filepath: '/uploads/attachment.txt',
          object: 'file',
          type: 'text/plain',
          bytes: 256,
          embedded: false,
          usage: 0,
        },
      ];

      mockGetFiles.mockResolvedValue(mockOcrFiles);
      const attachments = Promise.resolve(mockAttachmentFiles);

      const tool_resources = {
        [EToolResources.ocr]: {
          file_ids: ['ocr-file-1'],
        },
      };

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        requestFileSet,
        attachments,
        tool_resources,
      });

      expect(result.attachments).toHaveLength(2);
      expect(result.attachments?.[0]?.file_id).toBe('ocr-file-1');
      expect(result.attachments?.[1]?.file_id).toBe('file1');
      expect(result.agentContextAttachments).toEqual(mockOcrFiles);
      expect(result.requestAttachments).toEqual(mockAttachmentFiles);
    });

    it('should prevent duplicate files when same file exists in context tool_resource and attachments', async () => {
      const sharedFile: TFile = {
        user: 'user1',
        file_id: 'shared-file-id',
        filename: 'document.pdf',
        filepath: '/uploads/document.pdf',
        object: 'file',
        type: 'application/pdf',
        bytes: 1024,
        embedded: false,
        usage: 0,
      };

      const mockOcrFiles: TFile[] = [sharedFile];
      const mockAttachmentFiles: TFile[] = [
        sharedFile,
        {
          user: 'user1',
          file_id: 'unique-file',
          filename: 'other.txt',
          filepath: '/uploads/other.txt',
          object: 'file',
          type: 'text/plain',
          bytes: 256,
          embedded: false,
          usage: 0,
        },
      ];

      mockGetFiles.mockResolvedValue(mockOcrFiles);
      const attachments = Promise.resolve(mockAttachmentFiles);

      const tool_resources = {
        [EToolResources.context]: {
          file_ids: ['shared-file-id'],
        },
      };

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        requestFileSet,
        attachments,
        tool_resources,
      });

      // Should only have 2 files, not 3 (no duplicate)
      expect(result.attachments).toHaveLength(2);
      expect(result.attachments?.filter((f) => f?.file_id === 'shared-file-id')).toHaveLength(1);
      expect(result.attachments?.find((f) => f?.file_id === 'unique-file')).toBeDefined();
      expect(result.agentContextAttachments).toEqual(mockOcrFiles);
      expect(result.requestAttachments).toEqual(mockAttachmentFiles);
    });

    it('should still categorize duplicate files for tool_resources', async () => {
      const sharedFile: TFile = {
        user: 'user1',
        file_id: 'shared-file-id',
        filename: 'script.py',
        filepath: '/uploads/script.py',
        object: 'file',
        type: 'text/x-python',
        bytes: 512,
        embedded: false,
        usage: 0,
        metadata: {
          codeEnvRef: { kind: 'user', id: 'user1', storage_session_id: 'sess', file_id: 'fid' },
        },
      };

      const mockOcrFiles: TFile[] = [sharedFile];
      const mockAttachmentFiles: TFile[] = [sharedFile];

      mockGetFiles.mockResolvedValue(mockOcrFiles);
      const attachments = Promise.resolve(mockAttachmentFiles);

      const tool_resources = {
        [EToolResources.context]: {
          file_ids: ['shared-file-id'],
        },
      };

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        requestFileSet,
        attachments,
        tool_resources,
      });

      // File should appear only once in attachments
      expect(result.attachments).toHaveLength(1);
      expect(result.attachments?.[0]?.file_id).toBe('shared-file-id');

      // But should still be categorized in tool_resources
      expect(result.tool_resources?.[EToolResources.execute_code]?.files).toHaveLength(1);
      expect(result.tool_resources?.[EToolResources.execute_code]?.files?.[0]?.file_id).toBe(
        'shared-file-id',
      );
    });

    it('should handle multiple duplicate files', async () => {
      const file1: TFile = {
        user: 'user1',
        file_id: 'file-1',
        filename: 'doc1.pdf',
        filepath: '/uploads/doc1.pdf',
        object: 'file',
        type: 'application/pdf',
        bytes: 1024,
        embedded: false,
        usage: 0,
      };

      const file2: TFile = {
        user: 'user1',
        file_id: 'file-2',
        filename: 'doc2.pdf',
        filepath: '/uploads/doc2.pdf',
        object: 'file',
        type: 'application/pdf',
        bytes: 2048,
        embedded: false,
        usage: 0,
      };

      const uniqueFile: TFile = {
        user: 'user1',
        file_id: 'unique-file',
        filename: 'unique.txt',
        filepath: '/uploads/unique.txt',
        object: 'file',
        type: 'text/plain',
        bytes: 256,
        embedded: false,
        usage: 0,
      };

      const mockOcrFiles: TFile[] = [file1, file2];
      const mockAttachmentFiles: TFile[] = [file1, file2, uniqueFile];

      mockGetFiles.mockResolvedValue(mockOcrFiles);
      const attachments = Promise.resolve(mockAttachmentFiles);

      const tool_resources = {
        [EToolResources.context]: {
          file_ids: ['file-1', 'file-2'],
        },
      };

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        requestFileSet,
        attachments,
        tool_resources,
      });

      // Should have 3 files total (2 from context files + 1 unique from attachments)
      expect(result.attachments).toHaveLength(3);

      // Each file should appear only once
      const fileIds = result.attachments?.map((f) => f?.file_id);
      expect(fileIds).toContain('file-1');
      expect(fileIds).toContain('file-2');
      expect(fileIds).toContain('unique-file');

      // Check no duplicates
      const uniqueFileIds = new Set(fileIds);
      expect(uniqueFileIds.size).toBe(fileIds?.length);
    });

    it('should handle files without file_id gracefully', async () => {
      const fileWithoutId: Partial<TFile> = {
        user: 'user1',
        filename: 'no-id.txt',
        filepath: '/uploads/no-id.txt',
        object: 'file',
        type: 'text/plain',
        bytes: 256,
        embedded: false,
        usage: 0,
      };

      const normalFile: TFile = {
        user: 'user1',
        file_id: 'normal-file',
        filename: 'normal.txt',
        filepath: '/uploads/normal.txt',
        object: 'file',
        type: 'text/plain',
        bytes: 512,
        embedded: false,
        usage: 0,
      };

      const mockOcrFiles: TFile[] = [normalFile];
      const mockAttachmentFiles = [fileWithoutId as TFile, normalFile];

      mockGetFiles.mockResolvedValue(mockOcrFiles);
      const attachments = Promise.resolve(mockAttachmentFiles);

      const tool_resources = {
        [EToolResources.context]: {
          file_ids: ['normal-file'],
        },
      };

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        requestFileSet,
        attachments,
        tool_resources,
      });

      // Should include file without ID and one instance of normal file
      expect(result.attachments).toHaveLength(2);
      expect(result.attachments?.filter((f) => f?.file_id === 'normal-file')).toHaveLength(1);
      expect(result.attachments?.some((f) => !f?.file_id)).toBe(true);
    });

    it('should rebuild runtime files from trusted attachments instead of persisted files', async () => {
      const existingFile: TFile = {
        user: 'user1',
        file_id: 'existing-file',
        filename: 'existing.py',
        filepath: '/uploads/existing.py',
        object: 'file',
        type: 'text/x-python',
        bytes: 512,
        embedded: false,
        usage: 0,
        metadata: {
          codeEnvRef: { kind: 'user', id: 'user1', storage_session_id: 'sess', file_id: 'fid' },
        },
      };

      const newFile: TFile = {
        user: 'user1',
        file_id: 'new-file',
        filename: 'new.py',
        filepath: '/uploads/new.py',
        object: 'file',
        type: 'text/x-python',
        bytes: 256,
        embedded: false,
        usage: 0,
        metadata: {
          codeEnvRef: { kind: 'user', id: 'user1', storage_session_id: 'sess', file_id: 'fid' },
        },
      };

      const existingToolResources = {
        [EToolResources.execute_code]: {
          files: [existingFile],
        },
      };

      const attachments = Promise.resolve([existingFile, newFile]);

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        requestFileSet,
        attachments,
        tool_resources: existingToolResources,
      });

      expect(result.attachments).toEqual([existingFile, newFile]);

      expect(result.tool_resources?.[EToolResources.execute_code]?.files).toHaveLength(2);
      const fileIds = result.tool_resources?.[EToolResources.execute_code]?.files?.map(
        (f) => f.file_id,
      );
      expect(fileIds).toEqual(['existing-file', 'new-file']);
    });

    it('should handle duplicates within attachments array', async () => {
      const duplicatedFile: TFile = {
        user: 'user1',
        file_id: 'dup-file',
        filename: 'duplicate.txt',
        filepath: '/uploads/duplicate.txt',
        object: 'file',
        type: 'text/plain',
        bytes: 256,
        embedded: false,
        usage: 0,
      };

      const uniqueFile: TFile = {
        user: 'user1',
        file_id: 'unique-file',
        filename: 'unique.txt',
        filepath: '/uploads/unique.txt',
        object: 'file',
        type: 'text/plain',
        bytes: 128,
        embedded: false,
        usage: 0,
      };

      // Same file appears multiple times in attachments
      const attachments = Promise.resolve([
        duplicatedFile,
        duplicatedFile,
        uniqueFile,
        duplicatedFile,
      ]);

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        requestFileSet,
        attachments,
        tool_resources: {},
      });

      // Should only have 2 unique files
      expect(result.attachments).toHaveLength(2);
      const fileIds = result.attachments?.map((f) => f?.file_id);
      expect(fileIds).toContain('dup-file');
      expect(fileIds).toContain('unique-file');

      // Verify no duplicates
      expect(fileIds?.filter((id) => id === 'dup-file')).toHaveLength(1);
    });

    it('should not let persisted files suppress trusted attachments', async () => {
      const multiPurposeFile: TFile = {
        user: 'user1',
        file_id: 'multi-file',
        filename: 'data.txt',
        filepath: '/uploads/data.txt',
        object: 'file',
        type: 'text/plain',
        bytes: 512,
        embedded: true, // Will be categorized as file_search
        usage: 0,
      };

      const existingToolResources = {
        [EToolResources.file_search]: {
          files: [multiPurposeFile],
        },
      };

      const attachments = Promise.resolve([multiPurposeFile]);

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        requestFileSet,
        attachments,
        tool_resources: existingToolResources,
      });

      expect(result.attachments).toEqual([multiPurposeFile]);

      expect(result.tool_resources?.[EToolResources.file_search]?.files).toHaveLength(1);
      expect(result.tool_resources?.[EToolResources.file_search]?.files?.[0]?.file_id).toBe(
        'multi-file',
      );
    });

    it('should handle complex scenario with context files, existing tool_resources, and attachments', async () => {
      const ocrFile: TFile = {
        user: 'user1',
        file_id: 'ocr-file',
        filename: 'scan.pdf',
        filepath: '/uploads/scan.pdf',
        object: 'file',
        type: 'application/pdf',
        bytes: 2048,
        embedded: false,
        usage: 0,
      };

      const existingFile: TFile = {
        user: 'user1',
        file_id: 'existing-file',
        filename: 'code.py',
        filepath: '/uploads/code.py',
        object: 'file',
        type: 'text/x-python',
        bytes: 512,
        embedded: false,
        usage: 0,
        metadata: {
          codeEnvRef: { kind: 'user', id: 'user1', storage_session_id: 'sess', file_id: 'fid' },
        },
      };

      const newFile: TFile = {
        user: 'user1',
        file_id: 'new-file',
        filename: 'image.png',
        filepath: '/uploads/image.png',
        object: 'file',
        type: 'image/png',
        bytes: 4096,
        embedded: false,
        usage: 0,
        height: 800,
        width: 600,
      };

      mockGetFiles.mockResolvedValue([ocrFile, existingFile]); // context returns both files
      const attachments = Promise.resolve([existingFile, ocrFile, newFile]); // Attachments has duplicates

      const existingToolResources = {
        [EToolResources.context]: {
          file_ids: ['ocr-file', 'existing-file'],
        },
        [EToolResources.execute_code]: {
          files: [existingFile],
        },
      };

      requestFileSet.add('new-file'); // Only new-file is in request set

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        requestFileSet,
        attachments,
        tool_resources: existingToolResources,
      });

      // Should have 3 unique files total
      expect(result.attachments).toHaveLength(3);
      const attachmentIds = result.attachments?.map((f) => f?.file_id).sort();
      expect(attachmentIds).toEqual(['existing-file', 'new-file', 'ocr-file']);

      // Check tool_resources
      expect(result.tool_resources?.[EToolResources.execute_code]?.files).toHaveLength(1);
      expect(result.tool_resources?.[EToolResources.image_edit]?.files).toHaveLength(1);
      expect(result.tool_resources?.[EToolResources.image_edit]?.files?.[0]?.file_id).toBe(
        'new-file',
      );
    });
  });

  describe('error handling', () => {
    it('should handle errors gracefully and log them', async () => {
      const mockFiles: TFile[] = [
        {
          user: 'user1',
          file_id: 'file1',
          filename: 'test.txt',
          filepath: '/uploads/test.txt',
          object: 'file',
          type: 'text/plain',
          bytes: 256,
          embedded: false,
          usage: 0,
        },
      ];

      const attachments = Promise.resolve(mockFiles);
      const error = new Error('Test error');

      // Mock getFiles to throw an error when called for context
      mockGetFiles.mockRejectedValue(error);

      const tool_resources = {
        [EToolResources.context]: {
          file_ids: ['ocr-file-1'],
        },
      };

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        requestFileSet,
        attachments,
        tool_resources,
      });

      expect(logger.error).toHaveBeenCalledWith('Error priming resources', error);
      expect(result.attachments).toEqual(mockFiles);
      expect(result.tool_resources).toEqual({});
    });

    it('should handle promise rejection in attachments', async () => {
      const error = new Error('Attachment error');
      const attachments = Promise.reject(error);

      // The function should now handle rejected attachment promises gracefully
      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        requestFileSet,
        attachments,
        tool_resources: {},
      });

      // Should log both the main error and the attachment error
      expect(logger.error).toHaveBeenCalledWith('Error priming resources', error);
      expect(logger.error).toHaveBeenCalledWith(
        'Error resolving attachments in catch block',
        error,
      );

      // Should return empty array when attachments promise is rejected
      expect(result.attachments).toEqual([]);
      expect(result.tool_resources).toEqual({});
    });
  });

  describe('tool_resources field deletion behavior', () => {
    it('should not mutate the original tool_resources object', async () => {
      const originalToolResources = {
        [EToolResources.context]: {
          file_ids: ['context-file-1'],
          files: [
            {
              user: 'user1',
              file_id: 'context-file-1',
              filename: 'original.txt',
              filepath: '/uploads/original.txt',
              object: 'file' as const,
              type: 'text/plain',
              bytes: 256,
              embedded: false,
              usage: 0,
            },
          ],
        },
        [EToolResources.ocr]: {
          file_ids: ['ocr-file-1'],
        },
      };

      // Create a deep copy to compare later
      const originalCopy = JSON.parse(JSON.stringify(originalToolResources));

      const mockOcrFiles: TFile[] = [
        {
          user: 'user1',
          file_id: 'ocr-file-1',
          filename: 'document.pdf',
          filepath: '/uploads/document.pdf',
          object: 'file',
          type: 'application/pdf',
          bytes: 1024,
          embedded: true,
          usage: 0,
        },
      ];

      mockGetFiles.mockResolvedValue(mockOcrFiles);

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        requestFileSet,
        attachments: undefined,
        tool_resources: originalToolResources,
      });

      // Original object should remain unchanged
      expect(originalToolResources).toEqual(originalCopy);

      // Result should have modifications
      expect(result.tool_resources?.[EToolResources.ocr]).toBeUndefined();
      expect(result.tool_resources?.[EToolResources.context]).toBeUndefined();
      expect(result.tool_resources?.[EToolResources.file_search]).toBeDefined();
    });

    it('should delete ocr field after merging file_ids with context', async () => {
      const mockOcrFiles: TFile[] = [
        {
          user: 'user1',
          file_id: 'ocr-file-1',
          filename: 'document.pdf',
          filepath: '/uploads/document.pdf',
          object: 'file',
          type: 'application/pdf',
          bytes: 1024,
          embedded: true, // Will be categorized as file_search
          usage: 0,
        },
      ];

      mockGetFiles.mockResolvedValue(mockOcrFiles);

      const tool_resources = {
        [EToolResources.ocr]: {
          file_ids: ['ocr-file-1'],
        },
        [EToolResources.context]: {
          file_ids: ['context-file-1'],
        },
      };

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        requestFileSet,
        attachments: undefined,
        tool_resources,
      });

      // OCR field should be deleted after merging
      expect(result.tool_resources?.[EToolResources.ocr]).toBeUndefined();
      // Context field should also be deleted since files were fetched and re-categorized
      expect(result.tool_resources?.[EToolResources.context]).toBeUndefined();
      // File should be categorized as file_search based on embedded=true
      expect(result.tool_resources?.[EToolResources.file_search]?.files).toHaveLength(1);
      expect(result.tool_resources?.[EToolResources.file_search]?.files?.[0]?.file_id).toBe(
        'ocr-file-1',
      );

      expect(mockGetFiles).toHaveBeenCalledWith(
        { file_id: { $in: ['context-file-1', 'ocr-file-1'] } },
        {},
        {},
      );
    });

    it('should delete context field when fetching and re-categorizing files', async () => {
      const mockContextFiles: TFile[] = [
        {
          user: 'user1',
          file_id: 'context-file-1',
          filename: 'script.py',
          filepath: '/uploads/script.py',
          object: 'file',
          type: 'text/x-python',
          bytes: 512,
          embedded: false,
          usage: 0,
          metadata: {
            codeEnvRef: { kind: 'user', id: 'user1', storage_session_id: 'sess', file_id: 'fid' },
          },
        },
        {
          user: 'user1',
          file_id: 'context-file-2',
          filename: 'data.txt',
          filepath: '/uploads/data.txt',
          object: 'file',
          type: 'text/plain',
          bytes: 256,
          embedded: true,
          usage: 0,
        },
      ];

      mockGetFiles.mockResolvedValue(mockContextFiles);

      const tool_resources = {
        [EToolResources.context]: {
          file_ids: ['context-file-1', 'context-file-2'],
        },
      };

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        requestFileSet,
        attachments: undefined,
        tool_resources,
      });

      // Context field should be deleted after fetching files
      expect(result.tool_resources?.[EToolResources.context]).toBeUndefined();

      // Files should be re-categorized based on their properties
      expect(result.tool_resources?.[EToolResources.execute_code]?.files).toHaveLength(1);
      expect(result.tool_resources?.[EToolResources.execute_code]?.files?.[0]?.file_id).toBe(
        'context-file-1',
      );

      expect(result.tool_resources?.[EToolResources.file_search]?.files).toHaveLength(1);
      expect(result.tool_resources?.[EToolResources.file_search]?.files?.[0]?.file_id).toBe(
        'context-file-2',
      );
    });

    it('should preserve context field when context capability is disabled', async () => {
      // Disable context capability
      (mockAppConfig.endpoints![EModelEndpoint.agents] as TAgentsEndpoint).capabilities = [];

      const tool_resources = {
        [EToolResources.context]: {
          file_ids: ['context-file-1'],
        },
      };

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        requestFileSet,
        attachments: undefined,
        tool_resources,
      });

      // Context field should be preserved when capability is disabled
      expect(result.tool_resources?.[EToolResources.context]).toEqual({
        file_ids: ['context-file-1'],
      });

      // getFiles should not have been called
      expect(mockGetFiles).not.toHaveBeenCalled();
    });

    it('should still delete ocr field even when context capability is disabled', async () => {
      // Disable context capability
      (mockAppConfig.endpoints![EModelEndpoint.agents] as TAgentsEndpoint).capabilities = [];

      const tool_resources = {
        [EToolResources.ocr]: {
          file_ids: ['ocr-file-1'],
        },
        [EToolResources.context]: {
          file_ids: ['context-file-1'],
        },
      };

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        requestFileSet,
        attachments: undefined,
        tool_resources,
      });

      // OCR field should still be deleted (merged into context)
      expect(result.tool_resources?.[EToolResources.ocr]).toBeUndefined();

      // Context field should contain merged file_ids but not be processed
      expect(result.tool_resources?.[EToolResources.context]).toEqual({
        file_ids: ['context-file-1', 'ocr-file-1'],
      });

      // getFiles should not have been called since context is disabled
      expect(mockGetFiles).not.toHaveBeenCalled();
    });
  });

  describe('access control filtering', () => {
    it('should filter context files through filterFiles when provided', async () => {
      const ownedFile: TFile = {
        user: 'user1',
        file_id: 'owned-file',
        filename: 'owned.pdf',
        filepath: '/uploads/owned.pdf',
        object: 'file',
        type: 'application/pdf',
        bytes: 1024,
        embedded: false,
        usage: 0,
      };

      const inaccessibleFile: TFile = {
        user: 'other-user',
        file_id: 'inaccessible-file',
        filename: 'secret.pdf',
        filepath: '/uploads/secret.pdf',
        object: 'file',
        type: 'application/pdf',
        bytes: 2048,
        embedded: false,
        usage: 0,
      };

      mockGetFiles.mockResolvedValue([ownedFile, inaccessibleFile]);
      mockFilterFiles.mockResolvedValue([ownedFile]);

      const tool_resources = {
        [EToolResources.context]: {
          file_ids: ['owned-file', 'inaccessible-file'],
        },
      };

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        filterFiles: mockFilterFiles,
        requestFileSet,
        attachments: undefined,
        tool_resources,
        agentId: 'agent_shared',
      });

      expect(mockFilterFiles).toHaveBeenCalledWith({
        files: [ownedFile, inaccessibleFile],
        userId: 'user1',
        role: 'USER',
        agentId: 'agent_shared',
      });
      expect(result.attachments).toEqual([ownedFile]);
      expect(result.attachments).not.toContainEqual(inaccessibleFile);
    });

    it('should filter OCR files merged into context through filterFiles', async () => {
      const ocrFile: TFile = {
        user: 'other-user',
        file_id: 'ocr-restricted',
        filename: 'scan.pdf',
        filepath: '/uploads/scan.pdf',
        object: 'file',
        type: 'application/pdf',
        bytes: 1024,
        embedded: false,
        usage: 0,
      };

      mockGetFiles.mockResolvedValue([ocrFile]);
      mockFilterFiles.mockResolvedValue([]);

      const tool_resources = {
        [EToolResources.ocr]: {
          file_ids: ['ocr-restricted'],
        },
      };

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        filterFiles: mockFilterFiles,
        requestFileSet,
        attachments: undefined,
        tool_resources,
        agentId: 'agent_shared',
      });

      expect(mockFilterFiles).toHaveBeenCalledWith({
        files: [ocrFile],
        userId: 'user1',
        role: 'USER',
        agentId: 'agent_shared',
      });
      expect(result.attachments).toBeUndefined();
    });

    it('should skip filtering when filterFiles is not provided', async () => {
      const mockFile: TFile = {
        user: 'user1',
        file_id: 'file-1',
        filename: 'doc.pdf',
        filepath: '/uploads/doc.pdf',
        object: 'file',
        type: 'application/pdf',
        bytes: 1024,
        embedded: false,
        usage: 0,
      };

      mockGetFiles.mockResolvedValue([mockFile]);

      const tool_resources = {
        [EToolResources.context]: {
          file_ids: ['file-1'],
        },
      };

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        requestFileSet,
        attachments: undefined,
        tool_resources,
        agentId: 'agent_test',
      });

      expect(mockFilterFiles).not.toHaveBeenCalled();
      expect(result.attachments).toEqual([mockFile]);
    });

    it('should skip filtering when user ID is missing', async () => {
      const reqNoUser = {} as unknown as ServerRequest & { user?: IUser };
      const mockFile: TFile = {
        user: 'user1',
        file_id: 'file-1',
        filename: 'doc.pdf',
        filepath: '/uploads/doc.pdf',
        object: 'file',
        type: 'application/pdf',
        bytes: 1024,
        embedded: false,
        usage: 0,
      };

      mockGetFiles.mockResolvedValue([mockFile]);

      const tool_resources = {
        [EToolResources.context]: {
          file_ids: ['file-1'],
        },
      };

      const result = await primeResources({
        req: reqNoUser,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        filterFiles: mockFilterFiles,
        requestFileSet,
        attachments: undefined,
        tool_resources,
        agentId: 'agent_test',
      });

      expect(mockFilterFiles).not.toHaveBeenCalled();
      expect(result.attachments).toEqual([mockFile]);
    });

    it('should gracefully handle filterFiles rejection', async () => {
      const mockFile: TFile = {
        user: 'user1',
        file_id: 'file-1',
        filename: 'doc.pdf',
        filepath: '/uploads/doc.pdf',
        object: 'file',
        type: 'application/pdf',
        bytes: 1024,
        embedded: false,
        usage: 0,
      };

      mockGetFiles.mockResolvedValue([mockFile]);
      mockFilterFiles.mockRejectedValue(new Error('DB failure'));

      const tool_resources = {
        [EToolResources.context]: {
          file_ids: ['file-1'],
        },
      };

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        filterFiles: mockFilterFiles,
        requestFileSet,
        attachments: undefined,
        tool_resources,
        agentId: 'agent_test',
      });

      expect(logger.error).toHaveBeenCalledWith('Error priming resources', expect.any(Error));
      expect(result.tool_resources).toEqual({});
    });

    it('should skip filtering when agentId is missing', async () => {
      const mockFile: TFile = {
        user: 'user1',
        file_id: 'file-1',
        filename: 'doc.pdf',
        filepath: '/uploads/doc.pdf',
        object: 'file',
        type: 'application/pdf',
        bytes: 1024,
        embedded: false,
        usage: 0,
      };

      mockGetFiles.mockResolvedValue([mockFile]);

      const tool_resources = {
        [EToolResources.context]: {
          file_ids: ['file-1'],
        },
      };

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        filterFiles: mockFilterFiles,
        requestFileSet,
        attachments: undefined,
        tool_resources,
      });

      expect(mockFilterFiles).not.toHaveBeenCalled();
      expect(result.attachments).toEqual([mockFile]);
    });
  });

  describe('edge cases', () => {
    it('should handle missing appConfig agents endpoint gracefully', async () => {
      const reqWithoutLocals = {} as ServerRequest & { user?: IUser };
      const emptyAppConfig = {} as AppConfig;

      const result = await primeResources({
        req: reqWithoutLocals,
        appConfig: emptyAppConfig,
        getFiles: mockGetFiles,
        requestFileSet,
        attachments: undefined,
        tool_resources: {
          [EToolResources.context]: {
            file_ids: ['ocr-file-1'],
          },
        },
      });

      expect(mockGetFiles).not.toHaveBeenCalled();
      // When appConfig agents endpoint is missing, context is disabled
      // and no attachments are provided, the function returns undefined
      expect(result.attachments).toBeUndefined();
    });

    it('should handle undefined tool_resources', async () => {
      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        requestFileSet,
        attachments: undefined,
        tool_resources: undefined,
      });

      expect(result.tool_resources).toEqual({});
      expect(result.attachments).toBeUndefined();
    });

    it('should handle empty requestFileSet', async () => {
      const mockFiles: TFile[] = [
        {
          user: 'user1',
          file_id: 'file1',
          filename: 'image.png',
          filepath: '/uploads/image.png',
          object: 'file',
          type: 'image/png',
          bytes: 2048,
          embedded: false,
          usage: 0,
          height: 800,
          width: 600,
        },
      ];

      const attachments = Promise.resolve(mockFiles);
      const emptyRequestFileSet = new Set<string>();

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        requestFileSet: emptyRequestFileSet,
        attachments,
        tool_resources: {},
      });

      expect(result.attachments).toEqual(mockFiles);
      expect(result.tool_resources?.[EToolResources.image_edit]).toBeUndefined();
    });
  });

  describe('llmDeliveryPath handling', () => {
    it('should keep files with llmDeliveryPath "none" in attachments', async () => {
      const providerFile: TFile = {
        user: 'user1',
        file_id: 'provider-file',
        filename: 'image.png',
        filepath: '/path/image.png',
        type: 'image/png',
        bytes: 1000,
        object: 'file' as const,
        usage: 0,
        embedded: false,
        source: FileSources.local,
        llmDeliveryPath: 'provider',
        width: 100,
        height: 100,
      };
      const noneFile: TFile = {
        user: 'user1',
        file_id: 'none-file',
        filename: 'audio.mp3',
        filepath: '/path/audio.mp3',
        type: 'audio/mpeg',
        bytes: 5000,
        object: 'file' as const,
        usage: 0,
        embedded: false,
        source: FileSources.local,
        llmDeliveryPath: 'none',
        metadata: { destinationChosen: false },
      };

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        filterFiles: mockFilterFiles,
        tool_resources: {},
        attachments: Promise.resolve([providerFile, noneFile]),
        requestFileSet,
        agentId: 'agent1',
      });

      const attachmentIds = result.attachments?.map((f) => f?.file_id);
      expect(attachmentIds).toContain('provider-file');
      expect(attachmentIds).toContain('none-file');
    });

    it('should include llmDeliveryPath "none" files in lazy provisioning state', async () => {
      const noneFile: TFile = {
        user: 'user1',
        file_id: 'none-file',
        filename: 'data.csv',
        filepath: '/path/data.csv',
        type: 'text/csv',
        bytes: 5000,
        object: 'file' as const,
        usage: 0,
        embedded: false,
        source: FileSources.local,
        llmDeliveryPath: 'none',
        metadata: { destinationChosen: false },
      };

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        filterFiles: mockFilterFiles,
        tool_resources: {},
        attachments: Promise.resolve([noneFile]),
        requestFileSet,
        agentId: 'agent1',
        enabledToolResources: new Set([EToolResources.execute_code, EToolResources.file_search]),
        loadCodeApiKey: jest.fn().mockResolvedValue('code-key'),
      });

      expect(result.attachments?.map((f) => f?.file_id)).toContain('none-file');
      expect(result.provisionState?.codeEnvFiles.map((f) => f.file_id)).toContain('none-file');
      expect(result.provisionState?.vectorDBFiles.map((f) => f.file_id)).toContain('none-file');
    });

    it('provisions nothing when the legacy destination chooser is active', async () => {
      /* In legacy mode the destination is the user's explicit choice and the upload path
       * already acted on it, so a missing reference records a decline, not pending work.
       * Queueing on it would send the file to a service the user did not select. */
      const providerFile: TFile = {
        user: 'user1',
        file_id: 'provider-file',
        filename: 'data.csv',
        filepath: '/path/data.csv',
        type: 'text/csv',
        bytes: 5000,
        object: 'file' as const,
        usage: 0,
        embedded: false,
        source: FileSources.local,
      };

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        filterFiles: mockFilterFiles,
        tool_resources: {},
        attachments: Promise.resolve([providerFile]),
        requestFileSet,
        agentId: 'agent1',
        enabledToolResources: new Set([EToolResources.execute_code, EToolResources.file_search]),
        loadCodeApiKey: jest.fn().mockResolvedValue('code-key'),
      });

      expect(result.attachments?.map((f) => f?.file_id)).toContain('provider-file');
      expect(result.provisionState).toBeUndefined();
    });

    it('should include files with undefined llmDeliveryPath in attachments (legacy files)', async () => {
      const legacyFile: TFile = {
        user: 'user1',
        file_id: 'legacy-file',
        filename: 'doc.pdf',
        filepath: '/path/doc.pdf',
        type: 'application/pdf',
        bytes: 2000,
        object: 'file' as const,
        usage: 0,
        embedded: false,
        source: FileSources.local,
      };

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        filterFiles: mockFilterFiles,
        tool_resources: {},
        attachments: Promise.resolve([legacyFile]),
        requestFileSet,
        agentId: 'agent1',
      });

      const attachmentIds = result.attachments?.map((f) => f?.file_id);
      expect(attachmentIds).toContain('legacy-file');
    });
  });

  describe('code auth gating for lazy provisioning', () => {
    const priorAuthProvider = process.env.CODEAPI_AUTH_PROVIDER;
    const priorJwtEnabled = process.env.CODEAPI_JWT_ENABLED;

    afterEach(() => {
      if (priorAuthProvider === undefined) {
        delete process.env.CODEAPI_AUTH_PROVIDER;
      } else {
        process.env.CODEAPI_AUTH_PROVIDER = priorAuthProvider;
      }
      if (priorJwtEnabled === undefined) {
        delete process.env.CODEAPI_JWT_ENABLED;
      } else {
        process.env.CODEAPI_JWT_ENABLED = priorJwtEnabled;
      }
    });

    const makeCodeFile = (overrides: Partial<TFile> = {}): TFile => ({
      user: 'user1',
      file_id: 'code-file',
      filename: 'data.csv',
      filepath: '/path/data.csv',
      type: 'text/csv',
      bytes: 5000,
      object: 'file' as const,
      usage: 0,
      embedded: false,
      source: FileSources.local,
      llmDeliveryPath: 'none',
      metadata: { destinationChosen: false },
      ...overrides,
    });

    it('populates codeEnvFiles under JWT code auth without a legacy key', async () => {
      process.env.CODEAPI_AUTH_PROVIDER = 'librechat-jwt';

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        filterFiles: mockFilterFiles,
        tool_resources: {},
        attachments: Promise.resolve([makeCodeFile()]),
        requestFileSet,
        agentId: 'agent1',
        enabledToolResources: new Set([EToolResources.execute_code]),
      });

      expect(result.provisionState?.codeEnvFiles.map((f) => f.file_id)).toContain('code-file');
    });

    it('still queues provisioning for an unauthenticated Code API deployment', async () => {
      delete process.env.CODEAPI_AUTH_PROVIDER;
      delete process.env.CODEAPI_JWT_ENABLED;

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        filterFiles: mockFilterFiles,
        tool_resources: {},
        attachments: Promise.resolve([makeCodeFile()]),
        requestFileSet,
        agentId: 'agent1',
        enabledToolResources: new Set([EToolResources.execute_code]),
        loadCodeApiKey: jest.fn().mockResolvedValue(undefined),
      });

      expect(result.provisionState?.codeEnvFiles.map((f) => f.file_id)).toContain('code-file');
    });

    it('passes req through to checkSessionsAlive so JWT auth can mint tokens', async () => {
      process.env.CODEAPI_AUTH_PROVIDER = 'librechat-jwt';
      const checkSessionsAlive = jest.fn().mockResolvedValue(new Set(['ref-file']));
      const refFile = makeCodeFile({
        file_id: 'ref-file',
        metadata: {
          codeEnvRef: { kind: 'user', id: 'user1', storage_session_id: 'sess', file_id: 'remote' },
        },
      });

      await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        filterFiles: mockFilterFiles,
        tool_resources: {},
        attachments: Promise.resolve([refFile]),
        requestFileSet,
        agentId: 'agent1',
        enabledToolResources: new Set([EToolResources.execute_code]),
        checkSessionsAlive,
      });

      expect(checkSessionsAlive).toHaveBeenCalledWith(
        expect.objectContaining({ req: mockReq, apiKey: undefined }),
      );
    });

    it('queues re-provisioning and clears refs for a pre-categorized stale code file', async () => {
      process.env.CODEAPI_AUTH_PROVIDER = 'librechat-jwt';
      const checkSessionsAlive = jest.fn().mockResolvedValue(new Set<string>());
      const staleFile = makeCodeFile({
        file_id: 'stale-file',
        metadata: {
          codeEnvRef: {
            kind: 'user',
            id: 'user1',
            storage_session_id: 'sess',
            file_id: 'remote',
            executionProfile: 'default',
            sandboxFilename: 'default-alias.csv',
          },
          codeEnvRefs: {
            default: {
              kind: 'user',
              id: 'user1',
              storage_session_id: 'sess',
              file_id: 'remote',
              executionProfile: 'default',
              sandboxFilename: 'default-alias.csv',
            },
            'stateful:env1': {
              kind: 'user',
              id: 'user1',
              storage_session_id: 'sess-2',
              file_id: 'remote-2',
              executionProfile: 'stateful',
              sandboxFilename: 'stateful-alias.csv',
            },
          },
        },
      });

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        filterFiles: mockFilterFiles,
        tool_resources: {},
        attachments: Promise.resolve([staleFile]),
        requestFileSet,
        agentId: 'agent1',
        enabledToolResources: new Set([EToolResources.execute_code]),
        checkSessionsAlive,
      });

      expect(result.provisionState?.codeEnvFiles.map((f) => f.file_id)).toContain('stale-file');
      expect(result.provisionState?.codeEnvRecoveryNames?.get('stale-file')).toEqual({
        name: 'default-alias.csv',
        isTargetScope: true,
      });
      expect(staleFile.metadata?.codeEnvRef).toBeUndefined();
      expect(staleFile.metadata?.codeEnvRefs?.default).toBeUndefined();
      expect(staleFile.metadata?.codeEnvRefs?.['stateful:env1']).toBeDefined();
    });

    it('probes a stateful route against its own Code API and clears its stale ref', async () => {
      /* A configured deployment issues its own refs, so leaving it out of the probe left
       * a dead session usable forever: nothing queued a replacement and the same file id
       * was injected on every later turn. */
      process.env.CODEAPI_AUTH_PROVIDER = 'librechat-jwt';
      const checkSessionsAlive = jest.fn().mockResolvedValue(new Set<string>());
      const statefulFile = makeCodeFile({
        file_id: 'stateful-stale',
        metadata: {
          codeEnvRefs: {
            default: {
              kind: 'user',
              id: 'user1',
              storage_session_id: 'sess-default',
              file_id: 'remote-default',
              executionProfile: 'default',
              sandboxFilename: 'default-alias.csv',
            },
            'stateful:env1': {
              kind: 'user',
              id: 'user1',
              storage_session_id: 'sess-2',
              file_id: 'remote-2',
              executionProfile: 'stateful',
              sandboxFilename: 'stateful-alias.csv',
              executionRouteKey: 'stateful:env1',
            },
          },
        },
      });

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        filterFiles: mockFilterFiles,
        tool_resources: {},
        attachments: Promise.resolve([statefulFile]),
        requestFileSet,
        agentId: 'agent1',
        enabledToolResources: new Set([EToolResources.execute_code]),
        checkSessionsAlive,
        codeRouteKey: 'stateful:env1',
        codeBaseUrl: 'https://stateful.example.com',
      });

      expect(checkSessionsAlive).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: 'https://stateful.example.com',
          routeKey: 'stateful:env1',
        }),
      );
      expect(result.provisionState?.codeEnvFiles.map((f) => f.file_id)).toContain('stateful-stale');
      expect(result.provisionState?.codeEnvRecoveryNames?.get('stateful-stale')).toEqual({
        name: 'stateful-alias.csv',
        isTargetScope: true,
      });
      expect(statefulFile.metadata?.codeEnvRefs?.['stateful:env1']).toBeUndefined();
      /* Another deployment's ref is untouched: this probe never asked about it. */
      expect(statefulFile.metadata?.codeEnvRefs?.default).toBeDefined();
    });

    it('keeps alive pre-categorized files out of the provisioning queue', async () => {
      process.env.CODEAPI_AUTH_PROVIDER = 'librechat-jwt';
      const checkSessionsAlive = jest.fn().mockResolvedValue(new Set(['alive-file']));
      const aliveFile = makeCodeFile({
        file_id: 'alive-file',
        metadata: {
          codeEnvRef: { kind: 'user', id: 'user1', storage_session_id: 'sess', file_id: 'remote' },
        },
      });

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        filterFiles: mockFilterFiles,
        tool_resources: {},
        attachments: Promise.resolve([aliveFile]),
        requestFileSet,
        agentId: 'agent1',
        enabledToolResources: new Set([EToolResources.execute_code]),
        checkSessionsAlive,
      });

      expect(result.provisionState).toBeUndefined();
      const codeFiles = result.tool_resources?.[EToolResources.execute_code]?.files;
      expect(codeFiles?.map((f) => f.file_id)).toContain('alive-file');
    });

    it('does not treat refs as stale when no liveness check ran', async () => {
      process.env.CODEAPI_AUTH_PROVIDER = 'librechat-jwt';
      const refFile = makeCodeFile({
        file_id: 'unchecked-file',
        metadata: {
          codeEnvRef: { kind: 'user', id: 'user1', storage_session_id: 'sess', file_id: 'remote' },
        },
      });

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        filterFiles: mockFilterFiles,
        tool_resources: {},
        attachments: Promise.resolve([refFile]),
        requestFileSet,
        agentId: 'agent1',
        enabledToolResources: new Set([EToolResources.execute_code]),
      });

      expect(result.provisionState).toBeUndefined();
      expect(refFile.metadata?.codeEnvRef).toBeDefined();
    });

    it('skips the liveness check when JWT auth has no req to mint from', async () => {
      process.env.CODEAPI_AUTH_PROVIDER = 'librechat-jwt';
      const checkSessionsAlive = jest.fn();
      const refFile = makeCodeFile({
        file_id: 'principal-file',
        metadata: {
          codeEnvRef: { kind: 'user', id: 'user1', storage_session_id: 'sess', file_id: 'remote' },
        },
      });

      const result = await primeResources({
        principal: { id: 'user1', role: 'USER' },
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        filterFiles: mockFilterFiles,
        tool_resources: {},
        attachments: Promise.resolve([refFile]),
        requestFileSet,
        agentId: 'agent1',
        enabledToolResources: new Set([EToolResources.execute_code]),
        checkSessionsAlive,
      });

      expect(checkSessionsAlive).not.toHaveBeenCalled();
      expect(result.provisionState).toBeUndefined();
      expect(refFile.metadata?.codeEnvRef).toBeDefined();
    });

    it('never clears a non-default route ref probed against the default Code API', async () => {
      process.env.CODEAPI_AUTH_PROVIDER = 'librechat-jwt';
      const checkSessionsAlive = jest.fn().mockResolvedValue(new Set<string>());
      const statefulRef = {
        kind: 'user' as const,
        id: 'user1',
        storage_session_id: 'sess-stateful',
        file_id: 'remote-stateful',
        executionProfile: 'stateful' as const,
        executionRouteKey: 'stateful:abc',
      };
      const statefulFile = makeCodeFile({
        file_id: 'stateful-file',
        metadata: { codeEnvRef: statefulRef, codeEnvRefs: { 'stateful:abc': statefulRef } },
      });

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        filterFiles: mockFilterFiles,
        tool_resources: {},
        attachments: Promise.resolve([statefulFile]),
        requestFileSet,
        agentId: 'agent1',
        enabledToolResources: new Set([EToolResources.execute_code]),
        checkSessionsAlive,
        /* The agent runs on the same route the ref names, so the file is already usable
         * and the probe has nothing to clear. */
        codeRouteKey: 'stateful:abc',
      });

      expect(checkSessionsAlive).not.toHaveBeenCalled();
      expect(result.provisionState).toBeUndefined();
      expect(statefulFile.metadata?.codeEnvRef).toEqual(statefulRef);
      expect(statefulFile.metadata?.codeEnvRefs?.['stateful:abc']).toEqual(statefulRef);
    });

    it('keeps a usable stateful reference when the default session behind it died', async () => {
      /* Liveness is probed on the default route only, so a dead default session says
       * nothing about the stateful deployment this turn runs on. Re-uploading there is
       * redundant, and a failure would abort a tool call the existing file could serve. */
      const defaultRef = {
        kind: 'user' as const,
        id: 'user1',
        storage_session_id: 'sess-default',
        file_id: 'remote-default',
      };
      const statefulRef = {
        kind: 'user' as const,
        id: 'user1',
        storage_session_id: 'sess-stateful',
        file_id: 'remote-stateful',
        executionProfile: 'stateful' as const,
        executionRouteKey: 'stateful:abc',
      };
      const bothRoutesFile = makeCodeFile({
        file_id: 'both-routes-file',
        metadata: {
          codeEnvRef: defaultRef,
          codeEnvRefs: { default: defaultRef, 'stateful:abc': statefulRef },
        },
      });
      const checkSessionsAlive = jest.fn().mockResolvedValue(new Set<string>());

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        filterFiles: mockFilterFiles,
        tool_resources: {},
        attachments: Promise.resolve([bothRoutesFile]),
        requestFileSet,
        agentId: 'agent1',
        enabledToolResources: new Set([EToolResources.execute_code]),
        checkSessionsAlive,
        codeRouteKey: 'stateful:abc',
      });

      expect(checkSessionsAlive).not.toHaveBeenCalled();
      expect(result.provisionState?.codeEnvFiles ?? []).toEqual([]);
      expect(bothRoutesFile.metadata?.codeEnvRefs?.['stateful:abc']).toEqual(statefulRef);
    });

    it('reprovisions a sandbox reference owned by another agent', async () => {
      /* Code API derives its session key from the reference kind and id, so an agent-owned
       * reference points at a session this caller cannot read. Reusing it adds the file to
       * the second agent's code resources while the bytes live in the first agent's. */
      const foreignRef = {
        kind: 'agent' as const,
        id: 'other-agent',
        storage_session_id: 'sess-other',
        file_id: 'remote-other',
      };
      const foreignScopedFile = makeCodeFile({
        file_id: 'foreign-code-file',
        metadata: { codeEnvRef: foreignRef, codeEnvRefs: { default: foreignRef } },
      });

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        filterFiles: mockFilterFiles,
        tool_resources: {},
        attachments: Promise.resolve([foreignScopedFile]),
        requestFileSet,
        agentId: 'agent1',
        enabledToolResources: new Set([EToolResources.execute_code]),
      });

      expect(result.provisionState?.codeEnvFiles.map((f) => f.file_id)).toEqual([
        'foreign-code-file',
      ]);
    });

    it('keeps a sandbox reference already owned by the requesting user', async () => {
      /* The converse: a message attachment is provisioned under the user, so a matching
       * user reference is reusable and must not be uploaded again every turn. */
      const ownRef = {
        kind: 'user' as const,
        id: 'user1',
        storage_session_id: 'sess-own',
        file_id: 'remote-own',
      };
      const ownScopedFile = makeCodeFile({
        file_id: 'own-code-file',
        metadata: { codeEnvRef: ownRef, codeEnvRefs: { default: ownRef } },
      });

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        filterFiles: mockFilterFiles,
        tool_resources: {},
        attachments: Promise.resolve([ownScopedFile]),
        requestFileSet,
        agentId: 'agent1',
        enabledToolResources: new Set([EToolResources.execute_code]),
      });

      expect(result.provisionState?.codeEnvFiles ?? []).toEqual([]);
    });

    it('queues a file whose only reference names another code route', async () => {
      /* Priming resolves the active route alone, so a reference to a different deployment
       * would leave the sandbox call without the attachment. */
      const otherRouteRef = {
        kind: 'user' as const,
        id: 'user1',
        storage_session_id: 'sess-a',
        file_id: 'remote-a',
        executionProfile: 'stateful' as const,
        executionRouteKey: 'stateful:a',
      };
      const otherRouteFile = makeCodeFile({
        file_id: 'other-route-file',
        metadata: { codeEnvRef: otherRouteRef, codeEnvRefs: { 'stateful:a': otherRouteRef } },
      });

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        filterFiles: mockFilterFiles,
        tool_resources: {},
        attachments: Promise.resolve([otherRouteFile]),
        requestFileSet,
        agentId: 'agent1',
        enabledToolResources: new Set([EToolResources.execute_code]),
        codeRouteKey: 'stateful:b',
      });

      expect(result.provisionState?.codeEnvFiles.map((f) => f.file_id)).toEqual([
        'other-route-file',
      ]);
    });

    it('queues persistent context files on a turn with no request attachments', async () => {
      process.env.CODEAPI_AUTH_PROVIDER = 'librechat-jwt';
      const contextFile: TFile = {
        user: 'user1',
        file_id: 'context-file',
        filename: 'handbook.pdf',
        filepath: '/uploads/handbook.pdf',
        object: 'file',
        type: 'application/pdf',
        bytes: 2048,
        embedded: false,
        usage: 0,
        metadata: { destinationChosen: false },
      };
      mockGetFiles.mockResolvedValue([contextFile]);

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        filterFiles: mockFilterFiles,
        tool_resources: { [EToolResources.context]: { file_ids: ['context-file'] } },
        attachments: undefined,
        requestFileSet,
        agentId: 'agent1',
        enabledToolResources: new Set([EToolResources.execute_code, EToolResources.file_search]),
      });

      expect(result.provisionState?.codeEnvFiles.map((f) => f.file_id)).toContain('context-file');
      expect(result.provisionState?.vectorDBFiles.map((f) => f.file_id)).toContain('context-file');
    });

    it('rebuilds an embedded agent context file as an agent-scoped file_id', async () => {
      const embeddedContextFile: TFile = {
        user: 'user1',
        file_id: 'embedded-context',
        filename: 'handbook.pdf',
        filepath: '/uploads/handbook.pdf',
        object: 'file',
        type: 'application/pdf',
        bytes: 2048,
        embedded: true,
        usage: 0,
        context: FileContext.agents,
        metadata: { embeddedEntities: ['agent1'] },
      } as TFile;
      mockGetFiles.mockResolvedValue([embeddedContextFile]);

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        filterFiles: mockFilterFiles,
        tool_resources: { [EToolResources.context]: { file_ids: ['embedded-context'] } },
        attachments: undefined,
        requestFileSet,
        agentId: 'agent1',
      });

      const searchResource = result.tool_resources?.[EToolResources.file_search];
      expect(searchResource?.file_ids).toContain('embedded-context');
      expect(searchResource?.files?.map((f) => f.file_id) ?? []).not.toContain('embedded-context');
    });

    it('re-embeds a foreign agent setup file attached as an ordinary message file', async () => {
      /* Its vectors live under the other agent's entity, and the record-wide flag cannot
       * say otherwise. Registering it for the user namespace on the strength of that flag
       * leaves file_search querying a namespace holding none of its vectors, which returns
       * nothing rather than failing. */
      const foreignSetupFile = {
        user: 'user1',
        file_id: 'foreign-setup',
        filename: 'handbook.pdf',
        filepath: '/uploads/handbook.pdf',
        object: 'file',
        type: 'application/pdf',
        bytes: 2048,
        embedded: true,
        usage: 0,
        context: FileContext.agents,
        metadata: { embeddedEntities: ['other-agent'] },
      } as TFile;

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        filterFiles: mockFilterFiles,
        tool_resources: {},
        attachments: Promise.resolve([foreignSetupFile]),
        requestFileSet,
        agentId: 'agent1',
        enabledToolResources: new Set([EToolResources.file_search]),
      });

      const searchResource = result.tool_resources?.[EToolResources.file_search];
      expect(searchResource?.files?.map((f) => f.file_id) ?? []).not.toContain('foreign-setup');
      expect(result.provisionState?.vectorDBFiles.map((f) => f.file_id)).toEqual(['foreign-setup']);
    });

    it('registers a file already embedded in the user namespace without re-queueing it', async () => {
      /* The converse: once an unscoped upload records the user namespace, the file is
       * reachable through .files and must not be embedded again every turn. */
      const userNamespaceFile = {
        user: 'user1',
        file_id: 'user-embedded',
        filename: 'handbook.pdf',
        filepath: '/uploads/handbook.pdf',
        object: 'file',
        type: 'application/pdf',
        bytes: 2048,
        embedded: true,
        usage: 0,
        context: FileContext.agents,
        metadata: { embeddedEntities: ['other-agent', 'user1'] },
      } as TFile;

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        filterFiles: mockFilterFiles,
        tool_resources: {},
        attachments: Promise.resolve([userNamespaceFile]),
        requestFileSet,
        agentId: 'agent1',
        enabledToolResources: new Set([EToolResources.file_search]),
      });

      const searchResource = result.tool_resources?.[EToolResources.file_search];
      expect(searchResource?.files?.map((f) => f.file_id) ?? []).toContain('user-embedded');
      expect(result.provisionState?.vectorDBFiles ?? []).toEqual([]);
    });

    it('re-embeds an agent context file recorded before namespaces were tracked', async () => {
      /* Records predating per-namespace tracking cannot say which agent holds their
       * vectors, so they are provisioned once for the agent that next uses them and carry
       * the namespace afterwards. */
      const legacyContextFile = {
        user: 'user1',
        file_id: 'legacy-context',
        filename: 'handbook.pdf',
        filepath: '/uploads/handbook.pdf',
        object: 'file',
        type: 'application/pdf',
        bytes: 2048,
        embedded: true,
        usage: 0,
        context: FileContext.agents,
      } as TFile;
      mockGetFiles.mockResolvedValue([legacyContextFile]);

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        filterFiles: mockFilterFiles,
        tool_resources: { [EToolResources.context]: { file_ids: ['legacy-context'] } },
        attachments: undefined,
        requestFileSet,
        agentId: 'agent1',
        enabledToolResources: new Set([EToolResources.file_search]),
      });

      expect(result.provisionState?.vectorDBFiles.map((f) => f.file_id)).toEqual([
        'legacy-context',
      ]);
    });

    it('leaves a file alone whose destination came from the legacy chooser', async () => {
      /* The endpoint deciding this turn need not be the one the file was uploaded under,
       * so the request-level legacy check cannot answer for it. Its missing references
       * are declines, not work to do. */
      const chosenFile = {
        user: 'user1',
        file_id: 'legacy-chosen',
        filename: 'notes.csv',
        filepath: '/uploads/notes.csv',
        object: 'file',
        type: 'text/csv',
        bytes: 512,
        embedded: false,
        usage: 0,
        metadata: { destinationChosen: true },
      } as TFile;

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        filterFiles: mockFilterFiles,
        tool_resources: {},
        attachments: Promise.resolve([chosenFile]),
        requestFileSet,
        agentId: 'agent1',
        enabledToolResources: new Set([EToolResources.execute_code, EToolResources.file_search]),
      });

      expect(result.provisionState).toBeUndefined();
    });

    it('queues a unified file even when this turn runs under the legacy setting', async () => {
      /* The marker says the upload was not a legacy choice, so its missing references are
       * work to do. Deferring to the request's setting would let the tool run without it
       * after an administrator flips the endpoint or a handoff crosses providers. */
      const unifiedFile = {
        user: 'user1',
        file_id: 'unified-under-legacy',
        filename: 'notes.csv',
        filepath: '/uploads/notes.csv',
        object: 'file',
        type: 'text/csv',
        bytes: 512,
        embedded: false,
        usage: 0,
        metadata: { destinationChosen: false },
      } as TFile;

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        filterFiles: mockFilterFiles,
        tool_resources: {},
        attachments: Promise.resolve([unifiedFile]),
        requestFileSet,
        agentId: 'agent1',
        enabledToolResources: new Set([EToolResources.file_search]),
      });

      expect(result.provisionState?.vectorDBFiles.map((f) => f.file_id)).toEqual([
        'unified-under-legacy',
      ]);
    });

    it('preserves chooser semantics for a record predating the marker', async () => {
      /* Every markerless record predates unified routing. Missing destination evidence
       * therefore means the chooser declined this consumer, regardless of today's mode. */
      const legacyEraFile = {
        user: 'user1',
        file_id: 'pre-marker',
        filename: 'notes.csv',
        filepath: '/uploads/notes.csv',
        object: 'file',
        type: 'text/csv',
        bytes: 512,
        embedded: false,
        usage: 0,
      } as TFile;

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        filterFiles: mockFilterFiles,
        tool_resources: {},
        attachments: Promise.resolve([legacyEraFile]),
        requestFileSet,
        agentId: 'agent1',
        enabledToolResources: new Set([EToolResources.file_search]),
      });

      expect(result.provisionState).toBeUndefined();
    });

    it('uses persisted membership as the destination for a pre-marker chooser file', async () => {
      const legacySearchFile = {
        user: 'user1',
        file_id: 'pre-marker-search',
        filename: 'notes.pdf',
        filepath: '/uploads/notes.pdf',
        object: 'file',
        type: 'application/pdf',
        bytes: 512,
        embedded: false,
        usage: 0,
        source: FileSources.local,
      } as TFile;
      mockGetFiles.mockResolvedValue([legacySearchFile]);

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        filterFiles: mockFilterFiles,
        tool_resources: {
          [EToolResources.file_search]: { file_ids: ['pre-marker-search'] },
        },
        attachments: undefined,
        requestFileSet,
        agentId: 'agent1',
        enabledToolResources: new Set([EToolResources.execute_code, EToolResources.file_search]),
      });

      expect(result.provisionState?.vectorDBFiles.map((file) => file.file_id)).toEqual([
        'pre-marker-search',
      ]);
      expect(result.provisionState?.codeEnvFiles).toEqual([]);
    });

    it('removes a screened-out file id from the runtime tool resources', async () => {
      /* The tool primers read these ids directly and re-check only access, so a record
       * the screen rejected still reaches the Code API unless its id goes with it. */
      const rejected = {
        user: 'user1',
        file_id: 'rejected-code',
        filename: 'bundle.zip',
        filepath: '/uploads/bundle.zip',
        object: 'file',
        type: 'application/zip',
        bytes: 2048,
        embedded: false,
        usage: 0,
        context: FileContext.agents,
      } as TFile;
      mockGetFiles.mockResolvedValue([rejected]);
      const tool_resources = {
        [EToolResources.execute_code]: { file_ids: ['rejected-code'] },
      };

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        filterFiles: mockFilterFiles,
        tool_resources,
        attachments: undefined,
        requestFileSet,
        agentId: 'agent1',
        enabledToolResources: new Set([EToolResources.execute_code]),
        screenPersistentFiles: () => [],
      });

      expect(result.tool_resources?.[EToolResources.execute_code]?.file_ids ?? []).not.toContain(
        'rejected-code',
      );
    });

    it('keeps screened resources pruned when a later liveness probe fails', async () => {
      const rejected = {
        user: 'user1',
        file_id: 'rejected-code',
        filename: 'rejected.zip',
        filepath: '/uploads/rejected.zip',
        object: 'file',
        type: 'application/zip',
        bytes: 2048,
        embedded: false,
        usage: 0,
        context: FileContext.agents,
      } as TFile;
      const allowed = {
        ...rejected,
        file_id: 'allowed-code',
        filename: 'allowed.zip',
        metadata: {
          destinationChosen: false,
          codeEnvRef: {
            kind: 'agent',
            id: 'agent1',
            storage_session_id: 'session',
            file_id: 'remote',
          },
        },
      } as TFile;
      mockGetFiles.mockResolvedValue([rejected, allowed]);

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        filterFiles: mockFilterFiles,
        tool_resources: {
          [EToolResources.execute_code]: {
            file_ids: ['rejected-code', 'allowed-code'],
          },
        },
        attachments: undefined,
        requestFileSet,
        agentId: 'agent1',
        enabledToolResources: new Set([EToolResources.execute_code]),
        screenPersistentFiles: (files) => files.filter((file) => file.file_id === 'allowed-code'),
        checkSessionsAlive: jest.fn().mockRejectedValue(new Error('code api unavailable')),
      });

      expect(result.tool_resources?.[EToolResources.execute_code]?.file_ids).toEqual([
        'allowed-code',
      ]);
    });

    it('queues a permanent code resource on a turn that attaches nothing', async () => {
      /* A promoted code upload waits for the route the turn resolves, so it carries no
       * sandbox reference. Without loading the agent's own code resources here, its first
       * code call runs without the file it was uploaded for. */
      const codeResourceFile = {
        user: 'user1',
        file_id: 'permanent-code',
        filename: 'bundle.zip',
        filepath: '/uploads/bundle.zip',
        object: 'file',
        type: 'application/zip',
        bytes: 2048,
        embedded: false,
        usage: 0,
        context: FileContext.agents,
        metadata: { destinationChosen: false },
      } as TFile;
      mockGetFiles.mockResolvedValue([codeResourceFile]);

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        filterFiles: mockFilterFiles,
        tool_resources: {
          [EToolResources.execute_code]: { file_ids: ['permanent-code'] },
        },
        attachments: undefined,
        requestFileSet,
        agentId: 'agent1',
        enabledToolResources: new Set([EToolResources.execute_code]),
      });

      expect(result.provisionState?.codeEnvFiles.map((f) => f.file_id)).toEqual(['permanent-code']);
    });

    it('reprovisions a chooser message attachment onto the route this turn uses', async () => {
      /* A message attachment is never in the agent's resources, so membership cannot show
       * which destination the chooser picked. The reference it already carries can: only
       * a code upload creates one. */
      const defaultRef = {
        kind: 'user' as const,
        id: 'user1',
        storage_session_id: 'sess-default',
        file_id: 'remote-default',
      };
      const chosenAttachment = makeCodeFile({
        file_id: 'chooser-attachment',
        metadata: {
          destinationChosen: true,
          codeEnvRef: defaultRef,
          codeEnvRefs: { default: defaultRef },
        },
      });

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        filterFiles: mockFilterFiles,
        tool_resources: {},
        attachments: Promise.resolve([chosenAttachment]),
        requestFileSet,
        agentId: 'agent1',
        enabledToolResources: new Set([EToolResources.execute_code, EToolResources.file_search]),
        codeRouteKey: 'stateful:abc',
      });

      expect(result.provisionState?.codeEnvFiles.map((f) => f.file_id)).toEqual([
        'chooser-attachment',
      ]);
      /* And still only that destination: search was declined at upload. */
      expect(result.provisionState?.vectorDBFiles ?? []).toEqual([]);
    });

    it('reprovisions the destination a chooser upload was actually filed under', async () => {
      /* A duplicated agent inherits the file id but not its vectors, and the marker says
       * the upload was a chooser one without saying which destination it chose. Blanket
       * suppression leaves search querying a namespace holding nothing. */
      const inherited = {
        user: 'user1',
        file_id: 'inherited-search',
        filename: 'handbook.pdf',
        filepath: '/uploads/handbook.pdf',
        object: 'file',
        type: 'application/pdf',
        bytes: 2048,
        embedded: true,
        usage: 0,
        context: FileContext.agents,
        metadata: { destinationChosen: true, embeddedEntities: ['original-agent'] },
      } as TFile;
      mockGetFiles.mockResolvedValue([inherited]);

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        filterFiles: mockFilterFiles,
        tool_resources: {
          [EToolResources.file_search]: { file_ids: ['inherited-search'] },
        },
        attachments: undefined,
        requestFileSet,
        agentId: 'agent1',
        enabledToolResources: new Set([EToolResources.file_search, EToolResources.execute_code]),
      });

      expect(result.provisionState?.vectorDBFiles.map((f) => f.file_id)).toEqual([
        'inherited-search',
      ]);
      /* And only that destination: code was declined at upload. */
      expect(result.provisionState?.codeEnvFiles ?? []).toEqual([]);
    });

    it('keeps a type the sandbox cannot take out of the code queue', async () => {
      /* Uploading it aborts the whole tool batch over a file that was only ever meant for
       * provider delivery. */
      const clip = {
        user: 'user1',
        file_id: 'clip-file',
        filename: 'clip.mp4',
        filepath: '/uploads/clip.mp4',
        object: 'file',
        type: 'video/mp4',
        bytes: 4096,
        embedded: false,
        usage: 0,
      } as TFile;

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        filterFiles: mockFilterFiles,
        tool_resources: {},
        attachments: Promise.resolve([clip]),
        requestFileSet,
        agentId: 'agent1',
        enabledToolResources: new Set([EToolResources.execute_code]),
      });

      expect(result.provisionState?.codeEnvFiles ?? []).toEqual([]);
    });

    it('keeps a type the vector store cannot read out of the search queue', async () => {
      /* Queueing it sends it to RAG on the next search call, and extraction refusing it
       * aborts the tool over a file that was never a search candidate. */
      const archive = {
        user: 'user1',
        file_id: 'archive-file',
        filename: 'bundle.zip',
        filepath: '/uploads/bundle.zip',
        object: 'file',
        type: 'application/zip',
        bytes: 2048,
        embedded: false,
        usage: 0,
      } as TFile;

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        filterFiles: mockFilterFiles,
        tool_resources: {},
        attachments: Promise.resolve([archive]),
        requestFileSet,
        agentId: 'agent1',
        enabledToolResources: new Set([EToolResources.file_search]),
      });

      expect(result.provisionState?.vectorDBFiles ?? []).toEqual([]);
    });

    it('queues a deferred candidate for provisioning without delivering it again', async () => {
      process.env.CODEAPI_AUTH_PROVIDER = 'librechat-jwt';
      const deferred = makeCodeFile({ file_id: 'deferred-file' });

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        filterFiles: mockFilterFiles,
        tool_resources: {},
        attachments: Promise.resolve([]),
        requestFileSet,
        agentId: 'agent1',
        enabledToolResources: new Set([EToolResources.execute_code, EToolResources.file_search]),
        provisionCandidates: [deferred],
      });

      expect(result.provisionState?.codeEnvFiles.map((f) => f.file_id)).toContain('deferred-file');
      expect(result.provisionState?.vectorDBFiles.map((f) => f.file_id)).toContain('deferred-file');
      /* The point of the separation: it must not become an attachment again. */
      expect(result.attachments?.map((f) => f?.file_id) ?? []).not.toContain('deferred-file');
    });

    it('does not double-queue a candidate that is already an attachment', async () => {
      process.env.CODEAPI_AUTH_PROVIDER = 'librechat-jwt';
      const file = makeCodeFile({ file_id: 'shared-file' });

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        filterFiles: mockFilterFiles,
        tool_resources: {},
        attachments: Promise.resolve([file]),
        requestFileSet,
        agentId: 'agent1',
        enabledToolResources: new Set([EToolResources.execute_code]),
        provisionCandidates: [{ ...file }],
      });

      const queued = result.provisionState?.codeEnvFiles.filter((f) => f.file_id === 'shared-file');
      expect(queued).toHaveLength(1);
    });

    it('never queues a text-source record, which has no streamable backing', async () => {
      process.env.CODEAPI_AUTH_PROVIDER = 'librechat-jwt';
      const textFile = makeCodeFile({ file_id: 'text-record', source: FileSources.text });

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        filterFiles: mockFilterFiles,
        tool_resources: {},
        attachments: Promise.resolve([textFile]),
        requestFileSet,
        agentId: 'agent1',
        enabledToolResources: new Set([EToolResources.execute_code, EToolResources.file_search]),
      });

      expect(result.provisionState).toBeUndefined();
      expect(result.attachments?.map((f) => f?.file_id)).toContain('text-record');
    });

    it('grants agent scope only to the active agent own resource files', async () => {
      /* A user who owns another agent's setup file can attach it here. Scoping it to this
       * agent would provision it under an identity this agent's other users share, so the
       * record's context is not enough: membership in this agent's resources decides. */
      const foreignSetupFile = makeCodeFile({
        file_id: 'foreign-agent-file',
        context: FileContext.agents,
      });
      const ownSetupFile = makeCodeFile({ file_id: 'own-agent-file', context: FileContext.agents });
      mockGetFiles.mockResolvedValue([ownSetupFile]);

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        filterFiles: mockFilterFiles,
        tool_resources: { [EToolResources.context]: { file_ids: ['own-agent-file'] } },
        attachments: Promise.resolve([foreignSetupFile]),
        requestFileSet,
        agentId: 'agent1',
        enabledToolResources: new Set([EToolResources.execute_code]),
      });

      const scoped = result.provisionState?.agentScopedFileIds;
      expect(scoped?.has('own-agent-file')).toBe(true);
      expect(scoped?.has('foreign-agent-file')).toBe(false);
    });

    it('rebuilds an embedded code output under files, not agent file_ids', async () => {
      const codeOutput: TFile = {
        user: 'user1',
        file_id: 'code-output',
        filename: 'plot.csv',
        filepath: '/uploads/plot.csv',
        object: 'file',
        type: 'text/csv',
        bytes: 512,
        embedded: true,
        usage: 0,
        context: FileContext.execute_code,
      };
      mockGetFiles.mockResolvedValue([codeOutput]);

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        filterFiles: mockFilterFiles,
        tool_resources: { [EToolResources.context]: { file_ids: ['code-output'] } },
        attachments: undefined,
        requestFileSet,
        agentId: 'agent1',
      });

      const searchResource = result.tool_resources?.[EToolResources.file_search];
      expect(searchResource?.files?.map((f) => f.file_id)).toContain('code-output');
      expect(searchResource?.file_ids ?? []).not.toContain('code-output');
    });

    it('rebuilds an embedded user attachment under files, not agent file_ids', async () => {
      const embeddedAttachment: TFile = {
        user: 'user1',
        file_id: 'embedded-attachment',
        filename: 'notes.pdf',
        filepath: '/uploads/notes.pdf',
        object: 'file',
        type: 'application/pdf',
        bytes: 1024,
        embedded: true,
        usage: 0,
        context: FileContext.message_attachment,
      };
      mockGetFiles.mockResolvedValue([embeddedAttachment]);

      const result = await primeResources({
        req: mockReq,
        appConfig: mockAppConfig,
        getFiles: mockGetFiles,
        filterFiles: mockFilterFiles,
        tool_resources: { [EToolResources.context]: { file_ids: ['embedded-attachment'] } },
        attachments: undefined,
        requestFileSet,
        agentId: 'agent1',
      });

      const searchResource = result.tool_resources?.[EToolResources.file_search];
      expect(searchResource?.files?.map((f) => f.file_id)).toContain('embedded-attachment');
      expect(searchResource?.file_ids ?? []).not.toContain('embedded-attachment');
    });
  });
});
