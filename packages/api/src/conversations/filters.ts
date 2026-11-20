import { conversationListConfigSchema } from 'librechat-data-provider';
import type { TConversationListConfig } from 'librechat-data-provider';
import type { Request } from 'express';

/**
 * A conversation-list request carries user input straight into a database query, so the
 * facets are parsed here rather than in the route: one place decides what a valid filter
 * is, and the route keeps only the call.
 */
export interface ConversationListFilters {
  updatedAfter?: Date;
  createdAfter?: Date;
  endpoints?: string[];
  hasFiles?: boolean;
  sharedOnly?: boolean;
}

export interface ConversationListFilterResult {
  filters: ConversationListFilters;
  /** Set when the request is malformed; the route answers 400 with it. */
  error?: string;
}

/** Reads the deployment config; injected so this module does not reach for the app's. A
 *  config not yet loaded reads as none, so the schema defaults apply. */
export type ConversationListConfigReader = (options: {
  baseOnly: true;
}) => Promise<{ conversationList?: TConversationListConfig } | undefined>;

const firstValue = (value: unknown): unknown => (Array.isArray(value) ? value[0] : value);

/**
 * The documented contract is ISO 8601, so anything `new Date()` would quietly accept
 * beyond that is rejected here rather than applied as an unintended cutoff: `2026-02-30`
 * rolls over to March, and `1` becomes January 1, 2001. A date-only string means UTC
 * midnight, matching how `new Date()` parses it, and a timestamp without an offset is
 * UTC as well: left to `new Date()` it would take the server's local zone, so the same
 * request would select different conversations on hosts in different zones.
 */
const ISO_DATE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-](?:0\d|1[0-4])(?::?[0-5]\d)?)?)?$/;

const parseDate = (value: unknown): { date?: Date; invalid?: boolean } => {
  const raw = firstValue(value);
  if (raw == null || raw === '') {
    return {};
  }
  if (typeof raw !== 'string') {
    return { invalid: true };
  }
  const match = ISO_DATE.exec(raw);
  if (match == null) {
    return { invalid: true };
  }
  const [, year, month, day, hour = '00', minute = '00', second = '00', , zone] = match;
  const utc = new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    ),
  );
  /* A calendar-valid write reads back unchanged; February 30th does not. */
  const readsBackClean =
    utc.getUTCFullYear() === Number(year) &&
    utc.getUTCMonth() === Number(month) - 1 &&
    utc.getUTCDate() === Number(day) &&
    utc.getUTCHours() === Number(hour) &&
    utc.getUTCMinutes() === Number(minute) &&
    utc.getUTCSeconds() === Number(second);
  if (!readsBackClean) {
    return { invalid: true };
  }
  /* An offset the regex could not rule out can still be unparsable; a NaN date would
     reach the query builder as a filter it silently drops. */
  const hasTime = match[4] != null;
  const date = new Date(`${raw.replace(' ', 'T')}${hasTime && zone == null ? 'Z' : ''}`);
  if (Number.isNaN(date.getTime())) {
    return { invalid: true };
  }
  return { date };
};

const parseEndpoints = (
  value: unknown,
  limits: TConversationListConfig,
): { endpoints?: string[]; invalid?: boolean } => {
  if (value == null) {
    return {};
  }
  const raw = Array.isArray(value) ? value : [value];
  const endpoints: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      return { invalid: true };
    }
    const trimmed = entry.trim();
    if (trimmed === '') {
      continue;
    }
    if (trimmed.length > limits.maxEndpointNameLength) {
      return { invalid: true };
    }
    /** Repeated values would widen the `$in` without widening the result. */
    if (!endpoints.includes(trimmed)) {
      endpoints.push(trimmed);
    }
  }
  if (endpoints.length === 0) {
    return {};
  }
  if (endpoints.length > limits.maxEndpointFilters) {
    return { invalid: true };
  }
  return { endpoints };
};

/** A supplied flag must be `true` or `false`; a typo fails the request rather than
 *  silently widening the list past what the user asked to see. */
const parseFlag = (value: unknown): { set?: boolean; invalid?: boolean } => {
  const raw = firstValue(value);
  if (raw == null || raw === '') {
    return {};
  }
  if (raw === 'true') {
    return { set: true };
  }
  if (raw === 'false') {
    return { set: false };
  }
  return { invalid: true };
};

/**
 * Reads the list facets off a request query. An absent facet is left undefined so the
 * query builder can tell "not filtering" from "filtering on nothing", and anything
 * malformed fails the request rather than being silently dropped: a filter that is
 * quietly ignored shows the user more conversations than they asked to see.
 */
export function parseConversationListFilters(
  query: Request['query'] | Record<string, unknown>,
  limits: TConversationListConfig,
): ConversationListFilterResult {
  const updated = parseDate(query.updatedAfter);
  if (updated.invalid === true) {
    return { filters: {}, error: 'updatedAfter must be an ISO 8601 date' };
  }

  const created = parseDate(query.createdAfter);
  if (created.invalid === true) {
    return { filters: {}, error: 'createdAfter must be an ISO 8601 date' };
  }

  const endpoints = parseEndpoints(query.endpoints, limits);
  if (endpoints.invalid === true) {
    return {
      filters: {},
      error: `endpoints must be at most ${limits.maxEndpointFilters} names of ${limits.maxEndpointNameLength} characters or fewer`,
    };
  }

  const hasFiles = parseFlag(query.hasFiles);
  if (hasFiles.invalid === true) {
    return { filters: {}, error: 'hasFiles must be true or false' };
  }
  const sharedOnly = parseFlag(query.sharedOnly);
  if (sharedOnly.invalid === true) {
    return { filters: {}, error: 'sharedOnly must be true or false' };
  }

  const filters: ConversationListFilters = {};
  if (updated.date) {
    filters.updatedAfter = updated.date;
  }
  if (created.date) {
    filters.createdAfter = created.date;
  }
  if (endpoints.endpoints) {
    filters.endpoints = endpoints.endpoints;
  }
  /** Only the positive case is a filter: an explicit "false" means the user is not
      filtering, same as leaving the facet out. */
  if (hasFiles.set === true) {
    filters.hasFiles = true;
  }
  if (sharedOnly.set === true) {
    filters.sharedOnly = true;
  }

  return { filters };
}

/**
 * The list route's entry point. Only a request naming endpoints reads the limits at all:
 * they bound nothing else, and an unfiltered sidebar request should not wait on, or fail
 * with, a config cache it does not use.
 */
export async function resolveConversationListFilters(
  query: Request['query'],
  getAppConfig: ConversationListConfigReader,
): Promise<ConversationListFilterResult> {
  const limits =
    query.endpoints == null
      ? conversationListConfigSchema.parse({})
      : await loadConversationListLimits(getAppConfig);
  return parseConversationListFilters(query, limits);
}

/**
 * The limits a deployment enforces on list filters. They are deployment-level, so they come
 * from the base config rather than a caller's merged one, with the schema defaults standing
 * in for an unconfigured deployment. The startup config publishes what this returns, so the
 * sidebar stops a selection exactly where the list route would refuse it.
 */
export async function loadConversationListLimits(
  getAppConfig: ConversationListConfigReader,
): Promise<TConversationListConfig> {
  const config = await getAppConfig({ baseOnly: true });
  return config?.conversationList ?? conversationListConfigSchema.parse({});
}
