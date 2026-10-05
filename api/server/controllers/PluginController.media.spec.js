const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveMediaConfig } = require('librechat-data-provider');

jest.mock('~/models', () => ({ getRoleByName: jest.fn() }));
jest.mock('~/server/services/Config', () => ({
  getCachedTools: jest.fn(),
  getAppConfig: jest.fn(),
  setCachedTools: jest.fn(),
}));
jest.mock('~/app/clients/tools', () => jest.requireActual('~/app/clients/tools/manifest'));

const { getRoleByName } = require('~/models');
const { getCachedTools, getAppConfig } = require('~/server/services/Config');
const { loadAndFormatTools } = require('~/server/services/start/tools');
const { getAvailableTools } = require('./PluginController');

describe('media toolkit startup cache and agent listing', () => {
  let directory;

  beforeEach(() => {
    jest.clearAllMocks();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'librechat-media-tool-list-'));
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it.each([
    { name: 'enabled agent toolkit', visible: true },
    {
      name: 'included toolkit also includes status',
      adminIncluded: ['media_generate'],
      visible: true,
    },
    {
      name: 'filtered toolkit also excludes status',
      adminFilter: ['media_generate'],
      visible: false,
    },
    {
      name: 'included toolkit overrides filter',
      adminIncluded: ['media_generate'],
      adminFilter: ['media_generate'],
      visible: true,
    },
    { name: 'disabled runtime', enabled: false, visible: false },
    { name: 'disabled tools surface', tools: false, visible: false },
    { name: 'missing use grant', use: false, visible: false },
    { name: 'missing creation grant', create: false, visible: false },
    { name: 'unsupported assistants runtime', baseUrl: '/api/assistants', visible: false },
  ])('$name', async ({ visible, ...options }) => {
    const definitions = loadAndFormatTools({
      directory,
      adminIncluded: options.adminIncluded,
      adminFilter: options.adminFilter,
    });
    const registered = !options.adminFilter || options.adminIncluded?.length > 0;
    for (const name of ['media_generate', 'media_status']) {
      if (registered) {
        expect(definitions[name]).toMatchObject({
          type: 'function',
          function: { name, parameters: { type: 'object' } },
        });
      } else {
        expect(definitions[name]).toBeUndefined();
      }
    }
    getCachedTools.mockResolvedValue(definitions);
    getRoleByName.mockResolvedValue({
      permissions: { MEDIA: { USE: options.use ?? true, CREATE: options.create ?? true } },
    });
    const req = {
      baseUrl: options.baseUrl ?? '/api/agents',
      user: { id: 'owner', role: 'USER' },
      config: {
        media: resolveMediaConfig({
          enabled: options.enabled ?? true,
          surfaces: { tools: options.tools ?? true },
          integrations: [
            {
              id: 'images',
              api: 'openai.images',
              endpointRef: { kind: 'direct', apiKey: 'test-key' },
              catalog: { kind: 'configured', models: ['gpt-image-1'] },
              operations: ['image.generate'],
            },
          ],
        }),
      },
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await getAvailableTools(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].some((plugin) => plugin.pluginKey === 'media_generate')).toBe(
      visible,
    );
    expect(getAppConfig).not.toHaveBeenCalled();
  });
});
