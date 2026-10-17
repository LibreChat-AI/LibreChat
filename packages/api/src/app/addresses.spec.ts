jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import { logger } from '@librechat/data-schemas';
import type { TCustomConfig } from 'librechat-data-provider';
import { resolveConfigAllowedAddresses } from './addresses';
import { createCustomConfigLoader } from './loader';
import { isAddressAllowed } from '../auth';

const SEARXNG = 'searxng.search-ns.local';
const FIRECRAWL = 'firecrawl.search-ns.local';

const YAML = `
version: 1.3.0
endpoints:
  allowedAddresses:
    - "ollama.internal:11434"
webSearch:
  allowedAddresses:
    - "\${SEARXNG_ALLOWED_ADDRESS}"
    - "\${FIRECRAWL_HOST}:3002"
    - "proxy.internal:3128"
`;

function createLoader(yaml: string) {
  return createCustomConfigLoader({
    defaultConfigPath: '/config/librechat.yaml',
    loadLocal: () => yaml,
    redactConfig: (config) => config,
  });
}

describe('allowedAddresses environment references at config load', () => {
  const originalEnv = process.env;
  const originalExit = process.exit;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.CONFIG_PATH;
    delete process.env.CONFIG_BYPASS_VALIDATION;
    delete process.env.SEARXNG_ALLOWED_ADDRESS;
    delete process.env.FIRECRAWL_HOST;
    process.exit = jest.fn((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never;
    jest.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    process.exit = originalExit;
  });

  it('resolves webSearch entries so the internal hosts are exempted', async () => {
    process.env.SEARXNG_ALLOWED_ADDRESS = `${SEARXNG}:8080`;
    process.env.FIRECRAWL_HOST = FIRECRAWL;

    const config = await createLoader(YAML)(false);
    const allowed = config?.webSearch?.allowedAddresses;

    expect(allowed).toEqual([`${SEARXNG}:8080`, `${FIRECRAWL}:3002`, 'proxy.internal:3128']);
    expect(isAddressAllowed(SEARXNG, allowed, 8080)).toBe(true);
    expect(isAddressAllowed(FIRECRAWL, allowed, 3002)).toBe(true);
    expect(isAddressAllowed(SEARXNG, allowed, 3002)).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('starts without the variables, dropping only those entries with a warning', async () => {
    const config = await createLoader(YAML)(false);

    expect(process.exit).not.toHaveBeenCalled();
    expect(config?.webSearch?.allowedAddresses).toEqual(['proxy.internal:3128']);
    expect(config?.endpoints?.allowedAddresses).toEqual(['ollama.internal:11434']);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'Dropped webSearch.allowedAddresses entry ${SEARXNG_ALLOWED_ADDRESS}: the environment variable is unset',
      ),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Dropped webSearch.allowedAddresses entry ${FIRECRAWL_HOST}:3002'),
    );
  });

  it('drops a variable holding an invalid value without logging the value', async () => {
    process.env.SEARXNG_ALLOWED_ADDRESS = 'http://user:secret@searxng.internal:8080';
    process.env.FIRECRAWL_HOST = '8.8.8.8';

    const config = await createLoader(YAML)(false);

    expect(config?.webSearch?.allowedAddresses).toEqual(['proxy.internal:3128']);
    const warnings = (logger.warn as jest.Mock).mock.calls.map(([message]) => String(message));
    expect(warnings).toHaveLength(2);
    expect(warnings.every((message) => message.includes('does not resolve'))).toBe(true);
    expect(warnings.join('\n')).not.toContain('secret');
    expect(warnings.join('\n')).not.toContain('8.8.8.8');
  });

  it('rejects a partial reference instead of storing it as a literal hostname', async () => {
    process.env.SEARXNG_NAMESPACE = 'search-ns.local';
    const yaml = `
version: 1.3.0
webSearch:
  allowedAddresses:
    - "searxng.\${SEARXNG_NAMESPACE}:8080"
`;

    await expect(createLoader(yaml)(false)).rejects.toThrow('process.exit(1)');
  });

  it('leaves a config with only literal entries unchanged', async () => {
    const yaml = `
version: 1.3.0
actions:
  allowedAddresses:
    - "host.docker.internal:8080"
    - "[::1]:11434"
`;

    const config = await createLoader(yaml)(false);

    expect(config?.actions?.allowedAddresses).toEqual(['host.docker.internal:8080', '[::1]:11434']);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('resolveConfigAllowedAddresses', () => {
  it('resolves every allowedAddresses list and reports drops by path', () => {
    const config = {
      actions: { allowedAddresses: ['${ACTIONS_ADDRESS}'] },
      mcpSettings: { allowedAddresses: ['${MCP_HOST}:8000'] },
      speech: { tts: { allowedAddresses: ['${TTS_ADDRESS}'] } },
      webSearch: { allowedAddresses: ['${SEARXNG_ALLOWED_ADDRESS}'] },
    } as unknown as TCustomConfig;

    const dropped = resolveConfigAllowedAddresses(config, {
      ACTIONS_ADDRESS: 'actions.internal:443',
      MCP_HOST: 'mcp.internal',
    });

    expect(config.actions?.allowedAddresses).toEqual(['actions.internal:443']);
    expect(config.mcpSettings?.allowedAddresses).toEqual(['mcp.internal:8000']);
    expect(config.speech?.tts?.allowedAddresses).toEqual([]);
    expect(config.webSearch?.allowedAddresses).toEqual([]);
    expect(dropped.map(({ path, reason }) => [path, reason])).toEqual([
      ['speech.tts.allowedAddresses', 'unset'],
      ['webSearch.allowedAddresses', 'unset'],
    ]);
  });
});
