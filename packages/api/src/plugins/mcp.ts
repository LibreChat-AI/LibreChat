import path from 'path';
import { normalizeServerName } from 'librechat-data-provider';
import type { PluginDiagnostic, PluginMcpOptions, PluginMcpServer } from './types';
import {
  PLUGIN_MCP_FILE,
  PLUGIN_DATA_VAR,
  PLUGIN_ROOT_VAR,
  PLUGIN_MCP_SCHEMA_ID,
} from './constants';
import { isPluginRelativePath, isWithinRoot, realpathAllowingMissing } from './paths';
import { MCP_PLUGIN_SOURCE } from '~/utils/env';

const PLACEHOLDER_PATTERN = /\$\{(PLUGIN_ROOT|PLUGIN_DATA)\}/g;
const SCHEMA_VERSION_PATTERN = /\/schemas\/(\d+\.\d+\.\d+)\//;
const HTTP_TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** RFC 7230 field-value: visible ASCII, space, horizontal tab, and obs-text. CR, LF, and NUL are rejected. */
const HTTP_FIELD_VALUE_PATTERN = /^[\t\x20-\x7e\x80-\xff]*$/;
const LOOPBACK_IPV4_PATTERN = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

const SUPPORTED_TRANSPORTS = new Set(['stdio', 'streamable-http', 'sse']);

const STDIO_FIELDS = new Set(['type', 'command', 'args', 'env', 'cwd']);
const REMOTE_FIELDS = new Set(['type', 'url', 'headers']);

/**
 * Server names become keys on plain configuration objects downstream. These
 * survive tool-name normalization unchanged, so they are refused here to keep a
 * package from reaching a prototype setter.
 */
const RESERVED_SERVER_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

export interface PluginMcpContext {
  /** Filesystem-resolved plugin root. */
  realRoot: string;
  /** Filesystem-resolved persistent data directory for this plugin instance. */
  dataDirectory: string;
  /** Agent Plugins version declared by `plugin.json`. */
  declaredVersion: string;
}

export interface PluginMcpResult {
  servers: PluginMcpServer[];
  diagnostics: PluginDiagnostic[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Agent Plugins §9.2: one non-recursive pass replacing every exact occurrence.
 * A function replacement keeps `$`-bearing paths literal and prevents text
 * introduced by a replacement from being rescanned.
 */
export function expandPluginVariables(value: string, root: string, data: string): string {
  return value.replace(PLACEHOLDER_PATTERN, (_match, name: string) =>
    name === PLUGIN_ROOT_VAR ? root : data,
  );
}

export function schemaVersion(schemaId: string): string | undefined {
  return SCHEMA_VERSION_PATTERN.exec(schemaId)?.[1];
}

function serverLocation(name: string): string {
  return `${PLUGIN_MCP_FILE}#/mcpServers/${name}`;
}

function invalidServer(name: string, message: string): PluginDiagnostic {
  return {
    code: 'mcp_server_invalid',
    severity: 'warning',
    message,
    location: serverLocation(name),
  };
}

function hasForeignFields(server: Record<string, unknown>, allowed: Set<string>): string | null {
  for (const key of Object.keys(server)) {
    if (!allowed.has(key)) {
      return key;
    }
  }
  return null;
}

function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.every((entry) => typeof entry === 'string') ? (value as string[]) : null;
}

function readStringRecord(value: unknown): Record<string, string> | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      return null;
    }
    record[key] = entry;
  }
  return record;
}

/**
 * §7.2.1: `command` is a single executable token — a bare name resolved by the
 * platform, or a plugin-relative path. Shell strings and absolute paths are
 * rejected, and no placeholder expansion applies.
 */
async function resolveCommand(
  command: string,
  realRoot: string,
): Promise<{ command: string } | { error: string }> {
  if (isPluginRelativePath(command)) {
    const resolved = await realpathAllowingMissing(path.resolve(realRoot, command));
    if (!isWithinRoot(realRoot, resolved)) {
      return { error: `"command" resolves outside the plugin root: ${command}` };
    }
    return { command: resolved };
  }
  if (/[\\/]/.test(command)) {
    return {
      error: `"command" must be a bare executable name or a "./" plugin-relative path: ${command}`,
    };
  }
  if (/\s/.test(command)) {
    return { error: `"command" must be a single executable token, not a shell string: ${command}` };
  }
  return { command };
}

/**
 * §7.2.1: an explicit `cwd` is plugin-relative, `${PLUGIN_ROOT}`-rooted, or
 * `${PLUGIN_DATA}`-rooted, and must stay inside whichever base it names.
 */
async function resolveCwd(
  cwd: string,
  context: PluginMcpContext,
): Promise<{ cwd: string } | { error: string }> {
  const { realRoot, dataDirectory } = context;
  const rootedInData =
    cwd === `\${${PLUGIN_DATA_VAR}}` || cwd.startsWith(`\${${PLUGIN_DATA_VAR}}/`);
  const rootedInRoot =
    cwd === `\${${PLUGIN_ROOT_VAR}}` || cwd.startsWith(`\${${PLUGIN_ROOT_VAR}}/`);

  if (!rootedInData && !rootedInRoot && !isPluginRelativePath(cwd)) {
    return {
      error: `"cwd" must begin with "./", "\${${PLUGIN_ROOT_VAR}}", or "\${${PLUGIN_DATA_VAR}}": ${cwd}`,
    };
  }

  const expanded = expandPluginVariables(cwd, realRoot, dataDirectory);
  const base = rootedInData ? dataDirectory : realRoot;
  const resolved = await realpathAllowingMissing(path.resolve(base, expanded));
  if (!isWithinRoot(base, resolved)) {
    return { error: `"cwd" resolves outside ${rootedInData ? 'PLUGIN_DATA' : 'the plugin root'}` };
  }
  return { cwd: resolved };
}

function validateHeaders(headers: Record<string, string>): string | null {
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    if (!HTTP_TOKEN_PATTERN.test(name)) {
      return `"${name}" is not a valid HTTP header name`;
    }
    const lowered = name.toLowerCase();
    if (seen.has(lowered)) {
      return `"${name}" is declared more than once under different casing`;
    }
    seen.add(lowered);
    if (!HTTP_FIELD_VALUE_PATTERN.test(value)) {
      return `the value of "${name}" is not a valid HTTP header value`;
    }
  }
  return null;
}

function isLoopbackHost(hostname: string): boolean {
  if (hostname === 'localhost') {
    return true;
  }
  const literal = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
  return literal === '::1' || LOOPBACK_IPV4_PATTERN.test(literal);
}

/** §7.2.1: absolute http(s), no userinfo, no fragment, HTTPS off the loopback. */
function validateUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `"url" must be an absolute URL: ${raw}`;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `"url" must use http or https: ${raw}`;
  }
  if (url.username !== '' || url.password !== '') {
    return '"url" must not contain user information';
  }
  if (url.hash !== '') {
    return '"url" must not contain a fragment';
  }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    return '"url" must use https for non-loopback hosts';
  }
  return null;
}

async function readStdioServer(
  name: string,
  server: Record<string, unknown>,
  context: PluginMcpContext,
): Promise<{ options: PluginMcpOptions } | { error: PluginDiagnostic }> {
  const foreign = hasForeignFields(server, STDIO_FIELDS);
  if (foreign !== null) {
    return { error: invalidServer(name, `"${foreign}" is not a valid stdio server field`) };
  }
  if (typeof server.command !== 'string' || server.command.length === 0) {
    return { error: invalidServer(name, 'stdio servers require a "command" string') };
  }

  const rawArgs = server.args === undefined ? [] : readStringArray(server.args);
  if (rawArgs === null) {
    return { error: invalidServer(name, '"args" must be an array of strings') };
  }

  const rawEnv = server.env === undefined ? {} : readStringRecord(server.env);
  if (rawEnv === null) {
    return { error: invalidServer(name, '"env" must be an object of strings') };
  }
  for (const key of Object.keys(rawEnv)) {
    if (key === PLUGIN_ROOT_VAR || key === PLUGIN_DATA_VAR) {
      return {
        error: invalidServer(name, `"env" must not declare the reserved variable "${key}"`),
      };
    }
  }

  const resolvedCommand = await resolveCommand(server.command, context.realRoot);
  if ('error' in resolvedCommand) {
    return { error: invalidServer(name, resolvedCommand.error) };
  }

  let cwd = context.realRoot;
  if (server.cwd !== undefined) {
    if (typeof server.cwd !== 'string') {
      return { error: invalidServer(name, '"cwd" must be a string') };
    }
    const resolvedCwd = await resolveCwd(server.cwd, context);
    if ('error' in resolvedCwd) {
      return { error: invalidServer(name, resolvedCwd.error) };
    }
    cwd = resolvedCwd.cwd;
  }

  const { realRoot, dataDirectory } = context;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawEnv)) {
    env[key] = expandPluginVariables(value, realRoot, dataDirectory);
  }
  env[PLUGIN_ROOT_VAR] = realRoot;
  env[PLUGIN_DATA_VAR] = dataDirectory;

  return {
    options: {
      source: MCP_PLUGIN_SOURCE,
      type: 'stdio',
      command: resolvedCommand.command,
      args: rawArgs.map((arg) => expandPluginVariables(arg, realRoot, dataDirectory)),
      env,
      cwd,
    },
  };
}

function readRemoteServer(
  name: string,
  type: 'streamable-http' | 'sse',
  server: Record<string, unknown>,
): { options: PluginMcpOptions } | { error: PluginDiagnostic } {
  const foreign = hasForeignFields(server, REMOTE_FIELDS);
  if (foreign !== null) {
    return { error: invalidServer(name, `"${foreign}" is not a valid ${type} server field`) };
  }
  if (typeof server.url !== 'string' || server.url.length === 0) {
    return { error: invalidServer(name, `${type} servers require a "url" string`) };
  }
  const urlError = validateUrl(server.url);
  if (urlError !== null) {
    return { error: invalidServer(name, urlError) };
  }

  let headers: Record<string, string> | undefined;
  if (server.headers !== undefined) {
    const parsed = readStringRecord(server.headers);
    if (parsed === null) {
      return { error: invalidServer(name, '"headers" must be an object of strings') };
    }
    const headerError = validateHeaders(parsed);
    if (headerError !== null) {
      return { error: invalidServer(name, headerError) };
    }
    headers = parsed;
  }

  return {
    options: {
      source: MCP_PLUGIN_SOURCE,
      type,
      url: server.url,
      ...(headers !== undefined && { headers }),
    },
  };
}

async function readServer(
  name: string,
  value: unknown,
  context: PluginMcpContext,
): Promise<{ options: PluginMcpOptions } | { error: PluginDiagnostic }> {
  if (!isPlainObject(value)) {
    return { error: invalidServer(name, 'server configuration must be an object') };
  }
  const type = value.type;
  if (typeof type !== 'string') {
    return { error: invalidServer(name, 'server configuration requires a "type" field') };
  }
  if (!SUPPORTED_TRANSPORTS.has(type)) {
    return { error: invalidServer(name, `"${type}" is not a recognized transport`) };
  }
  if (type === 'stdio') {
    return readStdioServer(name, value, context);
  }
  return readRemoteServer(name, type as 'streamable-http' | 'sse', value);
}

/**
 * Validates a parsed `mcp.json` and maps each conforming server onto LibreChat
 * MCP options. A malformed document disables MCP for the plugin; a malformed
 * entry skips only that server (§7.2.2).
 */
export async function readMcpConfig(
  document: unknown,
  context: PluginMcpContext,
): Promise<PluginMcpResult> {
  const diagnostics: PluginDiagnostic[] = [];
  const disable = (message: string): PluginMcpResult => ({
    servers: [],
    diagnostics: [
      ...diagnostics,
      { code: 'mcp_invalid', severity: 'warning', message, location: PLUGIN_MCP_FILE },
    ],
  });

  if (!isPlainObject(document)) {
    return disable('mcp.json must contain a top-level JSON object');
  }

  const foreign = hasForeignFields(document, new Set(['$schema', 'mcpServers']));
  if (foreign !== null) {
    return disable(`"${foreign}" is not a valid mcp.json field`);
  }

  const schemaId = document.$schema;
  if (typeof schemaId !== 'string' || schemaId.length === 0) {
    return disable('mcp.json is missing the required "$schema" field');
  }
  if (schemaId !== PLUGIN_MCP_SCHEMA_ID) {
    return disable(
      `Unsupported Agent Plugins MCP schema "${schemaId}"; this client implements ${PLUGIN_MCP_SCHEMA_ID}`,
    );
  }
  const declared = schemaVersion(schemaId);
  if (declared !== context.declaredVersion) {
    return {
      servers: [],
      diagnostics: [
        ...diagnostics,
        {
          code: 'mcp_version_mismatch',
          severity: 'warning',
          message: `mcp.json targets Agent Plugins ${declared} but plugin.json targets ${context.declaredVersion}`,
          location: PLUGIN_MCP_FILE,
        },
      ],
    };
  }

  if (!isPlainObject(document.mcpServers)) {
    return disable('"mcpServers" must be an object');
  }

  const servers: PluginMcpServer[] = [];
  for (const [name, value] of Object.entries(document.mcpServers)) {
    /**
     * Tool keys embed `normalizeServerName(name)` while request-time resolution
     * looks the server up by its raw name. A name that changes under
     * normalization publishes tools nothing can resolve, so it is rejected here
     * rather than failing silently at request time.
     */
    if (RESERVED_SERVER_NAMES.has(name)) {
      diagnostics.push(invalidServer(name, `"${name}" is a reserved MCP server name`));
      continue;
    }
    if (normalizeServerName(name) !== name) {
      diagnostics.push(
        invalidServer(
          name,
          `"${name}" is not a stable MCP server name; use only the characters preserved by tool naming (it would become "${normalizeServerName(name)}")`,
        ),
      );
      continue;
    }
    const result = await readServer(name, value, context);
    if ('error' in result) {
      diagnostics.push(result.error);
      continue;
    }
    servers.push({ name, options: result.options });
  }

  return { servers, diagnostics };
}
