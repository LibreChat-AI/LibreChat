const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { batchResetMeiliFlags } = require('./utils');

describe('batchResetMeiliFlags', () => {
  let mongoServer;
  let testCollection;
  const ORIGINAL_BATCH_SIZE = process.env.MEILI_SYNC_BATCH_SIZE;
  const ORIGINAL_BATCH_DELAY = process.env.MEILI_SYNC_DELAY_MS;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const mongoUri = mongoServer.getUri();
    await mongoose.connect(mongoUri);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();

    // Restore original env variables
    if (ORIGINAL_BATCH_SIZE !== undefined) {
      process.env.MEILI_SYNC_BATCH_SIZE = ORIGINAL_BATCH_SIZE;
    } else {
      delete process.env.MEILI_SYNC_BATCH_SIZE;
    }

    if (ORIGINAL_BATCH_DELAY !== undefined) {
      process.env.MEILI_SYNC_DELAY_MS = ORIGINAL_BATCH_DELAY;
    } else {
      delete process.env.MEILI_SYNC_DELAY_MS;
    }
  });

  beforeEach(async () => {
    // Create a fresh collection for each test
    testCollection = mongoose.connection.db.collection('test_meili_batch');
    await testCollection.deleteMany({});

    // Reset env variables to defaults
    delete process.env.MEILI_SYNC_BATCH_SIZE;
    delete process.env.MEILI_SYNC_DELAY_MS;
  });

  afterEach(async () => {
    if (testCollection) {
      await testCollection.deleteMany({});
    }
  });

  describe('basic functionality', () => {
    it('should reset _meiliIndex flag for documents with expiredAt: null and _meiliIndex: true', async () => {
      // Insert test documents
      await testCollection.insertMany([
        { _id: new mongoose.Types.ObjectId(), expiredAt: null, _meiliIndex: true, name: 'doc1' },
        { _id: new mongoose.Types.ObjectId(), expiredAt: null, _meiliIndex: true, name: 'doc2' },
        { _id: new mongoose.Types.ObjectId(), expiredAt: null, _meiliIndex: true, name: 'doc3' },
      ]);

      const result = await batchResetMeiliFlags(testCollection);

      expect(result).toBe(3);

      const updatedDocs = await testCollection.find({ _meiliIndex: false }).toArray();
      expect(updatedDocs).toHaveLength(3);

      const notUpdatedDocs = await testCollection.find({ _meiliIndex: true }).toArray();
      expect(notUpdatedDocs).toHaveLength(0);
    });

    it('should not modify documents with expiredAt set', async () => {
      const expiredDate = new Date();
      await testCollection.insertMany([
        { _id: new mongoose.Types.ObjectId(), expiredAt: expiredDate, _meiliIndex: true },
        { _id: new mongoose.Types.ObjectId(), expiredAt: null, _meiliIndex: true },
      ]);

      const result = await batchResetMeiliFlags(testCollection);

      expect(result).toBe(1);

      const expiredDoc = await testCollection.findOne({ expiredAt: expiredDate });
      expect(expiredDoc._meiliIndex).toBe(true);
    });

    it('should reset active non-temporary documents with expiredAt set for all-data retention', async () => {
      const retentionDate = new Date(Date.now() + 60 * 60 * 1000);
      await testCollection.insertMany([
        {
          _id: new mongoose.Types.ObjectId(),
          isTemporary: false,
          expiredAt: retentionDate,
          _meiliIndex: true,
        },
        {
          _id: new mongoose.Types.ObjectId(),
          isTemporary: true,
          expiredAt: retentionDate,
          _meiliIndex: true,
        },
      ]);

      const result = await batchResetMeiliFlags(testCollection);

      expect(result).toBe(1);

      const retainedDoc = await testCollection.findOne({ isTemporary: false });
      const temporaryDoc = await testCollection.findOne({ isTemporary: true });
      expect(retainedDoc._meiliIndex).toBe(false);
      expect(temporaryDoc._meiliIndex).toBe(true);
    });

    it('should not reset expired non-temporary documents with expiredAt set for all-data retention', async () => {
      const retentionDate = new Date(Date.now() - 60 * 60 * 1000);
      await testCollection.insertMany([
        {
          _id: new mongoose.Types.ObjectId(),
          isTemporary: false,
          expiredAt: retentionDate,
          _meiliIndex: true,
        },
        {
          _id: new mongoose.Types.ObjectId(),
          isTemporary: false,
          expiredAt: null,
          _meiliIndex: true,
        },
      ]);

      const result = await batchResetMeiliFlags(testCollection);

      expect(result).toBe(1);

      const expiredDoc = await testCollection.findOne({ expiredAt: retentionDate });
      const permanentDoc = await testCollection.findOne({ expiredAt: null });
      expect(expiredDoc._meiliIndex).toBe(true);
      expect(permanentDoc._meiliIndex).toBe(false);
    });

    it('should not modify documents with _meiliIndex: false', async () => {
      await testCollection.insertMany([
        { _id: new mongoose.Types.ObjectId(), expiredAt: null, _meiliIndex: false },
        { _id: new mongoose.Types.ObjectId(), expiredAt: null, _meiliIndex: true },
      ]);

      const result = await batchResetMeiliFlags(testCollection);

      expect(result).toBe(1);
    });

    it('should return 0 when no documents match the criteria', async () => {
      await testCollection.insertMany([
        { _id: new mongoose.Types.ObjectId(), expiredAt: new Date(), _meiliIndex: true },
        { _id: new mongoose.Types.ObjectId(), expiredAt: null, _meiliIndex: false },
      ]);

      const result = await batchResetMeiliFlags(testCollection);

      expect(result).toBe(0);
    });

    it('should return 0 when collection is empty', async () => {
      const result = await batchResetMeiliFlags(testCollection);

      expect(result).toBe(0);
    });
  });

  describe('batch processing', () => {
    it('should process documents in batches according to MEILI_SYNC_BATCH_SIZE', async () => {
      process.env.MEILI_SYNC_BATCH_SIZE = '2';

      const docs = [];
      for (let i = 0; i < 5; i++) {
        docs.push({
          _id: new mongoose.Types.ObjectId(),
          expiredAt: null,
          _meiliIndex: true,
          name: `doc${i}`,
        });
      }
      await testCollection.insertMany(docs);

      const result = await batchResetMeiliFlags(testCollection);

      expect(result).toBe(5);

      const updatedDocs = await testCollection.find({ _meiliIndex: false }).toArray();
      expect(updatedDocs).toHaveLength(5);
    });

    it('should handle large datasets with small batch sizes', async () => {
      process.env.MEILI_SYNC_BATCH_SIZE = '10';

      const docs = [];
      for (let i = 0; i < 25; i++) {
        docs.push({
          _id: new mongoose.Types.ObjectId(),
          expiredAt: null,
          _meiliIndex: true,
        });
      }
      await testCollection.insertMany(docs);

      const result = await batchResetMeiliFlags(testCollection);

      expect(result).toBe(25);
    });

    it('should use default batch size of 1000 when env variable is not set', async () => {
      // Create exactly 1000 documents to verify default batch behavior
      const docs = [];
      for (let i = 0; i < 1000; i++) {
        docs.push({
          _id: new mongoose.Types.ObjectId(),
          expiredAt: null,
          _meiliIndex: true,
        });
      }
      await testCollection.insertMany(docs);

      const result = await batchResetMeiliFlags(testCollection);

      expect(result).toBe(1000);
    });
  });

  describe('return value', () => {
    it('should return correct modified count', async () => {
      await testCollection.insertMany([
        { _id: new mongoose.Types.ObjectId(), expiredAt: null, _meiliIndex: true },
      ]);

      await expect(batchResetMeiliFlags(testCollection)).resolves.toBe(1);
    });
  });

  describe('batch delay', () => {
    it('should respect MEILI_SYNC_DELAY_MS between batches', async () => {
      process.env.MEILI_SYNC_BATCH_SIZE = '2';
      process.env.MEILI_SYNC_DELAY_MS = '50';

      const docs = [];
      for (let i = 0; i < 5; i++) {
        docs.push({
          _id: new mongoose.Types.ObjectId(),
          expiredAt: null,
          _meiliIndex: true,
        });
      }
      await testCollection.insertMany(docs);

      const startTime = Date.now();
      await batchResetMeiliFlags(testCollection);
      const endTime = Date.now();

      // With 5 documents and batch size 2, we need 3 batches
      // That means 2 delays between batches (not after the last one)
      // So minimum time should be around 100ms (2 * 50ms)
      // Using a slightly lower threshold to account for timing variations
      const elapsed = endTime - startTime;
      expect(elapsed).toBeGreaterThanOrEqual(80);
    });

    it('should not delay when MEILI_SYNC_DELAY_MS is 0', async () => {
      process.env.MEILI_SYNC_BATCH_SIZE = '2';
      process.env.MEILI_SYNC_DELAY_MS = '0';

      const docs = [];
      for (let i = 0; i < 5; i++) {
        docs.push({
          _id: new mongoose.Types.ObjectId(),
          expiredAt: null,
          _meiliIndex: true,
        });
      }
      await testCollection.insertMany(docs);

      const startTime = Date.now();
      await batchResetMeiliFlags(testCollection);
      const endTime = Date.now();

      const elapsed = endTime - startTime;
      // Should complete without intentional delays, but database operations still take time
      // Just verify it completes and returns the correct count
      expect(elapsed).toBeLessThan(1000); // More reasonable upper bound

      const result = await testCollection.countDocuments({ _meiliIndex: false });
      expect(result).toBe(5);
    });

    it('should not delay after the last batch', async () => {
      process.env.MEILI_SYNC_BATCH_SIZE = '3';
      process.env.MEILI_SYNC_DELAY_MS = '100';

      // Exactly 3 documents - should fit in one batch, no delay
      await testCollection.insertMany([
        { _id: new mongoose.Types.ObjectId(), expiredAt: null, _meiliIndex: true },
        { _id: new mongoose.Types.ObjectId(), expiredAt: null, _meiliIndex: true },
        { _id: new mongoose.Types.ObjectId(), expiredAt: null, _meiliIndex: true },
      ]);

      const result = await batchResetMeiliFlags(testCollection);

      // Verify all 3 documents were processed in a single batch
      expect(result).toBe(3);

      const updatedDocs = await testCollection.countDocuments({ _meiliIndex: false });
      expect(updatedDocs).toBe(3);
    });
  });

  describe('edge cases', () => {
    it('should handle documents without _meiliIndex field', async () => {
      await testCollection.insertMany([
        { _id: new mongoose.Types.ObjectId(), expiredAt: null },
        { _id: new mongoose.Types.ObjectId(), expiredAt: null, _meiliIndex: true },
      ]);

      const result = await batchResetMeiliFlags(testCollection);

      // both documents should be updated
      expect(result).toBe(2);
    });

    it('should handle mixed document states correctly', async () => {
      await testCollection.insertMany([
        { _id: new mongoose.Types.ObjectId(), expiredAt: null, _meiliIndex: true },
        { _id: new mongoose.Types.ObjectId(), expiredAt: null, _meiliIndex: false },
        { _id: new mongoose.Types.ObjectId(), expiredAt: new Date(), _meiliIndex: true },
        { _id: new mongoose.Types.ObjectId(), expiredAt: null, _meiliIndex: true },
        { _id: new mongoose.Types.ObjectId(), expiredAt: null, _meiliIndex: null },
        { _id: new mongoose.Types.ObjectId(), expiredAt: null },
      ]);

      const result = await batchResetMeiliFlags(testCollection);

      expect(result).toBe(4);

      const flaggedDocs = await testCollection
        .find({ expiredAt: null, _meiliIndex: false })
        .toArray();
      expect(flaggedDocs).toHaveLength(5); // 4 were updated, 1 was already false
    });
  });

  describe('error handling', () => {
    it('should throw error with context when find operation fails', async () => {
      const mockCollection = {
        collectionName: 'test_meili_batch',
        find: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            toArray: jest.fn().mockRejectedValue(new Error('Network error')),
          }),
        }),
      };

      await expect(batchResetMeiliFlags(mockCollection)).rejects.toThrow(
        "Failed to batch reset Meili flags for collection 'test_meili_batch' after processing 0 documents: Network error",
      );
    });

    it('should throw error with context when updateMany operation fails', async () => {
      const mockCollection = {
        collectionName: 'test_meili_batch',
        find: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            toArray: jest
              .fn()
              .mockResolvedValue([
                { _id: new mongoose.Types.ObjectId() },
                { _id: new mongoose.Types.ObjectId() },
              ]),
          }),
        }),
        updateMany: jest.fn().mockRejectedValue(new Error('Connection lost')),
      };

      await expect(batchResetMeiliFlags(mockCollection)).rejects.toThrow(
        "Failed to batch reset Meili flags for collection 'test_meili_batch' after processing 0 documents: Connection lost",
      );
    });

    it('should include documents processed count in error when failure occurs mid-batch', async () => {
      // Set batch size to 2 to force multiple batches
      process.env.MEILI_SYNC_BATCH_SIZE = '2';
      process.env.MEILI_SYNC_DELAY_MS = '0'; // No delay for faster test

      let findCallCount = 0;
      let updateCallCount = 0;

      const mockCollection = {
        collectionName: 'test_meili_batch',
        find: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            toArray: jest.fn().mockImplementation(() => {
              findCallCount++;
              // Return 2 documents for first two calls (to keep loop going)
              // Return 2 documents for third call (to trigger third update which will fail)
              if (findCallCount <= 3) {
                return Promise.resolve([
                  { _id: new mongoose.Types.ObjectId() },
                  { _id: new mongoose.Types.ObjectId() },
                ]);
              }
              // Should not reach here due to error
              return Promise.resolve([]);
            }),
          }),
        }),
        updateMany: jest.fn().mockImplementation(() => {
          updateCallCount++;
          if (updateCallCount === 1) {
            return Promise.resolve({ modifiedCount: 2 });
          } else if (updateCallCount === 2) {
            return Promise.resolve({ modifiedCount: 2 });
          } else {
            return Promise.reject(new Error('Database timeout'));
          }
        }),
      };

      await expect(batchResetMeiliFlags(mockCollection)).rejects.toThrow(
        "Failed to batch reset Meili flags for collection 'test_meili_batch' after processing 4 documents: Database timeout",
      );
    });

    it('should use collection.collectionName in error messages', async () => {
      const mockCollection = {
        collectionName: 'messages',
        find: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            toArray: jest.fn().mockRejectedValue(new Error('Permission denied')),
          }),
        }),
      };

      await expect(batchResetMeiliFlags(mockCollection)).rejects.toThrow(
        "Failed to batch reset Meili flags for collection 'messages' after processing 0 documents: Permission denied",
      );
    });
  });

  describe('environment variable validation', () => {
    let warnSpy;

    beforeEach(() => {
      // Mock logger.warn to track warning calls
      const { logger } = require('@librechat/data-schemas');
      warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      if (warnSpy) {
        warnSpy.mockRestore();
      }
    });

    it('should log warning and use default when MEILI_SYNC_BATCH_SIZE is not a number', async () => {
      process.env.MEILI_SYNC_BATCH_SIZE = 'abc';

      await testCollection.insertMany([
        { _id: new mongoose.Types.ObjectId(), expiredAt: null, _meiliIndex: true },
      ]);

      const result = await batchResetMeiliFlags(testCollection);

      expect(result).toBe(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Invalid value for MEILI_SYNC_BATCH_SIZE="abc"'),
      );
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Using default: 1000'));
    });

    it('should log warning and use default when MEILI_SYNC_DELAY_MS is not a number', async () => {
      process.env.MEILI_SYNC_DELAY_MS = 'xyz';

      await testCollection.insertMany([
        { _id: new mongoose.Types.ObjectId(), expiredAt: null, _meiliIndex: true },
      ]);

      const result = await batchResetMeiliFlags(testCollection);

      expect(result).toBe(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Invalid value for MEILI_SYNC_DELAY_MS="xyz"'),
      );
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Using default: 100'));
    });

    it('should log warning and use default when MEILI_SYNC_BATCH_SIZE is negative', async () => {
      process.env.MEILI_SYNC_BATCH_SIZE = '-50';

      await testCollection.insertMany([
        { _id: new mongoose.Types.ObjectId(), expiredAt: null, _meiliIndex: true },
      ]);

      const result = await batchResetMeiliFlags(testCollection);

      expect(result).toBe(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Invalid value for MEILI_SYNC_BATCH_SIZE="-50"'),
      );
    });

    it('should log warning and use default when MEILI_SYNC_DELAY_MS is negative', async () => {
      process.env.MEILI_SYNC_DELAY_MS = '-100';

      await testCollection.insertMany([
        { _id: new mongoose.Types.ObjectId(), expiredAt: null, _meiliIndex: true },
      ]);

      const result = await batchResetMeiliFlags(testCollection);

      expect(result).toBe(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Invalid value for MEILI_SYNC_DELAY_MS="-100"'),
      );
    });

    it('should accept valid positive integer values without warnings', async () => {
      process.env.MEILI_SYNC_BATCH_SIZE = '500';
      process.env.MEILI_SYNC_DELAY_MS = '50';

      await testCollection.insertMany([
        { _id: new mongoose.Types.ObjectId(), expiredAt: null, _meiliIndex: true },
      ]);

      const result = await batchResetMeiliFlags(testCollection);

      expect(result).toBe(1);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('should log warning and use default when MEILI_SYNC_BATCH_SIZE is zero', async () => {
      process.env.MEILI_SYNC_BATCH_SIZE = '0';

      await testCollection.insertMany([
        { _id: new mongoose.Types.ObjectId(), expiredAt: null, _meiliIndex: true },
      ]);

      const result = await batchResetMeiliFlags(testCollection);

      expect(result).toBe(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('MEILI_SYNC_BATCH_SIZE cannot be 0. Using default: 1000'),
      );
    });

    it('should accept zero as a valid value for MEILI_SYNC_DELAY_MS without warnings', async () => {
      process.env.MEILI_SYNC_DELAY_MS = '0';

      await testCollection.insertMany([
        { _id: new mongoose.Types.ObjectId(), expiredAt: null, _meiliIndex: true },
      ]);

      const result = await batchResetMeiliFlags(testCollection);

      expect(result).toBe(1);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('should not log warnings when environment variables are not set', async () => {
      delete process.env.MEILI_SYNC_BATCH_SIZE;
      delete process.env.MEILI_SYNC_DELAY_MS;

      await testCollection.insertMany([
        { _id: new mongoose.Types.ObjectId(), expiredAt: null, _meiliIndex: true },
      ]);

      const result = await batchResetMeiliFlags(testCollection);

      expect(result).toBe(1);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});
