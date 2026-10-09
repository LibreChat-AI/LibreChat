import type { AgentOwnerContact } from 'librechat-data-provider';

export interface AgentContactSource {
  authorName?: string | null;
  support_contact?: {
    name?: string | null;
    email?: string | null;
  } | null;
}

export interface AgentOwnerContactSource {
  name?: string | null;
  username?: string | null;
}

const normalizeContactValue = (value?: string | null): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

/** Auth strategies fall back to the account email for name/username, and legal
 * email forms include quoted local parts with whitespace, so any '@'-containing
 * value is treated as email-derived and never used as a public display name. */
const normalizeDisplayName = (value?: string | null): string | undefined => {
  const normalized = normalizeContactValue(value);
  if (normalized == null || normalized.includes('@')) {
    return undefined;
  }
  return normalized;
};

export const hasSupportContact = (agent: AgentContactSource): boolean => {
  const support = agent.support_contact;
  if (!support) {
    return false;
  }
  return !!normalizeContactValue(support.name) || !!normalizeContactValue(support.email);
};

/**
 * Resolves a display-only owner contact for agents without an explicit support contact.
 * Never includes the owner's account email, nor email-shaped display names; emails are
 * only exposed when the owner opts in by configuring `support_contact`.
 */
export function resolveAgentOwnerContact(
  agent: AgentContactSource,
  owner: AgentOwnerContactSource | null,
): AgentOwnerContact | undefined {
  if (hasSupportContact(agent) || owner == null) {
    return undefined;
  }

  const name =
    normalizeDisplayName(owner.name) ??
    normalizeDisplayName(owner.username) ??
    normalizeDisplayName(agent.authorName);

  if (!name) {
    return undefined;
  }

  return { name };
}
