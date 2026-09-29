import mongoose from 'mongoose';
import { createConversationModel } from '~/models/convo';
import { createMessageModel } from '~/models/message';
import mongoMeili from '~/models/plugins/mongoMeili';

const mockGetRawInfo = jest.fn().mockResolvedValue({ uid: 'index' });
const mockUpdateSettings = jest.fn().mockResolvedValue({ taskUid: 1 });
const mockCreateIndex = jest.fn().mockResolvedValue({ taskUid: 1 });
const mockWaitForTask = jest.fn().mockResolvedValue({ status: 'succeeded' });
const mockIndex = jest.fn().mockReturnValue({
  getRawInfo: mockGetRawInfo,
  updateSettings: mockUpdateSettings,
});

jest.mock('meilisearch', () => ({
  MeiliSearch: jest.fn().mockImplementation(() => ({
    index: mockIndex,
    createIndex: mockCreateIndex,
    waitForTask: mockWaitForTask,
  })),
  MeiliSearchTimeOutError: class MeiliSearchTimeOutError extends Error {},
}));

/** Every outbound MeiliSearch call the index-provisioning block can make. */
const meiliRequestMocks = [mockGetRawInfo, mockCreateIndex, mockWaitForTask, mockUpdateSettings];

/** Let the fire-and-forget provisioning block run past its awaits before asserting. */
const flushDetachedWork = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * The contract of `isEnabled` in `packages/api/src/utils/common.ts`, restated here because
 * `packages/data-schemas` does not depend on `@librechat/api`. `areStartupTasksDisabledLocal` in
 * `mongoMeili.ts` must agree with it for every value `process.env.DISABLE_STARTUP_TASKS` can hold;
 * `isEnabled`'s boolean branch is unreachable from an environment variable, which yields only
 * `string | undefined`.
 */
const isEnabledReference = (value?: string): boolean =>
  typeof value === 'string' ? value.toLowerCase().trim() === 'true' : false;

/** Attach the plugin to a throwaway schema, which is what runs the provisioning block. */
let attachCount = 0;
const attachPluginToThrowawaySchema = (): void => {
  attachCount += 1;
  const schema = new mongoose.Schema({ docId: { type: String, meiliIndex: true } });
  schema.plugin(mongoMeili, {
    mongoose,
    host: 'http://meili.test',
    apiKey: 'master-key',
    indexName: `throwaway_${attachCount}`,
    primaryKey: 'docId',
  });
};

describe('mongoMeili index provisioning under the startup task gate', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = {
      ...OLD_ENV,
      /** Enabling values throughout: the gate must hold regardless of what these resolve to. */
      SEARCH: 'true',
      MEILI_HOST: 'http://meili.test',
      MEILI_MASTER_KEY: 'master-key',
    };
    delete process.env.DISABLE_STARTUP_TASKS;
    meiliRequestMocks.forEach((mock) => mock.mockClear());
    mockIndex.mockClear();
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  describe('with DISABLE_STARTUP_TASKS set', () => {
    beforeEach(() => {
      process.env.DISABLE_STARTUP_TASKS = 'true';
    });

    it('issues no MeiliSearch request when the conversations model registers', async () => {
      createConversationModel(mongoose);
      await flushDetachedWork();

      meiliRequestMocks.forEach((mock) => expect(mock).not.toHaveBeenCalled());
    });

    it('issues no MeiliSearch request when the messages model registers', async () => {
      createMessageModel(mongoose);
      await flushDetachedWork();

      meiliRequestMocks.forEach((mock) => expect(mock).not.toHaveBeenCalled());
    });

    it('still builds the client and the index handle the document hooks need', async () => {
      createConversationModel(mongoose);
      await flushDetachedWork();

      expect(mockIndex).toHaveBeenCalledWith('convos');
      meiliRequestMocks.forEach((mock) => expect(mock).not.toHaveBeenCalled());
    });
  });

  describe('with DISABLE_STARTUP_TASKS unset', () => {
    it('provisions the index for the conversations model exactly as before', async () => {
      createConversationModel(mongoose);
      await flushDetachedWork();

      expect(mockIndex).toHaveBeenCalledWith('convos');
      expect(mockGetRawInfo).toHaveBeenCalledTimes(1);
      expect(mockUpdateSettings).toHaveBeenCalledWith({ filterableAttributes: ['user'] });
    });

    it('provisions the index for the messages model exactly as before', async () => {
      createMessageModel(mongoose);
      await flushDetachedWork();

      expect(mockIndex).toHaveBeenCalledWith('messages');
      expect(mockGetRawInfo).toHaveBeenCalledTimes(1);
      expect(mockUpdateSettings).toHaveBeenCalledWith({ filterableAttributes: ['user'] });
    });

    it('creates a missing index, waiting on the creation task', async () => {
      mockGetRawInfo.mockRejectedValueOnce({ code: 'index_not_found' });

      createConversationModel(mongoose);
      await flushDetachedWork();

      expect(mockCreateIndex).toHaveBeenCalledWith('convos', { primaryKey: 'conversationId' });
      expect(mockWaitForTask).toHaveBeenCalled();
    });
  });

  describe('agreement with isEnabled', () => {
    const flagValues = ['true', 'TRUE', ' true ', 'false', '1', ''];

    it.each(flagValues)('gates on %p exactly as isEnabled reads it', async (value) => {
      process.env.DISABLE_STARTUP_TASKS = value;

      attachPluginToThrowawaySchema();
      await flushDetachedWork();

      const suppressed = !mockGetRawInfo.mock.calls.length;
      expect(suppressed).toBe(isEnabledReference(value));
    });

    it('gates on an absent variable exactly as isEnabled reads it', async () => {
      delete process.env.DISABLE_STARTUP_TASKS;

      attachPluginToThrowawaySchema();
      await flushDetachedWork();

      const suppressed = !mockGetRawInfo.mock.calls.length;
      expect(suppressed).toBe(isEnabledReference(undefined));
    });

    it('reads the environment per attach rather than freezing it at module load', async () => {
      process.env.DISABLE_STARTUP_TASKS = 'true';
      attachPluginToThrowawaySchema();
      await flushDetachedWork();
      expect(mockGetRawInfo).not.toHaveBeenCalled();

      delete process.env.DISABLE_STARTUP_TASKS;
      attachPluginToThrowawaySchema();
      await flushDetachedWork();
      expect(mockGetRawInfo).toHaveBeenCalledTimes(1);
    });
  });
});
