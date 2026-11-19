import { randomUUID } from 'node:crypto';
import { Constants, discordRunControl } from 'librechat-data-provider';
import type { DiscordPrivateReply } from 'librechat-data-provider';
import { createDiscordAcceptance, acceptDiscordInBrowser } from '../discord.helpers';
import { expect, test } from '../fixtures';

test.describe('real Discord backend runtime', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(
    process.env.E2E_DISCORD_CHANNELS !== 'true',
    'Requires isolated Discord runtime opt-in',
  );
  test.setTimeout(120000);

  test('only fresh prompts after original-actor confirmation execute once @scenario:discord-signed-consent-and-exactly-once', async ({
    page,
    request,
    baseURL,
  }) => {
    if (!baseURL) throw new Error('Discord acceptance requires a backend URL');
    const fixture = await createDiscordAcceptance(request, baseURL);
    try {
      const [actor, outsider] = fixture.actors;
      const invalid = fixture.event(actor, 'ask', 'This signature must fail');
      expect((await fixture.send(invalid, false)).status).toBe(401);
      expect(await fixture.runs()).toHaveLength(0);
      const earlier = await fixture.command(actor, 'ask', 'Never run this earlier prompt');
      expect(earlier.reply.content).toContain('will not run automatically');
      expect(await fixture.runs()).toHaveLength(0);
      await acceptDiscordInBrowser(page, earlier.reply);
      expect((await fixture.linkState(actor))?.state).toBe('accepted');
      const stillUnconfirmed = await fixture.command(
        actor,
        'ask',
        'Not authorized by browser acceptance alone',
      );
      expect(stillUnconfirmed.reply.content).toContain('Confirm');
      expect(await fixture.runs()).toHaveLength(0);
      const reference = stillUnconfirmed.reply.actions?.find((action) => 'reference' in action);
      if (!reference || !('reference' in reference))
        throw new Error('Missing confirmation control');
      const forwarded = await fixture.command(outsider, 'link', '', reference.reference);
      expect(forwarded.reply.content).toContain('no longer available');
      expect((await fixture.linkState(actor))?.state).toBe('accepted');
      const confirmed = await fixture.command(actor, 'link', '', reference.reference);
      expect(confirmed.reply.content).toContain('Your account is linked');
      expect((await fixture.linkState(actor))?.state).toBe('active');
      expect((await fixture.send(earlier.input)).status).toBe(200);
      expect(await fixture.runs()).toHaveLength(0);
      const marker = `discord-confirmed-${randomUUID()}`;
      const fresh = fixture.event(actor, 'ask', `E2E_REPLY:${marker}`);
      for (let retry = 0; retry < 2; retry++) {
        const ack = await fixture.send(fresh);
        expect(ack.status).toBe(200);
        expect(await ack.json()).toEqual({ type: 5, data: { flags: 64 } });
      }
      await expect
        .poll(async () => (await fixture.runs()).map((run) => run.state), { timeout: 60000 })
        .toEqual(['delivered']);
      const [run] = await fixture.runs();
      expect(run.admission.eventId).toBe(fresh.id);
      expect(run.admission.input).toBe(`E2E_REPLY:${marker}`);
      expect(run.principal.userId).toBe(fixture.userId);
      expect(run.execution?.apiKeyId).toBeTruthy();
      const response = await fixture.response(run.execution!.responseId!);
      expect(response).toMatchObject({
        status: 'completed',
        sourceKeyId: run.execution?.apiKeyId,
        requestKey: `channel:${run.runId}`,
        userId: fixture.userId,
      });
      const answers = fixture.writes.filter(
        (write) => write.method === 'POST' && write.content.includes(marker),
      );
      expect(answers).toHaveLength(1);
      expect(answers[0].channelId).toBe(fixture.externalChannelId);
      expect(answers[0].allowed_mentions).toEqual({ parse: [], replied_user: false });
      expect((await fixture.send(fresh)).status).toBe(200);
      expect(await fixture.runs()).toHaveLength(1);
      expect(
        fixture.writes.filter((write) => write.method === 'POST' && write.content.includes(marker)),
      ).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  test('durable Responses output and native controls remain bound to the requesting actor @scenario:discord-durable-response-and-actor-isolation', async ({
    request,
    baseURL,
  }) => {
    if (!baseURL) throw new Error('Discord acceptance requires a backend URL');
    const fixture = await createDiscordAcceptance(request, baseURL);
    try {
      const [first, second] = fixture.actors;
      // Both external actors deliberately link the same LibreChat account.
      await fixture.link(first);
      await fixture.link(second);
      const firstMarker = `first-actor-${randomUUID()}`;
      const secondMarker = `second-actor-${randomUUID()}`;
      const a = await fixture.command(
        first,
        'ask',
        `E2E_REPLY:${firstMarker}<@${fixture.botUserId}>`,
      );
      const b = await fixture.command(second, 'ask', `E2E_REPLY:${secondMarker}`);
      await expect
        .poll(async () => (await fixture.runs()).map((run) => run.state), { timeout: 60000 })
        .toEqual(['delivered', 'delivered']);
      const runs = await fixture.runs();
      const firstRun = runs.find((run) => run.admission.eventId === a.input.id)!;
      const secondRun = runs.find((run) => run.admission.eventId === b.input.id)!;
      expect(firstRun.principal.userId).toBe(secondRun.principal.userId);
      expect(firstRun.laneId).not.toBe(secondRun.laneId);
      expect(firstRun.execution?.conversationId).not.toBe(secondRun.execution?.conversationId);
      expect(firstRun.execution?.parentMessageId).toBe(Constants.NO_PARENT);
      expect(secondRun.execution?.parentMessageId).toBe(Constants.NO_PARENT);
      for (const run of runs) {
        expect(run.admission.externalChannelId).toBe(fixture.externalChannelId);
        expect(run.receipts.every((receipt) => receipt.outcome === 'confirmed')).toBe(true);
        expect(run.execution?.apiKeyId).toBeTruthy();
        expect((await fixture.response(run.execution!.responseId!))?.status).toBe('completed');
      }
      expect(
        fixture.writes.some(
          (write) =>
            write.content.includes(firstMarker) &&
            write.content.includes(`<@\u200b${fixture.botUserId}>`),
        ),
      ).toBe(true);
      expect(fixture.writes.some((write) => write.content.includes(secondMarker))).toBe(true);
      for (const write of fixture.writes) {
        expect(write.channelId).toBe(fixture.externalChannelId);
        expect(write.allowed_mentions).toEqual({ parse: [], replied_user: false });
        if (write.method === 'POST') {
          expect(write.enforce_nonce).toBe(true);
          expect(write.nonce?.length).toBeLessThanOrEqual(25);
        }
      }
      // A private status card must resolve the acting user's latest run, never the other actor's.
      const status: DiscordPrivateReply = (await fixture.command(second, 'status')).reply;
      expect(status.content).toContain('completed');
      const link = status.actions?.find((action) => 'url' in action);
      expect(link).toMatchObject({
        url: new URL(`/c/${secondRun.execution!.conversationId}`, baseURL).href,
      });
      const slow = await fixture.command(first, 'ask', `E2E_EMPTY_SLOW_REPLY:${randomUUID()}`);
      await expect
        .poll(
          async () =>
            (await fixture.runs()).find((run) => run.admission.eventId === slow.input.id)?.execution
              ?.responseId,
          { timeout: 30000 },
        )
        .toBeTruthy();
      const held = (await fixture.runs()).find((run) => run.admission.eventId === slow.input.id)!;
      const reference = discordRunControl('cancel', held.runId);
      const controls = () =>
        fixture.writes.filter((write) =>
          write.components?.some((row) =>
            row.components.some((button) => button.custom_id === reference),
          ),
        );
      await expect.poll(() => controls().length, { timeout: 10000 }).toBeGreaterThan(0);
      const component = { reference, messageId: controls().at(-1)!.id };
      expect((await fixture.command(second, 'cancel', '', component)).reply.content).toContain(
        'no active run',
      );
      expect(
        (await fixture.runs()).find((run) => run.runId === held.runId)?.cancellationRequested,
      ).toBe(false);
      expect((await fixture.command(first, 'cancel', '', component)).reply.content).toContain(
        'Cancellation requested',
      );
      await expect
        .poll(
          async () =>
            (await fixture.runs()).find((run) => run.runId === held.runId)?.snapshot?.status,
          { timeout: 60000 },
        )
        .toBe('cancelled');
      expect(
        (await fixture.runs())
          .filter((run) => run.runId !== held.runId)
          .every((run) => !run.cancellationRequested),
      ).toBe(true);
    } finally {
      await fixture.close();
    }
  });
});
