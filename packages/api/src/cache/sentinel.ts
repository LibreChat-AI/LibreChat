import tls from 'tls';
import net from 'net';

/** Sentinel node address (host + port). */
export interface SentinelNode {
  host: string;
  port: number;
}

/** Discovered master address returned by Sentinel. */
export interface DiscoveredMaster {
  host: string;
  port: number;
}

/**
 * Parse a comma-separated list of `host:port` Sentinel addresses.
 * Throws on empty input or malformed entries so the process fails fast at
 * startup rather than silently falling back to a broken connection.
 *
 * @example
 * parseSentinelHosts('redis-s-0:26379,redis-s-1:26389')
 * // → [{ host: 'redis-s-0', port: 26379 }, { host: 'redis-s-1', port: 26389 }]
 */
export function parseSentinelHosts(value: string | undefined): SentinelNode[] {
  if (!value || value.trim() === '') {
    throw new Error('REDIS_SENTINEL_HOSTS is not set or empty.');
  }
  const nodes = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry): SentinelNode => {
      const lastColon = entry.lastIndexOf(':');
      if (lastColon === -1) {
        throw new Error(`Invalid Sentinel host '${entry}': expected host:port.`);
      }
      const host = entry.substring(0, lastColon);
      const port = parseInt(entry.substring(lastColon + 1), 10);
      if (!host || Number.isNaN(port) || port <= 0 || port > 65535) {
        throw new Error(`Invalid Sentinel host '${entry}': expected host:port with valid port.`);
      }
      return { host, port };
    });
  if (nodes.length === 0) {
    throw new Error('REDIS_SENTINEL_HOSTS contains no valid entries.');
  }
  return nodes;
}

// ─── RESP protocol (minimal: only what AUTH and SENTINEL MASTER return) ───

/** RESP type prefix bytes: `+` simple string, `-` error, `$` bulk string, `*` array. */
const RESP_SIMPLE_STRING = '+'.charCodeAt(0);
const RESP_ERROR = '-'.charCodeAt(0);
const RESP_BULK_STRING = '$'.charCodeAt(0);
const RESP_ARRAY = '*'.charCodeAt(0);

/** RESP line terminator. */
const CRLF = '\r\n';
const CRLF_LENGTH = CRLF.length;

/**
 * The reply shapes Sentinel returns for the commands LibreChat sends:
 * `+OK` simple strings (AUTH), `-ERR` error lines, `$n` bulk strings (and
 * `$-1` nils), and flat `*n` arrays of bulk strings (SENTINEL MASTER).
 * Responds do not contain integers or nested arrays, so they are not in the
 * value domain — an unexpected byte fails the parse with a clear error.
 */
type RespValue = string | null | Error | RespValue[];

/** A complete value read from a buffer, plus the offset just past it. */
interface RespReply {
  value: RespValue;
  next: number;
}

/** A `<digits>\r\n` length line read from a buffer, plus the offset just past it. */
interface RespLine {
  int: number;
  next: number;
}

/** Encode a RESP array-of-bulk-strings command. */
function encodeCommand(args: string[]): string {
  const encodedArgs = args.map((arg) => `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`);
  return `*${args.length}\r\n${encodedArgs.join('')}`;
}

/**
 * Reads a `<digits>\r\n` line — the `n` in a `$n` or `*n` header — starting at
 * `offset` (the first byte after the type prefix). Returns null while the
 * line is incomplete; throws when the line is complete but not numeric,
 * because that only happens with a malformed upstream reply.
 */
function readIntLine(data: Buffer, offset: number): RespLine | null {
  const end = data.indexOf(CRLF, offset);
  if (end === -1) {
    return null;
  }
  const int = parseInt(data.subarray(offset, end).toString(), 10);
  if (Number.isNaN(int)) {
    throw new Error(`Malformed RESP length line at offset ${offset}`);
  }
  return { int, next: end + CRLF_LENGTH };
}

/**
 * Read one complete RESP value from `data` starting at `offset`.
 * Returns null while the buffer does not yet contain a complete value;
 * throws on malformed input (non-numeric length lines, unknown type bytes).
 */
function parseReply(data: Buffer, offset: number): RespReply | null {
  if (offset >= data.length) {
    return null;
  }
  const type = data[offset];

  if (type === RESP_SIMPLE_STRING || type === RESP_ERROR) {
    const end = data.indexOf(CRLF, offset);
    if (end === -1) {
      return null;
    }
    const text = data.subarray(offset + 1, end).toString();
    return {
      value: type === RESP_ERROR ? new Error(text) : text,
      next: end + CRLF_LENGTH,
    };
  }

  if (type === RESP_BULK_STRING) {
    const header = readIntLine(data, offset + 1);
    if (header === null) {
      return null;
    }
    const { int: length, next: bodyStart } = header;
    if (length === -1) {
      return { value: null, next: bodyStart };
    }
    const end = bodyStart + length;
    if (end + CRLF_LENGTH > data.length) {
      return null;
    }
    return {
      value: data.subarray(bodyStart, end).toString(),
      next: end + CRLF_LENGTH,
    };
  }

  if (type === RESP_ARRAY) {
    const header = readIntLine(data, offset + 1);
    if (header === null) {
      return null;
    }
    const { int: count, next: first } = header;
    if (count === -1) {
      return { value: null, next: first };
    }
    const items: RespValue[] = [];
    let cursor = first;
    for (let i = 0; i < count; i++) {
      const item = parseReply(data, cursor);
      if (item === null) {
        return null;
      }
      items.push(item.value);
      cursor = item.next;
    }
    return { value: items, next: cursor };
  }

  throw new Error(`Unsupported RESP type byte ${type} at offset ${offset}`);
}

/** Safe error message extraction without unsafe casts. */
function errorToMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

/**
 * Write a RESP command to the socket and resolve with the first complete
 * reply. RESP error replies (`-ERR ...`) reject with the server's error;
 * malformed replies and socket errors reject as well. Listeners are detached
 * once settled, so it is safe to call sequentially (AUTH then SENTINEL).
 */
function sendCommand(socket: net.Socket, args: string[]): Promise<RespValue> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const detach = () => {
      socket.off('data', onData);
      socket.off('error', onError);
    };
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const reply = parseReply(buf, 0);
      if (reply === null) {
        return; // incomplete; wait for more chunks
      }
      detach();
      const { value } = reply;
      if (value instanceof Error) {
        reject(value);
      } else {
        resolve(value);
      }
    };
    const onError = (err: Error) => {
      detach();
      reject(err);
    };
    socket.on('data', onData);
    socket.on('error', onError);
    socket.write(encodeCommand(args));
  });
}

/** Authenticate to a Sentinel node with the given password. */
async function authenticate(socket: net.Socket, password: string): Promise<void> {
  const reply = await sendCommand(socket, ['AUTH', password]).catch((err: Error) => {
    throw new Error(`Sentinel AUTH failed: ${err.message}`);
  });
  if (reply === null) {
    throw new Error('Sentinel AUTH failed: nil reply');
  }
}

/**
 * Extract the master ip/port pair from a `SENTINEL MASTER <name>` reply.
 *
 * The reply is a flat array of key/value pairs: `[name, value, ip, host, port, port]`.
 * @throws when the reply is not an array or does not contain a valid ip/port.
 */
function parseSentinelMasterReply(reply: RespValue, masterName: string): DiscoveredMaster {
  if (!Array.isArray(reply)) {
    throw new Error(`Unexpected Sentinel reply: ${JSON.stringify(reply)}`);
  }
  let host: string | undefined;
  let port: number | undefined;
  for (let i = 0; i + 1 < reply.length; i += 2) {
    const key = reply[i];
    const value = reply[i + 1];
    if (key === 'ip' && typeof value === 'string') host = value;
    if (key === 'port' && typeof value === 'string') port = parseInt(value, 10);
  }
  if (host === undefined || port === undefined || Number.isNaN(port)) {
    throw new Error(`Sentinel reply did not contain ip/port for master '${masterName}'`);
  }
  return { host, port };
}

// ─── Sentinel query options and socket creation ───

/** TLS/mTLS options common to every Sentinel query. */
export interface SentinelQueryOptions {
  /** Password for Sentinel AUTH (if Sentinel requires auth) */
  password?: string;
  /** Use TLS for Sentinel connections */
  useTls?: boolean;
  /** PEM-encoded CA certificates for Sentinel connections */
  ca?: string;
  /** Client certificate (PEM) for mTLS — requires `key` */
  cert?: string;
  /** Client key (PEM) for mTLS — requires `cert` */
  key?: string;
  /** Allow self-signed certificates (defaults to `false`) */
  rejectUnauthorized?: boolean;
  /** Timeout per Sentinel node in milliseconds (defaults to 5000) */
  timeoutMs?: number;
}

/** Build a TLS or plain TCP socket to a Sentinel node. */
function createSentinelSocket(
  node: SentinelNode,
  options: Required<Pick<SentinelQueryOptions, 'useTls' | 'rejectUnauthorized'>> &
    SentinelQueryOptions,
): net.Socket {
  const { useTls, rejectUnauthorized, ca, cert, key } = options;
  if (useTls) {
    return tls.connect({
      host: node.host,
      port: node.port,
      ca: ca ? [ca] : undefined,
      // Opt-in mTLS: cert + key are sent when both are provided.
      cert,
      key,
      rejectUnauthorized,
    });
  }
  return net.connect({ host: node.host, port: node.port });
}

/**
 * Query a single Sentinel node for the current master address of the given
 * master group. The returned promise is guarded by a settle-once closure:
 * whichever of the timeout, socket error, or reply events arrives first wins,
 * and the socket is always cleaned up exactly once.
 */
export function querySentinelMaster(
  node: SentinelNode,
  masterName: string,
  options?: SentinelQueryOptions,
): Promise<DiscoveredMaster> {
  const {
    password,
    useTls = false,
    ca,
    cert,
    key,
    rejectUnauthorized = false,
    timeoutMs = 5000,
  } = options ?? {};
  return new Promise<DiscoveredMaster>((resolve, reject) => {
    const socket = createSentinelSocket(node, { useTls, rejectUnauthorized, ca, cert, key });
    let settled = false;

    const timer = setTimeout(
      () =>
        settle(() =>
          reject(
            new Error(
              `Sentinel query timed out after ${timeoutMs}ms for ${node.host}:${node.port}`,
            ),
          ),
        ),
      timeoutMs,
    );

    /** Run exactly once: clears the timeout, tears down the socket, finishes. */
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      finish();
    };

    socket.on('error', (err) => {
      settle(() =>
        reject(
          new Error(`Sentinel connection to ${node.host}:${node.port} failed: ${err.message}`),
        ),
      );
    });

    socket.on('connect', () => {
      void (async () => {
        try {
          if (password) {
            await authenticate(socket, password);
          }
          // Compute the result BEFORE settling: if parsing throws, the catch
          // below still needs to settle the promise (a throw inside settle's
          // finish callback would otherwise deadlock the promise).
          const reply = await sendCommand(socket, ['SENTINEL', 'MASTER', masterName]).catch(
            (err: Error) => {
              throw new Error(`Sentinel error: ${err.message}`);
            },
          );
          const master = parseSentinelMasterReply(reply, masterName);
          settle(() => resolve(master));
        } catch (err) {
          settle(() => reject(err));
        }
      })();
    });
  });
}

/**
 * Discover the current master by querying Sentinel nodes in order.
 * Tries each node until one responds with a valid master address.
 */
export async function discoverSentinelMaster(
  nodes: SentinelNode[],
  masterName: string,
  options?: SentinelQueryOptions,
): Promise<DiscoveredMaster> {
  const errors: string[] = [];
  for (const node of nodes) {
    try {
      const master = await querySentinelMaster(node, masterName, options);
      console.info(
        `[sentinel] discovered master ${master.host}:${master.port} for '${masterName}' via ${node.host}:${node.port}`,
      );
      return master;
    } catch (err) {
      errors.push(`${node.host}:${node.port}: ${errorToMessage(err)}`);
    }
  }
  throw new Error(
    `Failed to discover master '${masterName}' from any Sentinel node:\n${errors.join('\n')}`,
  );
}
