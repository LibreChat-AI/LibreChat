import mongoose from 'mongoose';
import { expect } from '@playwright/test';
import { randomBytes, randomUUID } from 'crypto';
import {
  createModels,
  tenantStorage,
  createChannelRunStorage,
  createChannelIdentityStorage,
} from '@librechat/data-schemas';
import type {
  ChannelRunPrincipal,
  ProviderAgentChannel,
  ChannelExternalIdentity,
  DiscordChannelExternalIdentity,
} from 'librechat-data-provider';
import type {
  ChannelRunStorage,
  ChannelIdentityRecord,
  ChannelIdentityStorage,
} from '@librechat/data-schemas';
import type { Db, Document } from 'mongodb';
import type { Channel } from './channels.helpers';
import { getMongoUri, withMongo } from './db';

/**
 * Plumbing for the provider contract scenarios, beside channels.helpers.ts. A route cannot give
 * them two things: the real storage methods behind the HTTP guards (the final transaction fences),
 * and the rows a restored database would hold. Every raw write here replaces a field the app would
 * have written itself, and the scenario that makes it puts the original back.
 */

export interface Guild {
  applicationId: string;
  guildId: string;
  botUserId: string;
}

const rows = (db: Db, collection: string) => db.collection(collection);
const whole = { projection: { _id: 0 } };

/** The channel storage the routes call, on a private connection to the harness database. */
async function withStorage<T>(
  work: (storage: { identities: ChannelIdentityStorage; runs: ChannelRunStorage }) => Promise<T>,
): Promise<T> {
  const connection = new mongoose.Mongoose();
  await connection.connect(getMongoUri(), { autoIndex: false });
  try {
    createModels(connection);
    return await tenantStorage.run({ tenantId: undefined }, async () =>
      work({
        identities: createChannelIdentityStorage(connection),
        runs: createChannelRunStorage(connection),
      }),
    );
  } finally {
    await connection.disconnect();
  }
}

export const readStored = (identity: ChannelExternalIdentity) =>
  withStorage(({ identities }) => identities.readChannelIdentity(identity));

export const saveLink = (record: ChannelIdentityRecord, expectedRevision: string | null) =>
  withStorage(({ identities }) => identities.saveChannelIdentity(record, expectedRevision));

/** Saves a pending record under fresh link and ticket ids, so only its identity can refuse it. */
export async function savePending(identity: ChannelExternalIdentity) {
  const [linkId, expiry] = [`link-${randomUUID()}`, Date.now() + 600_000];
  const saved = await saveLink(
    {
      identity,
      linkId,
      tenantId: '_',
      state: 'pending',
      revision: `rev-${randomUUID()}`,
      ticketHash: randomBytes(32).toString('hex'),
      ticketExpiresAtMs: expiry,
      expiresAtMs: expiry,
    },
    null,
  );
  return { saved, linkId };
}

/**
 * The linked admission fence, past principal resolution: a fresh Slack event under a principal a
 * run captured earlier. A refusal is the storage's own `invalid_transition`, not a route's 403.
 */
export function admitStored(channel: Channel, actor: string, principal: ChannelRunPrincipal) {
  const key = `C0E2ECHAN1:${Math.floor(Date.now() / 1000)}.${randomBytes(3).readUIntBE(0, 3)}`;
  const { teamId, appId } = channel.slack;
  const admission = {
    eventId: `Ev${randomUUID()}`,
    externalChannelId: 'C0E2ECHAN1',
    externalThreadKey: key,
    externalMessageKey: key,
    actor: { teamId, appId, externalUserId: actor },
    input: 'hello from the storage fence',
  };
  const { channelId, agentId } = channel;
  const enrollment = { tenantId: '_', channelId, agentId, principal, admission };
  return withStorage(({ runs }) => runs.admit(enrollment, Date.now()));
}

/** A link's complete private row, ticket hash included, exactly as stored. */
export const linkRow = (linkId: string): Promise<Document | null> =>
  withMongo((db) => rows(db, 'channelidentities').findOne({ linkId }, whole));

export const runRow = (runId: string): Promise<Document | null> =>
  withMongo((db) => rows(db, 'channelruns').findOne({ runId }, whole));

/** Replaces only the identity of a stored link: ticket, revision, expiry and owner stay as issued. */
export async function replaceIdentity(linkId: string, identity: Document): Promise<void> {
  const updated = await withMongo((db) =>
    rows(db, 'channelidentities').updateOne({ linkId }, { $set: { identity } }),
  );
  expect(updated.matchedCount).toBe(1);
}

/** Restores a channel row as a Discord guild record (metadata only), or back as the Slack row. */
export async function restoreParent(channel: Channel, guild: Guild | null): Promise<void> {
  const update = guild
    ? { $set: { type: 'discord', discord: guild } }
    : { $set: { type: 'slack' }, $unset: { discord: '' } };
  const updated = await withMongo((db) =>
    rows(db, 'agentchannels').updateOne({ channelId: channel.channelId }, update),
  );
  expect(updated.matchedCount).toBe(1);
}

export function recordOf(row: Document | null): ChannelIdentityRecord {
  if (!row) throw new Error('The link row is missing');
  const { tenantId, linkId, revision, state, ticketHash, identity } = row;
  const { ticketExpiresAtMs, expiresAtMs, userId, accountLabel } = row;
  return {
    tenantId,
    linkId,
    revision,
    state,
    ticketHash,
    ticketExpiresAtMs,
    expiresAtMs,
    userId,
    accountLabel,
    identity,
  };
}

export async function principalOf(runId: string): Promise<ChannelRunPrincipal> {
  const run = await runRow(runId);
  if (!run) throw new Error(`Run ${runId} is missing`);
  return run.principal;
}

/** The stored channel row as the canonical provider record that actor matching reads. */
export async function canonicalChannel(channelId: string): Promise<ProviderAgentChannel> {
  const row = await withMongo((db) =>
    rows(db, 'agentchannels').findOne<ProviderAgentChannel>({ channelId }, whole),
  );
  if (!row) throw new Error(`Channel ${channelId} is missing`);
  return row;
}

/** The six fields a Slack consent identity has always had. */
export const slackIdentity = (channel: Channel, actor: string) => ({
  tenantId: '_',
  channelId: channel.channelId,
  channelRevision: channel.revision,
  teamId: channel.slack.teamId,
  externalUserId: actor,
  agentId: channel.agentId,
});

/** Unsigned 64-bit decimal string between 2^63 and 2^64, past what a JavaScript number holds. */
const snowflake = (): string =>
  (BigInt(`0x${randomBytes(8).toString('hex')}`) | (1n << 63n)).toString();

export const newGuild = (): Guild => ({
  applicationId: snowflake(),
  guildId: snowflake(),
  botUserId: snowflake(),
});

export function discordIdentity(channel: Channel, guild: Guild): DiscordChannelExternalIdentity {
  const { applicationId, guildId } = guild;
  const { channelId, agentId } = channel;
  const [tenantId, channelRevision] = ['_', channel.revision];
  const provider = 'discord';
  return {
    ...{ provider, tenantId, channelId, channelRevision, agentId },
    ...{ applicationId, guildId, externalUserId: snowflake() },
  };
}

export const NONE = { channels: 0, links: 0, runs: 0, lanes: 0, agents: 0 };

/** What a scenario's fixtures left in the database once its channels and accounts are closed. */
export function leftovers(channels: Channel[]): Promise<typeof NONE> {
  const [ids, agents] = [channels.map((c) => c.channelId), channels.map((c) => c.agentId)];
  return withMongo(async (db) => ({
    channels: await rows(db, 'agentchannels').countDocuments({ channelId: { $in: ids } }),
    links: await rows(db, 'channelidentities').countDocuments({
      'identity.channelId': { $in: ids },
    }),
    runs: await rows(db, 'channelruns').countDocuments({ channelId: { $in: ids } }),
    lanes: await rows(db, 'channellanes').countDocuments({ channelId: { $in: ids } }),
    agents: await rows(db, 'agents').countDocuments({ id: { $in: agents } }),
  }));
}
