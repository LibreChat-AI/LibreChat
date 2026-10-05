import { z } from 'zod';
import { resolveMediaConfig, mediaProviderDiagnosticSchema } from 'librechat-data-provider';
import type { MediaConfig, MediaProviderDiagnostic } from 'librechat-data-provider';

export type MediaDiagnosticLimits = Pick<
  MediaConfig['recovery'],
  'maxDiagnosticMessageChars' | 'maxDiagnosticResponseBytes'
>;

export const defaultMediaDiagnosticLimits: MediaDiagnosticLimits = resolveMediaConfig({}).recovery;

const publicHeaders =
  /^(?:accept(?:-encoding|-language)?|content-type|content-length|user-agent|x-request-id|request-id|x-goog-request-id|x-ms-request-id)$/i;

export function mediaDiagnosticSecrets(headers: Record<string, string> = {}): string[] {
  const secrets = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    if (!value || publicHeaders.test(name)) continue;
    secrets.add(value);
    const scheme = /^authorization$/i.test(name) ? /^\S+\s+(.+)$/ : /^(?:Bearer|Basic)\s+(.+)$/i;
    const token = scheme.exec(value)?.[1];
    if (token) secrets.add(token);
  }
  return [...secrets].sort((left, right) => right.length - left.length);
}

function redact(value: string, limit: number, secrets: readonly string[]): string | undefined {
  let result = value;
  for (const secret of secrets) {
    if (secret) result = result.split(secret).join('[redacted]');
  }
  result = result
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/gi,
      '[redacted]',
    )
    .replace(/data:[^\s"'<>]+/gi, '[redacted media]')
    .replace(/\b(?:https?|gs|s3):\/\/[^\s"'<>]+/gi, '[redacted URL]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s,"'<>]+/gi, '[redacted]')
    .replace(
      /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|signature|credential)["']?\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '[redacted]',
    )
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]+|AIza[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g,
      '[redacted]',
    )
    .replace(/[A-Za-z0-9+/_=-]{128,}/g, '[redacted media]')
    .replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return result.slice(0, limit).trim() || undefined;
}

/** Only bounded text fields cross the provider boundary; raw envelopes and headers never do. */
export function sanitizeMediaProviderDiagnostic(
  diagnostic: MediaProviderDiagnostic | undefined,
  maxMessageChars: number,
  secrets: readonly string[] = [],
): MediaProviderDiagnostic | undefined {
  if (!diagnostic) return;
  const candidate = {
    status: diagnostic.status,
    code: diagnostic.code ? redact(diagnostic.code, 256, secrets) : undefined,
    message: diagnostic.message ? redact(diagnostic.message, maxMessageChars, secrets) : undefined,
    requestId: diagnostic.requestId ? redact(diagnostic.requestId, 256, secrets) : undefined,
  };
  const parsed = mediaProviderDiagnosticSchema.safeParse(candidate);
  return parsed.success && Object.values(parsed.data).some((value) => value !== undefined)
    ? parsed.data
    : undefined;
}

const providerCode = z.union([z.string(), z.number().finite()]);
const providerError = z.object({
  code: providerCode.nullish(),
  message: z.string().nullish(),
  type: z.string().nullish(),
  status: z.string().nullish(),
  request_id: z.string().nullish(),
  requestId: z.string().nullish(),
});
const envelopeSchema = providerError.extend({
  error: z.union([z.string(), providerError]).nullish(),
  error_description: z.string().nullish(),
  detail: z.string().nullish(),
  errors: z.array(providerError).nullish(),
});

export function parseMediaProviderDiagnostic(
  body: string,
  {
    status,
    requestId,
    limits = defaultMediaDiagnosticLimits,
    secrets = [],
  }: {
    status: number;
    requestId?: string;
    limits?: MediaDiagnosticLimits;
    secrets?: readonly string[];
  },
): MediaProviderDiagnostic | undefined {
  let diagnostic: MediaProviderDiagnostic = { status, requestId };
  if (Buffer.byteLength(body) <= limits.maxDiagnosticResponseBytes) {
    try {
      const parsed = envelopeSchema.safeParse(JSON.parse(body));
      if (parsed.success) {
        const envelope = parsed.data;
        const error =
          envelope.error && typeof envelope.error === 'object'
            ? envelope.error
            : (envelope.errors?.[0] ?? envelope);
        const code =
          typeof error.code === 'string' ? error.code : (error.status ?? error.type ?? error.code);
        diagnostic = {
          ...diagnostic,
          code: code == null ? undefined : String(code),
          message:
            error.message ??
            envelope.message ??
            envelope.error_description ??
            envelope.detail ??
            (typeof envelope.error === 'string' ? envelope.error : undefined),
          requestId: requestId ?? error.request_id ?? error.requestId ?? undefined,
        };
      }
    } catch {
      // HTML, plaintext and oversized bodies are not provider diagnostic contracts.
    }
  }
  return sanitizeMediaProviderDiagnostic(diagnostic, limits.maxDiagnosticMessageChars, secrets);
}
