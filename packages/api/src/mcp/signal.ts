/** The MCP SDK retains its abort listener after a response; never give it a long-lived run signal. */
export async function withMCPRequestSignal<T>(
  parent: AbortSignal | undefined,
  request: (signal: AbortSignal | undefined) => Promise<T>,
): Promise<T> {
  if (!parent) {
    return request(undefined);
  }

  parent.throwIfAborted();
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent.reason);
  parent.addEventListener('abort', onAbort, { once: true });
  try {
    if (parent.aborted) {
      onAbort();
      parent.throwIfAborted();
    }
    return await request(controller.signal);
  } finally {
    parent.removeEventListener('abort', onAbort);
  }
}
