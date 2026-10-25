/**
 * The admin config write path with the real YAML loader, AppService, config service and cache
 * invalidation: a base-only section edited in librechat.yaml reaches the running server on the
 * next admin config write. Only the database methods and the structured-tool scan are stubbed;
 * neither contributes to the base config under test.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const { Constants } = require('librechat-data-provider');

jest.mock('~/server/services/start/tools', () => ({
  loadAndFormatTools: jest.fn(() => ({})),
}));

jest.mock('~/models', () => ({
  initializeMessageBudget: jest.fn(),
  getApplicableConfigs: jest.fn().mockResolvedValue([]),
  getUserPrincipals: jest.fn().mockResolvedValue([]),
}));

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'librechat-config-reload-'));
const configPath = path.join(configDir, 'librechat.yaml');
const previousConfigPath = process.env.CONFIG_PATH;
process.env.CONFIG_PATH = configPath;

const filters = {
  prompts: { pii: { action: 'block', fields: ['name'] } },
};

/** @param {Record<string, unknown>} config */
function writeYaml(config) {
  fs.writeFileSync(configPath, yaml.dump({ version: Constants.CONFIG_VERSION, ...config }));
}

writeYaml({});

const { getAppConfig, reloadConfigCaches, invalidateConfigCaches } = require('../app');

afterAll(() => {
  if (previousConfigPath === undefined) {
    delete process.env.CONFIG_PATH;
  } else {
    process.env.CONFIG_PATH = previousConfigPath;
  }
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe('admin config writes and librechat.yaml', () => {
  it('serve base-only sections edited in librechat.yaml after the next write', async () => {
    const before = await getAppConfig({ baseOnly: true });
    const effectiveBefore = await getAppConfig({ role: 'USER' });
    expect(before.filters).toBeUndefined();
    expect(effectiveBefore.filters).toBeUndefined();

    writeYaml({ filters });
    expect((await getAppConfig({ baseOnly: true })).filters).toBeUndefined();

    await invalidateConfigCaches();

    const after = await getAppConfig({ baseOnly: true });
    const effectiveAfter = await getAppConfig({ role: 'USER' });
    expect(after.filters?.prompts?.pii).toEqual(expect.objectContaining(filters.prompts.pii));
    expect(effectiveAfter.filters).toEqual(after.filters);
  });

  it('serve a section removed from librechat.yaml as gone after the next write', async () => {
    writeYaml({ filters });
    await invalidateConfigCaches();
    expect((await getAppConfig({ baseOnly: true })).filters).toBeDefined();

    writeYaml({});
    await invalidateConfigCaches();

    expect((await getAppConfig({ baseOnly: true })).filters).toBeUndefined();
    expect((await getAppConfig({ role: 'USER' })).filters).toBeUndefined();
  });

  it('reload the file for the reload route, reporting a local clear and no broadcast without Redis', async () => {
    writeYaml({});
    await invalidateConfigCaches();
    expect((await getAppConfig({ baseOnly: true })).filters).toBeUndefined();

    writeYaml({ filters });
    const report = await reloadConfigCaches();

    expect(report).toEqual({ cleared: true, loaded: { ok: true }, broadcast: 'none' });
    expect((await getAppConfig({ baseOnly: true })).filters?.prompts?.pii).toEqual(
      expect.objectContaining(filters.prompts.pii),
    );
  });

  it('report a librechat.yaml the loader refuses on the reload route, keeping the last good config', async () => {
    writeYaml({ filters });
    await expect(reloadConfigCaches()).resolves.toMatchObject({ loaded: { ok: true } });
    const lastGood = await getAppConfig({ baseOnly: true });
    expect(lastGood.filters).toBeDefined();

    writeYaml({ bogusTopLevelKey: true, interface: { customWelcome: 42 } });
    const report = await reloadConfigCaches();

    expect(report).toEqual({
      cleared: true,
      loaded: {
        ok: false,
        error: {
          code: 'CONFIG_INVALID',
          issues: expect.arrayContaining([
            { path: 'bogusTopLevelKey', segments: ['bogusTopLevelKey'], code: 'unrecognized_keys' },
            {
              path: 'interface.customWelcome',
              segments: ['interface', 'customWelcome'],
              code: 'invalid_type',
            },
          ]),
        },
      },
      broadcast: 'skipped',
    });
    expect(JSON.stringify(report)).not.toContain('42');
    expect((await getAppConfig({ baseOnly: true })).filters).toEqual(lastGood.filters);
  });
});
