import { expect, test } from '@playwright/test';
import type { Account, Channel, Json } from '../channels.helpers';
import {
  CHANNELS_ENABLED,
  RESTORED,
  THREAD,
  acceptTicket,
  admission,
  admit,
  bearer,
  bundle,
  channelRow,
  closeAccount,
  confirmLink,
  count,
  createAgent,
  createChannel,
  deliverReply,
  dropChannel,
  feedbackState,
  identityRow,
  inspectActor,
  installSlack,
  installWorkspace,
  issueTicket,
  linkActor,
  newActor,
  openAccount,
  openAdmin,
  ownerCall,
  ownerList,
  previewTicket,
  reaction,
  removeWorkspace,
  restoreProvider,
  send,
  sendReaction,
  service,
  serviceHeaders,
  shareAgent,
  startLink,
} from '../channels.helpers';
import { inOneProject } from './lint.helpers';

/**
 * A stored channel is served as Slack only when its canonical provider says so. Each scenario
 * restores a row as another provider (a value no route supports, or none at all) while its Slack
 * metadata still matches, then asks the real routes the Slack channel answered a moment earlier.
 * Enabled with E2E_CHANNELS=true against a MongoDB that supports transactions.
 */

const NOT_FOUND = { error: 'channel_not_found' };
const FORBIDDEN = { ok: false, error: { code: 'forbidden' } };

async function finish(channels: Channel[], ...accounts: Account[]): Promise<void> {
  for (const channel of channels) await dropChannel(channel);
  for (const account of accounts) await closeAccount(account);
}

test.describe('Slack channel provider isolation', () => {
  test.skip(!CHANNELS_ENABLED, 'Run with E2E_CHANNELS=true and a transaction-capable MongoDB');
  test.setTimeout(120_000);

  test('identity resolution refuses a restored provider whose Slack metadata still matches @scenario:slack-identity-resolution-rejects-a-different-canonical-provider-even-when-retained-slack-metadata-matches', async ({
    baseURL,
  }) => {
    inOneProject();
    const owner = await openAccount(baseURL, 'identity');
    const made: Channel[] = [];
    try {
      const channel = await installSlack(await createChannel(owner));
      made.push(channel);
      const [linked, waiting] = [newActor(), newActor()];
      const link = await linkActor(channel, linked);
      const ticket = await startLink(channel, waiting);
      const linkState = async () => {
        const links = await send<Json[]>(owner.api, 'GET', '/api/channels/links', {
          headers: bearer(owner.token),
        });
        return links.body.find((entry) => entry.linkId === link.linkId)?.state;
      };
      const expectServed = async () => {
        const inspected = await inspectActor(channel, linked);
        expect(inspected.body).toMatchObject({ ok: true, value: { state: 'active' } });
        expect(await linkState()).toBe('active');
        const preview = await previewTicket(owner, ticket.secret);
        expect(preview.body).toMatchObject({ ok: true, value: { state: 'pending' } });
      };
      await expectServed();

      for (const provider of RESTORED) {
        await restoreProvider(channel, provider);
        const { teamId, appId, botUserId } = channel.slack;
        expect((await channelRow(channel.channelId))?.slack).toEqual({ teamId, appId, botUserId });
        for (const refused of [
          await inspectActor(channel, linked),
          await issueTicket(channel, newActor()),
        ]) {
          expect([refused.status, refused.body]).toEqual([404, NOT_FOUND]);
        }
        expect(await linkState()).toBe('unavailable');
        expect((await previewTicket(owner, ticket.secret)).body).toEqual(FORBIDDEN);
        const rows = [
          await identityRow(channel.channelId, linked),
          await identityRow(channel.channelId, waiting),
        ];
        expect(rows).toMatchObject([
          { state: 'active', revision: link.revision },
          { state: 'pending', revision: ticket.revision },
        ]);
      }

      await restoreProvider(channel, 'slack');
      await expectServed();
    } finally {
      await finish(made, owner);
    }
  });

  test('setup, service bundles and thread reads refuse a restored provider, and deletion still works @scenario:slack-setup-service-bundles-and-thread-reads-refuse-unsupported-providers-while-deletion-remains-available', async ({
    baseURL,
  }) => {
    inOneProject();
    const owner = await openAccount(baseURL, 'service');
    const made: Channel[] = [];
    const activate = (channel: Channel) =>
      ownerCall(channel, 'PATCH', '', {
        slack: { botToken: 'not-a-bot-token', appId: channel.slack.appId },
      });
    const threads = (channel: Channel) =>
      Promise.all(
        (['GET', 'PUT'] as const).map((method) =>
          service(channel, method, `/threads/${THREAD}`, method === 'PUT' ? {} : undefined),
        ),
      );
    try {
      /** Control: Slack serves the manifest, reaches activation validation, and serves bundle and threads. */
      const pending = await createChannel(owner);
      const active = await installSlack(await createChannel(owner));
      made.push(pending, active);
      const manifest = await ownerCall(pending, 'GET', '/manifest');
      expect(manifest.status, manifest.text).toBe(200);
      expect(manifest.body).toMatchObject({ settings: { socket_mode_enabled: false } });
      const invalid = await activate(pending);
      expect([invalid.status, invalid.body]).toEqual([
        400,
        { error: 'invalid_channel_activation' },
      ]);
      const served = await bundle(active);
      const { botToken, signingSecret } = active.slack;
      expect(served.status, served.text).toBe(200);
      expect([served.cache, served.body.credentials]).toEqual([
        'no-store',
        { botToken, signingSecret },
      ]);
      for (const thread of await threads(active)) {
        expect([thread.status, thread.body]).toEqual([410, { error: 'use_actor_scoped_runs' }]);
      }

      for (const provider of RESTORED) {
        const setup = await createChannel(owner);
        const serving = await installSlack(await createChannel(owner));
        made.push(setup, serving);
        await restoreProvider(setup, provider);
        await restoreProvider(serving, provider);
        const refusals = [
          await ownerCall(setup, 'GET', '/manifest'),
          await activate(setup),
          await bundle(serving),
          ...(await threads(serving)),
        ];
        for (const refused of refusals) {
          expect([refused.status, refused.body]).toEqual([404, NOT_FOUND]);
        }

        const listed = await ownerList(serving);
        expect(listed.status, listed.text).toBe(200);
        expect(listed.body.map((row) => row.channelId)).toEqual([serving.channelId]);
        expect(listed.body[0]).toEqual({
          type: 'unavailable',
          status: 'disabled',
          channelId: serving.channelId,
          agentId: serving.agentId,
          createdBy: owner.userId,
          revision: serving.revision,
        });
        for (const secret of [serving.slack.botToken, serving.slack.signingSecret, 'encrypted']) {
          expect(listed.text).not.toContain(secret);
        }
        for (const channel of [setup, serving]) {
          const removed = await ownerCall(channel, 'DELETE');
          expect(removed.status, removed.text).toBe(204);
          expect(await channelRow(channel.channelId)).toBeNull();
        }
      }
    } finally {
      await finish(made, owner);
    }
  });

  test('feedback on a restored provider is refused and leaves every feedback row as it was @scenario:slack-feedback-refuses-another-provider-before-reading-a-reply-trace-or-exporting-a-score', async ({
    baseURL,
  }) => {
    inOneProject();
    const owner = await openAccount(baseURL, 'feedback');
    const made: Channel[] = [];
    try {
      const channel = await installSlack(await createChannel(owner));
      made.push(channel);
      const actor = newActor();
      await linkActor(channel, actor);
      const admitted = await admit(channel, admission(channel, actor));
      expect(admitted.status, admitted.text).toBe(201);
      const { messageKey, messageId } = await deliverReply(channel, String(admitted.body.runId));

      /** Control: a rating on a delivered reply is recorded and its export settles, so a refusal below is not a broken route. */
      const rated = await sendReaction(channel, reaction(actor, messageKey, '+1'));
      expect(rated.status, rated.text).toBe(200);
      expect(rated.body).toMatchObject({
        messageId,
        ignored: false,
        feedback: { rating: 'thumbsUp' },
      });
      const unknown = await sendReaction(channel, reaction(actor, `${THREAD}9`, '+1'));
      expect([unknown.status, unknown.body]).toEqual([404, { error: 'mapping_not_found' }]);
      const exported = async () =>
        (await feedbackState(channel.channelId)).ledgers[0]?.exportStatus;
      await expect.poll(exported, { timeout: 20_000 }).toBe('sent');
      const settled = await feedbackState(channel.channelId);
      expect(settled).toMatchObject({
        replies: 1,
        events: 1,
        ledgers: [{ rating: 'thumbsUp', votes: 1 }],
      });

      for (const provider of RESTORED) {
        await restoreProvider(channel, provider);
        const refused = await sendReaction(channel, reaction(actor, messageKey, '-1'));
        expect([refused.status, refused.body]).toEqual([404, NOT_FOUND]);
        expect(await feedbackState(channel.channelId)).toEqual(settled);
      }

      /** Once only the provider is restored, a new reaction on the same reply is recorded. */
      await restoreProvider(channel, 'slack');
      const changed = await sendReaction(channel, reaction(actor, messageKey, '-1'));
      expect(changed.body).toMatchObject({ messageId, feedback: { rating: 'thumbsDown' } });
      const after = await feedbackState(channel.channelId);
      expect(after).toMatchObject({ events: 2, ledgers: [{ rating: 'thumbsDown', revision: 2 }] });
      await expect.poll(exported, { timeout: 20_000 }).toBe('sent');
    } finally {
      await finish(made, owner);
    }
  });

  test('identity updates and run admission refuse a restored provider @scenario:identity-updates-and-linked-run-admission-reject-a-canonical-provider-change', async ({
    baseURL,
  }) => {
    inOneProject();
    const owner = await openAccount(baseURL, 'admission');
    const made: Channel[] = [];
    try {
      const channel = await installSlack(await createChannel(owner));
      made.push(channel);
      const [linked, waiting, accepted] = [newActor(), newActor(), newActor()];
      await linkActor(channel, linked);
      const ticket = await startLink(channel, waiting);
      const reviewed = await linkActor(channel, accepted, owner, false);
      const runs = () => count('channelruns', { channelId: channel.channelId });

      const first = await admit(channel, admission(channel, linked));
      expect([first.status, first.body.duplicate]).toEqual([201, false]);
      expect(await runs()).toBe(1);

      for (const provider of RESTORED) {
        await restoreProvider(channel, provider);
        const refused = await admit(channel, admission(channel, linked));
        expect([refused.status, refused.body]).toEqual([404, NOT_FOUND]);
        expect(await runs()).toBe(1);
        expect((await acceptTicket(owner, ticket.secret, ticket.revision)).body).toEqual(FORBIDDEN);
        expect((await confirmLink(channel, accepted, reviewed)).status).toBe(404);
        const rows = [
          await identityRow(channel.channelId, waiting),
          await identityRow(channel.channelId, accepted),
        ];
        expect(rows).toMatchObject([
          { state: 'pending', revision: ticket.revision },
          { state: 'accepted', revision: reviewed.revision },
        ]);
      }

      /** Once only the provider is restored, the same ticket and confirmation are accepted and a new event is admitted. */
      await restoreProvider(channel, 'slack');
      const accept = await acceptTicket(owner, ticket.secret, ticket.revision);
      expect(accept.body).toMatchObject({ ok: true, value: { state: 'accepted' } });
      const confirmed = await confirmLink(channel, accepted, reviewed);
      expect(confirmed.body).toMatchObject({ ok: true, value: { state: 'active' } });
      expect((await admit(channel, admission(channel, linked))).status).toBe(201);
      expect(await runs()).toBe(2);
    } finally {
      await finish(made, owner);
    }
  });

  test('Slack shared and per-user channels keep tenant, revision, consent and credential boundaries @scenario:existing-slack-shared-and-per-user-channels-preserve-tenant-revision-consent-and-private-credential-boundaries', async ({
    baseURL,
  }) => {
    inOneProject();
    const admin = await openAdmin(baseURL);
    const guest = await openAccount(baseURL, 'guest');
    const made: Channel[] = [];
    try {
      const shared = await installSlack(await createChannel(admin, 'shared'));
      const personal = await installSlack(await createChannel(admin, 'per_user'));
      made.push(shared, personal);

      for (const channel of made) {
        await shareAgent(admin, channel.agentId, guest);
        /** Credentials go only to the service holding the token, for the channel's own tenant. */
        const { botToken, signingSecret } = channel.slack;
        const served = await bundle(channel);
        expect(served.status, served.text).toBe(200);
        expect(served.body.credentials).toEqual({ botToken, signingSecret });
        const denied = [await bundle(channel, {}), await bundle(channel, bearer('0'.repeat(64)))];
        for (const reply of denied) {
          expect([reply.status, reply.body]).toEqual([401, { error: 'invalid_service_auth' }]);
        }
        const elsewhere = [
          await bundle(channel, serviceHeaders(), 'other-tenant'),
          await inspectActor(channel, newActor(), 'other-tenant'),
        ];
        for (const reply of elsewhere) {
          expect([reply.status, reply.body]).toEqual([404, NOT_FOUND]);
        }

        /** The owner's own views never carry credentials, and a viewer cannot manage the channel. */
        for (const view of [
          await ownerList(channel),
          await ownerCall(channel, 'GET', '/manifest'),
        ]) {
          expect(view.status, view.text).toBe(200);
          for (const secret of [botToken, signingSecret, 'encrypted']) {
            expect(view.text).not.toContain(secret);
          }
        }
        const viewer = await send(guest.api, 'GET', `/api/agents/${channel.agentId}/channels`, {
          headers: bearer(guest.token),
        });
        expect(viewer.status).toBe(403);
      }

      /** Consent: a per-user channel accepts a permitted viewer, a shared one only its creator. */
      const [viewer, creator] = [newActor(), newActor()];
      await linkActor(personal, viewer, guest);
      await linkActor(shared, creator, admin);
      const outsider = await issueTicket(shared, newActor());
      const secret = new URL((outsider.body.value as { url: string }).url).hash.slice(1);
      expect((await previewTicket(guest, secret)).body).toEqual(FORBIDDEN);

      /** Revision: a stale mode change is refused, and a rotated revision ends earlier consent. */
      const disabled = await ownerCall(personal, 'PATCH', '', { status: 'disabled' });
      expect(disabled.status, disabled.text).toBe(200);
      const mode = { credentialMode: 'shared' };
      const stale = await ownerCall(personal, 'PATCH', '', {
        ...mode,
        revision: personal.revision,
      });
      expect([stale.status, stale.body]).toEqual([409, { error: 'channel_changed' }]);
      const switched = await ownerCall(personal, 'PATCH', '', {
        ...mode,
        revision: disabled.body.revision,
      });
      expect(switched.status, switched.text).toBe(200);
      expect(switched.body.revision).not.toBe(disabled.body.revision);
      const reinstalled = await installSlack(personal);
      expect((await inspectActor(reinstalled, viewer)).body).toEqual({ ok: true, value: null });
      const stalled = await admit(reinstalled, admission(reinstalled, viewer));
      expect([stalled.status, stalled.body]).toEqual([403, { error: 'channel_link_required' }]);
    } finally {
      await finish(made, guest, admin);
    }
  });

  test('shared workspace routing and bindings refuse restored providers, and deletion removes their routes @scenario:shared-slack-workspace-binding-routing-and-credential-overlay-refuse-non-slack-or-typeless-restored-records-while-generic-deletion-removes-their-routes', async ({
    baseURL,
  }) => {
    inOneProject();
    const admin = await openAdmin(baseURL);
    const workspace = await installWorkspace();
    const made: Channel[] = [];
    try {
      const agentId = await createAgent(admin);
      for (const [index, provider] of RESTORED.entries()) {
        const connected = await send<Json & { channelId: string; revision: string }>(
          admin.api,
          'POST',
          `/api/agents/${agentId}/channels/workspace-connections`,
          { headers: bearer(admin.token), data: { workspaceId: workspace.workspaceId } },
        );
        expect(connected.status, connected.text).toBe(201);
        expect(connected.body.status).toBe('pending_install');
        const { teamId, appId, botUserId } = workspace;
        const slack = { teamId, appId, botUserId, botToken: '', signingSecret: '' };
        const { channelId, revision } = connected.body;
        const channel: Channel = { owner: admin, agentId, channelId, revision, slack };
        made.push(channel);
        const slackChannel = `C0E2ECH${index}`;
        const routed = { channelRevision: revision, externalChannelId: slackChannel };
        const resolve = () =>
          send(admin.api, 'POST', '/api/channels/service/workspaces/resolve', {
            headers: serviceHeaders(),
            data: {
              tenantId: '_',
              appId,
              teamId,
              target: {
                kind: 'thread',
                actorId: newActor(),
                externalChannelId: slackChannel,
                externalThreadKey: `${slackChannel}:1700000000.000100`,
              },
            },
          });

        /** A restored pending binding cannot be read, routed or unrouted, and nothing is written. */
        await restoreProvider(channel, provider);
        const stored = await channelRow(channelId);
        const refusals = [
          await ownerCall(channel, 'GET', '/workspace-routes?target=default'),
          await ownerCall(channel, 'POST', '/workspace-routes', routed),
          await ownerCall(channel, 'DELETE', '/workspace-routes', { expectedRevision: 'rev' }),
        ];
        for (const refused of refusals) expect(refused.status, refused.text).toBe(404);
        expect(await channelRow(channelId)).toEqual(stored);
        expect(await count('slackroutes', { channelId })).toBe(0);

        /** Control: the same binding is routed and resolved as Slack once only the provider differs. */
        await restoreProvider(channel, 'slack');
        const assigned = await ownerCall(channel, 'POST', '/workspace-routes', routed);
        expect(assigned.status, assigned.text).toBe(200);
        expect(assigned.body).toMatchObject({ status: 'active', slack: { teamId } });
        expect((await resolve()).body).toMatchObject({ kind: 'bound', channelId });
        expect(await count('slackroutes', { channelId })).toBe(1);

        /** Restored again, the route no longer resolves to it and the overlay serves no Slack channel. */
        await restoreProvider(channel, provider);
        const resolved = await resolve();
        expect([resolved.body.kind, resolved.body.channelId]).toEqual(['unmapped', undefined]);
        const listed = await ownerList(channel);
        expect(listed.status, listed.text).toBe(200);
        expect(listed.body.find((row) => row.channelId === channelId)?.status).toBe('disabled');

        /** Generic deletion still works and takes the route with it. */
        const removed = await ownerCall(channel, 'DELETE');
        expect(removed.status, removed.text).toBe(204);
        expect(await channelRow(channelId)).toBeNull();
        expect(await count('slackroutes', { channelId })).toBe(0);
      }
    } finally {
      await finish(made);
      await removeWorkspace(workspace);
      await closeAccount(admin);
    }
  });
});
