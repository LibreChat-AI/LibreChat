import type { DiscordApplicationObservation } from './observe';
import { DiscordClient } from './client';

const input = {
  applicationId: '123456789012345678',
  botUserId: '234567890123456789',
  guildId: '345678901234567890',
  channelId: '456789012345678901',
};
const channel = { id: input.channelId, guild_id: input.guildId, type: 0, flags: 0 };
const permissions = String(1024 | 2048 | 65536);
const options = { botToken: 'private-bot-token', timeoutMs: 1000, maxResponseBytes: 2048 };
it('reads effective permissions for the requested actor without coercing lossless bitfields', async () => {
  const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(async () =>
    Response.json({ permissions: '9007199254742016' }),
  );
  const client = new DiscordClient(options, transport);
  await expect(client.getChannelMemberPermissions(input.channelId, input.botUserId)).resolves.toBe(
    '9007199254742016',
  );
  expect(transport).toHaveBeenCalledWith(
    `https://discord.com/api/v10/channels/${input.channelId}/permissions/member/${input.botUserId}`,
    expect.objectContaining({ method: 'GET', body: undefined }),
  );
});
it.each([{}, { permissions: 1024 }, { permissions: '-1' }, { permissions: 'invalid' }])(
  'refuses malformed member permissions',
  async (body) => {
    const client = new DiscordClient(options, async () => Response.json(body));
    await expect(
      client.getChannelMemberPermissions(input.channelId, input.botUserId),
    ).rejects.toMatchObject({ outcome: 'unknown' });
  },
);
function fixture(value = channel, bits = permissions) {
  const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(async (url) =>
    Response.json(
      String(url).endsWith(`/member/${input.botUserId}`) ? { permissions: bits } : value,
    ),
  );
  return { transport, client: new DiscordClient(options, transport) };
}
it('inspects actual guild/channel identity and effective bot permissions through bounded authenticated GET requests', async () => {
  const { client, transport } = fixture();
  expect(await client.inspectGuildTextSource(input)).toEqual({
    kind: 'guild_text',
    ...input,
    permissions,
  });
  expect(transport).toHaveBeenCalledWith(
    `https://discord.com/api/v10/channels/${input.channelId}`,
    expect.objectContaining({
      method: 'GET',
      redirect: 'error',
      headers: { Authorization: 'Bot private-bot-token', 'Content-Type': 'application/json' },
    }),
  );
  expect(transport).toHaveBeenCalledWith(
    `https://discord.com/api/v10/channels/${input.channelId}/permissions/member/${input.botUserId}`,
    expect.objectContaining({ method: 'GET', body: undefined }),
  );
});
it.each([
  [{ ...channel, type: 11 }, permissions],
  [{ ...channel, type: 1 }, permissions],
  [{ ...channel, guild_id: '999999999999999999' }, permissions],
  [{ ...channel, id: '999999999999999999' }, permissions],
  [{ ...channel, flags: 1 << 17 }, permissions],
  [channel, '2048'],
] as const)(
  'refuses unsupported destinations or missing current permissions',
  async (value, bits) => {
    expect(await fixture(value, bits).client.inspectGuildTextSource(input)).toBeNull();
  },
);
it.each([403, 404])(
  'treats HTTP%s as unavailable without disclosing provider details',
  async (status) => {
    const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(async () =>
      Response.json({ message: 'private-provider-body' }, { status }),
    );
    expect(await new DiscordClient(options, transport).inspectGuildTextSource(input)).toBeNull();
    expect(transport).toHaveBeenCalledTimes(2);
  },
);
it('propagates authentication failure and rate limits instead of silently consuming the message', async () => {
  const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(async () =>
    Response.json({ message: 'private-provider-body' }, { status: 401 }),
  );
  const client = new DiscordClient(options, transport);
  await expect(client.inspectGuildTextSource(input)).rejects.toMatchObject({
    outcome: 'permanent',
    status: 401,
    message: 'Discord operation was not confirmed',
  });
  transport.mockImplementation(
    async () => new Response('{', { status: 429, headers: { 'Retry-After': '60' } }),
  );
  await expect(client.inspectGuildTextSource(input)).rejects.toMatchObject({
    outcome: 'retryable',
    retryAfterMs: 60000,
  });
  expect(transport).toHaveBeenCalledTimes(4);
});

const actorInput = { ...input, authorId: '567890123456789012' };
function actorFixture({
  bits = '1024',
  member = { user: { id: actorInput.authorId } },
  status = 200,
} = {}) {
  const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === `/api/v10/guilds/${input.guildId}/members/${actorInput.authorId}`)
      return Response.json(member, { status });
    if (path.endsWith(`/member/${actorInput.authorId}`))
      return Response.json({ permissions: bits });
    if (path.endsWith(`/member/${input.botUserId}`)) return Response.json({ permissions });
    return Response.json(channel);
  });
  return { client: new DiscordClient(options, transport), transport };
}
it('proves current human guild membership and effective actor visibility independently of bot access', async () => {
  const { client, transport } = actorFixture();
  expect(await client.inspectGuildTextActorSource(actorInput)).toEqual({
    kind: 'guild_text',
    ...input,
    permissions,
    authorId: actorInput.authorId,
    authorMember: true,
    authorPermissions: '1024',
  });
  expect(transport).toHaveBeenCalledTimes(4);
  expect(transport).toHaveBeenCalledWith(
    `https://discord.com/api/v10/guilds/${input.guildId}/members/${actorInput.authorId}`,
    expect.objectContaining({ method: 'GET', redirect: 'error' }),
  );
  expect(
    await actorFixture({ bits: '8' }).client.inspectGuildTextActorSource(actorInput),
  ).not.toBeNull();
});
it.each([403, 404])('refuses a departed or inaccessible guild member (HTTP%s)', async (status) => {
  expect(await actorFixture({ status }).client.inspectGuildTextActorSource(actorInput)).toBeNull();
});
it('refuses actors without View Channel and bot/system identities', async () => {
  expect(
    await actorFixture({ bits: '2048' }).client.inspectGuildTextActorSource(actorInput),
  ).toBeNull();
  for (const flags of [{ bot: true }, { system: true }]) {
    const transport: typeof fetch = async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.includes('/members/'))
        return Response.json({ user: { id: actorInput.authorId, ...flags } });
      if (path.includes('/permissions/member/')) return Response.json({ permissions });
      return Response.json(channel);
    };
    expect(
      await new DiscordClient(options, transport).inspectGuildTextActorSource(actorInput),
    ).toBeNull();
  }
  const own = actorFixture();
  expect(
    await own.client.inspectGuildTextActorSource({ ...actorInput, authorId: input.botUserId }),
  ).toBeNull();
  expect(own.transport).not.toHaveBeenCalled();
});
it('does not convert malformed membership or operational failures into durable permission denials', async () => {
  await expect(
    actorFixture({ member: { user: { id: input.botUserId } } }).client.inspectGuildTextActorSource(
      actorInput,
    ),
  ).rejects.toMatchObject({ outcome: 'unknown', message: 'Discord operation was not confirmed' });
  await expect(
    actorFixture({ status: 503 }).client.inspectGuildTextActorSource(actorInput),
  ).rejects.toMatchObject({ outcome: 'unknown', message: 'Discord operation was not confirmed' });
});

describe('bot permission observation', () => {
  type Seen = Extract<DiscordApplicationObservation, { type: 'permission' }>;
  const watch = (transport: typeof fetch) => {
    const observed: Seen[] = [];
    const client = new DiscordClient(
      { ...options, observe: (observation) => observed.push(observation) },
      transport,
    );
    return { client, observed };
  };
  const answer =
    (
      member: (path: string) => Response,
      other: (path: string) => Response = () => Response.json(channel),
    ) =>
    async (url: Parameters<typeof fetch>[0]) => {
      const path = new URL(String(url)).pathname;
      return path.includes('/permissions/member/') ? member(path) : other(path);
    };

  it('reports a usable bot inspection as ok, once', async () => {
    const f = watch(answer(() => Response.json({ permissions })));
    expect(await f.client.inspectGuildTextSource(input)).not.toBeNull();
    expect(f.observed).toEqual([{ type: 'permission', outcome: 'ok' }]);
  });

  it.each([
    ['missing permission bits', () => Response.json({ permissions: '2048' }), undefined],
    ['a refused permission read', () => Response.json({}, { status: 403 }), undefined],
    [
      'a refused channel read',
      () => Response.json({ permissions }),
      () => Response.json({}, { status: 403 }),
    ],
  ] as const)('reports %s as denied, once', async (_name, member, other) => {
    const f = watch(answer(member, other));
    expect(await f.client.inspectGuildTextSource(input)).toBeNull();
    expect(f.observed).toEqual([{ type: 'permission', outcome: 'denied' }]);
  });

  it.each([
    [
      'a missing channel or member',
      () => Response.json({}, { status: 404 }),
      () => Response.json({}, { status: 404 }),
    ],
    [
      'a thread',
      () => Response.json({ permissions }),
      () => Response.json({ ...channel, type: 11 }),
    ],
    [
      'another guild',
      () => Response.json({ permissions }),
      () => Response.json({ ...channel, guild_id: '999999999999999999' }),
    ],
    [
      'a hidden channel',
      () => Response.json({ permissions }),
      () => Response.json({ ...channel, flags: 1 << 17 }),
    ],
  ] as const)(
    'reports nothing for %s, which says nothing about permissions',
    async (_name, member, other) => {
      const f = watch(answer(member, other));
      expect(await f.client.inspectGuildTextSource(input)).toBeNull();
      expect(f.observed).toEqual([]);
    },
  );

  it.each([401, 429, 503])(
    'reports nothing when HTTP %s makes the answer unknown',
    async (status) => {
      const f = watch(
        answer(
          () => Response.json({}, { status }),
          () => Response.json({}, { status }),
        ),
      );
      await expect(f.client.inspectGuildTextSource(input)).rejects.toBeDefined();
      const network = watch(async () => {
        throw new Error('private transport detail');
      });
      await expect(network.client.inspectGuildTextSource(input)).rejects.toBeDefined();
      expect([...f.observed, ...network.observed]).toEqual([]);
    },
  );

  it('never reports the actor, whatever the actor can see', async () => {
    const actor = (bits: string, member: Response) => (path: string) =>
      path.endsWith(`/member/${actorInput.authorId}`)
        ? Response.json({ permissions: bits })
        : member;
    const run = async (bits: string, status: number) => {
      const f = watch(
        answer(
          (path) =>
            path.endsWith(`/member/${actorInput.authorId}`)
              ? Response.json({ permissions: bits })
              : Response.json({ permissions }),
          (path) =>
            path.includes('/members/')
              ? Response.json({ user: { id: actorInput.authorId } }, { status })
              : Response.json(channel),
        ),
      );
      await f.client.inspectGuildTextActorSource(actorInput).catch(() => undefined);
      return f.observed;
    };
    void actor;
    for (const [bits, status] of [
      ['1024', 200],
      ['2048', 200],
      ['0', 200],
      ['1024', 403],
      ['1024', 404],
    ] as const)
      expect(await run(bits, status)).toEqual([{ type: 'permission', outcome: 'ok' }]);
    const botDenied = watch(
      answer(
        (path) =>
          path.endsWith(`/member/${actorInput.authorId}`)
            ? Response.json({ permissions: '1024' })
            : Response.json({}, { status: 403 }),
        () => Response.json(channel),
      ),
    );
    expect(await botDenied.client.inspectGuildTextActorSource(actorInput)).toBeNull();
    expect(botDenied.observed).toEqual([{ type: 'permission', outcome: 'denied' }]);
  });

  it('keeps the existing answer when the observer throws', async () => {
    const client = new DiscordClient(
      {
        ...options,
        observe: () => {
          throw new Error('sink unavailable');
        },
      },
      answer(() => Response.json({ permissions })),
    );
    expect(await client.inspectGuildTextSource(input)).toMatchObject({ kind: 'guild_text' });
  });

  it('carries only the closed outcome', async () => {
    const f = watch(answer(() => Response.json({ permissions })));
    await f.client.inspectGuildTextSource(input);
    expect(JSON.stringify(f.observed)).toBe('[{"type":"permission","outcome":"ok"}]');
  });
});
