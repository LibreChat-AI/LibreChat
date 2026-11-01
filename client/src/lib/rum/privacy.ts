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

/** The SDK calls this hook at export time, including for spans buffered before a route change. */
export function sanitizeSpanAttributes(attributes: SpanAttributes): SpanAttributes {
  return Object.fromEntries(
    Object.entries(attributes).map(([key, value]) => {
      if (URL_SPAN_ATTRIBUTE.test(key)) {
        if (/(?:^|\.)query$|(?:^|\.)fragment$/i.test(key)) return [key, ''];
        if (typeof value === 'string') return [key, sanitizeTelemetryUrl(value)];
        if (Array.isArray(value)) {
          return [
            key,
            value.map((entry) => (typeof entry === 'string' ? sanitizeTelemetryUrl(entry) : entry)),
          ];
        }
      }
      return [key, typeof value === 'string' ? sanitizeUrlReferences(value) : value];
    }),
  );
}
