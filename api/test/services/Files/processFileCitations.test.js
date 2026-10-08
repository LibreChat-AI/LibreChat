const { Tools } = require('librechat-data-provider');
const {
  processFileCitations,
  applyCitationLimits,
  enhanceSourcesWithMetadata,
} = require('~/server/services/Files/Citations');

// Mock dependencies
jest.mock('~/models', () => ({
  getFiles: jest.fn().mockResolvedValue([]),
  getRoleByName: jest.fn(),
}));

jest.mock('@librechat/api', () => {
  const { applyCitationLimits, selectFileCitationSources } = jest.requireActual('@librechat/api');
  return {
    applyCitationLimits,
    checkAccess: jest.fn().mockResolvedValue(true),
    selectFileCitationSources,
  };
});

jest.mock('~/cache/getLogStores', () => () => ({
  get: jest.fn().mockResolvedValue({
    agents: {
      maxCitations: 30,
      maxCitationsPerFile: 5,
      minRelevanceScore: 0.45,
    },
    fileStrategy: 'local',
  }),
  set: jest.fn(),
  delete: jest.fn(),
}));

jest.mock('~/config', () => ({
  logger: {
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

describe('processFileCitations', () => {
  const mockReq = {
    user: {
      id: 'user123',
    },
  };

  const mockAppConfig = {
    endpoints: {
      agents: {
        maxCitations: 30,
        maxCitationsPerFile: 5,
        minRelevanceScore: 0.45,
      },
    },
    fileStrategy: 'local',
  };

  const mockMetadata = {
    run_id: 'run123',
    thread_id: 'conv123',
  };

  describe('file search artifact processing', () => {
    it('should process file search artifacts correctly', async () => {
      const toolArtifact = {
        [Tools.file_search]: {
          sources: [
            {
              fileId: 'file_123',
              fileName: 'example.pdf',
              pages: [5],
              relevance: 0.85,
              type: 'file',
              pageRelevance: { 5: 0.85 },
              content: 'This is the content',
            },
            {
              fileId: 'file_456',
              fileName: 'document.txt',
              pages: [],
              relevance: 0.72,
              type: 'file',
              pageRelevance: {},
              content: 'Another document',
            },
          ],
        },
      };

      const result = await processFileCitations({
        toolArtifact,
        toolCallId: 'call_123',
        metadata: mockMetadata,
        user: mockReq.user,
        appConfig: mockAppConfig,
      });

      expect(result).toBeTruthy();
      expect(result.type).toBe('file_search');
      expect(result.file_search.sources).toHaveLength(2);
      expect(result.file_search.sources[0].fileId).toBe('file_123');
      expect(result.file_search.sources[0].relevance).toBe(0.85);
    });

    it('should return null for non-file_search tools', async () => {
      const result = await processFileCitations({
        toolArtifact: { other_tool: {} },
        toolCallId: 'call_123',
        metadata: mockMetadata,
        user: mockReq.user,
        appConfig: mockAppConfig,
      });

      expect(result).toBeNull();
    });

    it('should filter results below relevance threshold', async () => {
      const toolArtifact = {
        [Tools.file_search]: {
          sources: [
            {
              fileId: 'file_789',
              fileName: 'low_relevance.pdf',
              pages: [],
              relevance: 0.2,
              type: 'file',
              pageRelevance: {},
              content: 'Low relevance content',
            },
          ],
        },
      };

      const result = await processFileCitations({
        toolArtifact,
        toolCallId: 'call_123',
        metadata: mockMetadata,
        user: mockReq.user,
        appConfig: mockAppConfig,
      });

      expect(result).toBeNull();
    });

    it('should return null when artifact is missing file_search data', async () => {
      const result = await processFileCitations({
        toolArtifact: {},
        toolCallId: 'call_123',
        metadata: mockMetadata,
        user: mockReq.user,
        appConfig: mockAppConfig,
      });

      expect(result).toBeNull();
    });
  });

  describe('applyCitationLimits', () => {
    it('should limit citations per file and total', () => {
      const sources = [
        { fileId: 'file1', relevance: 0.9 },
        { fileId: 'file1', relevance: 0.8 },
        { fileId: 'file1', relevance: 0.7 },
        { fileId: 'file2', relevance: 0.85 },
        { fileId: 'file2', relevance: 0.75 },
      ];

      const result = applyCitationLimits(sources, 3, 2);

      expect(result).toHaveLength(3);
      expect(result[0].relevance).toBe(0.9);
      expect(result[1].relevance).toBe(0.85);
      expect(result[2].relevance).toBe(0.8);
    });
  });

  describe('enhanceSourcesWithMetadata', () => {
    const { getFiles } = require('~/models');
    const mockCustomConfig = {
      fileStrategy: 'local',
    };

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should enhance sources with file metadata from database', async () => {
      const sources = [
        {
          fileId: 'file_123',
          fileName: 'example.pdf',
          relevance: 0.85,
          type: 'file',
        },
        {
          fileId: 'file_456',
          fileName: 'document.txt',
          relevance: 0.72,
          type: 'file',
        },
      ];

      getFiles.mockResolvedValue([
        {
          file_id: 'file_123',
          filename: 'example_from_db.pdf',
          source: 's3',
        },
        {
          file_id: 'file_456',
          filename: 'document_from_db.txt',
          source: 'local',
        },
      ]);

      const result = await enhanceSourcesWithMetadata(sources, mockCustomConfig);

      expect(getFiles).toHaveBeenCalledWith({ file_id: { $in: ['file_123', 'file_456'] } });
      expect(result).toHaveLength(2);

      expect(result[0]).toEqual({
        fileId: 'file_123',
        fileName: 'example_from_db.pdf',
        relevance: 0.85,
        type: 'file',
        metadata: {
          storageType: 's3',
        },
      });

      expect(result[1]).toEqual({
        fileId: 'file_456',
        fileName: 'document_from_db.txt',
        relevance: 0.72,
        type: 'file',
        metadata: {
          storageType: 'local',
        },
      });
    });

    it('should preserve existing metadata and source data', async () => {
      const sources = [
        {
          fileId: 'file_123',
          fileName: 'example.pdf',
          relevance: 0.85,
          type: 'file',
          pages: [1, 2, 3],
          content: 'Some content',
          metadata: {
            existingField: 'value',
          },
        },
      ];

      getFiles.mockResolvedValue([
        {
          file_id: 'file_123',
          filename: 'example_from_db.pdf',
          source: 'gcs',
        },
      ]);

      const result = await enhanceSourcesWithMetadata(sources, mockCustomConfig);

      expect(result[0]).toEqual({
        fileId: 'file_123',
        fileName: 'example_from_db.pdf',
        relevance: 0.85,
        type: 'file',
        pages: [1, 2, 3],
        content: 'Some content',
        metadata: {
          existingField: 'value',
          storageType: 'gcs',
        },
      });
    });

    it('should handle missing file metadata gracefully', async () => {
      const sources = [
        {
          fileId: 'file_789',
          fileName: 'missing.pdf',
          relevance: 0.9,
          type: 'file',
        },
      ];

      getFiles.mockResolvedValue([]);

      const result = await enhanceSourcesWithMetadata(sources, mockCustomConfig);

      expect(result[0]).toEqual({
        fileId: 'file_789',
        fileName: 'missing.pdf',
        relevance: 0.9,
        type: 'file',
        metadata: {
          storageType: 'local', // Falls back to customConfig.fileStrategy
        },
      });
    });

    it('should handle database errors gracefully', async () => {
      const sources = [
        {
          fileId: 'file_123',
          fileName: 'example.pdf',
          relevance: 0.85,
          type: 'file',
        },
      ];

      getFiles.mockRejectedValue(new Error('Database error'));

      const result = await enhanceSourcesWithMetadata(sources, mockCustomConfig);

      expect(result[0]).toEqual({
        fileId: 'file_123',
        fileName: 'example.pdf',
        relevance: 0.85,
        type: 'file',
        metadata: {
          storageType: 'local',
        },
      });
    });

    it('should deduplicate file IDs when querying database', async () => {
      const sources = [
        { fileId: 'file_123', fileName: 'doc1.pdf', relevance: 0.9, type: 'file' },
        { fileId: 'file_123', fileName: 'doc1.pdf', relevance: 0.8, type: 'file' },
        { fileId: 'file_456', fileName: 'doc2.pdf', relevance: 0.7, type: 'file' },
      ];

      getFiles.mockResolvedValue([
        { file_id: 'file_123', filename: 'document1.pdf', source: 's3' },
        { file_id: 'file_456', filename: 'document2.pdf', source: 'local' },
      ]);

      await enhanceSourcesWithMetadata(sources, mockCustomConfig);

      expect(getFiles).toHaveBeenCalledWith({ file_id: { $in: ['file_123', 'file_456'] } });
    });
  });
});
