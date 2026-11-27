import { injectBootstrapConfig } from './bootstrap';

export const QUERY_DEVTOOLS_HEADER = 'x-librechat-enable-query-devtools';

const QUERY_DEVTOOLS_SENTINEL = 'data-librechat-query-devtools="true"';

export interface QueryDevtoolsRequest {
  get(header: string): string | undefined;
}

export const shouldEnableQueryDevtools = (req: QueryDevtoolsRequest): boolean =>
  req.get(QUERY_DEVTOOLS_HEADER) === '1';

export const maybeInjectQueryDevtoolsBootstrap = (
  html: string,
  req: QueryDevtoolsRequest,
): string => {
  if (!shouldEnableQueryDevtools(req)) {
    return html;
  }

  return injectBootstrapConfig(html, {
    sentinel: QUERY_DEVTOOLS_SENTINEL,
    values: { enableQueryDevtools: true },
  });
};
