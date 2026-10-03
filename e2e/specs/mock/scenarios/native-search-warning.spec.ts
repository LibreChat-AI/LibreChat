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
}: {
  webSearch?: boolean;
  list?: unknown[];
  storedUse?: boolean;
}): Promise<string[]> {
  const config = { interface: webSearch === undefined ? {} : { webSearch } };
  const appConfig = {
    config,
    interfaceConfig: { webSearch },
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
});
