import { HttpsProxyAgent } from 'https-proxy-agent';
import { Agent, EnvHttpProxyAgent, ProxyAgent } from 'undici';
import type { AxiosRequestConfig, AxiosProxyConfig } from 'axios';
import type { Dispatcher } from 'undici';

export type ProxyEnvConfig = {
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
};

type HttpsProxyAgentInstance = InstanceType<typeof HttpsProxyAgent>;
type ProxyResolution = {
  proxyUrl?: string;
  bypassed: boolean;
};

const directDispatchers = new Map<string, Agent>();
const envProxyDispatchers = new Map<string, EnvHttpProxyAgent>();
const explicitDispatchers = new Map<string, ProxyAgent>();
const httpsProxyAgents = new Map<string, HttpsProxyAgentInstance>();

function getTrimmedEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

export function getProxyEnvConfig(): ProxyEnvConfig | undefined {
  const proxy = getTrimmedEnv('PROXY', 'proxy');
  const noProxy = getTrimmedEnv('no_proxy', 'NO_PROXY');

  if (proxy) {
    return { httpProxy: proxy, httpsProxy: proxy, noProxy };
  }

  const httpProxy = getTrimmedEnv('http_proxy', 'HTTP_PROXY');
  const httpsProxy = getTrimmedEnv('https_proxy', 'HTTPS_PROXY');
  if (!httpProxy && !httpsProxy) return undefined;

  return { httpProxy, httpsProxy, noProxy };
}

function getProxyConfigKey(config: ProxyEnvConfig): string {
  return [config.httpProxy ?? '', config.httpsProxy ?? '', config.noProxy ?? ''].join('|');
}

export interface DispatcherTimeoutOptions {
  bodyTimeout?: number;
  headersTimeout?: number;
}

/** Discard extra runtime properties too: TypeScript cannot prevent structurally wider callers. */
function pickDispatcherTimeouts({
  bodyTimeout,
  headersTimeout,
}: DispatcherTimeoutOptions): DispatcherTimeoutOptions {
  return {
    ...(bodyTimeout != null ? { bodyTimeout } : {}),
    ...(headersTimeout != null ? { headersTimeout } : {}),
  };
}

function getDispatcherOptionsKey(options: DispatcherTimeoutOptions): string {
  return `${options.bodyTimeout ?? ''}|${options.headersTimeout ?? ''}`;
}

export function getDirectDispatcher(options: DispatcherTimeoutOptions = {}): Dispatcher {
  options = pickDispatcherTimeouts(options);
  const key = getDispatcherOptionsKey(options);
  const cached = directDispatchers.get(key);
  if (cached) return cached;

  const dispatcher = new Agent(options);
  directDispatchers.set(key, dispatcher);
  return dispatcher;
}

export function getEnvProxyDispatcher(
  options: DispatcherTimeoutOptions = {},
): Dispatcher | undefined {
  options = pickDispatcherTimeouts(options);
  const proxyConfig = getProxyEnvConfig();
  if (!proxyConfig) return undefined;

  const key = `${getProxyConfigKey(proxyConfig)}|${getDispatcherOptionsKey(options)}`;
  const cached = envProxyDispatchers.get(key);
  if (cached) return cached;

  const dispatcher = new EnvHttpProxyAgent({ ...proxyConfig, ...options });
  envProxyDispatchers.set(key, dispatcher);
  return dispatcher;
}

function getExplicitProxyDispatcher(
  proxyUrl: string,
  options: DispatcherTimeoutOptions,
): Dispatcher {
  options = pickDispatcherTimeouts(options);
  const key = `${proxyUrl}|${getDispatcherOptionsKey(options)}`;
  const cached = explicitDispatchers.get(key);
  if (cached) return cached;

  const dispatcher =
    Object.keys(options).length === 0
      ? new ProxyAgent(proxyUrl)
      : new ProxyAgent({ uri: proxyUrl, ...options });
  explicitDispatchers.set(key, dispatcher);
  return dispatcher;
}

export function getProxyDispatcher(
  proxyUrl?: string | null,
  options: DispatcherTimeoutOptions = {},
): Dispatcher | undefined {
  const trimmedProxy = proxyUrl?.trim();
  if (!trimmedProxy) return getEnvProxyDispatcher(options);

  const proxyConfig = getProxyEnvConfig();
  if (proxyConfig?.httpProxy === trimmedProxy && proxyConfig?.httpsProxy === trimmedProxy) {
    return getEnvProxyDispatcher(options);
  }

  return getExplicitProxyDispatcher(trimmedProxy, options);
}

function parseUrl(value: string | URL | undefined): URL | undefined {
  if (!value) return undefined;
  if (value instanceof URL) return value;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function normalizeHostname(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

function getDefaultPort(protocol: string): number {
  if (protocol === 'http:' || protocol === 'ws:') return 80;
  if (protocol === 'https:' || protocol === 'wss:') return 443;
  return 0;
}

function getNoProxyEntry(entry: string): { host: string; port: number } {
  const trimmed = entry.trim();
  const bracketed = trimmed.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketed) {
    return {
      host: normalizeHostname(bracketed[1]),
      port: bracketed[2] ? Number.parseInt(bracketed[2], 10) : 0,
    };
  }

  const parsed = (trimmed.match(/:/g) ?? []).length === 1 ? trimmed.match(/^(.+):(\d+)$/) : null;
  const host = normalizeHostname(parsed ? parsed[1] : trimmed);
  return {
    host: host === '*' ? host : host.replace(/^\*\.?/, '.'),
    port: parsed ? Number.parseInt(parsed[2], 10) : 0,
  };
}

function hostMatchesNoProxy(hostname: string, entryHost: string): boolean {
  if (!entryHost) return false;
  if (entryHost === '*') return true;

  const normalizedEntry = entryHost.startsWith('.') ? entryHost.slice(1) : entryHost;
  return hostname === normalizedEntry || hostname.endsWith(`.${normalizedEntry}`);
}

export function shouldBypassProxy(targetUrl: string | URL, noProxy?: string): boolean {
  if (!noProxy?.trim()) return false;

  const url = parseUrl(targetUrl);
  if (!url) return false;

  const hostname = normalizeHostname(url.hostname);
  const port = Number.parseInt(url.port, 10) || getDefaultPort(url.protocol);

  return noProxy
    .split(/[\s,]+/)
    .filter(Boolean)
    .some((entry) => {
      const parsed = getNoProxyEntry(entry);
      return parsed.port > 0 && parsed.port !== port
        ? false
        : hostMatchesNoProxy(hostname, parsed.host);
    });
}

function getProxyResolution(targetUrl?: string | URL): ProxyResolution {
  const proxyConfig = getProxyEnvConfig();
  if (!proxyConfig) return { bypassed: false };

  const url = parseUrl(targetUrl);
  if (url && shouldBypassProxy(url, proxyConfig.noProxy)) {
    return { bypassed: true };
  }

  if (!url) return { proxyUrl: proxyConfig.httpsProxy ?? proxyConfig.httpProxy, bypassed: false };
  if (url.protocol === 'http:' || url.protocol === 'ws:') {
    return { proxyUrl: proxyConfig.httpProxy, bypassed: false };
  }
  if (url.protocol === 'https:' || url.protocol === 'wss:') {
    return { proxyUrl: proxyConfig.httpsProxy ?? proxyConfig.httpProxy, bypassed: false };
  }
  return { bypassed: false };
}

export function getProxyUrlForUrl(targetUrl?: string | URL): string | undefined {
  return getProxyResolution(targetUrl).proxyUrl;
}

export function getHttpsProxyAgent(targetUrl?: string | URL): HttpsProxyAgentInstance | undefined {
  const url = parseUrl(targetUrl);
  if (url && url.protocol !== 'https:' && url.protocol !== 'wss:') return undefined;

  const proxyUrl = getProxyUrlForUrl(targetUrl);
  if (!proxyUrl) return undefined;

  const cached = httpsProxyAgents.get(proxyUrl);
  if (cached) return cached;

  const agent = new HttpsProxyAgent(proxyUrl);
  httpsProxyAgents.set(proxyUrl, agent);
  return agent;
}

function getAxiosProxyConfig(proxyUrl: string): AxiosProxyConfig {
  const url = new URL(proxyUrl);
  const proxyConfig: Partial<AxiosProxyConfig> = {
    host: url.hostname.replace(/^\[|\]$/g, ''),
    protocol: url.protocol.replace(':', ''),
  };

  if (url.port) {
    proxyConfig.port = Number.parseInt(url.port, 10);
  }

  if (url.username || url.password) {
    proxyConfig.auth = {
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    };
  }

  return proxyConfig as AxiosProxyConfig;
}

export function applyAxiosProxyConfig(
  config: AxiosRequestConfig,
  targetUrl?: string | URL,
): AxiosRequestConfig {
  const resolution = getProxyResolution(targetUrl);
  if (resolution.bypassed) {
    config.proxy = false;
    return config;
  }

  const url = parseUrl(targetUrl);
  if (url && (url.protocol === 'http:' || url.protocol === 'ws:') && resolution.proxyUrl) {
    config.proxy = getAxiosProxyConfig(resolution.proxyUrl);
    return config;
  }

  const agent = getHttpsProxyAgent(targetUrl);
  if (!agent) return config;

  config.httpsAgent = agent;
  config.proxy = false;
  return config;
}

export const getOpenIdProxyDispatcher: () => Dispatcher | undefined = getEnvProxyDispatcher;
