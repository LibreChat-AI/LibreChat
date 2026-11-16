import { expect, test } from '@playwright/test';
import type { Document } from 'mongodb';
import type { Account } from '../channels.helpers';
import {
  APPS,
  GUILDS,
  fenceCount,
  inOrg,
  ok,
  refuses,
  rowOf,
  scopeOf,
  snowflake,
  within,
} from '../discord-installations.helpers';
import { CHANNELS_ENABLED, bearer, send } from '../channels.helpers';
import { inOneProject } from './lint.helpers';

/**
 * Who may own, change and admit through a Discord application: real accounts, another
 * organization, and an owner who is deleting or erased through the real route.
 * Enabled with E2E_CHANNELS=true against a MongoDB that supports transactions.
 */

test.describe('Discord installation ownership', () => {
  test.skip(!CHANNELS_ENABLED, 'Run with E2E_CHANNELS=true and a transaction-capable MongoDB');
  test.setTimeout(120_000);

  test('ownership and organization boundaries refuse without changing stored rows @scenario:discord-application-owner-and-tenant-boundaries', async ({
    baseURL,
  }) => {
    inOneProject();
    await within(baseURL, ['discord-owner', 'discord-admin'], async (world, [owner, admin]) => {
      const { store, methods } = world;
      const app = world.app();
      const stored = rowOf(APPS, { applicationId: app.applicationId });
      const configure = (actor: Account, extra: Document = {}) =>
        store.configureApplication({ actorId: actor.userId, ...app, ...extra });

      /** Controls: a real account creates the application, another updates it, ownership stays. */
      const created = ok(await configure(owner, { name: 'E2E bot' }));
      expect(created).toMatchObject({
        createdBy: owner.userId,
        name: 'E2E bot',
        authorityWrites: 0,
      });
      expect(await fenceCount(owner.userId)).toBe(1);
      const updated = ok(
        await configure(admin, { expectedRevision: created.revision, name: 'New' }),
      );
      expect(updated).toMatchObject({ createdBy: owner.userId, name: 'New', authorityWrites: 1 });
      expect(updated.revision).not.toBe(created.revision);
      const stale = { expectedRevision: created.revision };
      const retargeted = { expectedRevision: updated.revision, botUserId: snowflake() };
      for (const attempt of [stale, {}, retargeted]) {
        await refuses('application_changed', () => configure(admin, attempt), [stored]);
      }

      /** Another organization cannot see, claim or be acted on by this application's accounts. */
      const [org, stranger] = [world.org(), world.app()];
      const member = await world.member(org);
      await inOrg(org, async () => {
        expect(await store.readApplication(app.applicationId)).toBeNull();
        expect(await store.readApplicationCredentials(app.applicationId)).toBeNull();
        expect(await store.listApplications()).toEqual({ applications: [] });
        const claim = () => store.configureApplication({ actorId: member, ...app });
        await refuses('application_in_use', claim, [stored]);
        const outside = () => store.configureApplication({ actorId: owner.userId, ...stranger });
        const absent = rowOf(APPS, { applicationId: stranger.applicationId });
        await refuses('principal_unavailable', outside, [absent]);
      });

      /** An owner who is deleting blocks changes by anyone else; cancelling restores them. */
      const fence = new Date();
      expect(await methods.beginAgentTriggerUserDeletion(owner.userId, fence)).toBe('acquired');
      const reconfigure = () => configure(admin, { expectedRevision: updated.revision });
      await refuses('principal_unavailable', reconfigure, [stored]);
      expect(await methods.cancelAgentTriggerUserDeletion(owner.userId, fence)).toBe(true);
      const renewed = ok(await reconfigure());
      expect(renewed.revision).not.toBe(updated.revision);

      /** The real erasure route removes the owner account and the application rows it owned. */
      const erased = await send(owner.api, 'DELETE', '/api/user/delete', {
        headers: bearer(owner.token),
      });
      expect(erased.status, erased.text).toBe(200);
      expect(await stored()).toBeNull();
      const afterErasure = () => configure(admin, { expectedRevision: renewed.revision });
      await refuses('application_changed', afterErasure, [stored]);
    });
  });

  test('an owner who is deleting or erased fences installs and admission @scenario:discord-installation-owner-erasure-and-admission-fences', async ({
    baseURL,
  }) => {
    inOneProject();
    await within(baseURL, ['discord-owner', 'discord-admin'], async (world, [owner, admin]) => {
      const { store, methods } = world;
      const [app, guild] = [world.app(), { guildId: snowflake(), guildName: 'Sandbox' }];
      const { applicationId } = app;
      const stored = rowOf(APPS, { applicationId });
      const created = ok(await store.configureApplication({ actorId: owner.userId, ...app }));
      const install = (actor: Account, extra: Document = {}) =>
        store.connectGuild({
          actorId: actor.userId,
          applicationId,
          applicationRevision: created.revision,
          ...guild,
          ...extra,
        });

      /** An owner who is deleting blocks installs and admission but not a disconnect. */
      const installed = ok(await install(owner));
      const fence = new Date();
      expect(await methods.beginAgentTriggerUserDeletion(owner.userId, fence)).toBe('acquired');
      const extra = { guildId: snowflake(), guildName: 'Second' };
      const second = rowOf(GUILDS, { applicationId, guildId: extra.guildId });
      await refuses('principal_unavailable', () => install(admin, extra), [stored, second]);
      expect(await world.touch(scopeOf(applicationId, created.revision, installed))).toBe(false);
      const left = ok(
        await store.disconnectGuild({
          actorId: admin.userId,
          installationId: installed.installationId,
          expectedRevision: installed.revision,
        }),
      );
      expect(left.status).toBe('disconnected');

      /** Cancelling the deletion restores reconnect and admission. */
      expect(await methods.cancelAgentTriggerUserDeletion(owner.userId, fence)).toBe(true);
      const back = ok(
        await install(admin, {
          installationId: left.installationId,
          expectedRevision: left.revision,
        }),
      );
      expect(await world.touch(scopeOf(applicationId, created.revision, back))).toBe(true);

      /** The real erasure route removes the owner's rows, so the admitted scope stops admitting. */
      const erased = await send(owner.api, 'DELETE', '/api/user/delete', {
        headers: bearer(owner.token),
      });
      expect(erased.status, erased.text).toBe(200);
      const guildRow = rowOf(GUILDS, { installationId: back.installationId });
      expect(await Promise.all([stored(), guildRow()])).toEqual([null, null]);
      expect(await world.touch(scopeOf(applicationId, created.revision, back))).toBe(false);
    });
  });
});
