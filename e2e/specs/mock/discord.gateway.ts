/// <reference lib="es2022" />
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import type { WebSocket } from 'ws';

/** The Gateway intent bits the acceptance reasons about. */
const messageContentIntent = 1 << 15;

export interface DiscordGatewayOptions {
  applicationId: string;
  botUserId: string;
  botToken: string;
  /** Short enough for a scenario to see real heartbeats, long enough not to flood it. */
  heartbeatIntervalMs?: number;
}

export interface DiscordGatewayMessage {
  id: string;
  authorId: string;
  channelId: string;
  guildId?: string;
  content: string;
  /** User IDs the message mentions. A guild message that mentions the bot keeps its content. */
  mentions?: string[];
  /** Makes it a reply. Discord adds the replied-to author to `mentions` when the reply pings. */
  replyToMessageId?: string;
  channelType?: number;
}

export interface DiscordGatewayLifecycle {
  heartbeats: number;
  closes: number[];
  open: number;
}

/**
 * Discord's external Gateway as a local fixture. The SDK under test is the real one: it fetches this
 * fixture's URL from the Gateway REST fixture, then speaks HELLO, IDENTIFY, READY, heartbeats and
 * MESSAGE_CREATE dispatches over a real WebSocket. Only Discord itself is simulated.
 */
export async function createDiscordGateway(options: DiscordGatewayOptions) {
  const interval = options.heartbeatIntervalMs ?? 1000;
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const seen = {
    connections: 0,
    identifies: 0,
    heartbeats: 0,
    closes: [] as number[],
    intents: 0,
    refused: [] as string[],
  };
  let live: WebSocket | undefined;
  let sequence = 0;

  const frame = (socket: WebSocket, payload: object) => socket.send(JSON.stringify(payload));
  server.on('connection', (socket) => {
    seen.connections++;
    live = socket;
    sequence = 0;
    frame(socket, { op: 10, d: { heartbeat_interval: interval } });
    socket.on('message', (raw) => {
      const received = JSON.parse(String(raw)) as { op: number; d?: Record<string, unknown> };
      if (received.op === 1) {
        seen.heartbeats++;
        frame(socket, { op: 11 });
        return;
      }
      if (received.op !== 2) return;
      // A wrong token is what Discord closes with 4004. Anything else is a real session.
      if (received.d?.token !== options.botToken) {
        seen.refused.push('token');
        socket.close(4004);
        return;
      }
      seen.identifies++;
      seen.intents = Number(received.d?.intents ?? 0);
      frame(socket, {
        op: 0,
        t: 'READY',
        s: ++sequence,
        d: {
          v: 10,
          user: { id: options.botUserId, username: 'LibreChat Acceptance', bot: true },
          application: { id: options.applicationId, flags: 0 },
          guilds: [],
          session_id: randomUUID(),
          resume_gateway_url: 'wss://gateway.discord.gg',
          shard: [0, 1],
        },
      });
    });
    socket.on('close', (code) => {
      seen.closes.push(code);
      if (live === socket) live = undefined;
    });
  });

  /**
   * Delivers one MESSAGE_CREATE on the live session. Without the privileged Message Content intent
   * Discord strips the content of every guild message that does not mention the bot, so a policy of
   * `messageContent: false` really delivers an empty string for those.
   */
  function dispatch(message: DiscordGatewayMessage): void {
    if (!live) throw new Error('No live Discord Gateway session to deliver to');
    const mentioned = message.mentions?.includes(options.botUserId) === true;
    const visible =
      message.guildId === undefined || mentioned || (seen.intents & messageContentIntent) !== 0;
    frame(live, {
      op: 0,
      t: 'MESSAGE_CREATE',
      s: ++sequence,
      d: {
        id: message.id,
        channel_id: message.channelId,
        ...(message.guildId ? { guild_id: message.guildId } : {}),
        author: { id: message.authorId, bot: false },
        content: visible ? message.content : '',
        type: message.replyToMessageId ? 19 : 0,
        mentions: (message.mentions ?? []).map((id) => ({
          id,
          bot: id === options.botUserId,
        })),
        ...(message.replyToMessageId
          ? { message_reference: { message_id: message.replyToMessageId } }
          : {}),
        ...(message.channelType === undefined ? {} : { channel_type: message.channelType }),
      },
    });
  }

  return {
    url,
    seen,
    dispatch,
    /** Sockets the fixture still holds open. */
    open: () => server.clients.size,
    lifecycle(): DiscordGatewayLifecycle {
      return {
        heartbeats: seen.heartbeats,
        closes: [...seen.closes],
        open: server.clients.size,
      };
    },
    async close() {
      for (const client of server.clients) client.terminate();
      if (server.address() !== null) await new Promise((resolve) => server.close(resolve));
    },
  };
}

export type DiscordGateway = Awaited<ReturnType<typeof createDiscordGateway>>;
