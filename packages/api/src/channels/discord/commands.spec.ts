import type { DiscordInboxRecord } from '@librechat/data-schemas';
import {
  db,
  observations,
  tenantId,
  owner,
  other,
  applicationId,
  botUserId,
  externalChannelId,
  externalUserId,
  otherActor,
  scope,
  unwrap,
  models,
  installations,
  inbox,
  runs,
  execute,
  channel,
  applicationRevision,
  now,
  eventId,
  claim,
  native,
  invoke,
  accept,
  linked,
  allRuns,
  setAllowed,
  advanceClock,
} from './commands.helper';
it('requires browser consent and confirmation by the original Discord actor before admission', () =>
  scope(async () => {
    const first = await invoke({ kind: 'ask', prompt: 'Private prompt' });
    expect(first.content).toContain('visible to members');
    expect(first.content).toContain('will not run automatically');
    expect(await allRuns()).toHaveLength(0);
    const { card, confirmation } = await accept();
    expect(card.content).toContain('Account A');
    expect((await invoke(confirmation, otherActor)).content).toContain('no longer available');
    expect(await allRuns()).toHaveLength(0);
    expect((await invoke(confirmation)).content).toContain('Your account is linked');
    expect((await invoke({ kind: 'ask', prompt: 'New prompt' })).content).toContain('queued');
    const stored = await allRuns();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      principal: { userId: owner },
      admission: { input: 'New prompt', actor: { provider: 'discord', externalUserId } },
    });
    expect(stored[0].admission.externalThreadKey).toBe(
      `${externalChannelId}:${stored[0].admission.eventId}`,
    );
  }));

it('deduplicates ask retries and keeps separate commands in separate conversation lanes', () =>
  scope(async () => {
    await linked();
    const job = await claim({ kind: 'ask', prompt: 'Once' });
    await execute(job.record, job.fence, native(job.record));
    await execute(job.record, job.fence, native(job.record));
    expect(await allRuns()).toHaveLength(1);
    unwrap(await inbox.prepareReply(job.fence, 'reply', now));
    await inbox.finish(job.fence, 'completed', now);
    await invoke({ kind: 'ask', prompt: 'Separate' });
    const stored = await allRuns();
    expect(stored).toHaveLength(2);
    expect(new Set(stored.map((run) => run.laneId)).size).toBe(2);
  }));

it('shows owned status and preserves proxy prefixes in authenticated review links', () =>
  scope(async () => {
    await linked();
    expect((await invoke({ kind: 'status' })).content).toBe('You have no recent requests here.');
    await invoke({ kind: 'ask', prompt: 'Question' });
    const [run] = await allRuns();
    await models.ChannelRun.updateOne(
      { runId: run.runId },
      {
        $set: {
          state: 'requires_action',
          execution: {
            protocol: 'responses',
            responseId: 'response',
            conversationId: 'conversation',
            requestId: 'request',
            parentMessageId: 'parent',
          },
        },
      },
    );
    const reply = await invoke({ kind: 'status' });
    expect(reply.content).toContain('waiting for your review');
    expect(reply.actions).toEqual([
      {
        label: 'Review in LibreChat',
        url: 'https://chat.example/prefix/responses/response/review',
      },
    ]);
    await linked(otherActor, other);
    expect((await invoke({ kind: 'status' }, otherActor)).content).toBe(
      'You have no recent requests here.',
    );
  }));

it('freezes cancellation across a replay even if another run is admitted later', () =>
  scope(async () => {
    await linked();
    await invoke({ kind: 'ask', prompt: 'First' });
    const [first] = await allRuns();
    const job = await claim({ kind: 'cancel' });
    expect((await execute(job.record, job.fence, native(job.record))).content).toContain(
      'Stop requested. Waiting for the agent to confirm.',
    );
    const second = await runs.admit(
      {
        tenantId,
        channelId: channel.channelId,
        agentId: channel.agentId,
        applicationRevision,
        principal: first.principal,
        discordAuthority: native(job.record),
        admission: {
          ...first.admission,
          eventId: eventId(),
          externalThreadKey: `${externalChannelId}:later`,
          input: 'Later',
        },
      },
      now + 1,
    );
    expect((await execute(job.record, job.fence, native(job.record))).content).toContain(
      'Stop requested. Waiting for the agent to confirm.',
    );
    const persisted = await models.ChannelRun.findOne({ runId: second.run.runId }).lean();
    expect(persisted?.cancellationRequested).toBe(false);
    unwrap(await inbox.prepareReply(job.fence, 'reply', now));
    await inbox.finish(job.fence, 'completed', now);
    expect(
      await db
        .model<DiscordInboxRecord>('DiscordInbox')
        .findOne({ eventId: job.record.eventId })
        .select('+commandResult')
        .lean(),
    ).not.toHaveProperty('commandResult');
  }));

it('binds native cancellation to the current actor and a confirmed source message', () =>
  scope(async () => {
    await linked();
    await invoke({ kind: 'ask', prompt: 'Working' });
    const [run] = await allRuns();
    const messageId = '890123456789012345';
    await models.ChannelRun.updateOne(
      { runId: run.runId },
      {
        $set: {
          progress: {
            revision: 1,
            rendererVersion: 'discord-progress-v1',
            text: 'Working',
            outcome: 'confirmed',
            attempts: 1,
            externalMessageKey: `${externalChannelId}:${messageId}`,
          },
        },
      },
    );
    expect(
      (await invoke({ kind: 'cancel', reference: run.runId, messageId: '890123456789012346' }))
        .content,
    ).toBe('There is no active request to stop here.');
    await linked(otherActor, other);
    expect(
      (await invoke({ kind: 'cancel', reference: run.runId, messageId }, otherActor)).content,
    ).toBe('There is no active request to stop here.');
    expect((await invoke({ kind: 'cancel', reference: run.runId, messageId })).content).toContain(
      'Stop requested. Waiting for the agent to confirm.',
    );
  }));

it('fails closed on revoked permissions, stale application authority and stale command leases', () =>
  scope(async () => {
    await linked();
    const denied = await claim({ kind: 'ask', prompt: 'Denied' });
    setAllowed(false);
    await execute(denied.record, denied.fence, native(denied.record));
    expect(await allRuns()).toHaveLength(0);
    setAllowed(true);
    advanceClock(30000);
    const reclaimed = await inbox.claim(applicationId, 'replacement', now);
    expect(reclaimed?.eventId).toBe(denied.record.eventId);
    await expect(execute(denied.record, denied.fence, native(denied.record))).rejects.toMatchObject(
      {
        code: 'stale_fence',
      },
    );
    const fresh = { ...denied.fence, owner: 'replacement', epoch: reclaimed!.leaseEpoch };
    unwrap(
      await installations.configureApplication({
        actorId: owner,
        applicationId,
        botUserId,
        publicKey: 'b'.repeat(64),
        encryptedBotToken: 'new',
        expectedRevision: applicationRevision,
      }),
    );
    expect((await execute(denied.record, fresh, native(denied.record))).content).toContain(
      'no longer authorized',
    );
    expect(await inbox.prepareReply(fresh, 'reply', now)).toMatchObject({
      ok: false,
      error: { code: 'authority_changed' },
    });
    expect(await allRuns()).toHaveLength(0);
  }));

it('refuses a signed ask created before confirmation even when first received afterward', () =>
  scope(async () => {
    const delayedId = eventId();
    await linked();
    const delayed = await claim(
      { kind: 'ask', prompt: 'Before consent' },
      externalUserId,
      delayedId,
    );
    const reply = await execute(delayed.record, delayed.fence, native(delayed.record));
    expect(reply.content).toContain('new /librechat ask');
    expect(await allRuns()).toHaveLength(0);
    unwrap(await inbox.prepareReply(delayed.fence, 'reply', now));
    await inbox.finish(delayed.fence, 'completed', now);
    expect((await invoke({ kind: 'ask', prompt: 'Fresh prompt' })).content).toContain('queued');
    expect(await allRuns()).toHaveLength(1);
  }));

it('requires owned fresh actor source proof for signed asks even after account confirmation', () =>
  scope(async () => {
    await linked();
    const job = await claim({ kind: 'ask', prompt: 'Must have current access' });
    expect((await execute(job.record, job.fence)).content).toContain('no longer available');
    const observed = native(job.record);
    if (observed.kind !== 'guild_text') throw new Error('Missing text proof');
    expect(
      (
        await execute(job.record, job.fence, {
          ...observed,
          source: { ...observed.source, authorPermissions: '0' },
        })
      ).content,
    ).toContain('no longer available');
    expect(
      (
        await execute(job.record, job.fence, {
          ...observed,
          source: { ...observed.source, authorId: otherActor },
        })
      ).content,
    ).toContain('no longer available');
    expect(await allRuns()).toHaveLength(0);
    expect((await execute(job.record, job.fence, observed)).content).toContain('queued');
    expect(await allRuns()).toHaveLength(1);
  }));

it('observes native consent and command outcomes without retaining prompt or identity labels', () =>
  scope(async () => {
    await linked();
    await invoke({ kind: 'ask', prompt: 'metrics-private-prompt' });
    expect(observations).toEqual([
      { type: 'command', action: 'link', outcome: 'link_required' },
      { type: 'command', action: 'link', outcome: 'confirm_required' },
      { type: 'command', action: 'confirm', outcome: 'linked' },
      { type: 'command', action: 'ask', outcome: 'queued' },
    ]);
    setAllowed(false);
    await invoke({ kind: 'ask', prompt: 'metrics-private-denied' });
    expect(observations.at(-1)).toEqual({ type: 'command', action: 'ask', outcome: 'unavailable' });
    for (const secret of [
      owner,
      externalUserId,
      'metrics-private-prompt',
      'metrics-private-denied',
    ])
      expect(JSON.stringify(observations)).not.toContain(secret);
  }));
