import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@librechat/client';
import { apiBaseUrl, dataService } from 'librechat-data-provider';
import type { ResponseReviewView } from 'librechat-data-provider';
import { openInNewTab } from '~/utils/links';
import { useLocalize } from '~/hooks';

function resolveBinding(authURL: string) {
  try {
    const auth = new URL(authURL);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(auth.hostname);
    if (
      auth.username ||
      auth.password ||
      (auth.protocol !== 'https:' && !(local && auth.protocol === 'http:'))
    )
      return null;
    const callback = new URL(auth.searchParams.get('redirect_uri') ?? '');
    const base = new URL(apiBaseUrl() || '/', window.location.origin);
    const prefix = `${base.pathname.replace(/\/$/, '')}/api/`;
    if (
      callback.origin !== base.origin ||
      callback.username ||
      callback.password ||
      callback.search ||
      callback.hash ||
      !callback.pathname.startsWith(prefix)
    )
      return null;
    const match = callback.pathname
      .slice(prefix.length)
      .match(/^(mcp|actions)\/([^/]+)\/oauth\/callback$/);
    if (!match) return null;
    const id = decodeURIComponent(match[2]);
    if (!id || id === '.' || id === '..' || id.includes('/') || /[\\?#]/.test(id)) return null;
    return { type: match[1], id };
  } catch {
    return null;
  }
}

export default function OAuth({ prompt }: { prompt: ResponseReviewView['oauth'][number] }) {
  const localize = useLocalize();
  const target = useMemo(() => resolveBinding(prompt.authURL), [prompt.authURL]);
  const [binding, setBinding] = useState<'pending' | 'bound' | 'failed'>('pending');
  const [expired, setExpired] = useState(() => prompt.expiresAt <= Date.now());
  const active = useRef(false);
  const bindingInFlight = useRef(false);
  const bind = useCallback(async () => {
    if (!target || bindingInFlight.current || prompt.expiresAt <= Date.now()) return;
    bindingInFlight.current = true;
    setBinding('pending');
    try {
      const result =
        target.type === 'mcp'
          ? await dataService.bindMCPOAuth(encodeURIComponent(target.id))
          : await dataService.bindActionOAuth(encodeURIComponent(target.id));
      if (active.current) setBinding(result.success === true ? 'bound' : 'failed');
    } catch {
      if (active.current) setBinding('failed');
    } finally {
      bindingInFlight.current = false;
    }
  }, [target, prompt.expiresAt]);
  useEffect(() => {
    active.current = true;
    void bind();
    return () => {
      active.current = false;
    };
  }, [bind]);
  useEffect(() => {
    const remaining = prompt.expiresAt - Date.now();
    if (remaining <= 0) {
      setExpired(true);
      return;
    }
    const timer = setTimeout(() => setExpired(true), Math.min(remaining, 2147483647));
    return () => clearTimeout(timer);
  }, [prompt.expiresAt]);
  const authorize = () => {
    if (!active.current || !target || prompt.expiresAt <= Date.now() || binding === 'pending')
      return;
    if (binding === 'failed') {
      void bind();
      return;
    }
    openInNewTab(prompt.authURL);
    // Multiple prompts share a callback-path CSRF cookie. The initial binding's
    // owner session covers fast callbacks while the tapped flow claims it again.
    void bind();
  };
  if (expired) return <p role="status">{localize('com_ui_response_review_oauth_expired')}</p>;
  if (!target) return <p role="alert">{localize('com_ui_response_review_oauth_unavailable')}</p>;
  return (
    <div className="space-y-2">
      {binding === 'failed' && <p role="alert">{localize('com_ui_response_review_oauth_error')}</p>}
      <Button
        onClick={authorize}
        disabled={binding === 'pending'}
        aria-busy={binding === 'pending'}
      >
        {localize('com_ui_response_review_authorize', { tool: prompt.toolName })}
      </Button>
    </div>
  );
}
