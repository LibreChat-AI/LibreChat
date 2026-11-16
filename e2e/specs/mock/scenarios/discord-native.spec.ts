import { randomUUID } from 'node:crypto';
import { Constants } from 'librechat-data-provider';
import { createDiscordAcceptance } from '../discord.helpers';
import { expect, test } from '../fixtures';

type Fixture = Awaited<ReturnType<typeof createDiscordAcceptance>>;

/** Every run the fixture retained is delivered, however many there are. */
const delivered = (fixture: Fixture, count: number) =>
  expect
    .poll(async () => (await fixture.runs()).map((run) => run.state), { timeout: 60000 })
    .toEqual(Array.from({ length: count }, () => 'delivered'));

/**
 * The Gateway handles events one at a time, in order. A mention from someone who never linked an
 * account is refused and consumed by the API, so once that receipt exists every event delivered
 * before it has been handled. That is a fence with no sleep and no run to wait for.
 */
async function settled(fixture: Fixture, stranger: string) {
  const fence = fixture.native.mention(stranger, `E2E_REPLY:fence-${randomUUID()}`);
  await expect
    .poll(async () => (await fixture.receipt(fence.id))?.outcome, { timeout: 30000 })
    .toBe('ignored');
}

/** A deployment stop: the SDK acknowledged heartbeats all session and closed the socket normally. */
async function expectCleanShutdown(fixture: Fixture) {
  const lifecycle = await fixture.stopNative();
  expect(lifecycle.heartbeats).toBeGreaterThan(0);
  expect(lifecycle.closes.length).toBeGreaterThan(0);
  expect(lifecycle.closes.every((code) => code === 1000 || code === 1001)).toBe(true);
  expect(lifecycle.open).toBe(0);
}

const requestOf = async (fixture: Fixture, responseId: string | undefined) => {
  const stored = await fixture.response(responseId!);
  return JSON.parse(stored!.requestJSON) as { previous_response_id?: string };
};

test.describe('real Discord native Gateway runtime', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(
    process.env.E2E_DISCORD_CHANNELS !== 'true' || process.env.E2E_DISCORD_NATIVE !== 'true',
    'Requires the isolated native Discord Gateway opt-in',
  );
  test.setTimeout(180000);

  test('a real native mention runs once through the stored Responses path and answers only in its channel @scenario:discord-native-mention-exactly-once', async ({
    request,
    baseURL,
  }) => {
    if (!baseURL) throw new Error('Discord acceptance requires a backend URL');
    const fixture = await createDiscordAcceptance(request, baseURL, { native: true });
    try {
      const [actor, stranger] = fixture.actors;
      await fixture.link(actor);

      // Without a mention Discord strips the content of a guild message under this policy, and the
      // Gateway drops it before the API ever hears of it.
      const ignored = `Not for the bot ${randomUUID()}`;
      const plain = fixture.native.plain(actor, ignored);
      // A ping reply lists the bot in `mentions` and keeps its content, but names no one in the text.
      const implicit = fixture.native.reply(actor, `E2E_REPLY:implicit-${randomUUID()}`, plain.id);
      const marker = `discord-native-${randomUUID()}`;
      const mention = fixture.native.mention(actor, `E2E_REPLY:${marker}`);
      // Discord redelivers the same message, as after a reconnect: same ID, a new sequence number.
      fixture.native.redeliver(mention);
      await delivered(fixture, 1);
      await settled(fixture, stranger);

      const [run, ...extra] = await fixture.runs();
      expect(extra).toEqual([]);
      expect(run.admission).toMatchObject({
        actor: {
          provider: 'discord',
          applicationId: fixture.applicationId,
          guildId: fixture.guildId,
          externalUserId: actor,
        },
        eventId: mention.id,
        externalChannelId: fixture.externalChannelId,
        externalThreadKey: `${fixture.externalChannelId}:${mention.id}`,
        input: `E2E_REPLY:${marker}`,
      });
      expect(run.admission).not.toHaveProperty('discordDestination');
      expect(run.principal.userId).toBe(fixture.userId);
      expect(run.execution?.apiKeyId).toBeTruthy();
      expect(run.execution?.parentMessageId).toBe(Constants.NO_PARENT);
      expect(await fixture.response(run.execution!.responseId!)).toMatchObject({
        status: 'completed',
        sourceKeyId: run.execution?.apiKeyId,
        requestKey: `channel:${run.runId}`,
        userId: fixture.userId,
      });
      expect(run.receipts.every((receipt) => receipt.outcome === 'confirmed')).toBe(true);

      // The non-mention left nothing behind. The redelivery found the first message already consumed.
      for (const refused of [plain, implicit]) {
        expect(await fixture.receipt(refused.id)).toBeNull();
        expect(await fixture.inboxRow(refused.id)).toBeNull();
      }
      expect((await fixture.receipt(mention.id))?.outcome).toBe('admitted');
      const answers = fixture.writes.filter(
        (write) => write.method === 'POST' && write.content.includes(marker),
      );
      expect(answers).toHaveLength(1);
      expect(fixture.writes.some((write) => write.content.includes(ignored))).toBe(false);
      // Every write, including progress, went to the channel the message came from.
      for (const write of fixture.writes) {
        expect(write.channelId).toBe(fixture.externalChannelId);
        expect(write.allowed_mentions).toEqual({ parse: [], replied_user: false });
      }
      for (const removed of fixture.deletes)
        expect(removed.channelId).toBe(fixture.externalChannelId);

      // Native ingestion keeps working after both, and a fresh message outside a thread is a fresh conversation.
      const again = fixture.native.mention(actor, `E2E_REPLY:second-${randomUUID()}`);
      await delivered(fixture, 2);
      const next = (await fixture.runs()).find((entry) => entry.admission.eventId === again.id)!;
      expect(next.laneId).not.toBe(run.laneId);
      expect(next.execution?.conversationId).not.toBe(run.execution?.conversationId);
      expect(next.execution?.parentMessageId).toBe(Constants.NO_PARENT);

      expect(fixture.health()?.native).toEqual({
        disabled: 0,
        unknown: 0,
        healthy: 1,
        degraded: 0,
        failing: 0,
      });
      expect(fixture.unexpected).toEqual([]);
      await expectCleanShutdown(fixture);
    } finally {
      await fixture.close();
    }
  });

  test('native thread messages use the actual thread, its inspected parent and one lane per actor, and archived or non-member threads are refused @scenario:discord-native-thread-actor-lanes', async ({
    request,
    baseURL,
  }) => {
    if (!baseURL) throw new Error('Discord acceptance requires a backend URL');
    const fixture = await createDiscordAcceptance(request, baseURL, { native: true });
    try {
      const [first, second] = fixture.actors;
      // Both external actors deliberately link the same LibreChat account.
      await fixture.link(first);
      await fixture.link(second);
      const room = fixture.thread('public');
      const byEvent = async (eventId: string) =>
        (await fixture.runs()).find((run) => run.admission.eventId === eventId)!;

      // The first mention in the thread: intake and output are the thread itself, under the parent the
      // Gateway inspected, and the lane belongs to this actor in this thread.
      const startMarker = `thread-start-${randomUUID()}`;
      const started = fixture.native.mention(first, `E2E_REPLY:${startMarker}`, room, 11);
      await delivered(fixture, 1);
      const start = await byEvent(started.id);
      expect(start.admission).toMatchObject({
        actor: {
          provider: 'discord',
          applicationId: fixture.applicationId,
          guildId: fixture.guildId,
          externalUserId: first,
        },
        eventId: started.id,
        externalChannelId: room,
        externalThreadKey: `${room}:${room}`,
        input: `E2E_REPLY:${startMarker}`,
        discordDestination: { kind: 'guild_thread', parentChannelId: fixture.externalChannelId },
      });
      expect(start.execution?.parentMessageId).toBe(Constants.NO_PARENT);
      expect((await fixture.response(start.execution!.responseId!))?.status).toBe('completed');
      expect(
        fixture.writes.some(
          (write) => write.method === 'POST' && write.content.includes(startMarker),
        ),
      ).toBe(true);
      for (const write of fixture.writes) expect(write.channelId).toBe(room);

      // A follow-up mention continues the same lane, and the stored Responses request chains to the
      // previous response.
      const mentionMarker = `thread-mention-${randomUUID()}`;
      const followed = fixture.native.mention(first, `E2E_REPLY:${mentionMarker}`, room, 11);
      await delivered(fixture, 2);
      const mention = await byEvent(followed.id);
      expect(mention.laneId).toBe(start.laneId);
      expect(mention.execution?.conversationId).toBe(start.execution?.conversationId);
      expect((await requestOf(fixture, mention.execution?.responseId)).previous_response_id).toBe(
        start.execution!.responseId,
      );

      // So does a signed /librechat ask from the same person in the same thread.
      const askMarker = `thread-ask-${randomUUID()}`;
      const asked = await fixture.command(first, 'ask', `E2E_REPLY:${askMarker}`, undefined, room);
      await delivered(fixture, 3);
      const ask = await byEvent(asked.input.id);
      expect(ask.laneId).toBe(start.laneId);
      expect(ask.execution?.conversationId).toBe(start.execution?.conversationId);
      expect((await requestOf(fixture, ask.execution?.responseId)).previous_response_id).toBe(
        mention.execution!.responseId,
      );

      // A second actor, even on the same LibreChat account, never inherits that lane.
      const otherMarker = `thread-other-${randomUUID()}`;
      const other = fixture.native.mention(second, `E2E_REPLY:${otherMarker}`, room, 11);
      await delivered(fixture, 4);
      const separate = await byEvent(other.id);
      expect(separate.principal.userId).toBe(start.principal.userId);
      expect(separate.laneId).not.toBe(start.laneId);
      expect(separate.execution?.conversationId).not.toBe(start.execution?.conversationId);
      expect(separate.execution?.parentMessageId).toBe(Constants.NO_PARENT);
      expect((await requestOf(fixture, separate.execution?.responseId)).previous_response_id).toBe(
        undefined,
      );
      for (const write of fixture.writes) expect(write.channelId).toBe(room);

      // An archived thread, and a private thread the author has not joined, are refused without a
      // run, a Response or a write. The API consuming the message as ignored proves it was handled.
      const archived = fixture.thread('archived');
      const hidden = fixture.thread('private', { members: [second] });
      const before = await fixture.footprint();
      const refusedArchived = fixture.native.mention(
        first,
        `E2E_REPLY:archived-${randomUUID()}`,
        archived,
        11,
      );
      const refusedHidden = fixture.native.mention(
        first,
        `E2E_REPLY:hidden-${randomUUID()}`,
        hidden,
        12,
      );
      await expect
        .poll(
          async () => [
            (await fixture.receipt(refusedArchived.id))?.outcome,
            (await fixture.receipt(refusedHidden.id))?.outcome,
          ],
          { timeout: 30000 },
        )
        .toEqual(['ignored', 'ignored']);
      const after = await fixture.footprint();
      expect(after).toEqual({ ...before, keys: expect.any(Number) });
      expect(after.keys).toBeLessThanOrEqual(before.keys);
      expect(await fixture.runs()).toHaveLength(4);
      expect(
        fixture.writes.filter((write) => [archived, hidden].includes(write.channelId)),
      ).toEqual([]);

      // The same private thread admits a member, so the refusal above is about membership and nothing else.
      const memberMarker = `thread-member-${randomUUID()}`;
      const joined = fixture.native.mention(second, `E2E_REPLY:${memberMarker}`, hidden, 12);
      await delivered(fixture, 5);
      const member = await byEvent(joined.id);
      expect(member.admission).toMatchObject({
        externalChannelId: hidden,
        externalThreadKey: `${hidden}:${hidden}`,
        discordDestination: { kind: 'guild_thread', parentChannelId: fixture.externalChannelId },
      });
      expect(
        fixture.writes.some(
          (write) => write.channelId === hidden && write.content.includes(memberMarker),
        ),
      ).toBe(true);
      expect(fixture.writes.some((write) => write.channelId === archived)).toBe(false);

      expect(fixture.unexpected).toEqual([]);
      await expectCleanShutdown(fixture);
    } finally {
      await fixture.close();
    }
  });

  test('a selected DM answers a plain native message in the real DM, and revoking the selection fences later native messages @scenario:discord-native-dm-selection-and-revoke', async ({
    request,
    baseURL,
  }) => {
    if (!baseURL) throw new Error('Discord acceptance requires a backend URL');
    const fixture = await createDiscordAcceptance(request, baseURL, { native: true });
    try {
      const [actor, stranger] = fixture.actors;
      await fixture.link(actor);

      // Before any selection a plain DM message has no authority behind it.
      const early = fixture.native.dm(actor, `E2E_REPLY:before-selection-${randomUUID()}`);
      await settled(fixture, stranger);
      expect(await fixture.receipt(early.id)).toBeNull();
      expect(await fixture.runs()).toHaveLength(0);

      // The selection is the browser-issued code consumed by a signed /librechat select in that DM.
      const { code } = await fixture.issueDmCode(actor);
      const selected = await fixture.dmSelect(actor, code);
      expect([selected.status, selected.body.data?.content]).toEqual([
        200,
        'Your private agent selection is saved. Manage or revoke it in LibreChat.',
      ]);
      const [selection] = (await fixture.dmSelections()).selections;
      expect(selection).toMatchObject({
        agentId: fixture.agentId,
        applicationId: fixture.applicationId,
        dmChannelId: fixture.dmChannelId,
        state: 'active',
      });

      // The selection belongs to its actor and to the DM it was confirmed in.
      fixture.native.dm(actor, `E2E_REPLY:wrong-dm-${randomUUID()}`, fixture.otherDmChannelId);
      fixture.native.dm(stranger, `E2E_REPLY:wrong-actor-${randomUUID()}`);
      const marker = `discord-native-dm-${randomUUID()}`;
      const sent = fixture.native.dm(actor, `E2E_REPLY:${marker}`);
      await delivered(fixture, 1);
      await settled(fixture, stranger);

      const [run, ...extra] = await fixture.runs();
      expect(extra).toEqual([]);
      expect(run.admission).toMatchObject({
        actor: {
          provider: 'discord',
          scope: 'dm',
          applicationId: fixture.applicationId,
          externalUserId: actor,
          selectionId: selection.selectionId,
          selectionRevision: selection.revision,
        },
        discordDestination: {
          kind: 'dm',
          parentChannelId: fixture.externalChannelId,
          selectionId: selection.selectionId,
          selectionRevision: selection.revision,
        },
        eventId: sent.id,
        externalChannelId: fixture.dmChannelId,
        input: `E2E_REPLY:${marker}`,
      });
      expect(run.admission.actor).not.toHaveProperty('guildId');
      expect(run.principal.userId).toBe(fixture.userId);
      expect(run.execution?.apiKeyId).toBeTruthy();
      expect(await fixture.response(run.execution!.responseId!)).toMatchObject({
        status: 'completed',
        sourceKeyId: run.execution?.apiKeyId,
        requestKey: `channel:${run.runId}`,
        userId: fixture.userId,
      });
      expect((await fixture.receipt(sent.id))?.outcome).toBe('admitted');
      expect(run.receipts.every((receipt) => receipt.outcome === 'confirmed')).toBe(true);
      const keys = run.receipts.flatMap((receipt) => receipt.externalMessageKey ?? []);
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.every((key) => key.startsWith(`${fixture.dmChannelId}:`))).toBe(true);
      // The durable output is in the real DM and nowhere else.
      expect(
        fixture.writes.filter((write) => write.method === 'POST' && write.content.includes(marker)),
      ).toHaveLength(1);
      for (const write of fixture.writes) {
        expect(write.channelId).toBe(fixture.dmChannelId);
        expect(write.allowed_mentions).toEqual({ parse: [], replied_user: false });
      }

      // Revoking through the API fences every later native message: no run, no receipt, no write.
      const before = await fixture.footprint();
      const revoked = await fixture.revokeDmSelection(selection);
      expect([revoked.status, revoked.result]).toEqual([200, { ok: true, value: null }]);
      expect((await fixture.dmSelections()).selections).toMatchObject([
        { selectionId: selection.selectionId, state: 'revoked' },
      ]);
      const late = fixture.native.dm(actor, `E2E_REPLY:after-revoke-${randomUUID()}`);
      await settled(fixture, stranger);
      expect(await fixture.receipt(late.id)).toBeNull();
      expect(await fixture.runs()).toHaveLength(1);
      const after = await fixture.footprint();
      expect(after).toEqual({ ...before, keys: expect.any(Number) });
      expect(after.keys).toBeLessThanOrEqual(before.keys);
      expect(fixture.writes.some((write) => write.content.includes('after-revoke'))).toBe(false);

      expect(fixture.unexpected).toEqual([]);
      await expectCleanShutdown(fixture);
    } finally {
      await fixture.close();
    }
  });
});
