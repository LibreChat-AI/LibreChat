import { randomBytes, randomUUID } from 'crypto';
import {
  channelSnowflakeSchema,
  channelRunActorSchema,
  sameChannelRunActor,
  channelExternalIdentitySchema,
  sameChannelExternalIdentity,
  channelActorMatchesChannel,
} from 'librechat-data-provider';
import type {
  ChannelLinkView,
  ChannelRunActor,
  SlackAgentChannel,
  DiscordAgentChannel,
  ChannelIdentityResult,
  ChannelExternalIdentity,
  DiscordChannelRunActor,
} from 'librechat-data-provider';
import type { Route } from '@playwright/test';
import type { Account, Channel, Reply } from '../channels.helpers';
import {
  CHANNELS_ENABLED,
  acceptTicket,
  admission,
  admit,
  bearer,
  closeAccount,
  confirmLink,
  count,
  createChannel,
  dropChannel,
  inspectActor,
  installSlack,
  linkActor,
  newActor,
  openAccount,
  openAdmin,
  ownerCall,
  previewTicket,
  send,
  service,
  startLink,
} from '../channels.helpers';
import {
  NONE,
  linkRow,
  runRow,
  newGuild,
  recordOf,
  saveLink,
  leftovers,
  readStored,
  savePending,
  principalOf,
  admitStored,
  slackIdentity,
  restoreParent,
  replaceIdentity,
  discordIdentity,
  canonicalChannel,
} from '../channel-contracts.helpers';
import { appURL } from '../../../setup/authenticate';
import { expect, test, unroute } from '../fixtures';
import { inOneProject } from './lint.helpers';

/**
 * Provider scope on channel actors and consent, one literal tag per contract sentence. The Slack
 * lifecycle, the restored rows and the refused Discord consent go through the real routes and,
 * where a route cannot reach it, the real storage methods behind them. Two scenarios are tables
 * over the public schemas and comparators. No Discord route, installation or ticket exists in this
 * slice, so the accepted and active Discord views of scenario 5 are synthetic preview responses.
 * Enabled with E2E_CHANNELS=true against a MongoDB that supports transactions.
 */

const NOT_FOUND = { error: 'channel_not_found' };
const LINK_REQUIRED = { error: 'channel_link_required' };
const FORBIDDEN = { ok: false, error: { code: 'forbidden' } };
const CHANGED = { ok: false, error: { code: 'changed' } };
const COPY = { accepted: 'Back in Slack, confirm this account', active: 'Active' };
const MAX = '18446744073709551615';

/** Ids shared by the Slack and Discord fixtures, so that only the provider tells them apart. */
const [TEAM, APP, USER, OTHER] = ['111', '222', '333', '444'];
const SLACK: ChannelRunActor = { teamId: TEAM, appId: APP, externalUserId: USER };
const DISCORD: DiscordChannelRunActor = {
  provider: 'discord',
  applicationId: APP,
  guildId: TEAM,
  externalUserId: USER,
};
const CONTEXT = { tenantId: 't', channelId: 'c', channelRevision: 'r', agentId: 'a' };

const revisionOf = (reply: Reply): string => (reply.body.value as { revision: string }).revision;
const answers = (reply: Reply, status: number, body: unknown, label?: string) =>
  expect([reply.status, reply.body], label).toEqual([status, body]);
const accepts = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;
const evidence = (description: string) =>
  test.info().annotations.push({ type: 'evidence', description });
const omit = (value: object, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));

async function finish(channels: Channel[], ...accounts: Account[]): Promise<void> {
  for (const channel of channels) await dropChannel(channel);
  for (const account of accounts) await closeAccount(account);
  expect.soft(await leftovers(channels), 'fixtures left behind').toEqual(NONE);
}

test.describe('Slack and Discord channel provider contracts', () => {
  test.skip(!CHANNELS_ENABLED, 'Run with E2E_CHANNELS=true and a transaction-capable MongoDB');
  test.setTimeout(180_000);

  test('Slack actors and identities keep their historical shapes and matching @scenario:existing-untagged-slack-actors-and-identities-retain-their-accepted-shapes-and-matching-behavior', async ({
    baseURL,
  }) => {
    inOneProject();
    const owner = await openAccount(baseURL, 'untagged');
    const made: Channel[] = [];
    try {
      const channel = await installSlack(await createChannel(owner));
      made.push(channel);
      const actor = newActor();
      const link = await linkActor(channel, actor);
      const identity = slackIdentity(channel, actor);

      /** The service view and the stored consent row carry the six historical fields, nothing else. */
      const { value } = (await inspectActor(channel, actor)).body;
      expect(value).toMatchObject({ state: 'active', linkId: link.linkId });
      const stored = (await linkRow(link.linkId))?.identity;
      for (const found of [(value as { identity: unknown }).identity, stored]) {
        expect(found).toStrictEqual(identity);
        expect(channelExternalIdentitySchema.parse(found)).toStrictEqual(identity);
      }
      expect(sameChannelExternalIdentity(stored, { ...identity })).toBe(true);

      /** One captured admission: its first submission creates the run, the same body again is its duplicate. */
      const body = admission(channel, actor);
      const first = await admit(channel, body);
      expect([first.status, first.body.duplicate]).toEqual([201, false]);
      answers(await admit(channel, body), 200, { runId: first.body.runId, duplicate: true });
      expect(await count('channelruns', { channelId: channel.channelId })).toBe(1);

      const run = await runRow(String(first.body.runId));
      const { teamId, appId } = channel.slack;
      const actorShape = { teamId, appId, externalUserId: actor };
      expect(run?.admission.actor).toStrictEqual(actorShape);
      expect(channelRunActorSchema.parse(run?.admission.actor)).toStrictEqual(actorShape);
      expect(sameChannelRunActor(run?.admission.actor, { ...actorShape })).toBe(true);
      expect(run?.principal).toStrictEqual({
        userId: owner.userId,
        channelRevision: channel.revision,
        linkId: link.linkId,
        linkRevision: link.revision,
      });
      const canonical = await canonicalChannel(channel.channelId);
      expect(channelActorMatchesChannel(canonical, actorShape)).toBe(true);
    } finally {
      await finish(made, owner);
    }
  });

  test('Discord identities keep exact snowflakes and reject malformed or mixed scopes @scenario:discord-identities-retain-exact-snowflake-values-and-reject-malformed-or-mixed-provider-scopes', async () => {
    inOneProject();
    evidence('Public schema behavior only: no Discord route, database or installation.');
    const kinds = {
      actor: { schema: channelRunActorSchema, slack: SLACK, discord: DISCORD },
      identity: {
        schema: channelExternalIdentitySchema,
        slack: { ...CONTEXT, teamId: TEAM, externalUserId: USER },
        discord: { ...CONTEXT, ...DISCORD },
      },
    };
    /** Past 2^53, so a JavaScript number cannot hold them, and at the unsigned 64-bit boundary. */
    const wide = ['9007199254740993', '12345678901234567890', MAX];
    const spoiled = '0 01 -1 1.5 1e10 18446744073709551616'.split(' ');
    const malformed = [...spoiled, ' 123', '123 ', '', Number(USER), null];
    for (const value of wide) {
      expect(String(Number(value)), `${value} survives a number`).not.toBe(value);
      expect(channelSnowflakeSchema.parse(value)).toBe(value);
    }
    for (const value of malformed) {
      expect(accepts(channelSnowflakeSchema, value), `snowflake ${String(value)}`).toBe(false);
    }

    for (const [kind, { schema, slack, discord }] of Object.entries(kinds)) {
      expect(accepts(schema, slack), `${kind} Slack control`).toBe(true);
      expect(accepts(schema, discord), `${kind} Discord control`).toBe(true);
      for (const field of ['applicationId', 'guildId', 'externalUserId']) {
        for (const value of wide) {
          const parsed = schema.safeParse({ ...discord, [field]: value });
          expect(parsed.success, `${kind}.${field}=${value}`).toBe(true);
          expect(JSON.parse(JSON.stringify(parsed.data))[field], `${kind}.${field} JSON`).toBe(
            value,
          );
        }
        for (const value of malformed) {
          const label = `${kind}.${field}=${String(value)}`;
          expect(accepts(schema, { ...discord, [field]: value }), label).toBe(false);
        }
        expect(accepts(schema, omit(discord, field)), `${kind} without ${field}`).toBe(false);
      }
      for (const field of kind === 'identity' ? Object.keys(CONTEXT) : []) {
        expect(accepts(schema, omit(discord, field)), `${kind} without ${field}`).toBe(false);
      }
      const mixed: Record<string, object> = {
        'Discord plus teamId': { ...discord, teamId: TEAM },
        'Discord plus appId': { ...discord, appId: APP },
        'untagged Discord fields': omit(discord, 'provider'),
        'tagged Slack': { ...slack, provider: 'slack' },
        'unknown provider': { ...discord, provider: 'unknown' },
      };
      for (const [label, value] of Object.entries(mixed)) {
        expect(accepts(schema, value), `${kind}: ${label}`).toBe(false);
      }
    }
  });

  test('actor and consent equality reject any change of provider scope or authority @scenario:actor-and-consent-equality-reject-a-change-of-provider-application-guild-actor-or-channel-authority', async () => {
    inOneProject();
    evidence('Comparators on typed records: not channel activation or an authorization outcome.');
    const slackConsent: ChannelExternalIdentity = {
      ...CONTEXT,
      teamId: TEAM,
      externalUserId: USER,
    };
    const discordConsent: ChannelExternalIdentity = { ...CONTEXT, ...DISCORD };

    /** A copy is equal; each field changed alone to a valid alternate is not, in either order. */
    function distinct<T extends object>(
      same: (a: T, b: T) => boolean,
      base: T,
      fields: (keyof T & string)[],
    ) {
      expect(same(base, { ...base }), 'copy').toBe(true);
      for (const field of fields) {
        const changed = { ...base, [field]: OTHER };
        expect(same(base, changed), field).toBe(false);
        expect(same(changed, base), `${field} reversed`).toBe(false);
      }
    }
    const shared = [
      'tenantId',
      'channelId',
      'channelRevision',
      'agentId',
      'externalUserId',
    ] as const;
    distinct(sameChannelRunActor, SLACK, ['teamId', 'appId', 'externalUserId']);
    distinct(sameChannelRunActor, DISCORD, ['applicationId', 'guildId', 'externalUserId']);
    distinct(sameChannelExternalIdentity, slackConsent, [...shared, 'teamId']);
    distinct(sameChannelExternalIdentity, discordConsent, [...shared, 'applicationId', 'guildId']);
    for (const [a, b] of [
      [SLACK, DISCORD],
      [DISCORD, SLACK],
    ] as const) {
      expect(sameChannelRunActor(a, b)).toBe(false);
    }
    for (const [a, b] of [
      [slackConsent, discordConsent],
      [discordConsent, slackConsent],
    ] as const) {
      expect(sameChannelExternalIdentity(a, b)).toBe(false);
    }
    /** Slack consent has no application id and Slack actors require one: no appId rule is invented. */
    expect(accepts(channelExternalIdentitySchema, { ...slackConsent, appId: APP })).toBe(false);
    expect(accepts(channelRunActorSchema, omit(SLACK, 'appId'))).toBe(false);

    /** Canonical channel scope: each provider matches only its own metadata. */
    const row = { channelId: 'c', agentId: 'a', createdBy: 'o', revision: 'r' } as const;
    const base = { ...row, status: 'active', credentialMode: 'per_user' } as const;
    const botUserId = USER;
    const slackChannel: SlackAgentChannel = {
      ...base,
      type: 'slack',
      slack: { teamId: TEAM, appId: APP, botUserId },
    };
    const discordChannel: DiscordAgentChannel = {
      ...base,
      type: 'discord',
      discord: { applicationId: APP, guildId: TEAM, botUserId },
    };
    expect(channelActorMatchesChannel(slackChannel, SLACK)).toBe(true);
    expect(channelActorMatchesChannel(discordChannel, DISCORD)).toBe(true);
    expect(channelActorMatchesChannel(slackChannel, DISCORD)).toBe(false);
    expect(channelActorMatchesChannel(discordChannel, SLACK)).toBe(false);
    for (const field of ['teamId', 'appId'] as const) {
      expect(channelActorMatchesChannel(slackChannel, { ...SLACK, [field]: OTHER }), field).toBe(
        false,
      );
    }
    for (const field of ['applicationId', 'guildId'] as const) {
      const changed = { ...DISCORD, [field]: OTHER };
      expect(channelActorMatchesChannel(discordChannel, changed), field).toBe(false);
    }
    /** Missing provider metadata refuses every actor, the other provider's included. */
    const bare = [
      { ...slackChannel, slack: undefined },
      { ...discordChannel, discord: undefined },
    ];
    for (const channel of bare) {
      for (const actor of [SLACK, DISCORD]) {
        expect(channelActorMatchesChannel(channel, actor)).toBe(false);
      }
    }
  });

  test('restored non-Slack rows cannot match Slack identity writes or linked run admission @scenario:restored-non-slack-rows-retaining-slack-fields-cannot-match-slack-identity-writes-or-linked-run-admission', async ({
    baseURL,
  }) => {
    inOneProject();
    evidence('HTTP refusals, then the real storage fences, past principal resolution.');
    const owner = await openAccount(baseURL, 'restored');
    const made: Channel[] = [];
    try {
      const channel = await installSlack(await createChannel(owner));
      made.push(channel);
      const actor = newActor();
      const link = await linkActor(channel, actor);
      const control = await admit(channel, admission(channel, actor));
      expect(control.status, control.text).toBe(201);
      const principal = await principalOf(String(control.body.runId));
      const original = await linkRow(link.linkId);
      const slack = recordOf(original);
      const runs = () => count('channelruns', { channelId: channel.channelId });
      const revised = () => ({ ...slack, revision: `rev-${randomUUID()}` });

      /** Control: before any restoration the storage accepts these exact Slack inputs. */
      expect(await readStored(slack.identity)).toMatchObject({ state: 'active' });
      expect((await admitStored(channel, actor, principal)).duplicate).toBe(false);
      expect(await runs()).toBe(2);

      const { applicationId, guildId } = newGuild();
      const cases: Record<string, Record<string, string>> = {
        'a Discord tag with application and guild': { provider: 'discord', applicationId, guildId },
        'an unknown provider tag': { provider: 'unknown' },
        'a stray application id': { applicationId },
        'a stray guild id': { guildId },
      };
      for (const [label, extra] of Object.entries(cases)) {
        const identity = { ...slack.identity, ...extra };
        await replaceIdentity(link.linkId, identity);
        const restored = await linkRow(link.linkId);
        expect(restored, label).toStrictEqual({ ...original, identity });

        /** HTTP: the Slack actor has no consent and admits nothing. */
        expect((await inspectActor(channel, actor)).body, label).toEqual({ ok: true, value: null });
        answers(await admit(channel, admission(channel, actor)), 403, LINK_REQUIRED, label);

        /** Storage: valid Slack inputs reach the update scope and the linked admission fence. */
        expect(await readStored(slack.identity), label).toBeNull();
        expect(await saveLink(revised(), slack.revision), label).toBe(false);
        const admitted = admitStored(channel, actor, principal);
        await expect(admitted, label).rejects.toMatchObject({ code: 'invalid_transition' });
        expect(await linkRow(link.linkId), label).toStrictEqual(restored);
        expect(await runs(), label).toBe(2);
        await replaceIdentity(link.linkId, slack.identity);
        expect(await linkRow(link.linkId), label).toStrictEqual(original);
      }

      /** Control: restored, the same save succeeds and a fresh admission follows the new revision. */
      const next = revised();
      expect(await saveLink(next, slack.revision)).toBe(true);
      expect(await linkRow(link.linkId)).toMatchObject({
        state: 'active',
        revision: next.revision,
      });
      const resumed = await admit(channel, admission(channel, actor));
      expect([resumed.status, resumed.body.duplicate]).toEqual([201, false]);
      expect(await runs()).toBe(3);
    } finally {
      await finish(made, owner);
    }
  });

  test('Discord consent stays unavailable and its identities never open a Slack link @scenario:discord-consent-remains-unavailable-before-installation-authority-exists-and-discord-identities-cannot-open-a-slack-return-link', async ({
    baseURL,
    page,
  }) => {
    inOneProject();
    evidence(
      'Real backend and page. The Discord accepted and active views are synthetic previews.',
    );
    if (!baseURL) throw new Error('A baseURL is required');
    const admin = await openAdmin(baseURL);
    const made: Channel[] = [];
    const guild = newGuild();
    const entry = appURL(baseURL, 'channels/link');
    const slackLinks = page.locator('a[href^="slack://"]');
    try {
      const channel = await installSlack(await createChannel(admin));
      made.push(channel);

      /** Control: an accepted Slack ticket opens the real page with one Slack return link, never followed. */
      const slack = await startLink(channel, newActor(), admin);
      const accepted = await acceptTicket(admin, slack.secret, slack.revision);
      expect(accepted.body).toMatchObject({ ok: true, value: { state: 'accepted' } });
      await page.goto(`${entry}#${slack.secret}`);
      await expect(page.getByRole('status')).toContainText(COPY.accepted);
      await expect(slackLinks).toHaveCount(1);
      const href = `slack://open?team=${encodeURIComponent(channel.slack.teamId)}`;
      await expect(slackLinks).toHaveAttribute('href', href);

      /** Control: the storage saves a valid Slack record, so the Discord refusals below are not a broken setup. */
      const control = await savePending(slackIdentity(channel, newActor()));
      expect(control.saved).toBe(true);
      expect(await linkRow(control.linkId)).toMatchObject({ state: 'pending' });

      /** A pending ticket as issued, restored with a valid Discord identity. Slack holds no Discord authority. */
      const ticket = await startLink(channel, newActor(), admin);
      const issued = await linkRow(ticket.linkId);
      const identity = discordIdentity(channel, guild);
      await replaceIdentity(ticket.linkId, identity);
      const restored = { ...issued, identity };
      expect(await linkRow(ticket.linkId)).toStrictEqual(restored);
      /** The second pass restores the parent row with Discord metadata matching the identity: still no installation. */
      for (const parent of [null, guild]) {
        await restoreParent(channel, parent);
        answers(await previewTicket(admin, ticket.secret), 200, FORBIDDEN);
        answers(await acceptTicket(admin, ticket.secret, ticket.revision), 200, FORBIDDEN);
        expect(await linkRow(ticket.linkId)).toStrictEqual(restored);
        await page.goto('about:blank');
        await page.goto(`${entry}#${ticket.secret}`);
        await expect(page.getByText('You cannot link this account to this channel.')).toBeVisible();
        await expect(slackLinks).toHaveCount(0);
        const direct = await savePending(discordIdentity(channel, guild));
        expect(direct.saved).toBe(false);
        expect(await linkRow(direct.linkId)).toBeNull();
      }
      await restoreParent(channel, null);

      /** Synthetic: only the preview answer is supplied, since no backend path yields an accepted or active Discord view. */
      const expiresAtMs = Date.now() + 600_000;
      const view = (state: 'accepted' | 'active'): ChannelIdentityResult<ChannelLinkView> => ({
        ok: true,
        value: { identity, linkId: 'synthetic', revision: 'synthetic', state, expiresAtMs },
      });
      const previews = (url: URL) => url.pathname === '/api/channels/links/preview';
      for (const state of ['accepted', 'active'] as const) {
        const synthetic = randomBytes(32).toString('base64url');
        const answer = (route: Route) =>
          route.request().postDataJSON()?.ticket === synthetic
            ? route.fulfill({ json: view(state) })
            : route.fallback();
        await page.route(previews, answer);
        try {
          await page.goto('about:blank');
          await page.goto(`${entry}#${synthetic}`);
          await expect(page.getByRole('status')).toContainText(COPY[state]);
          await expect(page.getByText('Channel agent', { exact: true })).toBeVisible();
          await page.getByText('Connection details').click();
          await expect(page.getByText(identity.externalUserId)).toBeVisible();
          await expect(slackLinks).toHaveCount(0);
        } finally {
          await unroute(page, previews, answer);
        }
      }
    } finally {
      if (made[0]) await restoreParent(made[0], null).catch(() => undefined);
      await finish(made, admin);
    }
  });

  test('Slack consent lifecycle and run admission keep tenant and revision fencing @scenario:existing-slack-consent-creation-acceptance-revocation-and-run-admission-preserve-tenant-and-revision-fencing', async ({
    baseURL,
  }) => {
    inOneProject();
    const owner = await openAdmin(baseURL);
    const made: Channel[] = [];
    const revoke = (linkId: string, revision: string) =>
      send(owner.api, 'DELETE', `/api/channels/links/${linkId}`, {
        headers: bearer(owner.token),
        data: { revision },
      });
    try {
      for (const mode of ['shared', 'per_user'] as const) {
        const channel = await installSlack(await createChannel(owner, mode));
        made.push(channel);
        const actor = newActor();
        const runs = () => count('channelruns', { channelId: channel.channelId });

        /** Creation and acceptance: a stale revision is a body-level `changed` that writes nothing. */
        const ticket = await startLink(channel, actor);
        const issued = await linkRow(ticket.linkId);
        expect(issued, mode).toMatchObject({ state: 'pending', revision: ticket.revision });
        answers(await acceptTicket(owner, ticket.secret, 'stale-revision'), 200, CHANGED, mode);
        expect(await linkRow(ticket.linkId), mode).toStrictEqual(issued);
        const accept = await acceptTicket(owner, ticket.secret, ticket.revision);
        expect(accept.body, mode).toMatchObject({ ok: true, value: { state: 'accepted' } });
        const link = { linkId: ticket.linkId, revision: revisionOf(accept) };
        const early = await confirmLink(channel, actor, { ...link, revision: ticket.revision });
        answers(early, 200, CHANGED, mode);
        const row = await linkRow(link.linkId);
        expect(row, mode).toMatchObject({ state: 'accepted', revision: link.revision });
        const confirm = await confirmLink(channel, actor, link);
        expect(confirm.body, mode).toMatchObject({ ok: true, value: { state: 'active' } });
        const active = revisionOf(confirm);

        /** Admission: the captured event is admitted; another tenant sees no channel, a foreign team or app is refused. */
        const body = admission(channel, actor);
        const first = await admit(channel, body);
        expect([first.status, first.body.duplicate], mode).toEqual([201, false]);
        const tenant = await service(channel, 'POST', '/runs', admission(channel, actor), 'other');
        answers(tenant, 404, NOT_FOUND, mode);
        for (const change of [{ teamId: 'T0OTHER' }, { appId: 'A0OTHER' }]) {
          const foreign = { ...channel, slack: { ...channel.slack, ...change } };
          const refused = await admit(channel, admission(foreign, actor));
          answers(refused, 403, { error: 'channel_actor_mismatch' }, mode);
        }
        expect(await runs(), mode).toBe(1);

        /** Revocation: a stale revision changes nothing; the current one revokes and ends admission, retries included. */
        answers(await revoke(link.linkId, link.revision), 200, CHANGED, mode);
        expect(await linkRow(link.linkId), mode).toMatchObject({
          state: 'active',
          revision: active,
        });
        const revoked = await revoke(link.linkId, active);
        expect(revoked.body, mode).toMatchObject({ ok: true, value: { state: 'revoked' } });
        const gone = { state: 'revoked', revision: revisionOf(revoked) };
        expect(await linkRow(link.linkId), mode).toMatchObject(gone);
        for (const event of [body, admission(channel, actor)]) {
          answers(await admit(channel, event), 403, LINK_REQUIRED, mode);
        }
        expect(await runs(), mode).toBe(1);

        /** Consent again shows revocation left the fixture intact; that run's principal is the enrollment kept below. */
        await linkActor(channel, actor);
        const resumed = await admit(channel, admission(channel, actor));
        expect([resumed.status, resumed.body.duplicate], mode).toEqual([201, false]);
        const enrolled = await principalOf(String(resumed.body.runId));
        expect((await admitStored(channel, actor, enrolled)).duplicate, mode).toBe(false);
        expect(await runs(), mode).toBe(3);

        /** Rotation: disabling, then external activation under a fresh revision, ends the earlier consent. */
        const disabled = await ownerCall(channel, 'PATCH', '', { status: 'disabled' });
        expect(disabled.status, disabled.text).toBe(200);
        const credentialMode = mode === 'shared' ? 'per_user' : 'shared';
        const behind = { credentialMode, revision: channel.revision };
        const outdated = await ownerCall(channel, 'PATCH', '', behind);
        answers(outdated, 409, { error: 'channel_changed' }, mode);
        const current = { credentialMode, revision: disabled.body.revision };
        const switched = await ownerCall(channel, 'PATCH', '', current);
        expect(switched.status, switched.text).toBe(200);
        const rotated = await installSlack(channel);
        expect((await inspectActor(rotated, actor)).body, mode).toEqual({ ok: true, value: null });
        answers(await admit(rotated, admission(rotated, actor)), 403, LINK_REQUIRED, mode);
        const late = admitStored(rotated, actor, enrolled);
        await expect(late, mode).rejects.toMatchObject({ code: 'invalid_transition' });
        expect(await runs(), mode).toBe(3);

        /** A new link at the new revision admits again. */
        await linkActor(rotated, actor);
        const renewed = await admit(rotated, admission(rotated, actor));
        expect([renewed.status, renewed.body.duplicate], mode).toEqual([201, false]);
        expect(await runs(), mode).toBe(4);
      }
    } finally {
      await finish(made, owner);
    }
  });
});
