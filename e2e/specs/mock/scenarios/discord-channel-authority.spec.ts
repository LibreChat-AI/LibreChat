import { expect, test } from '@playwright/test';
import { randomBytes, randomUUID } from 'crypto';
import { discordConfirmationControl, parseDiscordControl } from 'librechat-data-provider';
import type { DiscordAgentChannel, DiscordGatewayOwner } from 'librechat-data-provider';
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
    const nativeOwnerId = randomBytes(16).toString('hex');
    let nativeOwner: DiscordGatewayOwner | undefined;
    await inOrg(tenantId, async () => {
      const { store, methods, identities, runs, routes, inbox, gateway } = world;
      type Enrollment = Parameters<typeof runs.admit>[0];
      const configured = ok(await store.configureApplication({ actorId: owner, ...app }));
      nativeOwner = {
        applicationId: app.applicationId,
        applicationRevision: configured.revision,
        ownerId: nativeOwnerId,
      };
      expect(await gateway.acquire(nativeOwner, 120_000)).toBe(true);
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
        linkId: randomBytes(32).toString('base64url'),
        revision: randomUUID(),
        state: 'active',
        userId: user,
        ticketHash: 'a'.repeat(64),
        ticketExpiresAtMs: Date.now() + 60_000,
        expiresAtMs: Date.now() + 60_000,
      };
      const acceptedRevision = randomBytes(32).toString('base64url');
      expect(
        await identities.saveChannelIdentity(
          { ...link, state: 'accepted', revision: acceptedRevision },
          null,
          configured.revision,
        ),
      ).toBe(true);
      const action = parseDiscordControl(discordConfirmationControl(link.linkId, acceptedRevision));
      if (!action || action.kind !== 'confirm') throw new Error('Invalid confirmation action');
      const confirmationId = snowflake();
      const worker = randomUUID();
      const submitted = await inbox.submit(
        {
          eventId: confirmationId,
          applicationId: app.applicationId,
          applicationRevision: configured.revision,
          guildId,
          externalChannelId,
          externalUserId: identity.externalUserId,
          channelId: channel.channelId,
          channelRevision: channel.revision,
          agentId: channel.agentId,
          action,
          encryptedToken: secret('confirmation'),
          tokenHash: 'b'.repeat(64),
          expiresAt: Date.now() + 60_000,
        },
        Date.now(),
      );
      expect(submitted).toEqual({
        ok: true,
        value: { eventId: confirmationId, state: 'queued', duplicate: false },
      });
      const claimed = await inbox.claim(app.applicationId, worker, Date.now());
      if (!claimed) throw new Error('Missing confirmation inbox claim');
      expect(claimed.eventId).toBe(confirmationId);
      expect(
        await identities.saveChannelIdentity(link, acceptedRevision, configured.revision, {
          fence: {
            applicationId: app.applicationId,
            eventId: claimed.eventId,
            owner: worker,
            epoch: claimed.leaseEpoch,
          },
          now: Date.now(),
        }),
      ).toBe(true);
      const confirmed = await identities.readChannelIdentity(identity);
      expect(confirmed).toMatchObject({ ...link });
      if (!confirmed || typeof confirmed.discordActivatedAtMs !== 'number')
        throw new Error('Missing server-written Discord activation time');
      expect(Number.isSafeInteger(confirmed.discordActivatedAtMs)).toBe(true);
      expect(confirmed.discordActivatedAtMs).toBeGreaterThan(0);
      let eventAtMs = confirmed.discordActivatedAtMs;
      const clock = () => {
        eventAtMs = Math.max(Date.now(), eventAtMs + 1);
        return eventAtMs;
      };
      const event = (
        applicationRevision = configured.revision,
        authorityChannelId = externalChannelId,
      ): Enrollment => {
        const eventId = String(BigInt(clock() - 1420070400000) << BigInt(22));
        return {
          tenantId,
          channelId: channel.channelId,
          agentId: channel.agentId,
          applicationRevision,
          discordAuthority: {
            kind: 'guild_text',
            owner: {
              applicationId: app.applicationId,
              applicationRevision,
              ownerId: nativeOwnerId,
            },
            source: {
              kind: 'guild_text',
              applicationId: app.applicationId,
              guildId,
              channelId: authorityChannelId,
              botUserId: app.botUserId,
              authorId: identity.externalUserId,
              authorMember: true,
              permissions: '68608',
              authorPermissions: '1024',
            },
          },
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
      const admit = (input: Enrollment) => runs.admit(input, clock());
      const refused = async (input: Enrollment) => {
        await expect(admit(input)).rejects.toMatchObject({ code: 'invalid_transition' });
      };
      const unowned = event();
      expect(await gateway.release(nativeOwner)).toBe(true);
      await refused(unowned);
      expect(await gateway.acquire(nativeOwner, 120_000)).toBe(true);
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
      const otherDestination = snowflake();
      const wrong = event(configured.revision, otherDestination);
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
      expect(await gateway.release(nativeOwner)).toBe(true);
      nativeOwner = { ...nativeOwner, applicationRevision: rotatedRevision };
      expect(await gateway.acquire(nativeOwner, 120_000)).toBe(true);
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
    }).finally(async () => {
      const owner = nativeOwner;
      if (owner) await inOrg(tenantId, () => world.gateway.release(owner));
    });
  });
});
