import { useCallback, useEffect, useState } from 'react';
import { Spinner } from '@librechat/client';
import { useLocation, useNavigate } from 'react-router-dom';
import { channelConfigSchema, dataService } from 'librechat-data-provider';
import type { ChannelIdentityResult, ChannelLinkView } from 'librechat-data-provider';
import { AuthContextProvider } from '~/hooks/AuthContext';
import useAuthRedirect from './useAuthRedirect';
import Link from '~/components/Channels/Link';

const storageKey = 'channel_link_pending_ticket';
const maxAgeMs = channelConfigSchema.shape.ticketLifetimeMs.removeDefault().maxValue ?? 0;
interface PendingTicket {
  ticket: string;
  savedAt: number;
  expiresAtMs: number;
}

function fromFragment(fragment: string): PendingTicket | undefined {
  if (!/^[A-Za-z0-9_-]{43}$/.test(fragment)) return undefined;
  const savedAt = Date.now();
  return { ticket: fragment, savedAt, expiresAtMs: savedAt + maxAgeMs };
}

function initialTicket(): PendingTicket | undefined {
  const fragment = window.location.hash.slice(1);
  if (fragment) return fromFragment(fragment);
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(storageKey) ?? 'null');
    if (
      saved &&
      typeof saved.ticket === 'string' &&
      /^[A-Za-z0-9_-]{43}$/.test(saved.ticket) &&
      Number.isSafeInteger(saved.savedAt) &&
      saved.savedAt <= Date.now() &&
      Date.now() - saved.savedAt < maxAgeMs
    ) {
      const expiresAtMs = saved.expiresAtMs ?? saved.savedAt + maxAgeMs;
      if (Number.isSafeInteger(expiresAtMs) && expiresAtMs > Date.now())
        return {
          ticket: saved.ticket,
          savedAt: saved.savedAt,
          expiresAtMs: Math.min(expiresAtMs, saved.savedAt + maxAgeMs),
        };
    }
    window.sessionStorage.removeItem(storageKey);
  } catch {
    /* Invalid or blocked tab storage is treated as an absent ticket. */
  }
  return undefined;
}

function AuthenticatedLink({
  ticket,
  onResult,
}: {
  ticket: string;
  onResult: (result: ChannelIdentityResult<ChannelLinkView>) => void;
}) {
  const { user, isAuthenticated } = useAuthRedirect();
  if (!isAuthenticated || !user) return <Spinner />;
  return (
    <Link
      api={dataService.channelIdentityClient}
      accountLabel={user.email || user.name || user.id}
      ticket={ticket}
      onTicketResult={onResult}
    />
  );
}

/** Clears the fragment before AuthContext can turn the return path into a login query. */
export default function ChannelLinkRoute() {
  const [pending, setPending] = useState(initialTicket);
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    if (!location.hash) return;
    const next = fromFragment(location.hash.slice(1));
    setPending(next);
    try {
      if (next) window.sessionStorage.setItem(storageKey, JSON.stringify(next));
      else window.sessionStorage.removeItem(storageKey);
    } catch {
      /* Sign-in remains possible; blocked storage requires requesting another ticket. */
    }
    // Update both native history and router location before any auth redirect can read it.
    navigate({ pathname: location.pathname, search: location.search, hash: '' }, { replace: true });
  }, [location.hash, location.pathname, location.search, navigate]);
  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(
      () => {
        setPending((current) => (current?.ticket === pending.ticket ? undefined : current));
        try {
          const saved = JSON.parse(window.sessionStorage.getItem(storageKey) ?? 'null');
          if (saved?.ticket === pending.ticket) window.sessionStorage.removeItem(storageKey);
        } catch {
          /* Tab storage may be unavailable. */
        }
      },
      Math.max(0, pending.expiresAtMs - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [pending]);
  const onResult = useCallback(
    (result: ChannelIdentityResult<ChannelLinkView>) => {
      if (!pending) return;
      const terminal = result.ok
        ? result.value.state !== 'pending' || result.value.expiresAtMs <= Date.now()
        : ['invalid_ticket', 'revoked', 'expired'].includes(result.error.code);
      const expiry = result.ok ? result.value.expiresAtMs : undefined;
      const next =
        !terminal && expiry != null && Number.isSafeInteger(expiry)
          ? { ...pending, expiresAtMs: Math.min(pending.expiresAtMs, expiry) }
          : pending;
      try {
        const saved = JSON.parse(window.sessionStorage.getItem(storageKey) ?? 'null');
        if (saved?.ticket === pending.ticket) {
          if (terminal) window.sessionStorage.removeItem(storageKey);
          else window.sessionStorage.setItem(storageKey, JSON.stringify(next));
        }
      } catch {
        /* An in-memory ticket remains usable without exporting it to a URL. */
      }
      if (next.expiresAtMs !== pending.expiresAtMs)
        setPending((current) => (current?.ticket === pending.ticket ? next : current));
    },
    [pending],
  );
  if (location.hash) return <Spinner />;
  return (
    <AuthContextProvider>
      <AuthenticatedLink
        key={pending?.savedAt ?? 'absent'}
        ticket={pending?.ticket ?? ''}
        onResult={onResult}
      />
    </AuthContextProvider>
  );
}
