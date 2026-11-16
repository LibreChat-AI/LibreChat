import { randomBytes } from 'crypto';
import { expect, test } from '@playwright/test';
import type { DiscordGuild } from 'librechat-data-provider';
import type { Document } from 'mongodb';
import {
  APPS,
  GUILDS,
  facts,
  keeps,
  ok,
  refuses,
  rowOf,
  scopeOf,
  secret,
  snowflake,
  within,
} from '../discord-installations.helpers';
import { CHANNELS_ENABLED } from '../channels.helpers';
import { inOneProject } from './lint.helpers';

/**
 * Rotation and reconnect fences of Discord installation persistence. Every transition names the
 * exact application and guild revision it acts on, and admission only passes on the current pair.
 * Enabled with E2E_CHANNELS=true against a MongoDB that supports transactions.
 */

test.describe('Discord installation fences', () => {
  test.skip(!CHANNELS_ENABLED, 'Run with E2E_CHANNELS=true and a transaction-capable MongoDB');
  test.setTimeout(120_000);

  test('rotation, disconnect and reconnect honour exact application and guild revisions @scenario:discord-installation-rotation-and-reconnect-fences', async ({
    baseURL,
  }) => {
    inOneProject();
    await within(
      baseURL,
      ['discord-owner', 'discord-installer'],
      async (world, [owner, installer]) => {
        const { store } = world;
        const app = world.app();
        const { applicationId } = app;
        const [first, second] = [
          { guildId: snowflake(), guildName: 'First' },
          { guildId: snowflake(), guildName: 'Second' },
        ];
        const appRow = rowOf(APPS, { applicationId });
        const guildRow = (guild: DiscordGuild) =>
          rowOf(GUILDS, { installationId: guild.installationId });
        const rotate = (expectedRevision: string, extra: Document = {}) =>
          store.configureApplication({ actorId: owner.userId, ...app, expectedRevision, ...extra });
        const install = (applicationRevision: string, guild = first, extra: Document = {}) =>
          store.connectGuild({
            actorId: installer.userId,
            applicationId,
            applicationRevision,
            ...guild,
            ...extra,
          });
        const leave = (guild: DiscordGuild, expectedRevision = guild.revision) =>
          store.disconnectGuild({
            actorId: installer.userId,
            installationId: guild.installationId,
            expectedRevision,
          });
        const admits = (revision: string, guild: DiscordGuild) =>
          world.touch(scopeOf(applicationId, revision, guild));
        const counters = async (guild: DiscordGuild) => [
          (await appRow())?.authorityWrites,
          (await guildRow(guild)())?.authorityWrites,
        ];

        /** Exact revisions admit, and one admission advances each fence exactly once. */
        const base = ok(await store.configureApplication({ actorId: owner.userId, ...app }));
        const one = ok(await install(base.revision));
        const [appWrites, guildWrites] = await counters(one);
        expect(await admits(base.revision, one)).toBe(true);
        expect(await counters(one)).toEqual([appWrites + 1, guildWrites + 1]);

        /** Rotation moves the application revision, keeps guild consent and retires the old one. */
        const consent = facts(await guildRow(one)());
        const key = randomBytes(32).toString('hex');
        const rotated = ok(
          await rotate(base.revision, { encryptedBotToken: secret('bot'), publicKey: key }),
        );
        expect(rotated.revision).not.toBe(base.revision);
        expect(facts(await guildRow(one)())).toEqual(consent);
        expect(await admits(base.revision, one)).toBe(false);
        expect(await admits(rotated.revision, one)).toBe(true);
        const nothing = rowOf(GUILDS, { applicationId, guildId: second.guildId });
        await refuses('application_changed', () => install(base.revision, second), [nothing]);
        const other = ok(await install(rotated.revision, second));
        expect(other.installationId).not.toBe(one.installationId);

        /** Each guild moves only on its own revision, and its sibling never notices. */
        await keeps([guildRow(other)], async () => {
          await refuses('installation_changed', () => leave(one, 'stale-revision'), [
            guildRow(one),
          ]);
          const left = ok(await leave(one));
          expect(left).toMatchObject({
            status: 'disconnected',
            installationId: one.installationId,
          });
          expect(left.revision).not.toBe(one.revision);
          for (const guild of [one, left])
            expect(await admits(rotated.revision, guild)).toBe(false);
          await refuses('installation_changed', () => leave(left), [guildRow(one)]);
          const targets = [
            { installationId: one.installationId, expectedRevision: one.revision },
            { installationId: other.installationId, expectedRevision: left.revision },
          ];
          for (const target of targets) {
            await refuses('installation_changed', () => install(rotated.revision, first, target), [
              guildRow(one),
            ]);
          }
          const renamed = { ...first, guildName: 'Renamed' };
          const exact = { installationId: one.installationId, expectedRevision: left.revision };
          const back = ok(await install(rotated.revision, renamed, exact));
          expect(back).toMatchObject({
            status: 'active',
            guildName: 'Renamed',
            createdBy: installer.userId,
            installationId: one.installationId,
          });
          expect(back.revision).not.toBe(left.revision);
          expect(await admits(rotated.revision, left)).toBe(false);
          expect(await admits(rotated.revision, back)).toBe(true);

          /** A scope claiming another organization is a caller bug: it throws and writes nothing. */
          const foreign = {
            ...scopeOf(applicationId, rotated.revision, back),
            tenantId: 'other-org',
          };
          await keeps([appRow, guildRow(back)], async () => {
            await expect(world.touch(foreign)).rejects.toThrow(TypeError);
          });
        });
      },
    );
  });
});
