const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { createModels, runAsSystem } = require('@librechat/data-schemas');

/** `~/models` pulls in `getLogStores`, which builds Keyv/Mongo/Redis stores at module scope. */
jest.mock('~/cache/getLogStores', () =>
  jest.fn(() => ({
    get: jest.fn(),
    set: jest.fn(),
    delete: jest.fn(),
  })),
);

const { syncCategories } = require('~/server/utils/agentCategory');

const DEFAULT_VALUES = ['general', 'hr', 'rd', 'finance', 'it', 'sales', 'aftersales'];

let mongoServer;
let AgentCategory;
let models;

/** Mirrors the production call site in `loadCustomConfig`, which wraps the sync in a system context. */
const sync = (list, enableDefaultCategories) =>
  runAsSystem(() => syncCategories(list, enableDefaultCategories));

const seedDefaults = () => runAsSystem(() => models.ensureDefaultCategories());

async function categoriesByValue() {
  const rows = await AgentCategory.find({}).lean();
  return new Map(rows.map((row) => [row.value, row]));
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  AgentCategory = mongoose.models.AgentCategory;
  models = require('~/models');
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await AgentCategory.deleteMany({});
  await seedDefaults();
});

describe('syncCategories', () => {
  it('seeds the expected default categories before each case', async () => {
    const categories = await categoriesByValue();
    expect([...categories.keys()].sort()).toEqual([...DEFAULT_VALUES].sort());
    expect(categories.get('general').label).toBe('com_agents_category_general');
  });

  describe('custom category labels', () => {
    it('falls back to the value as typed when no label is given', async () => {
      await sync([{ value: '  Education  ' }], true);

      expect((await categoriesByValue()).get('education')).toMatchObject({
        label: 'Education',
        description: '',
        custom: true,
        isActive: true,
      });
    });

    it('stores a translation key verbatim so the client can localize it', async () => {
      await sync(
        [
          {
            value: 'education',
            label: 'com_agents_category_education',
            description: 'com_agents_category_education_description',
          },
        ],
        true,
      );

      expect((await categoriesByValue()).get('education')).toMatchObject({
        label: 'com_agents_category_education',
        description: 'com_agents_category_education_description',
        custom: true,
      });
    });

    it('falls back to the value when the label is an empty string', async () => {
      await sync([{ value: 'Education', label: '   ' }], true);

      expect((await categoriesByValue()).get('education').label).toBe('Education');
    });
  });

  describe('the general fallback category', () => {
    it('stays active when default categories are disabled', async () => {
      await sync(undefined, false);

      const categories = await categoriesByValue();
      expect(categories.get('general').isActive).toBe(true);
      for (const value of DEFAULT_VALUES.filter((v) => v !== 'general')) {
        expect(categories.get(value).isActive).toBe(false);
      }
    });

    it('is reactivated when a previous run left it disabled', async () => {
      await AgentCategory.updateOne({ value: 'general' }, { $set: { isActive: false } });

      await sync(undefined, false);

      expect((await categoriesByValue()).get('general').isActive).toBe(true);
    });

    it('keeps its localized label when re-declared without one', async () => {
      await sync([{ value: 'general' }], false);

      expect((await categoriesByValue()).get('general')).toMatchObject({
        label: 'com_agents_category_general',
        description: 'com_agents_category_general_description',
        custom: false,
        isActive: true,
      });
    });
  });

  describe('overriding default categories', () => {
    it('applies the label without converting the row to a custom category', async () => {
      const before = (await categoriesByValue()).get('aftersales');

      await sync([{ value: 'aftersales', label: 'Customer Success' }], true);

      const after = (await categoriesByValue()).get('aftersales');
      expect(after).toMatchObject({
        label: 'Customer Success',
        custom: false,
        isActive: true,
      });
      expect(after.order).toBe(before.order);
    });

    it('applies an explicitly empty description', async () => {
      await sync([{ value: 'aftersales', description: '' }], true);

      expect((await categoriesByValue()).get('aftersales').description).toBe('');
    });

    it('reactivates an explicitly declared default even when defaults are disabled', async () => {
      await sync([{ value: 'hr', label: 'People' }], false);

      const categories = await categoriesByValue();
      expect(categories.get('hr')).toMatchObject({
        label: 'People',
        isActive: true,
        custom: false,
      });
      expect(categories.get('rd').isActive).toBe(false);
    });

    it('survives being removed from the config, and is restored on the next boot', async () => {
      await sync([{ value: 'aftersales', label: 'Customer Success' }], true);
      await sync([], true);

      const afterRemoval = (await categoriesByValue()).get('aftersales');
      expect(afterRemoval).toMatchObject({ label: 'Customer Success', custom: false });

      await seedDefaults();

      expect((await categoriesByValue()).get('aftersales').label).toBe(
        'com_agents_category_aftersales',
      );
    });
  });

  describe('custom category lifecycle', () => {
    it('deletes custom categories that are no longer in the config', async () => {
      await sync([{ value: 'education' }], true);
      await sync([], true);

      expect((await categoriesByValue()).has('education')).toBe(false);
    });

    it('leaves custom categories untouched when no list is provided', async () => {
      await sync([{ value: 'education' }], true);
      await sync(undefined, true);

      expect((await categoriesByValue()).has('education')).toBe(true);
    });

    it('skips entries with a missing or empty value', async () => {
      await sync([{ value: '   ' }, { description: 'no value' }, { value: 'Education' }], true);

      const categories = await categoriesByValue();
      expect([...categories.keys()].sort()).toEqual([...DEFAULT_VALUES, 'education'].sort());
    });
  });
});
