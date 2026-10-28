/** Join the public API domain and callback path without a duplicate slash. */
export function getOAuthCallbackUrl(baseUrl: string, callbackPath: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${callbackPath}`;
}
