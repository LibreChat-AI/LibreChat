import net from 'node:net';
import type { AddressInfo, Socket } from 'node:net';

/**
 * Minimal RESP2 server standing in for a Redis node whose role can be flipped
 * between master and demoted replica. Real node-redis and ioredis clients speak
 * to it over TCP, which is what a READONLY failover scenario needs: the socket
 * stays open and healthy while every write is rejected.
 */
export type RespServer = {
  url: string;
  port: number;
  /** Total sockets accepted since start; a reconnect shows up as a new one. */
  connections: number;
  /** When true, write commands are rejected with the READONLY reply. */
  readonly: boolean;
  /** When true, frames are recorded but never answered: a peer that has silently gone away. */
  silent: boolean;
  commands: string[][];
  close(): Promise<void>;
};

const READONLY_REPLY = "-READONLY You can't write against a read only replica.\r\n";
const WRITE_COMMANDS = new Set(['SET', 'DEL', 'UNLINK', 'EVAL', 'EVALSHA', 'INCR', 'EXPIRE']);

function encodeBulk(value: string | null): string {
  return value == null ? '$-1\r\n' : `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

function encodeScan(store: Map<string, string>, args: string[]): string {
  const matchIndex = args.findIndex((arg) => arg.toUpperCase() === 'MATCH');
  const matcher = matchIndex === -1 ? /^/ : globToRegExp(args[matchIndex + 1]);
  const keys = [...store.keys()].filter((key) => matcher.test(key));
  return `*2\r\n$1\r\n0\r\n*${keys.length}\r\n${keys.map(encodeBulk).join('')}`;
}

function parseFrames(buffer: Buffer): { frames: string[][]; rest: Buffer } {
  const frames: string[][] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0x2a) {
      break;
    }
    const headerEnd = buffer.indexOf('\r\n', offset);
    if (headerEnd === -1) {
      break;
    }
    const count = Number(buffer.subarray(offset + 1, headerEnd).toString());
    let cursor = headerEnd + 2;
    const args: string[] = [];
    let complete = true;
    for (let i = 0; i < count; i++) {
      const lengthEnd = buffer.indexOf('\r\n', cursor);
      if (lengthEnd === -1 || buffer[cursor] !== 0x24) {
        complete = false;
        break;
      }
      const length = Number(buffer.subarray(cursor + 1, lengthEnd).toString());
      const valueStart = lengthEnd + 2;
      const valueEnd = valueStart + length;
      if (buffer.length < valueEnd + 2) {
        complete = false;
        break;
      }
      args.push(buffer.subarray(valueStart, valueEnd).toString());
      cursor = valueEnd + 2;
    }
    if (!complete) {
      break;
    }
    frames.push(args);
    offset = cursor;
  }
  return { frames, rest: buffer.subarray(offset) };
}

export async function startRespServer(port = 0): Promise<RespServer> {
  const store = new Map<string, string>();
  const sockets = new Set<Socket>();
  const state = { connections: 0, readonly: false, silent: false, commands: [] as string[][] };

  const reply = (args: string[]): string => {
    const command = args[0]?.toUpperCase() ?? '';
    if (state.readonly && WRITE_COMMANDS.has(command)) {
      return READONLY_REPLY;
    }
    switch (command) {
      case 'PING':
        return '+PONG\r\n';
      case 'SUBSCRIBE':
        return `*3\r\n$9\r\nsubscribe\r\n${encodeBulk(args[1])}:1\r\n`;
      case 'INFO':
        return encodeBulk('# Server\r\nredis_version:7.2.4\r\nloading:0\r\n');
      case 'GET':
        return encodeBulk(store.get(args[1]) ?? null);
      case 'SET':
        store.set(args[1], args[2]);
        return '+OK\r\n';
      case 'DEL':
      case 'UNLINK':
        return `:${args.slice(1).filter((key) => store.delete(key)).length}\r\n`;
      case 'EVAL':
      case 'EVALSHA':
        return ':1\r\n';
      case 'SCAN':
        return encodeScan(store, args);
      default:
        return '+OK\r\n';
    }
  };

  const server = net.createServer((socket) => {
    state.connections += 1;
    sockets.add(socket);
    let pending: Buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      const { frames, rest } = parseFrames(Buffer.concat([pending, chunk]));
      pending = rest;
      for (const frame of frames) {
        state.commands.push(frame);
        if (!state.silent) {
          socket.write(reply(frame));
        }
      }
    });
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const { port: boundPort } = server.address() as AddressInfo;

  return {
    url: `redis://127.0.0.1:${boundPort}`,
    port: boundPort,
    get connections() {
      return state.connections;
    },
    get readonly() {
      return state.readonly;
    },
    set readonly(value: boolean) {
      state.readonly = value;
    },
    get silent() {
      return state.silent;
    },
    set silent(value: boolean) {
      state.silent = value;
    },
    commands: state.commands,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close(() => resolve());
      }),
  };
}

/** Polls until `predicate` holds, failing after `timeoutMs`. */
export async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
