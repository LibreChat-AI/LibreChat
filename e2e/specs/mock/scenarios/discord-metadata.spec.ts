import { expect, test } from '@playwright/test';
import type { DiscordApplication, DiscordGuild } from 'librechat-data-provider';
import { inOrg, ok, snowflake, within } from '../discord-installations.helpers';
import { CHANNELS_ENABLED } from '../channels.helpers';
import { inOneProject } from './lint.helpers';

/**
 * What a caller can read back from Discord installation storage: metadata without credentials on
 * every path, one explicit credential read, and pages that walk the set exactly once.
 * Enabled with E2E_CHANNELS=true against a MongoDB that supports transactions.
 */

const internal = ['encryptedBotToken', 'encryptedClientSecret', '_id', '__v'];

/** Whatever a caller can read must neither name a credential field nor hold a credential. */
const clean = (secrets: string[], ...items: object[]) => {
  expect(items.some((item) => Object.keys(item).some((key) => internal.includes(key)))).toBe(false);
  expect(secrets.some((credential) => JSON.stringify(items).includes(credential))).toBe(false);
};

const walk = async <T extends { next?: string }>(
  list: (cursor?: string, limit?: number) => Promise<T>,
  limit: number,
) => {
  const pages: T[] = [];
  let cursor: string | undefined;
  do {
    pages.push(await list(cursor, limit));
    cursor = pages[pages.length - 1].next;
  } while (cursor);
  return pages;
};

test.describe('Discord installation metadata', () => {
  test.skip(!CHANNELS_ENABLED, 'Run with E2E_CHANNELS=true and a transaction-capable MongoDB');
  test.setTimeout(120_000);

  test('application reads and pages carry no credentials while the private read stays explicit @scenario:discord-application-metadata-pagination-and-secret-redaction', async ({
    baseURL,
  }) => {
    inOneProject();
    await within(baseURL, [], async (world) => {
      const { store } = world;
      const [org, apps] = [world.org(), Array.from({ length: 5 }, () => world.app())];
      const actorId = await world.member(org);
      const secrets = apps.flatMap((app) => [app.encryptedBotToken, app.encryptedClientSecret]);
      const sizes = (total: number, limit: number) =>
        Array.from({ length: Math.ceil(total / limit) }, (_, i) =>
          Math.min(limit, total - i * limit),
        );

      await inOrg(org, async () => {
        const saved: DiscordApplication[] = [];
        for (const app of apps)
          saved.push(ok(await store.configureApplication({ actorId, ...app })));
        clean(secrets, ...saved);
        expect(await store.readApplication(apps[1].applicationId)).toEqual(saved[1]);

        /** The credential read is the one explicit door: exactly what was stored, same metadata. */
        const [target] = apps;
        const credentials = await store.readApplicationCredentials(target.applicationId);
        if (!credentials) throw new Error('The credential read returned no application');
        const { encryptedBotToken, encryptedClientSecret, ...metadata } = credentials;
        const matches = [
          encryptedBotToken === target.encryptedBotToken,
          encryptedClientSecret === target.encryptedClientSecret,
        ];
        expect(matches).toEqual([true, true]);
        expect(metadata).toEqual(await store.readApplication(target.applicationId));
        expect([
          await store.readApplication('1'),
          await store.readApplicationCredentials('1'),
        ]).toEqual([null, null]);

        /** Cursors walk the set once, in key order; an exhausted set has no cursor. */
        const ids = apps.map((app) => app.applicationId).sort();
        for (const limit of [2, 4, 5, 100]) {
          const pages = await walk((cursor, size) => store.listApplications(cursor, size), limit);
          const listed = pages.flatMap((page) => page.applications);
          expect(listed.map((item) => item.applicationId)).toEqual(ids);
          expect(pages.map((page) => page.applications.length)).toEqual(sizes(5, limit));
          clean(secrets, ...listed);
        }
        expect(await store.listApplications(ids[4])).toEqual({ applications: [] });

        for (const limit of [0, -1, 101, 1.5, Number.NaN]) {
          const invalid = 'Invalid Discord metadata page size';
          await expect(store.listApplications(undefined, limit)).rejects.toThrow(invalid);
        }
      });
    });
  });

  test('installation reads and pages carry no credentials and walk the set once @scenario:discord-installation-metadata-pagination-and-secret-redaction', async ({
    baseURL,
  }) => {
    inOneProject();
    await within(baseURL, [], async (world) => {
      const { store } = world;
      const [org, app] = [world.org(), world.app()];
      const actorId = await world.member(org);
      const secrets = [app.encryptedBotToken, app.encryptedClientSecret];

      await inOrg(org, async () => {
        const saved = ok(await store.configureApplication({ actorId, ...app }));
        const guilds: DiscordGuild[] = [];
        for (const guildId of [snowflake(), snowflake(), snowflake()]) {
          const installed = await store.connectGuild({
            actorId,
            applicationId: app.applicationId,
            applicationRevision: saved.revision,
            guildId,
            guildName: 'E2E guild',
          });
          guilds.push(ok(installed));
        }
        clean(secrets, ...guilds);

        /** Cursors walk the set once, in key order; the page that exhausts it has no cursor. */
        const installations = guilds.map((item) => item.installationId).sort();
        const pages = await walk((cursor, size) => store.listGuilds(cursor, size), 2);
        const listed = pages.flatMap((page) => page.guilds);
        expect(listed.map((item) => item.installationId)).toEqual(installations);
        expect(pages.map((page) => page.guilds.length)).toEqual([2, 1]);
        clean(secrets, ...listed);

        for (const limit of [0, -1, 101, 1.5, Number.NaN]) {
          const invalid = 'Invalid Discord metadata page size';
          await expect(store.listGuilds(undefined, limit)).rejects.toThrow(invalid);
        }
      });
    });
  });
});
