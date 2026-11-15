import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { DiscordAgentChannel } from 'librechat-data-provider';
import {
  GUILDS,
  inOrg,
  keeps,
  ok,
  rowOf,
  secret,
  snowflake,
  within,
} from '../discord-installations.helpers';
import { CHANNELS_ENABLED } from '../channels.helpers';
import { inOneProject } from './lint.helpers';

test('Discord authority preserves binding and fences linked admission @scenario:discord-channel-authority-preserves-binding-and-fences-linked-admission', async ({
  baseURL,
}) => {
  test.skip(!CHANNELS_ENABLED, 'Run with E2E_CHANNELS=true and a transaction-capable MongoDB');
  test.setTimeout(120_000);
  inOneProject();
  await within(baseURL, [], async (world) => {
    const tenantId = world.org();
    const [owner, user] = await Promise.all([world.member(tenantId), world.member(tenantId)]);
    const app = world.app();
    await inOrg(tenantId, async () => {
      const { store, methods, identities, runs, routes } = world;
      type Enrollment = Parameters<typeof runs.admit>[0];
      const configured = ok(await store.configureApplication({ actorId: owner, ...app }));
      const guildId = snowflake();
      const installed = ok(
        await store.connectGuild({
          actorId: owner,
          applicationId: app.applicationId,
          applicationRevision: configured.revision,
          guildId,
          guildName: 'Authority guild',
        }),
      );
      const externalChannelId = snowflake();
      const candidate: DiscordAgentChannel = {
        type: 'discord',
        tenantId,
        channelId: world.channel(tenantId),
        agentId: randomUUID(),
        createdBy: owner,
        revision: randomUUID(),
        status: 'pending_install',
        credentialMode: 'per_user',
        installationId: installed.installationId,
        installationRevision: installed.revision,
        discord: {
          applicationId: app.applicationId,
          guildId,
          botUserId: app.botUserId,
          externalChannelId,
        },
      };
      const created = await methods.createAgentChannel({
        ...candidate,
        applicationRevision: configured.revision,
      });
      const assigned = await routes.assign({
        actorId: owner,
        installationId: installed.installationId,
        installationRevision: installed.revision,
        applicationRevision: configured.revision,
        externalChannelId,
        channelId: candidate.channelId,
        channelRevision: candidate.revision,
      });
      if (!assigned.ok) throw new Error(assigned.error.code);
      const metadata = await methods.getAgentChannelMetadata(candidate.channelId);
      if (!metadata || metadata.type !== 'discord')
        throw new Error('Missing activated Discord channel');
      const channel: DiscordAgentChannel = {
        ...candidate,
        status: 'active',
        revision: metadata.revision,
      };
      expect(channel.revision).not.toBe(candidate.revision);
      const listed = await methods.listAgentChannels(channel.agentId);
      for (const view of [created, metadata, ...listed]) {
        if (!view) throw new Error('The public channel read returned no channel');
        expect(
          ['applicationRevision', 'encryptedBotToken', 'encryptedClientSecret'].some((key) =>
            Object.hasOwn(view, key),
          ),
        ).toBe(false);
        expect(
          [app.encryptedBotToken, app.encryptedClientSecret].some((credential) =>
            JSON.stringify(view).includes(credential),
          ),
        ).toBe(false);
        expect(view).toMatchObject({ ...(view === created ? candidate : channel) });
      }
      const privateView = await methods.getActiveAgentChannel(channel.channelId);
      expect(privateView?.applicationRevision).toBe(configured.revision);
      expect(privateView?.encryptedBotToken === app.encryptedBotToken).toBe(true);
      const identity = {
        provider: 'discord' as const,
        tenantId,
        channelId: channel.channelId,
        channelRevision: channel.revision,
        agentId: channel.agentId,
        applicationId: app.applicationId,
        guildId,
        externalUserId: snowflake(),
      };
      const link: Parameters<typeof identities.saveChannelIdentity>[0] = {
        tenantId,
        identity,
        linkId: randomUUID(),
        revision: randomUUID(),
        state: 'active',
        userId: user,
        ticketHash: 'a'.repeat(64),
        ticketExpiresAtMs: Date.now() + 60_000,
        expiresAtMs: Date.now() + 60_000,
      };
      expect(await identities.saveChannelIdentity(link, null, configured.revision)).toBe(true);
      expect(await identities.readChannelIdentity(identity)).toMatchObject({ ...link });
      const event = (applicationRevision = configured.revision): Enrollment => {
        const eventId = snowflake();
        return {
          tenantId,
          channelId: channel.channelId,
          agentId: channel.agentId,
          applicationRevision,
          principal: {
            userId: user,
            channelRevision: channel.revision,
            linkId: link.linkId,
            linkRevision: link.revision,
          },
          admission: {
            actor: {
              provider: 'discord',
              applicationId: app.applicationId,
              guildId,
              externalUserId: identity.externalUserId,
            },
            eventId,
            externalChannelId,
            externalThreadKey: `${externalChannelId}:${eventId}`,
            externalMessageKey: `${externalChannelId}:${eventId}`,
            input: 'Authority check',
          },
        };
      };
      const admit = (input: Enrollment) => runs.admit(input, Date.now());
      const refused = async (input: Enrollment) => {
        await expect(admit(input)).rejects.toMatchObject({ code: 'invalid_transition' });
      };
      const first = event();
      const admitted = await admit(first);
      expect(admitted.duplicate).toBe(false);
      expect((await admit(first)).duplicate).toBe(true);
      expect(admitted.run).not.toHaveProperty('applicationRevision');
      const wrongUser = event();
      await refused({
        ...wrongUser,
        principal: { ...wrongUser.principal, userId: owner },
      });
      await refused({ ...event(), applicationRevision: undefined });
      const slack = event();
      await refused({
        ...slack,
        admission: {
          ...slack.admission,
          actor: {
            teamId: guildId,
            appId: app.applicationId,
            externalUserId: identity.externalUserId,
          },
        },
      });
      const wrong = event();
      const otherDestination = snowflake();
      await refused({
        ...wrong,
        admission: {
          ...wrong.admission,
          externalChannelId: otherDestination,
          externalThreadKey: `${otherDestination}:${wrong.admission.eventId}`,
          externalMessageKey: `${otherDestination}:${wrong.admission.eventId}`,
        },
      });
      const channelRow = rowOf('agentchannels', { tenantId, channelId: channel.channelId });
      const linkRow = rowOf('channelidentities', { tenantId, linkId: link.linkId });
      for (const update of [
        { type: 'slack' as const },
        { installationId: randomUUID() },
        { installationRevision: randomUUID() },
        { discord: { ...channel.discord, guildId: snowflake() } },
        { credentialMode: 'shared' as const },
      ]) {
        await keeps([channelRow, linkRow], async () => {
          expect(await methods.updateAgentChannel(channel.channelId, owner, update)).toBeNull();
        });
      }
      const rotatedToken = secret('rotated-bot');
      let rotatedRevision = '';
      await keeps(
        [linkRow, rowOf(GUILDS, { installationId: installed.installationId })],
        async () => {
          const rotated = ok(
            await store.configureApplication({
              actorId: owner,
              ...app,
              encryptedBotToken: rotatedToken,
              expectedRevision: configured.revision,
            }),
          );
          rotatedRevision = rotated.revision;
          await refused(event());
          expect(
            await identities.saveChannelIdentity(
              { ...link, revision: randomUUID() },
              link.revision,
            ),
          ).toBe(false);
          expect(
            await identities.saveChannelIdentity(
              { ...link, revision: randomUUID() },
              link.revision,
              configured.revision,
            ),
          ).toBe(false);
        },
      );
      const current = await methods.getActiveAgentChannel(channel.channelId);
      expect(current?.applicationRevision).toBe(rotatedRevision);
      expect(current?.encryptedBotToken === rotatedToken).toBe(true);
      const secondLink = {
        ...link,
        identity: { ...identity, externalUserId: snowflake() },
        linkId: randomUUID(),
        revision: randomUUID(),
        ticketHash: 'c'.repeat(64),
      };
      const pending = { ...secondLink, state: 'pending' as const, userId: undefined };
      const accepted = { ...secondLink, state: 'accepted' as const, revision: randomUUID() };
      expect(await identities.saveChannelIdentity(secondLink, null)).toBe(false);
      expect(await identities.saveChannelIdentity(pending, null)).toBe(false);
      expect(await identities.saveChannelIdentity(accepted, null)).toBe(false);
      expect(await identities.saveChannelIdentity(pending, null, rotatedRevision)).toBe(true);
      expect(await identities.saveChannelIdentity(accepted, pending.revision)).toBe(true);
      expect(
        await identities.saveChannelIdentity(
          { ...accepted, revision: randomUUID() },
          accepted.revision,
        ),
      ).toBe(false);
      expect(await identities.readChannelIdentity(identity)).toMatchObject({ ...link });
      expect((await admit(event(rotatedRevision))).duplicate).toBe(false);
      const startedAt = new Date();
      expect(await methods.beginAgentTriggerUserDeletion(owner, startedAt)).toBe('acquired');
      try {
        expect(await methods.getActiveAgentChannel(channel.channelId)).toBeNull();
        await refused(event(rotatedRevision));
      } finally {
        expect(await methods.cancelAgentTriggerUserDeletion(owner, startedAt)).toBe(true);
      }
      expect((await admit(event(rotatedRevision))).duplicate).toBe(false);
      const disconnected = ok(
        await store.disconnectGuild({
          actorId: owner,
          installationId: installed.installationId,
          expectedRevision: installed.revision,
        }),
      );
      const unavailable = async () => {
        expect(await methods.getAgentChannelMetadata(channel.channelId)).toMatchObject({
          channelId: channel.channelId,
          revision: channel.revision,
          status: 'disabled',
        });
        expect(await methods.getActiveAgentChannel(channel.channelId)).toBeNull();
        await refused(event(rotatedRevision));
      };
      await unavailable();
      ok(
        await store.connectGuild({
          actorId: owner,
          applicationId: app.applicationId,
          applicationRevision: rotatedRevision,
          guildId,
          guildName: 'Authority guild',
          installationId: installed.installationId,
          expectedRevision: disconnected.revision,
        }),
      );
      await unavailable();
      await keeps([channelRow, linkRow], async () => {
        expect(
          await methods.updateAgentChannel(channel.channelId, owner, { status: 'active' }),
        ).toBeNull();
      });
      expect(await methods.beginAgentChannelDeletion(channel.channelId, owner)).toMatchObject({
        status: 'deleting',
      });
      expect(await identities.readChannelIdentity(identity)).toBeNull();
    });
  });
});
