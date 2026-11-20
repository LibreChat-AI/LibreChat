import type { RumRecorderConfig } from '@hyperdx/otel-web-session-recorder';
import type { RumOtelWebExporterOptions } from '@hyperdx/otel-web';

type ReplayPlugin = NonNullable<RumRecorderConfig['plugins']>[number];
type ReplayEvent = Parameters<NonNullable<ReplayPlugin['eventProcessor']>>[0];
type SnapshotNode = Extract<ReplayEvent, { type: 2 }>['data']['node'];
type MutationData = Extract<Extract<ReplayEvent, { type: 3 }>['data'], { source: 0 }>;
type StyleAttributes = Exclude<
  MutationData['attributes'][number]['attributes'][string],
  string | null
>;
type SpanAttributes = Parameters<
  NonNullable<RumOtelWebExporterOptions['onAttributesSerializing']>
>[0];

const AUTH_ROUTE = /\/(?:login|register|forgot-password|reset-password|verify|oauth)(?:\/|$)/i;
const URL_ATTRIBUTE =
  /^(?:data-)?(?:href|src|url|uri|action|formaction|poster|cite|background|data|xlink:href)$/i;
const URL_SPAN_ATTRIBUTE = /url|uri|href|referr?er|^http\.target$|location/i;
const HEADER_SPAN_ATTRIBUTE = /^http\.(?:request|response)\.header\.(.+)$/i;
const CREDENTIAL_HEADER = /authorization|cookie|apikey|token|signature/i;
const BODY_SPAN_ATTRIBUTE = /^http\.(?:request|response)\.body$/i;
const CREDENTIAL_ROUTES = [
  /\/oauth\/(?:google|facebook|openid|github|discord|apple|saml)(?:\/callback)?\/?$/i,
  /\/api\/(?:auth|keys|api-keys)(?:\/|$)/i,
  /\/api\/user\/(?:verify|email)(?:\/|$)/i,
  /\/api\/user\/(?:plugins|delete)\/?$/i,
  /\/api\/admin\/(?:login|oauth|config)(?:\/|$)/i,
  /\/api\/admin\/langfuse\/connection(?:\/|$)/i,
  /\/api\/admin\/skills\/sync\/credentials(?:\/|$)/i,
  /\/api\/admin\/code-environments\/[^/]+\/pairings\/?$/i,
  /\/api\/mcp\/(?:oauth|servers)(?:\/|$)/i,
  /\/api\/mcp\/[^/]+\/oauth(?:\/|$)/i,
  /\/api\/actions\/[^/]+\/oauth(?:\/|$)/i,
  /\/api\/(?:agents|assistants\/v[12])\/actions(?:\/|$)/i,
  /\/api\/pull-requests\/oauth(?:\/|$)/i,
  /\/api\/code-environments\/pairings\/?$/i,
  /\/api\/code-environments\/setup\/(?:start|poll|cancel|complete)\/?$/i,
  /\/api\/channels\/workspaces\/(?:apps|oauth)(?:\/|$)/i,
  /\/api\/channels\/workspaces\/connect\/?$/i,
  /\/api\/channels\/links\/(?:preview|accept)\/?$/i,
  /\/api\/agents\/[^/]+\/channels\/[^/]+\/?$/i,
];

/** Match the request URL, not the current page, so buffered auth calls stay protected. */
export function isCredentialRequest(attributes: SpanAttributes): boolean {
  const requestUrl = attributes['http.url'];
  if (typeof requestUrl !== 'string') return false;
  try {
    let pathname = new URL(requestUrl, 'https://librechat.invalid').pathname;
    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      // A malformed parameter must not hide an otherwise recognizable credential route.
    }
    // A deployment can mount LibreChat below a base path before these route segments.
    return CREDENTIAL_ROUTES.some((route) => route.test(pathname));
  } catch {
    return false;
  }
}

export function isReplayRouteAllowed(pathname: string): boolean {
  try {
    return pathname !== '/' && !AUTH_ROUTE.test(decodeURI(pathname));
  } catch {
    return false;
  }
}

/** Preserve URL origin/path while dropping query strings, fragments and URL credentials. */
export function sanitizeTelemetryUrl(value: string): string {
  const trimmed = value.trim();
  if (/^(?:data|javascript):/i.test(trimmed)) return '[redacted]';
  try {
    const url = new URL(value, 'https://librechat.invalid');
    url.search = '';
    url.hash = '';
    url.username = '';
    url.password = '';
    if (trimmed.startsWith('//')) return `//${url.host}${url.pathname}`;
    return /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? url.href : trimmed.split(/[?#]/, 1)[0];
  } catch {
    return '[redacted]';
  }
}

export function sanitizeUrlReferences(value: string): string {
  return value
    .replace(
      /url\(\s*(['"]?)(.*?)\1\s*\)/gi,
      (_match, quote: string, url: string) => `url(${quote}${sanitizeTelemetryUrl(url)}${quote})`,
    )
    .replace(/https?:\/\/[^\s"'<>)]*/gi, (url) => sanitizeTelemetryUrl(url));
}

function sanitizeAttributes(
  attributes: Record<string, string | number | boolean | null | StyleAttributes>,
): void {
  for (const [key, value] of Object.entries(attributes)) {
    if (value != null && typeof value === 'object') {
      for (const [property, style] of Object.entries(value)) {
        if (typeof style === 'string') value[property] = sanitizeUrlReferences(style);
        else if (Array.isArray(style))
          value[property] = [sanitizeUrlReferences(style[0]), style[1]];
      }
      continue;
    }
    if (typeof value !== 'string') continue;
    if (key.toLowerCase() === 'srcdoc') {
      attributes[key] = '';
    } else if (URL_ATTRIBUTE.test(key)) {
      attributes[key] = sanitizeTelemetryUrl(value);
    } else if (/^(?:data-)?srcset$/i.test(key)) {
      // Commas in URL values make srcset ambiguous; omit sensitive sets instead of leaking fragments.
      if (/data:|[?#@]/i.test(value)) {
        attributes[key] = '[redacted]';
        continue;
      }
      attributes[key] = value
        .split(',')
        .map((candidate) => {
          const [url, ...descriptor] = candidate.trim().split(/\s+/);
          return [
            sanitizeTelemetryUrl(url),
            ...descriptor.filter((entry) => /^\d+(?:\.\d+)?[wx]$/.test(entry)),
          ].join(' ');
        })
        .join(', ');
    } else {
      attributes[key] = sanitizeUrlReferences(value);
    }
  }
}

function sanitizeNodes(root: SnapshotNode): void {
  const pending = [root];
  while (pending.length) {
    const node = pending.pop();
    if (!node) continue;
    if ('attributes' in node) sanitizeAttributes(node.attributes);
    if ('childNodes' in node) pending.push(...node.childNodes);
    if (node.type === 3 && node.isStyle) {
      node.textContent = sanitizeUrlReferences(node.textContent);
    }
  }
}

/** Runs inside rrweb before its event is serialized, chunked or queued by the recorder. */
export function sanitizeReplayEvent(event: ReplayEvent, pathname: string): ReplayEvent {
  if (!isReplayRouteAllowed(pathname)) {
    return { type: 0, timestamp: event.timestamp, data: {} };
  }
  if (event.type === 4) {
    let allowed = false;
    try {
      allowed = isReplayRouteAllowed(
        new URL(event.data.href, 'https://librechat.invalid').pathname,
      );
    } catch {
      // Malformed metadata is not useful enough to risk forwarding an unparsed URL.
    }
    if (!allowed) {
      return { type: 0, timestamp: event.timestamp, data: {} };
    }
    event.data.href = sanitizeTelemetryUrl(event.data.href);
  } else if (event.type === 2) {
    sanitizeNodes(event.data.node);
  } else if (event.type === 3 && event.data.source === 0) {
    for (const addition of event.data.adds) sanitizeNodes(addition.node);
    for (const attribute of event.data.attributes) sanitizeAttributes(attribute.attributes);
    for (const text of event.data.texts) {
      if (text.value != null) text.value = sanitizeUrlReferences(text.value);
    }
  } else if (event.type === 3 && event.data.source === 8) {
    for (const addition of event.data.adds ?? [])
      addition.rule = sanitizeUrlReferences(addition.rule);
  } else if (event.type === 3 && event.data.source === 13 && event.data.set?.value != null) {
    event.data.set.value = sanitizeUrlReferences(event.data.set.value);
  }
  return event;
}

export function createReplayPrivacyPlugin(getPathname: () => string): ReplayPlugin {
  return {
    name: 'librechat-url-privacy',
    options: undefined,
    // rrweb's plugin type permits arbitrary extensions, but this plugin only preserves/redacts events.
    eventProcessor: <TExtend>(event: ReplayEvent) =>
      sanitizeReplayEvent(event, getPathname()) as ReplayEvent & TExtend,
  };
}

/** Remove credential headers and protected bodies before export, including buffered spans. */
export function sanitizeSpanAttributes(
  attributes: SpanAttributes,
  redactBody = false,
): SpanAttributes {
  const removeBody = redactBody || isCredentialRequest(attributes);
  return Object.fromEntries(
    Object.entries(attributes)
      .filter(([key]) => {
        if (removeBody && BODY_SPAN_ATTRIBUTE.test(key)) return false;
        const header = HEADER_SPAN_ATTRIBUTE.exec(key)?.[1];
        // The SDK lowercases header names and replaces hyphens with underscores.
        return !header || !CREDENTIAL_HEADER.test(header.replace(/[-_]/g, ''));
      })
      .map(([key, value]) => {
        if (URL_SPAN_ATTRIBUTE.test(key)) {
          if (/(?:^|\.)query$|(?:^|\.)fragment$/i.test(key)) return [key, ''];
          if (typeof value === 'string') return [key, sanitizeTelemetryUrl(value)];
          if (Array.isArray(value)) {
            return [
              key,
              value.map((entry) =>
                typeof entry === 'string' ? sanitizeTelemetryUrl(entry) : entry,
              ),
            ];
          }
        }
        return [key, typeof value === 'string' ? sanitizeUrlReferences(value) : value];
      }),
  );
}
