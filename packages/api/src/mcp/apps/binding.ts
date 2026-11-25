import { createHmac, timingSafeEqual } from 'crypto';
import type { MCPConnectionTarget, MCPOptions } from '../types';
import { getMCPAppToolsPublicationGeneration } from '../toolsChanged';

const BINDING_VERSION = 'v1';
const BINDING_KEY_DOMAIN = 'librechat:mcp-app:server-binding:v1';

export type MCPAppRuntimeTarget =
  | { type: 'stdio'; command: string; args: string[]; cwd: string | null; env: [string, string][] }
  | { type: string; url: string };

export interface MCPAppBindingSubject {
  userId: string;
  tenantId?: string | null;
  serverName: string;
  connectionTarget: MCPConnectionTarget;
  runtimeTarget: MCPAppRuntimeTarget;
}

export interface MCPAppBindingCodec {
  create(subject: MCPAppBindingSubject): string;
  verify(binding: string, subject: MCPAppBindingSubject): boolean;
}

/** Keeps routing identity while excluding live request headers and refreshable credentials. */
export function projectMCPAppRuntimeTarget(config: MCPOptions): MCPAppRuntimeTarget {
  if (config.type === 'stdio') {
    return {
      type: 'stdio',
      command: config.command,
      args: [...config.args],
      cwd: config.cwd ?? null,
      env: Object.entries(config.env ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    };
  }
  return { type: config.type, url: config.url };
}

export function createMCPAppBindingCodec(secret: string): MCPAppBindingCodec {
  if (!secret) {
    throw new Error('JWT_SECRET is required to bind persisted MCP Apps');
  }
  const key = createHmac('sha256', secret).update(BINDING_KEY_DOMAIN).digest();
  const digest = (subject: MCPAppBindingSubject): string => {
    const payload = JSON.stringify({
      userId: subject.userId,
      tenantId: subject.tenantId ?? null,
      serverName: subject.serverName,
      connectionOwner: subject.connectionTarget.connectionOwner,
      configGeneration: getMCPAppToolsPublicationGeneration(subject.connectionTarget.serverConfig),
      runtimeTarget: subject.runtimeTarget,
    });
    return createHmac('sha256', key).update(payload).digest('base64url');
  };
  const create = (subject: MCPAppBindingSubject): string => `${BINDING_VERSION}.${digest(subject)}`;

  return {
    create,
    verify(binding, subject) {
      if (!binding.startsWith(`${BINDING_VERSION}.`)) {
        return false;
      }
      const actual = Buffer.from(binding);
      const expected = Buffer.from(create(subject));
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    },
  };
}
