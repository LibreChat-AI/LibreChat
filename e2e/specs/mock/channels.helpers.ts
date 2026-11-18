import { createCipheriv, randomBytes, randomUUID } from 'crypto';
import { expect, request as playwrightRequest } from '@playwright/test';
import type { Db, Document, Filter } from 'mongodb';
import type { APIRequestContext } from '@playwright/test';
import type { User } from '../../types';
import cleanupUser from '../../setup/cleanupUser';
import { getE2EUser } from '../../setup/user';
import { withMongo } from './db';

/**
 * Real HTTP and database plumbing for the Slack channel scenarios. Only what happens outside this
 * app is written to Mongo: a Slack installation or shared workspace install (activation and OAuth
 * verify with Slack, which a test must not reach), the reply a gateway delivered, and a row
 * restored as another provider. Every other state change goes through the routes under test, and
 * an account deletes the agents it created when it closes.
 */

export type Json = Record<string, unknown>;
/** Providers a restored row can carry, neither of which the Slack routes may serve. */
export type Restored = 'unsupported-provider' | 'typeless';
export const RESTORED: Restored[] = ['unsupported-provider', 'typeless'];
export const CHANNELS_ENABLED = process.env.E2E_CHANNELS === 'true';
export const THREAD = 'C0E2ECHAN1:1700000000.000100';

export interface Reply<T = Json> {
  status: number;
  body: T;
  text: string;
  cache?: string;
}

export interface Account {
  api: APIRequestContext;
  token: string;
  userId: string;
  user: User;
  /** The suite's own user: signed in as, never deleted. */
  persistent: boolean;
  /** Agents this account created, each deleted once when it closes. */
  agents: Set<string>;
}

export interface Slack {
  teamId: string;
  appId: string;
  botUserId: string;
  botToken: string;
  signingSecret: string;
}

export interface Channel {
  owner: Account;
  agentId: string;
  channelId: string;
  revision: string;
  slack: Slack;
}

export interface Workspace {
  workspaceId: string;
  appId: string;
  teamId: string;
  botUserId: string;
}

const upper = (bytes: number): string => randomBytes(bytes).toString('hex').toUpperCase();
const conversationOf = (channel: Channel): string => `channels-e2e-${channel.channelId}`;
export const bearer = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
});
export const newActor = (): string => `U${upper(6)}`;

export function serviceHeaders(tenantId?: string): Record<string, string> {
  const token = process.env.E2E_CHANNEL_SERVICE_TOKEN;
  if (!token) {
    throw new Error('Run with E2E_CHANNELS=true so the harness provides a channel service token');
  }
  return { Authorization: `Bearer ${token}`, ...(tenantId ? { 'x-tenant-id': tenantId } : {}) };
}

export async function send<T = Json>(
  api: APIRequestContext,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  init: { headers?: Record<string, string>; data?: unknown } = {},
): Promise<Reply<T>> {
  const response = await api.fetch(url, { method, failOnStatusCode: false, ...init });
  const text = await response.text();
  const [status, cache] = [response.status(), response.headers()['cache-control']];
  await response.dispose();
  let body: unknown = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    /* a refusal may carry no JSON body; the status and text still say what happened */
  }
  return { status, body: body as T, text, cache };
}

async function signIn(
  baseURL: string | undefined,
  user: User,
  register: boolean,
): Promise<Account> {
  if (!baseURL) {
    throw new Error('A baseURL is required to open a channel account');
  }
  const api = await playwrightRequest.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
  });
  if (register) {
    const { email, name, password } = user;
    const data = { email, name, password, confirm_password: password };
    const registered = await api.post('/api/auth/register', { data });
    expect(registered.ok(), await registered.text()).toBeTruthy();
  }
  const data = { email: user.email, password: user.password };
  const login = await api.post('/api/auth/login', { data });
  expect(login.ok(), await login.text()).toBeTruthy();
  const body = (await login.json()) as { token: string; user: { _id: string } };
  const agents = new Set<string>();
  return { api, token: body.token, userId: body.user._id, user, persistent: !register, agents };
}

export const openAccount = (baseURL: string | undefined, label: string): Promise<Account> =>
  signIn(
    baseURL,
    {
      email: `channels-${label}-${randomUUID()}@example.com`,
      name: label,
      password: 'secret-pass-123',
    },
    true,
  );
/** The primary user, which the first registration made the administrator. */
export const openAdmin = (baseURL: string | undefined): Promise<Account> =>
  signIn(baseURL, getE2EUser(), false);

/** Deletes the account's agents through the owner route, then the account unless it is the suite's. */
export async function closeAccount(account: Account): Promise<void> {
  for (const id of account.agents) {
    const removed = await send(account.api, 'DELETE', `/api/agents/${id}`, {
      headers: bearer(account.token),
    });
    expect.soft(removed.status, removed.text).toBe(200);
  }
  await account.api.dispose();
  if (!account.persistent) {
    await cleanupUser(account.user);
  }
}

/** Gives another user remote access to an agent, the permission a channel link checks. */
export async function shareAgent(owner: Account, agentId: string, viewer: Account): Promise<void> {
  const principal = {
    type: 'user',
    id: viewer.userId,
    name: viewer.user.name,
    email: viewer.user.email,
    source: 'local',
    accessRoleId: 'remoteAgent_viewer',
  };
  /** Permissions are keyed by the document id, not the public agent id. */
  const agent = await withMongo((db) =>
    db.collection('agents').findOne({ id: agentId }, { projection: { _id: 1 } }),
  );
  expect(agent).not.toBeNull();
  const shared = await send(owner.api, 'PUT', `/api/permissions/remoteAgent/${agent?._id}`, {
    headers: bearer(owner.token),
    data: { updated: [principal], removed: [] },
  });
  expect(shared.status, shared.text).toBe(200);
}

export async function createAgent(owner: Account): Promise<string> {
  const model = { provider: 'Mock Provider A', model: 'mock-model-a', model_parameters: {} };
  const created = await send<{ id: string }>(owner.api, 'POST', '/api/agents', {
    headers: bearer(owner.token),
    data: { name: 'Channel agent', tools: [], ...model },
  });
  expect(created.status, created.text).toBe(201);
  owner.agents.add(created.body.id);
  return created.body.id;
}

/** A pending Slack channel, created through the owner route. */
export async function createChannel(
  owner: Account,
  mode: 'shared' | 'per_user' = 'per_user',
): Promise<Channel> {
  const agentId = await createAgent(owner);
  const created = await send<Json & { channelId: string; revision: string }>(
    owner.api,
    'POST',
    `/api/agents/${agentId}/channels`,
    { headers: bearer(owner.token), data: { type: 'slack', credentialMode: mode } },
  );
  expect(created.status, created.text).toBe(201);
  expect(created.body.status).toBe('pending_install');
  const slack: Slack = {
    teamId: `T${upper(5)}`,
    appId: `A${upper(5)}`,
    botUserId: `U${upper(5)}`,
    botToken: `xoxb-e2e-${randomUUID()}`,
    signingSecret: `e2e-signing-${randomUUID()}`,
  };
  const { channelId, revision } = created.body;
  return { owner, agentId, channelId, revision, slack };
}

/** A value as an installation that predates random IVs stored it. */
export function legacyCiphertext(plaintext: string): string {
  const key = Buffer.from(process.env.CREDS_KEY ?? '', 'hex');
  const iv = Buffer.from(process.env.CREDS_IV ?? '', 'hex');
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString('hex');
}

const agentChannels = (db: Db) => db.collection('agentchannels');

/** What a successful activation stores, under a fresh revision. */
export async function installSlack(channel: Channel): Promise<Channel> {
  const { teamId, appId, botUserId, botToken, signingSecret } = channel.slack;
  const revision = `rev-${randomUUID()}`;
  const updated = await withMongo((db) =>
    agentChannels(db).updateOne(
      { channelId: channel.channelId },
      {
        $set: {
          status: 'active',
          revision,
          slack: { teamId, appId, botUserId },
          encryptedBotToken: legacyCiphertext(botToken),
          encryptedSigningSecret: legacyCiphertext(signingSecret),
        },
      },
    ),
  );
  expect(updated.matchedCount).toBe(1);
  return { ...channel, revision };
}

/** Restores the stored provider, leaving every other field of the row as it was. */
export async function restoreProvider(
  channel: Pick<Channel, 'channelId'>,
  provider: Restored | 'slack',
): Promise<void> {
  const update = provider === 'typeless' ? { $unset: { type: '' } } : { $set: { type: provider } };
  const updated = await withMongo((db) =>
    agentChannels(db).updateOne({ channelId: channel.channelId }, update),
  );
  expect(updated.matchedCount).toBe(1);
}

export const channelRow = (channelId: string): Promise<Document | null> =>
  withMongo((db) => agentChannels(db).findOne({ channelId }, { projection: { _id: 0 } }));
export const count = (collection: string, filter: Filter<Document>): Promise<number> =>
  withMongo((db) => db.collection(collection).countDocuments(filter));
export const identityRow = (channelId: string, actor: string): Promise<Document | null> =>
  withMongo((db) =>
    db
      .collection('channelidentities')
      .findOne(
        { 'identity.channelId': channelId, 'identity.externalUserId': actor },
        { projection: { _id: 0, state: 1, revision: 1 } },
      ),
  );

/** The owner route of a channel, as its creator. */
export const ownerCall = (
  channel: Channel,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  rest = '',
  data?: unknown,
): Promise<Reply> =>
  send(
    channel.owner.api,
    method,
    `/api/agents/${channel.agentId}/channels/${channel.channelId}${rest}`,
    {
      headers: bearer(channel.owner.token),
      data,
    },
  );

export const ownerList = (channel: Channel): Promise<Reply<Json[]>> =>
  send(channel.owner.api, 'GET', `/api/agents/${channel.agentId}/channels`, {
    headers: bearer(channel.owner.token),
  });

/** A service route of a channel, as the gateway holding the service token. */
export const service = (
  channel: Channel,
  method: 'GET' | 'POST' | 'PUT',
  rest: string,
  data?: unknown,
  tenantId?: string,
): Promise<Reply> =>
  send(channel.owner.api, method, `/api/channels/service/${channel.channelId}${rest}`, {
    headers: serviceHeaders(tenantId),
    data,
  });

export const bundle = (
  channel: Channel,
  headers = serviceHeaders(),
  tenant = '_',
): Promise<Reply> =>
  send(channel.owner.api, 'GET', `/api/channels/service/slack/${tenant}/${channel.channelId}`, {
    headers,
  });
export const issueTicket = (channel: Channel, actor: string): Promise<Reply> =>
  service(channel, 'POST', `/identity/${actor}/ticket`, {});
export const inspectActor = (channel: Channel, actor: string, tenantId?: string): Promise<Reply> =>
  service(channel, 'GET', `/identity/${actor}`, undefined, tenantId);
export const confirmLink = (
  channel: Channel,
  actor: string,
  link: { linkId: string; revision: string },
): Promise<Reply> => service(channel, 'POST', `/identity/${actor}/confirm`, link);
export const sendReaction = (channel: Channel, body: Json): Promise<Reply> =>
  service(channel, 'POST', '/reactions', body);
export const admit = (channel: Channel, body: Json): Promise<Reply> =>
  service(channel, 'POST', '/runs', body);

const browser = (account: Account, action: 'preview' | 'accept', data: Json): Promise<Reply> =>
  send(account.api, 'POST', `/api/channels/links/${action}`, {
    headers: bearer(account.token),
    data,
  });
export const previewTicket = (account: Account, ticket: string): Promise<Reply> =>
  browser(account, 'preview', { ticket });
export const acceptTicket = (account: Account, ticket: string, revision: string): Promise<Reply> =>
  browser(account, 'accept', { ticket, revision });

const revisionOf = (reply: Reply): string => (reply.body.value as { revision: string }).revision;

export interface Ticket {
  secret: string;
  linkId: string;
  revision: string;
}

/** Issues a ticket as the gateway would, and previews it as the account about to accept it. */
export async function startLink(
  channel: Channel,
  actor: string,
  account = channel.owner,
): Promise<Ticket> {
  const issued = await issueTicket(channel, actor);
  expect(issued.body.ok, issued.text).toBe(true);
  const { url, linkId } = issued.body.value as { url: string; linkId: string };
  const secret = new URL(url).hash.slice(1);
  const preview = await previewTicket(account, secret);
  expect(preview.body, preview.text).toMatchObject({ ok: true, value: { state: 'pending' } });
  return { secret, linkId, revision: revisionOf(preview) };
}

/** The consent flow: ticket, browser accept and, unless stopped there, the gateway's confirmation. */
export async function linkActor(
  channel: Channel,
  actor: string,
  account = channel.owner,
  confirm = true,
): Promise<{ linkId: string; revision: string }> {
  const ticket = await startLink(channel, actor, account);
  const accepted = await acceptTicket(account, ticket.secret, ticket.revision);
  expect(accepted.body, accepted.text).toMatchObject({ ok: true, value: { state: 'accepted' } });
  const link = { linkId: ticket.linkId, revision: revisionOf(accepted) };
  if (!confirm) {
    return link;
  }
  const confirmed = await confirmLink(channel, actor, link);
  expect(confirmed.body, confirmed.text).toMatchObject({ ok: true, value: { state: 'active' } });
  return { linkId: link.linkId, revision: revisionOf(confirmed) };
}

export function admission(channel: Channel, actor: string): Json {
  const key = `C0E2ECHAN1:${Math.floor(Date.now() / 1000)}.${randomBytes(3).readUIntBE(0, 3)}`;
  const { teamId, appId } = channel.slack;
  return {
    eventId: `Ev${randomUUID()}`,
    externalChannelId: 'C0E2ECHAN1',
    externalThreadKey: key,
    externalMessageKey: key,
    actor: { teamId, appId, externalUserId: actor },
    input: 'hello from the channel',
  };
}

/**
 * A gateway posts the answer to Slack and reports the message it created. Without Slack that
 * delivery cannot happen, so its outcome is written onto the admitted run along with the response
 * message the run would have saved. Nothing here says what feedback does with it.
 */
export async function deliverReply(channel: Channel, runId: string) {
  const [messageId, conversationId] = [randomUUID(), conversationOf(channel)];
  const messageKey = `C0E2ECHAN1:${Math.floor(Date.now() / 1000)}.000200`;
  const now = new Date();
  await withMongo(async (db) => {
    await db.collection('messages').insertOne({
      messageId,
      conversationId,
      user: channel.owner.userId,
      sender: 'Channel agent',
      text: 'Delivered answer',
      isCreatedByUser: false,
      error: false,
      endpoint: 'agents',
      createdAt: now,
      updatedAt: now,
    });
    const receipt = { operationId: randomUUID(), outcome: 'confirmed', attempts: 1 };
    const delivered = await db.collection('channelruns').updateOne(
      { runId, channelId: channel.channelId },
      {
        $set: {
          state: 'delivered',
          deliveredAt: now.getTime(),
          execution: {
            protocol: 'responses',
            responseId: messageId,
            requestId: randomUUID(),
            conversationId,
            parentMessageId: 'root',
          },
          snapshot: { responseId: messageId },
          receipts: [{ ...receipt, externalMessageKey: messageKey }],
        },
      },
    );
    expect(delivered.matchedCount).toBe(1);
  });
  return { messageKey, messageId };
}

export const reaction = (actor: string, messageKey: string, name: string): Json => ({
  eventId: `Ev${randomUUID()}`,
  eventTimestampUs: Date.now() * 1000,
  externalMessageKey: messageKey,
  externalUserId: actor,
  reaction: name,
  action: 'added',
});

/** What feedback has persisted for a channel, including whether its export has settled. */
export const feedbackState = (channelId: string) =>
  withMongo(async (db) => {
    const ledgers = await db
      .collection('channelfeedbacks')
      .find({ 'mapping.channelId': channelId })
      .toArray();
    return {
      replies: await db.collection('channelreplies').countDocuments({ channelId }),
      events: await db.collection('channelfeedbackevents').countDocuments({ channelId }),
      ledgers: ledgers.map(({ rating, revision, votes, exportStatus }) => ({
        rating,
        revision,
        votes: (votes as unknown[]).length,
        exportStatus,
      })),
    };
  });

/** An OAuth-installed shared workspace and its registered app, as an organization admin leaves them. */
export async function installWorkspace(): Promise<Workspace> {
  const ids = { appId: `A${upper(5)}`, teamId: `T${upper(5)}`, botUserId: `U${upper(5)}` };
  const workspace = { workspaceId: `ws-${randomUUID()}`, ...ids };
  const [now, revision] = [new Date(), `rev-${randomUUID()}`];
  await withMongo(async (db) => {
    await db.collection('slackinstallgenerations').insertOne({
      partition: '_',
      appId: ids.appId,
      revision,
      writes: 0,
      clientId: `client-${upper(4)}`,
      name: 'Channel e2e app',
      encryptedClientSecret: legacyCiphertext(`e2e-client-${randomUUID()}`),
      encryptedSigningSecret: legacyCiphertext(`e2e-signing-${randomUUID()}`),
    });
    await db.collection('slackworkspaces').insertOne({
      ...workspace,
      teamName: 'Channel e2e workspace',
      status: 'active',
      revision,
      scopes: [],
      encryptedBotToken: legacyCiphertext(`xoxb-e2e-${randomUUID()}`),
      installOrder: now.getTime(),
      authorityWrites: 0,
      createdAt: now,
      updatedAt: now,
    });
  });
  return workspace;
}

/** Removes a channel through the generic delete route, then whatever the scenarios seeded for it. */
export async function dropChannel(channel: Channel): Promise<void> {
  await ownerCall(channel, 'DELETE');
  const { channelId } = channel;
  await withMongo(async (db) => {
    await db.collection('channelruns').deleteMany({ channelId });
    await db.collection('channellanes').deleteMany({ channelId });
    await db.collection('channelidentities').deleteMany({ 'identity.channelId': channelId });
    await db.collection('messages').deleteMany({ conversationId: conversationOf(channel) });
    await agentChannels(db).deleteMany({ channelId });
  });
}

export async function removeWorkspace({ workspaceId, appId }: Workspace): Promise<void> {
  await withMongo(async (db) => {
    await db.collection('slackworkspaces').deleteMany({ workspaceId });
    await db.collection('slackroutes').deleteMany({ workspaceId });
    await db.collection('slackinstallgenerations').deleteMany({ appId });
  });
}
