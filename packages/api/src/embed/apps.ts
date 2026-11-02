import { logger } from '@librechat/data-schemas';
import { extractEnvVariable } from 'librechat-data-provider';
import type { TEmbedAppConfig } from 'librechat-data-provider';

/** Shortest secret accepted for HS256: 32 characters, i.e. `openssl rand -hex 16` or longer. */
export const MIN_EMBED_SECRET_LENGTH = 32;

/** The `embed` section as the loaded config exposes it, with every field optional. */
export interface EmbedConfigInput {
  enabled?: boolean;
  apps?: Array<Partial<TEmbedAppConfig>>;
}

/** An embed app whose secret resolved and whose settings defaults were applied. */
export interface EmbedApp {
  id: string;
  allowedOrigins: string[];
  secret: string;
  role?: string;
  maxTokenAgeSeconds: number;
  clockToleranceSeconds: number;
  sessionSeconds: number;
}

/**
 * Resolves the configured embed apps, keyed by id. An app whose secret is an unset environment
 * variable or shorter than {@link MIN_EMBED_SECRET_LENGTH} is left out with a warning, so a
 * missing secret disables that app instead of signing sessions with a guessable key. Returns an
 * empty map when embedding is disabled.
 */
export function resolveEmbedApps(embed: EmbedConfigInput | undefined): Map<string, EmbedApp> {
  const apps = new Map<string, EmbedApp>();
  if (!embed?.enabled) {
    return apps;
  }

  for (const app of embed.apps ?? []) {
    if (!app.id || !app.secret || !app.allowedOrigins?.length) {
      logger.warn('[embed] Ignoring an embed app without an id, secret or allowed origins.');
      continue;
    }
    if (apps.has(app.id)) {
      logger.warn(`[embed] Ignoring duplicate embed app "${app.id}".`);
      continue;
    }
    const secret = extractEnvVariable(app.secret);
    if (!secret || /\$\{[^}]+\}/.test(secret) || secret.length < MIN_EMBED_SECRET_LENGTH) {
      logger.warn(
        `[embed] Embed app "${app.id}" is disabled: its secret is unset or shorter than ${MIN_EMBED_SECRET_LENGTH} characters.`,
      );
      continue;
    }
    apps.set(app.id, {
      id: app.id,
      allowedOrigins: [...new Set(app.allowedOrigins)],
      secret,
      role: app.role,
      maxTokenAgeSeconds: app.maxTokenAgeSeconds ?? 300,
      clockToleranceSeconds: app.clockToleranceSeconds ?? 30,
      sessionSeconds: app.sessionSeconds ?? 900,
    });
  }

  return apps;
}

/** Every origin any enabled embed app allows to frame LibreChat, without duplicates. */
export function getEmbedFrameAncestors(apps: Map<string, EmbedApp>): string[] {
  const origins = new Set<string>();
  for (const app of apps.values()) {
    for (const origin of app.allowedOrigins) {
      origins.add(origin);
    }
  }
  return [...origins];
}
