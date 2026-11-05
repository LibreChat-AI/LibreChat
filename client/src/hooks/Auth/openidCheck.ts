import { OPENID_CHECK_RECEIPT } from 'librechat-data-provider';
import type { OpenIDSessionCheckResponse } from 'librechat-data-provider';

/** A completion permits only this document, not a later reload or another tab. */
export function createOpenIDDocumentCheck(deps: {
  start: (returnTo: string) => Promise<OpenIDSessionCheckResponse>;
  complete: (receipt: string) => Promise<OpenIDSessionCheckResponse>;
  currentUrl: () => URL;
  replaceUrl: (url: URL) => void;
}) {
  let pending: Promise<OpenIDSessionCheckResponse> | undefined;
  const run = () => {
    if (pending) return pending;
    const url = deps.currentUrl();
    const receipt = url.searchParams.get(OPENID_CHECK_RECEIPT);
    url.searchParams.delete(OPENID_CHECK_RECEIPT);
    if (receipt) deps.replaceUrl(url);
    pending = (
      receipt ? deps.complete(receipt) : deps.start(url.pathname + url.search + url.hash)
    ).catch((): OpenIDSessionCheckResponse => ({ status: 'unavailable' }));
    return pending;
  };
  return {
    run,
    retry: () => {
      pending = undefined;
      return run();
    },
  };
}
