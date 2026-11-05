/** Minimal request shape needed by {@link stripQueryParam} and {@link setQueryParam}. */
export interface QueryParamRequest {
  query: Record<string, unknown>;
  originalUrl: string;
  url: string;
}

/** `URLSearchParams` over everything after the first `?`, so a literal `?` later in the query
 *  string stays part of it instead of starting a second, truncating split. */
export function withQueryString(url: string, mutate: (params: URLSearchParams) => void): string {
  const queryIndex = url.indexOf('?');
  const path = queryIndex === -1 ? url : url.slice(0, queryIndex);
  const params = new URLSearchParams(queryIndex === -1 ? '' : url.slice(queryIndex + 1));
  mutate(params);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

/** Removes a query param from the request's URL strings, so a stray `prompt` does not make
 *  `openid-client`'s passport adapter misclassify the retry as a callback. */
export function stripQueryParam(req: QueryParamRequest, name: string): void {
  delete req.query[name];
  req.originalUrl = withQueryString(req.originalUrl, (params) => params.delete(name));
  req.url = withQueryString(req.url, (params) => params.delete(name));
}

/** Sets a query param on the request's URL strings; `req.query` has no settable backing field
 *  to mutate directly (see above), so a value a retry needs restored must be written here. */
export function setQueryParam(
  req: Pick<QueryParamRequest, 'originalUrl' | 'url'>,
  name: string,
  value: string,
): void {
  req.originalUrl = withQueryString(req.originalUrl, (params) => params.set(name, value));
  req.url = withQueryString(req.url, (params) => params.set(name, value));
}
