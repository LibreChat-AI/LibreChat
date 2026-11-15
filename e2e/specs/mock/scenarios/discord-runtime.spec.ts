import { createHash, randomUUID } from 'node:crypto';
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

  test('a browser-issued DM selection lets a signed ask run through the real Responses path and answer only in the DM @scenario:discord-dm-selection-ask-and-output', async ({
    request,
    baseURL,
  }) => {
    if (!baseURL) throw new Error('Discord acceptance requires a backend URL');
    const fixture = await createDiscordAcceptance(request, baseURL);
    try {
      const [actor, outsider] = fixture.actors;
      await fixture.link(actor);
      expect((await fixture.dmSelections()).selections).toEqual([]);
      // Without a selection the physical DM cannot execute anything.
      const early = fixture.dmEvent(actor, { kind: 'ask', prompt: 'Never run before selection' });
      expect((await fixture.send(early)).status).toBe(409);
      expect(await fixture.runs()).toHaveLength(0);

      const { code, expiresAtMs } = await fixture.issueDmCode(actor);
      expect(/^[A-Za-z0-9_-]{43}$/.test(code)).toBe(true);
      expect(expiresAtMs).toBeGreaterThan(Date.now());
      expect(await fixture.hasStoredCodeHash(code)).toBe(true);
      // The code is bound to the linked actor: another Discord user cannot consume it anywhere.
      const stolen = await fixture.dmSelect(outsider, code, fixture.otherDmChannelId);
      expect(stolen.body.data?.content).toContain('unavailable');
      expect((await fixture.dmSelections()).selections).toEqual([]);

      const selected = await fixture.dmSelect(actor, code);
      expect(selected.status).toBe(200);
      expect(selected.body).toEqual({
        type: 4,
        data: {
          flags: 64,
          content: 'Your private agent selection is saved. Manage or revoke it in LibreChat.',
          allowed_mentions: { parse: [] },
        },
      });
      const { enabled, selections } = await fixture.dmSelections();
      expect(enabled).toBe(true);
      expect(selections).toHaveLength(1);
      const [selection] = selections;
      // Discord may redeliver /select: the same actor in the same DM gets the same selection back,
      // while the consumed code cannot establish a selection from any other DM.
      expect((await fixture.dmSelect(actor, code)).body).toEqual(selected.body);
      const elsewhere = await fixture.dmSelect(actor, code, fixture.otherDmChannelId);
      expect(elsewhere.body.data?.content).toContain('unavailable');
      expect((await fixture.dmSelections()).selections).toEqual(selections);
      expect(selection).toMatchObject({
        agentId: fixture.agentId,
        applicationId: fixture.applicationId,
        dmChannelId: fixture.dmChannelId,
        state: 'active',
      });
      // Browser metadata carries neither the code, its hash nor the retained guild source.
      expect(Object.keys(selection).sort()).toEqual([
        'agentId',
        'applicationId',
        'dmChannelId',
        'expiresAtMs',
        'linkId',
        'revision',
        'selectionId',
        'state',
      ]);

      // The selection belongs to the selecting actor and to the DM it was confirmed in.
      const wrongActor = fixture.dmEvent(outsider, { kind: 'ask', prompt: 'Wrong actor' });
      const wrongDm = fixture.dmEvent(
        actor,
        { kind: 'ask', prompt: 'Wrong DM' },
        fixture.otherDmChannelId,
      );
      for (const input of [wrongActor, wrongDm])
        expect((await fixture.send(input)).status).toBe(409);
      // A physical DM names no guild: a spoofed guild is refused by the signed boundary itself.
      const spoofed = fixture.dmEvent(
        actor,
        { kind: 'ask', prompt: 'Spoofed guild' },
        fixture.dmChannelId,
        {
          guild_id: fixture.guildId,
        },
      );
      const refused = await fixture.send(spoofed);
      expect([refused.status, await refused.json()]).toEqual([400, { error: 'invalid_context' }]);
      expect(await fixture.runs()).toHaveLength(0);

      const marker = `discord-dm-${randomUUID()}`;
      const ask = await fixture.dmCommand(actor, { kind: 'ask', prompt: `E2E_REPLY:${marker}` });
      expect(ask.reply.content).toContain('Replies are sent to this private DM');
      await expect
        .poll(async () => (await fixture.runs()).map((run) => run.state), { timeout: 60000 })
        .toEqual(['delivered']);
      const [run] = await fixture.runs();
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
        eventId: ask.input.id,
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
      expect(run.receipts.every((receipt) => receipt.outcome === 'confirmed')).toBe(true);
      const keys = run.receipts.flatMap((receipt) => receipt.externalMessageKey ?? []);
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.every((key) => key.startsWith(`${fixture.dmChannelId}:`))).toBe(true);
      // Every Discord write, including progress and the answer, went to the real DM channel only.
      const answers = fixture.writes.filter(
        (write) => write.method === 'POST' && write.content.includes(marker),
      );
      expect(answers).toHaveLength(1);
      for (const write of fixture.writes) {
        expect(write.channelId).toBe(fixture.dmChannelId);
        expect(write.allowed_mentions).toEqual({ parse: [], replied_user: false });
      }
      expect(fixture.unexpected).toEqual([]);
      // The durable inbox keeps the physical DM and the selection's source guild apart.
      const row = await fixture.inboxRow(ask.input.id);
      expect(row?.externalChannelId).toBe(fixture.dmChannelId);
      expect(row).not.toHaveProperty('guildId');
      expect(row?.dm).toMatchObject({
        selectionId: selection.selectionId,
        selectionRevision: selection.revision,
        parentChannelId: fixture.externalChannelId,
        source: { guildId: fixture.guildId, userId: fixture.userId },
      });

      const status = await fixture.dmCommand(actor, { kind: 'status' });
      expect(status.reply.content).toContain('completed');
      expect(status.reply.actions?.find((action) => 'url' in action)).toMatchObject({
        url: new URL(`/c/${run.execution!.conversationId}`, baseURL).href,
      });

      // Feedback is bound to the confirmed answer in the selected DM, never to any other message.
      const answer = answers[0];
      const [up, down] = (['thumbsUp', 'thumbsDown'] as const).map((rating) =>
        discordRunControl(rating, run.runId),
      );
      expect(
        answer.components?.flatMap((entry) => entry.components.map((button) => button.custom_id)),
      ).toEqual([up, down]);
      const answerKey = `${fixture.dmChannelId}:${answer.id}`;
      expect(run.receipts.some((receipt) => receipt.externalMessageKey === answerKey)).toBe(true);
      const vote = (reference: string, messageId: string) =>
        fixture.dmCommand(actor, { kind: 'control', reference, messageId });
      const unrelated = String(BigInt(answer.id) + BigInt(1));
      const foreign = discordRunControl('thumbsUp', `other-${run.runId}`);
      for (const denied of [await vote(up, unrelated), await vote(foreign, answer.id)])
        expect(denied.reply.content).toContain('unavailable');
      expect(await fixture.feedback()).toEqual([]);
      const intruder = fixture.dmEvent(outsider, {
        kind: 'control',
        reference: up,
        messageId: answer.id,
      });
      expect((await fixture.send(intruder)).status).toBe(409);
      expect((await vote(up, answer.id)).reply.content).toBe('Feedback received.');
      expect((await vote(down, answer.id)).reply.content).toBe('Feedback received.');
      const ledgers = await fixture.feedback();
      expect(ledgers).toHaveLength(1);
      expect(ledgers[0]).toMatchObject({
        rating: 'thumbsDown',
        mapping: {
          provider: 'discord',
          scope: 'dm',
          applicationId: fixture.applicationId,
          selectionId: selection.selectionId,
          selectionRevision: selection.revision,
          sourceGuildId: fixture.guildId,
          parentChannelId: fixture.externalChannelId,
          externalChannelId: fixture.dmChannelId,
          externalUserId: actor,
          externalMessageKey: answerKey,
          runId: run.runId,
          responseId: run.execution!.responseId,
          conversationId: run.execution!.conversationId,
          principalId: fixture.userId,
        },
      });
      expect(ledgers[0].mapping).not.toHaveProperty('guildId');

      // Discord redelivering the same signed ask neither runs nor writes again.
      const writes = fixture.writes.length;
      expect((await fixture.send(ask.input)).status).toBe(200);
      expect(await fixture.runs()).toHaveLength(1);
      expect(fixture.writes).toHaveLength(writes);
      // The one-time code is held only as its canonical hash, never in a log, output or row. The
      // scan demonstrably reads the code collection, so finding nothing means the code is absent.
      expect(await fixture.leaks(createHash('sha256').update(code).digest('hex'))).toContain(
        'DiscordDmCode',
      );
      expect(await fixture.leaks(code)).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  test('revoking the DM selection through the API fences every later prompt from executing or writing @scenario:discord-dm-revoke-fences-later-prompts', async ({
    request,
    baseURL,
  }) => {
    if (!baseURL) throw new Error('Discord acceptance requires a backend URL');
    const fixture = await createDiscordAcceptance(request, baseURL);
    try {
      const [actor] = fixture.actors;
      await fixture.link(actor);
      const { code } = await fixture.issueDmCode(actor);
      expect((await fixture.dmSelect(actor, code)).body.data?.content).toContain(
        'selection is saved',
      );
      const [selection] = (await fixture.dmSelections()).selections;
      const marker = `discord-dm-before-revoke-${randomUUID()}`;
      await fixture.dmCommand(actor, { kind: 'ask', prompt: `E2E_REPLY:${marker}` });
      await expect
        .poll(async () => (await fixture.runs()).map((run) => run.state), { timeout: 60000 })
        .toEqual(['delivered']);
      const [delivered] = await fixture.runs();
      const answer = fixture.writes.find(
        (write) => write.method === 'POST' && write.content.includes(marker),
      );
      if (!answer) throw new Error('Missing Discord DM answer');
      const before = await fixture.footprint();

      const revoked = await fixture.revokeDmSelection(selection);
      expect([revoked.status, revoked.result]).toEqual([200, { ok: true, value: null }]);
      expect((await fixture.dmSelections()).selections).toMatchObject([
        { selectionId: selection.selectionId, state: 'revoked' },
      ]);
      // Revocation rotates the revision, so the same request cannot be replayed, and it drops the code.
      expect((await fixture.revokeDmSelection(selection)).status).toBe(409);
      expect(await fixture.hasStoredCodeHash(code)).toBe(false);
      expect((await fixture.dmSelect(actor, code)).body.data?.content).toContain('unavailable');

      // Later prompts and metadata requests are refused before they reach the durable inbox.
      const later = [
        fixture.dmEvent(actor, { kind: 'ask', prompt: `E2E_REPLY:after-revoke-${randomUUID()}` }),
        fixture.dmEvent(actor, { kind: 'status' }),
        fixture.dmEvent(actor, { kind: 'cancel' }),
        fixture.dmEvent(actor, {
          kind: 'control',
          reference: discordRunControl('thumbsUp', delivered.runId),
          messageId: answer.id,
        }),
      ];
      for (const input of later) {
        const refused = await fixture.send(input);
        expect([refused.status, await refused.json()]).toEqual([
          409,
          { error: 'interaction_not_accepted' },
        ]);
      }
      const after = await fixture.footprint();
      expect(after).toEqual({ ...before, keys: expect.any(Number) });
      expect(after.keys).toBeLessThanOrEqual(before.keys);
      expect(await fixture.runs()).toHaveLength(1);
      expect(fixture.unexpected).toEqual([]);
      expect(await fixture.leaks(code)).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
});
