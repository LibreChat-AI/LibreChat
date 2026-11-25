import { expect, test } from '@playwright/test';
import { logger } from '@librechat/data-schemas';
import { Permissions, PermissionTypes } from 'librechat-data-provider';
import type { IRole, AppConfig } from '@librechat/data-schemas';
import { updateInterfacePermissions } from '../../../../packages/api/src/app/permissions';

/**
 * Startup runs `updateInterfacePermissions` once against the stored USER and ADMIN roles.
 * It is called here in-process with stubbed role reads and writes, so no shared role
 * document of this run is changed while other specs are using it.
 */

const nativeSpec = { name: 'gpt-native', label: 'GPT', preset: { web_search: true } };
const plainSpec = { name: 'plain', label: 'Plain', preset: {} };

async function startupWarnings({
  webSearch,
  list = [nativeSpec],
  storedUse,
  endpoints,
}: {
  webSearch?: boolean;
  list?: unknown[];
  storedUse?: boolean;
  endpoints?: unknown;
}): Promise<string[]> {
  const config = { interface: webSearch === undefined ? {} : { webSearch } };
  const appConfig = {
    config,
    interfaceConfig: { webSearch },
    endpoints,
    modelSpecs: { list },
  } as unknown as AppConfig;
  const getRoleByName = async (name: string) =>
    storedUse === undefined
      ? null
      : ({
          name,
          permissions: { [PermissionTypes.WEB_SEARCH]: { [Permissions.USE]: storedUse } },
        } as unknown as IRole);

  const messages: string[] = [];
  const original = logger.warn;
  logger.warn = ((message: unknown) => {
    messages.push(String(message));
    return logger;
  }) as typeof logger.warn;
  try {
    await updateInterfacePermissions({
      appConfig,
      getRoleByName,
      updateAccessPermissions: async () => undefined,
    });
  } finally {
    logger.warn = original;
  }
  return messages.filter((message) => message.includes('provider-native web search'));
}

test.describe('native web search startup warning', () => {
  test('an operator who sets interface.webSearch false is told which native search specs it blocks @scenario:explicit-websearch-false-warns-native-search-specs', async () => {
    const warnings = await startupWarnings({ webSearch: false });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('`interface.webSearch: false` denies');
    expect(warnings[0]).toContain('gpt-native');
    expect(warnings[0]).toContain('endpoints.agents.capabilities');
    expect(warnings[0]).toContain('UPGRADING.md');
  });

  test('an operator who removed interface.webSearch is told the stored role still blocks native search @scenario:stored-websearch-denial-warns-when-key-unset', async () => {
    const warnings = await startupWarnings({ storedUse: false });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('stored role permission keeps denying');
    expect(warnings[0]).toContain('gpt-native');
  });

  test('startup stays silent when web search is allowed or no spec requests native search @scenario:allowed-websearch-or-no-native-specs-stays-silent', async () => {
    expect(await startupWarnings({ webSearch: true })).toHaveLength(0);
    expect(await startupWarnings({})).toHaveLength(0);
    expect(await startupWarnings({ webSearch: true, storedUse: false })).toHaveLength(0);
    expect(await startupWarnings({ webSearch: false, list: [plainSpec] })).toHaveLength(0);
  });

  test('an operator whose custom endpoint turns native search on is warned about the specs it serves @scenario:endpoint-enabled-native-search-warns', async () => {
    const spec = { name: 'router-spec', label: 'Router', preset: { endpoint: 'Router' } };
    const endpoint = { name: 'Router', apiKey: 'key', baseURL: 'https://router.test' };
    const viaAddParams = await startupWarnings({
      webSearch: false,
      list: [spec],
      endpoints: { custom: [{ ...endpoint, addParams: { web_search: true } }] },
    });
    const viaDefault = await startupWarnings({
      webSearch: false,
      list: [spec],
      endpoints: {
        custom: [
          {
            ...endpoint,
            customParams: { paramDefinitions: [{ key: 'web_search', default: true }] },
          },
        ],
      },
    });
    for (const warnings of [viaAddParams, viaDefault]) {
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('router-spec');
    }
  });

  test('a spec whose endpoint turns native search off draws no warning @scenario:endpoint-disabled-native-search-stays-silent', async () => {
    const spec = {
      name: 'router-spec',
      label: 'Router',
      preset: { endpoint: 'Router', web_search: true },
    };
    const endpoint = { name: 'Router', apiKey: 'key', baseURL: 'https://router.test' };
    for (const params of [{ addParams: { web_search: false } }, { dropParams: ['web_search'] }]) {
      const warnings = await startupWarnings({
        webSearch: false,
        list: [spec],
        endpoints: { custom: [{ ...endpoint, ...params }] },
      });
      expect(warnings).toHaveLength(0);
    }
  });
});
